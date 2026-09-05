use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use demo_cosmetic_rewriter::header::validate_demo_layout;
use sha2::{Digest, Sha256};
use source2_demo::prelude::*;
use source2_demo::writer::{DemoRewriter, DemoWriter, RewriteInterests};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

const WORKER_STACK_SIZE: usize = 64 * 1024 * 1024;
const SKY_CLASS: &str = "CEnvSky";
const SKY_FIELD: &str = "m_hSkyMaterial";
const SKY_ENABLED_FIELD: &str = "m_bEnabled";
const SKY_START_DISABLED_FIELD: &str = "m_bStartDisabled";
const CUBEMAP_FOG_CLASS: &str = "CEnvCubemapFog";
const CUBEMAP_FOG_ACTIVE_FIELD: &str = "m_bActive";
const GRADIENT_FOG_CLASS: &str = "CGradientFog";
const GRADIENT_FOG_ENABLED_FIELD: &str = "m_bIsEnabled";
const FUNC_BRUSH_CLASS: &str = "CFuncBrush";
const FUNC_WATER_CLASS: &str = "CFuncWater";
const MODEL_FIELD: &str = "CBodyComponent.m_skeletonInstance.m_modelState.m_hModel";

#[derive(Debug, ClapParser)]
#[command(name = "demo-sky-handle-rewriter")]
#[command(about = "Offline, fail-closed rewrite of the active CEnvSky material handle")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    expected_input_sha256: String,
    #[arg(long)]
    expected_map: String,
    #[arg(long)]
    source_handle: Option<u64>,
    #[arg(long)]
    target_handle: u64,
    #[arg(long, default_value_t = 0)]
    expected_active_cubemap_fog_entities: usize,
    #[arg(long, default_value_t = false)]
    disable_active_gradient_fog: bool,
    #[arg(long)]
    suppress_func_brush_model_handle: Vec<u64>,
}

#[derive(Clone, Debug, Default)]
struct RewriteReport {
    source_fields_seen: usize,
    target_fields_seen: usize,
    fields_rewritten: usize,
    entity_handles: BTreeMap<u32, usize>,
    source_handles: BTreeMap<u64, usize>,
    cubemap_fog_active_fields_rewritten: usize,
    cubemap_fog_entities: BTreeSet<u32>,
    gradient_fog_enabled_fields_rewritten: usize,
    gradient_fog_entities: BTreeSet<u32>,
    func_brush_model_fields_rewritten: usize,
    suppressed_func_brush_entities: BTreeMap<u64, BTreeSet<u32>>,
}

#[derive(Clone, Debug, Default)]
struct RewriteTargets {
    active_cubemap_fog_entities: BTreeSet<u32>,
    active_gradient_fog_entities: BTreeSet<u32>,
    func_brush_entities_by_model: BTreeMap<u64, BTreeSet<u32>>,
    observed_func_brush_models: BTreeMap<u64, BTreeSet<u32>>,
}

struct RewriteTargetProbe {
    requested_func_brush_model_handles: BTreeSet<u64>,
    targets: RewriteTargets,
}

impl Observer for RewriteTargetProbe {
    fn interests(&self) -> Interests {
        Interests::ENTITY_STATE | Interests::ENTITY_EVENTS
    }

    fn on_entity(
        &mut self,
        _ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> ObserverResult {
        if event == EntityEvents::Deleted {
            return Ok(());
        }
        if entity.class().name() == CUBEMAP_FOG_CLASS
            && bool_property(entity, CUBEMAP_FOG_ACTIVE_FIELD).unwrap_or(false)
        {
            self.targets
                .active_cubemap_fog_entities
                .insert(entity.handle());
            return Ok(());
        }
        if entity.class().name() == GRADIENT_FOG_CLASS
            && bool_property(entity, GRADIENT_FOG_ENABLED_FIELD).unwrap_or(false)
        {
            self.targets
                .active_gradient_fog_entities
                .insert(entity.handle());
            return Ok(());
        }
        if is_suppressible_world_model_class(entity.class().name()) {
            let Some(model_handle) = u64_property(entity, MODEL_FIELD) else {
                return Ok(());
            };
            self.targets
                .observed_func_brush_models
                .entry(model_handle)
                .or_default()
                .insert(entity.handle());
            if self
                .requested_func_brush_model_handles
                .contains(&model_handle)
            {
                self.targets
                    .func_brush_entities_by_model
                    .entry(model_handle)
                    .or_default()
                    .insert(entity.handle());
            }
        }
        Ok(())
    }
}

struct SkyHandleRewriter {
    source_handle: Option<u64>,
    target_handle: u64,
    expected_active_cubemap_fog_entities: usize,
    disable_active_gradient_fog: bool,
    suppressed_func_brush_entities: BTreeMap<u32, u64>,
    report: RewriteReport,
}

fn u64_property(entity: &Entity, field_name: &str) -> Option<u64> {
    match entity.get_property(field_name).ok()? {
        FieldValue::Unsigned64(value) => Some(*value),
        _ => None,
    }
}

fn bool_property(entity: &Entity, field_name: &str) -> Option<bool> {
    match entity.get_property(field_name).ok()? {
        FieldValue::Boolean(value) => Some(*value),
        _ => None,
    }
}

fn is_suppressible_world_model_class(class_name: &str) -> bool {
    matches!(class_name, FUNC_BRUSH_CLASS | FUNC_WATER_CLASS)
}

fn is_active_sky(entity: &Entity) -> bool {
    bool_property(entity, SKY_ENABLED_FIELD).unwrap_or(false)
        || !bool_property(entity, SKY_START_DISABLED_FIELD).unwrap_or(true)
}

impl DemoRewriter for SkyHandleRewriter {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::ENTITY_FIELDS
    }

