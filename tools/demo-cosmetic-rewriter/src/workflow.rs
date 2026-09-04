use crate::config::ValidatedConfig;
use crate::header::{validate_demo_header, validate_demo_layout, DemoLayout};
use crate::rewrite::{run_rewrite_pass, MaterializationReport, ReplacementPassReport};
use crate::verify::{
    collect_demo, run_independent_demoparser2, sha256_file, validate_config_against_input,
    verify_captures, VerificationSummary,
};
use anyhow::{bail, Context, Result};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Debug)]
pub struct RewriteOptions {
    pub input: PathBuf,
    pub output: PathBuf,
    pub config: PathBuf,
    pub demoparser2_python: Option<PathBuf>,
    pub skip_independent_parser: bool,
    pub deep_verify: bool,
}

#[derive(Clone, Debug)]
pub struct VerifyOptions {
    pub original: PathBuf,
    pub rewritten: PathBuf,
    pub config: PathBuf,
    pub demoparser2_python: PathBuf,
    pub expected_sha256: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RewriteOutcome {
    pub output: PathBuf,
    pub sha256: String,
    pub layout: DemoLayout,
    pub replacement: ReplacementPassReport,
    pub materialization: Option<MaterializationReport>,
    pub verification: Option<VerificationSummary>,
    pub independent_parser: String,
}

#[derive(Clone, Debug)]
pub struct VerifyOutcome {
    pub sha256: String,
    pub layout: DemoLayout,
    pub verification: VerificationSummary,
    pub independent_parser: String,
}

pub fn rewrite_demo_atomically(options: RewriteOptions) -> Result<RewriteOutcome> {
    if options.demoparser2_python.is_none() && !options.skip_independent_parser {
        bail!(
            "rewrite requires --demoparser2-python for independent validation, or the explicit --skip-independent-parser escape hatch"
        );
    }
    if options.demoparser2_python.is_some() && options.skip_independent_parser {
        bail!("--demoparser2-python and --skip-independent-parser are mutually exclusive");
    }

    let input = fs::canonicalize(&options.input)
        .with_context(|| format!("failed to resolve input {}", options.input.display()))?;
    if !input.is_file() {
        bail!("input is not a file: {}", input.display());
    }
    let output = resolve_new_output(&options.output)?;
    if input == output {
        bail!("input demo cannot be overwritten in place");
    }

    let config = Arc::new(ValidatedConfig::load(&options.config)?);
    let input_layout = validate_demo_header(&input)?;
    let total_steps = if options.deep_verify { 5 } else { 4 };
    let stage = Instant::now();
    eprintln!("[1/{total_steps}] resolving rewrite targets");
    let original_capture = collect_demo(&input, &config)?;
    let targets = Arc::new(validate_config_against_input(
        &config,
        &original_capture,
        &input_layout,
    )?);
    eprintln!(
        "[1/{total_steps}] target resolution complete in {:.1?}",
        stage.elapsed()
    );

    let stage = Instant::now();
    eprintln!("[2/{total_steps}] rewriting existing and materialized entity fields");
    let (mut rewrite_temp, rewrite_file) = TempArtifact::create(&output, "rewrite")?;
    let (replacement, materialization) =
        run_rewrite_pass(&input, rewrite_file, config.clone(), targets.clone())?;
    eprintln!(
        "[2/{total_steps}] rewrite pass complete in {:.1?}",
        stage.elapsed()
    );

    let candidate = rewrite_temp.path();
    let layout = validate_demo_header(candidate)?;
    ensure_same_demo_metadata(&input_layout, &layout)?;
    let verification = if options.deep_verify {
        let stage = Instant::now();
        eprintln!("[3/{total_steps}] running deep source2 snapshot verification");
        let rewritten_capture = collect_demo(candidate, &config)?;
        let summary = verify_captures(&original_capture, &rewritten_capture, &config, &targets)?;
        eprintln!(
            "[3/{total_steps}] deep verification complete in {:.1?}",
            stage.elapsed()
        );
        Some(summary)
    } else {
        None
    };
    let independent_step = if options.deep_verify { 4 } else { 3 };
    let stage = Instant::now();
    eprintln!("[{independent_step}/{total_steps}] running independent parser validation");
    let independent_parser = if let Some(python) = &options.demoparser2_python {
        run_independent_demoparser2(python, candidate)?
    } else {
        "skipped by explicit --skip-independent-parser".to_owned()
    };
    eprintln!(
        "[{independent_step}/{total_steps}] independent validation complete in {:.1?}",
        stage.elapsed()
    );
    eprintln!("[{total_steps}/{total_steps}] hashing and atomically promoting output");
    let sha256 = sha256_file(candidate)?;
    rewrite_temp.commit_to(&output)?;

    Ok(RewriteOutcome {
        output,
        sha256,
        layout,
        replacement,
        materialization,
        verification,
        independent_parser,
    })
}

pub fn verify_demo_pair(options: VerifyOptions) -> Result<VerifyOutcome> {
    let original = fs::canonicalize(&options.original).with_context(|| {
        format!(
            "failed to resolve original demo {}",
            options.original.display()
        )
    })?;
    let rewritten = fs::canonicalize(&options.rewritten).with_context(|| {
        format!(
            "failed to resolve rewritten demo {}",
            options.rewritten.display()
        )
    })?;
    if original == rewritten {
        bail!("original and rewritten demos must be different files");
    }
    let config = ValidatedConfig::load(&options.config)?;
    let original_layout = validate_demo_layout(&original)?;
    let layout = validate_demo_layout(&rewritten)?;
    ensure_same_demo_metadata(&original_layout, &layout)?;
    eprintln!("[1/3] parsing original demo");
    let original_capture = collect_demo(&original, &config)?;
    let targets = validate_config_against_input(&config, &original_capture, &original_layout)?;
    eprintln!("[2/3] parsing and comparing rewritten demo");
    let rewritten_capture = collect_demo(&rewritten, &config)?;
    let verification = verify_captures(&original_capture, &rewritten_capture, &config, &targets)?;
    eprintln!("[3/3] running independent demoparser2 validation");
    let independent_parser = run_independent_demoparser2(&options.demoparser2_python, &rewritten)?;
    let sha256 = sha256_file(&rewritten)?;
    if let Some(expected) = options.expected_sha256 {
        if !sha256.eq_ignore_ascii_case(expected.trim()) {
            bail!("SHA-256 mismatch: expected {expected}, got {sha256}");
        }
    }
    Ok(VerifyOutcome {
        sha256,
        layout,
        verification,
        independent_parser,
    })
}

pub(crate) fn ensure_same_demo_metadata(original: &DemoLayout, rewritten: &DemoLayout) -> Result<()> {
    if original.metadata.patch_version != rewritten.metadata.patch_version
        || original.metadata.build_num != rewritten.metadata.build_num
        || original.metadata.map_name != rewritten.metadata.map_name
        || original.metadata.server_name != rewritten.metadata.server_name
    {
        bail!(
            "rewritten DEM_FileHeader metadata differs from the original: original={:?}, rewritten={:?}",
            original.metadata,
            rewritten.metadata
        );
    }
    Ok(())
}

pub(crate) fn resolve_new_output(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        bail!("refusing to overwrite existing output {}", path.display());
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("output path needs a file name"))?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent)
        .with_context(|| format!("failed to resolve output directory {}", parent.display()))?;
    if !parent.is_dir() {
        bail!("output parent is not a directory: {}", parent.display());
    }
    Ok(parent.join(file_name))
}

pub(crate) struct TempArtifact {
    path: PathBuf,
    committed: bool,
}

impl TempArtifact {
    pub(crate) fn create(final_path: &Path, stage: &str) -> Result<(Self, File)> {
        let parent = final_path.parent().expect("resolved output has parent");
        let file_name = final_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("output.dem");
        for attempt in 0..100_u32 {
            let name = format!(
                ".{file_name}.demo-cosmetic-rewriter-{}-{stage}-{attempt}.tmp",
                std::process::id()
            );
            let path = parent.join(name);
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok((
                        Self {
                            path,
                            committed: false,
                        },
                        file,
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("failed to create temporary output in {}", parent.display())
                    });
                }
            }
        }
        bail!("could not allocate a unique temporary output name")
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn commit_to(&mut self, final_path: &Path) -> Result<()> {
        fs::rename(&self.path, final_path).with_context(|| {
            format!(
                "failed to atomically move {} to {}",
                self.path.display(),
                final_path.display()
            )
        })?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for TempArtifact {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}