    fn should_track_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        let class_name = entity.class().name();
        class_name == SKY_CLASS
            || (self.expected_active_cubemap_fog_entities > 0 && class_name == CUBEMAP_FOG_CLASS)
            || (self.disable_active_gradient_fog && class_name == GRADIENT_FOG_CLASS)
            || (!self.suppressed_func_brush_entities.is_empty()
                && is_suppressible_world_model_class(class_name))
    }

    fn should_rewrite_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        let class_name = entity.class().name();
        class_name == SKY_CLASS
            || (self.expected_active_cubemap_fog_entities > 0 && class_name == CUBEMAP_FOG_CLASS)
            || (self.disable_active_gradient_fog && class_name == GRADIENT_FOG_CLASS)
            || (!self.suppressed_func_brush_entities.is_empty()
                && is_suppressible_world_model_class(class_name))
    }

    fn replace_entity_field(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
        field_name: &str,
        current: &FieldValue,
    ) -> Option<FieldValue> {
        match entity.class().name() {
            SKY_CLASS if field_name == SKY_FIELD => {
                let FieldValue::Unsigned64(current_handle) = current else {
                    return None;
                };
                if *current_handle == self.target_handle {
                    self.report.target_fields_seen += 1;
                    return None;
                }
                let selected = self
                    .source_handle
                    .map_or_else(|| is_active_sky(entity), |source| *current_handle == source);
                if !selected {
                    return None;
                }
                self.report.source_fields_seen += 1;
                self.report.fields_rewritten += 1;
                *self
                    .report
                    .source_handles
                    .entry(*current_handle)
                    .or_default() += 1;
                *self
                    .report
                    .entity_handles
                    .entry(entity.handle())
                    .or_default() += 1;
                Some(FieldValue::Unsigned64(self.target_handle))
            }
            CUBEMAP_FOG_CLASS
                if self.expected_active_cubemap_fog_entities > 0
                    && field_name == CUBEMAP_FOG_ACTIVE_FIELD =>
            {
                let FieldValue::Boolean(active) = current else {
                    return None;
                };
                if !*active {
                    return None;
                }
                self.report.cubemap_fog_entities.insert(entity.handle());
                self.report.cubemap_fog_active_fields_rewritten += 1;
                Some(FieldValue::Boolean(false))
            }
            GRADIENT_FOG_CLASS
                if self.disable_active_gradient_fog && field_name == GRADIENT_FOG_ENABLED_FIELD =>
            {
                let FieldValue::Boolean(enabled) = current else {
                    return None;
                };
                if !*enabled {
                    return None;
                }
                self.report.gradient_fog_entities.insert(entity.handle());
                self.report.gradient_fog_enabled_fields_rewritten += 1;
                Some(FieldValue::Boolean(false))
            }
            class_name
                if is_suppressible_world_model_class(class_name) && field_name == MODEL_FIELD =>
            {
                let expected_model_handle =
                    *self.suppressed_func_brush_entities.get(&entity.handle())?;
                let FieldValue::Unsigned64(model_handle) = current else {
                    return None;
                };
                if *model_handle != expected_model_handle {
                    return None;
                }
                self.report
                    .suppressed_func_brush_entities
                    .entry(*model_handle)
                    .or_default()
                    .insert(entity.handle());
                self.report.func_brush_model_fields_rewritten += 1;
                Some(FieldValue::Unsigned64(0))
            }
            _ => None,
        }
    }
}

#[derive(Default)]
struct SkyHandleVerifier {
    source_handle: Option<u64>,
    target_handle: u64,
    source_states: usize,
    target_states: usize,
    other_states: BTreeMap<u64, usize>,
    expected_active_cubemap_fog_entities: usize,
    targeted_cubemap_fog_entity_handles: BTreeSet<u32>,
    cubemap_fog_entities: BTreeSet<u32>,
    active_cubemap_fog_states: usize,
    disable_active_gradient_fog: bool,
    gradient_fog_entities: BTreeSet<u32>,
    active_gradient_fog_states: usize,
    suppressed_func_brush_entity_handles: BTreeSet<u32>,
    suppressed_func_brush_entities: BTreeSet<u32>,
    non_null_suppressed_func_brush_states: usize,
}

impl Observer for SkyHandleVerifier {
    fn interests(&self) -> Interests {
        Interests::ENTITY_STATE | Interests::ENTITY_EVENTS
    }

    fn on_entity(
        &mut self,
        _ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> ObserverResult {
        if event == EntityEvents::Deleted {
            return Ok(());
        }
        if self.disable_active_gradient_fog && entity.class().name() == GRADIENT_FOG_CLASS {
            self.gradient_fog_entities.insert(entity.handle());
            if bool_property(entity, GRADIENT_FOG_ENABLED_FIELD).unwrap_or(false) {
                self.active_gradient_fog_states += 1;
            }
            return Ok(());
        }
        if self.expected_active_cubemap_fog_entities > 0
            && entity.class().name() == CUBEMAP_FOG_CLASS
        {
            if self
                .targeted_cubemap_fog_entity_handles
                .contains(&entity.handle())
            {
                self.cubemap_fog_entities.insert(entity.handle());
            }
            if bool_property(entity, CUBEMAP_FOG_ACTIVE_FIELD).unwrap_or(false) {
                self.active_cubemap_fog_states += 1;
            }
            return Ok(());
        }
        if is_suppressible_world_model_class(entity.class().name())
            && self
                .suppressed_func_brush_entity_handles
                .contains(&entity.handle())
        {
            self.suppressed_func_brush_entities.insert(entity.handle());
            let null_model = matches!(
                entity.get_property(MODEL_FIELD),
                Ok(FieldValue::Unsigned64(0))
            );
            if !null_model {
                self.non_null_suppressed_func_brush_states += 1;
            }
            return Ok(());
        }
        if entity.class().name() != SKY_CLASS {
            return Ok(());
        }
        let Ok(FieldValue::Unsigned64(handle)) = entity.get_property(SKY_FIELD) else {
            return Ok(());
        };
        if let Some(source_handle) = self.source_handle {
            if *handle == source_handle {
                self.source_states += 1;
            } else if *handle == self.target_handle {
                self.target_states += 1;
            } else {
                *self.other_states.entry(*handle).or_default() += 1;
            }
        } else if is_active_sky(entity) {
            if *handle == self.target_handle {
                self.target_states += 1;
            } else {
                self.source_states += 1;
                *self.other_states.entry(*handle).or_default() += 1;
            }
        }
        Ok(())
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-sky-handle-rewriter-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn sky-handle rewrite worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("sky-handle rewrite worker panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    if cli
        .source_handle
        .is_some_and(|value| value == cli.target_handle)
    {
        bail!("source and target sky handles must differ");
    }
    let suppressed_func_brush_model_handles = cli
        .suppress_func_brush_model_handle
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if suppressed_func_brush_model_handles.contains(&0)
        || suppressed_func_brush_model_handles.len() != cli.suppress_func_brush_model_handle.len()
    {
        bail!("suppressed func_brush model handles must be unique and non-zero");
    }
    let input = fs::canonicalize(&cli.input)
        .with_context(|| format!("failed to resolve input {}", cli.input.display()))?;
    if !input.is_file() {
        bail!("input is not a file: {}", input.display());
    }
    let actual_input_sha256 = sha256_file(&input)?;
    if !actual_input_sha256.eq_ignore_ascii_case(cli.expected_input_sha256.trim()) {
        bail!(
            "input SHA-256 mismatch: expected {}, found {}",
            cli.expected_input_sha256,
            actual_input_sha256
        );
    }
    let input_layout = validate_demo_layout(&input)?;
    if !input_layout
        .metadata
        .map_name
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case(cli.expected_map.trim()))
    {
        bail!(
            "demo map mismatch: expected {}, found {:?}",
            cli.expected_map,
            input_layout.metadata.map_name
        );
    }
    let targets = probe_rewrite_targets(&input, suppressed_func_brush_model_handles.clone())?;
    if cli.expected_active_cubemap_fog_entities > 0
        && targets.active_cubemap_fog_entities.len() != cli.expected_active_cubemap_fog_entities
    {
        bail!(
            "active cubemap-fog entity count mismatch: expected {}, found {}",
            cli.expected_active_cubemap_fog_entities,
            targets.active_cubemap_fog_entities.len()
        );
    }
    if cli.disable_active_gradient_fog && targets.active_gradient_fog_entities.is_empty() {
        bail!("no active gradient-fog entities were found");
    }
    for model_handle in &suppressed_func_brush_model_handles {
        if !targets
            .func_brush_entities_by_model
            .get(model_handle)
            .is_some_and(|entities| !entities.is_empty())
        {
            bail!(
                "suppressible world-model handle {model_handle} was not found; observed {:?}",
                targets.observed_func_brush_models
            );
        }
    }
    let suppressed_func_brush_entities = targets
        .func_brush_entities_by_model
        .iter()
        .flat_map(|(model_handle, entities)| {
            entities
                .iter()
                .map(move |entity_handle| (*entity_handle, *model_handle))
        })
        .collect::<BTreeMap<_, _>>();
    let suppressed_func_brush_entity_handles = suppressed_func_brush_entities
        .keys()
        .copied()
        .collect::<BTreeSet<_>>();

    let output = absolute_new_output(&cli.output)?;
    if input == output {
        bail!("input demo cannot be overwritten in place");
    }
    let partial = partial_path(&output);
    if partial.exists() {
        bail!("partial output already exists: {}", partial.display());
    }

    let input_file = BufReader::new(File::open(&input)?);
    let output_file = File::create(&partial)
        .with_context(|| format!("failed to create {}", partial.display()))?;
    let mut writer = DemoWriter::from_reader(input_file, output_file)?;
    let state = writer.add_rewriter(SkyHandleRewriter {
        source_handle: cli.source_handle,
        target_handle: cli.target_handle,
        expected_active_cubemap_fog_entities: cli.expected_active_cubemap_fog_entities,
        disable_active_gradient_fog: cli.disable_active_gradient_fog,
        suppressed_func_brush_entities,
        report: RewriteReport::default(),
    });
    if let Err(error) = writer.run() {
        drop(writer);
        let _ = fs::remove_file(&partial);
        return Err(error.into());
    }
    let (_, output_file) = writer.into_parts();
    output_file.sync_all()?;
    let report = state.borrow().report.clone();
    if report.fields_rewritten == 0 {
        let _ = fs::remove_file(&partial);
        bail!(
            "no active CEnvSky {} field matched{}",
            SKY_FIELD,
            cli.source_handle
                .map(|value| format!(" source handle {value}"))
                .unwrap_or_default()
        );
    }
    if cli.disable_active_gradient_fog && report.gradient_fog_entities.is_empty() {
        let _ = fs::remove_file(&partial);
        bail!("no active gradient-fog fields were rewritten");
    }
    for model_handle in &suppressed_func_brush_model_handles {
        if !report
            .suppressed_func_brush_entities
            .get(model_handle)
            .is_some_and(|entities| !entities.is_empty())
        {
            let _ = fs::remove_file(&partial);
            bail!("suppressible world-model handle {model_handle} was not found");
        }
    }

    let output_layout = validate_demo_layout(&partial)?;
    if input_layout.metadata.patch_version != output_layout.metadata.patch_version
        || input_layout.metadata.build_num != output_layout.metadata.build_num
        || input_layout.metadata.map_name != output_layout.metadata.map_name
        || input_layout.metadata.server_name != output_layout.metadata.server_name
    {
        let _ = fs::remove_file(&partial);
        bail!("rewritten demo header metadata differs from the input");
    }
    let verifier = verify_handles(
        &partial,
        cli.source_handle,
        cli.target_handle,
        cli.expected_active_cubemap_fog_entities,
        targets.active_cubemap_fog_entities.clone(),
        cli.disable_active_gradient_fog,
        suppressed_func_brush_entity_handles.clone(),
    )?;
    if verifier.source_states != 0 || verifier.target_states == 0 {
        let _ = fs::remove_file(&partial);
        bail!(
            "sky-handle verification failed: source_states={} target_states={}",
            verifier.source_states,
            verifier.target_states
        );
    }
    if verifier.active_cubemap_fog_states != 0
        || verifier.cubemap_fog_entities.len() != cli.expected_active_cubemap_fog_entities
    {
        let _ = fs::remove_file(&partial);
        bail!(
            "cubemap-fog verification failed: active_states={} entities={}",
            verifier.active_cubemap_fog_states,
            verifier.cubemap_fog_entities.len()
        );
    }
    if cli.disable_active_gradient_fog
        && (verifier.active_gradient_fog_states != 0 || verifier.gradient_fog_entities.is_empty())
    {
        let _ = fs::remove_file(&partial);
        bail!(
            "gradient-fog verification failed: active_states={} entities={}",
            verifier.active_gradient_fog_states,
            verifier.gradient_fog_entities.len()
        );
    }
    if verifier.non_null_suppressed_func_brush_states != 0
        || verifier.suppressed_func_brush_entities != suppressed_func_brush_entity_handles
    {
        let _ = fs::remove_file(&partial);
        bail!(
            "func_brush suppression verification failed: non_null_model_states={} entities={:?}",
            verifier.non_null_suppressed_func_brush_states,
            verifier.suppressed_func_brush_entities
        );
    }

    let output_sha256 = sha256_file(&partial)?;
    let output_bytes = fs::metadata(&partial)?.len();
    fs::rename(&partial, &output).with_context(|| {
        format!(
            "failed to promote {} to {}",
            partial.display(),
            output.display()
        )
    })?;
    println!("input={}", input.display());
    println!("input_sha256={actual_input_sha256}");
    println!("output={}", output.display());
    println!("output_sha256={output_sha256}");
    println!("output_bytes={output_bytes}");
    println!(
        "source_fields_seen={} target_fields_seen={} fields_rewritten={} entity_handles={:?} source_handles={:?}",
        report.source_fields_seen,
        report.target_fields_seen,
        report.fields_rewritten,
        report.entity_handles,
        report.source_handles
    );
    println!(
        "verified_source_states={} verified_target_states={} verified_other_states={:?}",
        verifier.source_states, verifier.target_states, verifier.other_states
    );
    println!(
        "cubemap_fog_active_fields_rewritten={} cubemap_fog_entities={} gradient_fog_enabled_fields_rewritten={} gradient_fog_entities={} func_brush_model_fields_rewritten={} suppressed_func_brush_entities={}",
        report.cubemap_fog_active_fields_rewritten,
        verifier.cubemap_fog_entities.len(),
        report.gradient_fog_enabled_fields_rewritten,
        report.gradient_fog_entities.len(),
        report.func_brush_model_fields_rewritten,
        report
            .suppressed_func_brush_entities
            .values()
            .map(BTreeSet::len)
            .sum::<usize>()
    );
    Ok(())
}

fn verify_handles(
    path: &Path,
    source_handle: Option<u64>,
    target_handle: u64,
    expected_active_cubemap_fog_entities: usize,
    targeted_cubemap_fog_entity_handles: BTreeSet<u32>,
    disable_active_gradient_fog: bool,
    suppressed_func_brush_entity_handles: BTreeSet<u32>,
) -> Result<SkyHandleVerifier> {
    let input = BufReader::new(File::open(path)?);
    let mut parser = source2_demo::prelude::Parser::from_reader(input)?;
    let state = parser.add_observer(SkyHandleVerifier {
        source_handle,
        target_handle,
        expected_active_cubemap_fog_entities,
        targeted_cubemap_fog_entity_handles,
        disable_active_gradient_fog,
        suppressed_func_brush_entity_handles,
        ..SkyHandleVerifier::default()
    });
    parser.run_to_end()?;
    drop(parser);
    let mut state = state.borrow_mut();
    Ok(std::mem::take(&mut *state))
}

fn probe_rewrite_targets(
    path: &Path,
    requested_func_brush_model_handles: BTreeSet<u64>,
) -> Result<RewriteTargets> {
    let input = BufReader::new(File::open(path)?);
    let mut parser = source2_demo::prelude::Parser::from_reader(input)?;
    let state = parser.add_observer(RewriteTargetProbe {
        requested_func_brush_model_handles,
        targets: RewriteTargets::default(),
    });
    parser.run_to_end()?;
    drop(parser);
    let mut state = state.borrow_mut();
    Ok(std::mem::take(&mut state.targets))
}

fn absolute_new_output(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        bail!("refusing to overwrite existing output {}", path.display());
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("output path needs a file name"))?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    let parent = fs::canonicalize(parent)
        .with_context(|| format!("failed to resolve {}", parent.display()))?;
    Ok(parent.join(file_name))
}

fn partial_path(output: &Path) -> PathBuf {
    let mut name = output.as_os_str().to_os_string();
    name.push(".partial");
    PathBuf::from(name)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("failed to hash {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
