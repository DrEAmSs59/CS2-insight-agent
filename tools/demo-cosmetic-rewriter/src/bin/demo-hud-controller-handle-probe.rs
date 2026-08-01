use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use demo_cosmetic_rewriter::header::validate_demo_layout;
use demo_cosmetic_rewriter::WORKER_STACK_SIZE;
use sha2::{Digest, Sha256};
use source2_demo::prelude::*;
use source2_demo::writer::{DemoRewriter, DemoWriter, RewriteInterests};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

const HANDLE_FIELDS: &[&str] = &[
    "m_hPawn",
    "m_hPlayerPawn",
    "m_hObserverPawn",
    "m_hController",
    "m_hDefaultController",
    "m_hOriginalController",
];
const ALLOWED_FIELDS: &[&str] = &[
    "m_hPawn",
    "m_hPlayerPawn",
    "m_hObserverPawn",
    "m_hController",
    "m_hDefaultController",
    "m_hOriginalController",
    "m_bPawnIsAlive",
    "m_iPawnHealth",
    "m_iTeamNum",
];

#[derive(Debug, ClapParser)]
#[command(name = "demo-hud-controller-handle-probe")]
#[command(about = "Single-field CS2 Controller identity probe; preserves HLTV mode")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    expected_input_sha256: String,
    /// Entity class to rewrite. Defaults to the Controller class used by earlier probes.
    #[arg(long, default_value = "CCSPlayerController")]
    target_class: String,
    /// CCSPlayerController entity index selected by ServerInfo.player_slot + 1.
    #[arg(long)]
    local_controller_index: u32,
    /// One supported Controller or Pawn identity field.
    #[arg(long)]
    field: String,
    /// Numeric field value. Handles and m_iPawnHealth use Unsigned32;
    /// m_iTeamNum uses Unsigned8; m_bPawnIsAlive accepts 0 or 1.
    #[arg(long)]
    value: u32,
}

#[derive(Clone, Debug, Default)]
struct ProbeReport {
    entity_handles: BTreeSet<u32>,
    original_values: BTreeSet<u32>,
    existing_replacements: usize,
    created_materializations: usize,
    ticks: BTreeSet<u32>,
}

struct ControllerHandleProbe {
    target_class: String,
    controller_index: u32,
    field: String,
    desired: FieldValue,
    seen_in_current_delta: BTreeSet<(u32, u32)>,
    report: ProbeReport,
}

impl ControllerHandleProbe {
    fn new(
        target_class: String,
        controller_index: u32,
        field: String,
        desired: FieldValue,
    ) -> Self {
        Self {
            target_class,
            controller_index,
            field,
            desired,
            seen_in_current_delta: BTreeSet::new(),
            report: ProbeReport::default(),
        }
    }

    fn is_target(&self, entity: &Entity) -> bool {
        entity.class().name() == self.target_class
            && entity.index() == self.controller_index
    }

    fn record(&mut self, ctx: &Context, entity: &Entity, current: Option<&FieldValue>) {
        self.report.entity_handles.insert(entity.handle());
        self.report.ticks.insert(ctx.tick());
        if let Some(value) = current.and_then(numeric_value) {
            self.report.original_values.insert(value);
        }
    }
}

impl DemoRewriter for ControllerHandleProbe {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::ENTITY_FIELDS
    }

    fn should_track_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        self.is_target(entity)
    }

    fn should_rewrite_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        // Excludes the synthetic index-0 shared baseline entity.
        self.is_target(entity)
    }

    fn replace_entity_field(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
        field_name: &str,
        current: &FieldValue,
    ) -> Option<FieldValue> {
        if !self.is_target(entity) || field_name != self.field {
            return None;
        }
        if current.type_name() != self.desired.type_name() {
            return None;
        }
        if event == EntityEvents::Created {
            self.seen_in_current_delta
                .insert((ctx.tick(), entity.handle()));
        }
        self.record(ctx, entity, Some(current));
        self.report.existing_replacements += 1;
        Some(self.desired.clone())
    }

    fn append_entity_fields(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> Vec<(String, FieldValue)> {
        if event != EntityEvents::Created || !self.is_target(entity) {
            return Vec::new();
        }
        if self
            .seen_in_current_delta
            .remove(&(ctx.tick(), entity.handle()))
        {
            return Vec::new();
        }
        let current = entity.get_property(&self.field).ok();
        self.record(ctx, entity, current);
        self.report.created_materializations += 1;
        vec![(self.field.clone(), self.desired.clone())]
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-hud-controller-probe-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn 64MB probe worker thread")?
        .join()
        .map_err(|_| anyhow::anyhow!("demo HUD Controller probe worker panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    if !ALLOWED_FIELDS.contains(&cli.field.as_str()) {
        bail!(
            "unsupported field {:?}; allowed fields are {:?}",
            cli.field,
            ALLOWED_FIELDS
        );
    }
    if cli.local_controller_index == 0 {
        bail!("entity index 0 is reserved for the synthetic baseline guard");
    }
    if HANDLE_FIELDS.contains(&cli.field.as_str())
        && (cli.value == 0 || cli.value == u32::MAX)
    {
        bail!("target handle must be a nonzero, non-invalid Source 2 handle");
    }
    let desired = desired_value(&cli.field, cli.value)?;
    if cli.input == cli.output {
        bail!("input and output paths must differ");
    }
    if cli.output.exists() {
        bail!("output already exists: {}", cli.output.display());
    }
    let actual_input_sha256 = sha256_file(&cli.input)?;
    if !actual_input_sha256.eq_ignore_ascii_case(&cli.expected_input_sha256) {
        bail!(
            "input SHA-256 mismatch: expected {}, found {}",
            cli.expected_input_sha256,
            actual_input_sha256
        );
    }

    let parent = cli
        .output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create output directory {}", parent.display()))?;
    let partial = partial_path(&cli.output);
    if partial.exists() {
        bail!("partial output already exists: {}", partial.display());
    }

    let input = BufReader::new(
        File::open(&cli.input)
            .with_context(|| format!("failed to open input demo {}", cli.input.display()))?,
    );
    let output = File::create(&partial)
        .with_context(|| format!("failed to create partial demo {}", partial.display()))?;
    let mut writer = DemoWriter::from_reader(input, output)?;
    let state = writer.add_rewriter(ControllerHandleProbe::new(
        cli.target_class.clone(),
        cli.local_controller_index,
        cli.field.clone(),
        desired,
    ));
    writer.run()?;
    let (_, output) = writer.into_parts();
    output.sync_all()?;

    let report = state.borrow().report.clone();
    if report.entity_handles.is_empty() {
        bail!(
            "no {} entity at index {} was rewritten",
            cli.target_class,
            cli.local_controller_index
        );
    }
    if report.existing_replacements == 0 && report.created_materializations == 0 {
        bail!("the requested field was neither replaced nor materialized");
    }

    let layout = validate_demo_layout(&partial)?;
    let output_sha256 = sha256_file(&partial)?;
    fs::rename(&partial, &cli.output).with_context(|| {
        format!(
            "failed to promote {} to {}",
            partial.display(),
            cli.output.display()
        )
    })?;

    println!("probe=single entity identity field");
    println!("input={}", cli.input.display());
    println!("input_sha256={actual_input_sha256}");
    println!("output={}", cli.output.display());
    println!("output_sha256={output_sha256}");
    println!("target_class={}", cli.target_class);
    println!("controller_index={}", cli.local_controller_index);
    println!("field={}", cli.field);
    println!("value={}", cli.value);
    println!("entity_handles={:?}", report.entity_handles);
    println!("original_values={:?}", report.original_values);
    println!(
        "existing_replacements={} created_materializations={}",
        report.existing_replacements, report.created_materializations
    );
    println!(
        "first_tick={} last_tick={} touched_ticks={}",
        report.ticks.first().copied().unwrap_or_default(),
        report.ticks.last().copied().unwrap_or_default(),
        report.ticks.len()
    );
    println!(
        "header_offsets=file_info:{} spawn_groups:{} eof:{}",
        layout.actual_file_info_offset, layout.actual_spawn_groups_offset, layout.file_len
    );
    Ok(())
}

fn partial_path(output: &Path) -> PathBuf {
    let extension = output
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("dem");
    output.with_extension(format!("{extension}.partial"))
}

fn desired_value(field: &str, value: u32) -> Result<FieldValue> {
    if HANDLE_FIELDS.contains(&field) {
        return Ok(FieldValue::Unsigned32(value));
    }
    match field {
        "m_bPawnIsAlive" => match value {
            0 => Ok(FieldValue::Boolean(false)),
            1 => Ok(FieldValue::Boolean(true)),
            _ => bail!("m_bPawnIsAlive must be 0 or 1"),
        },
        "m_iPawnHealth" => Ok(FieldValue::Unsigned32(value)),
        "m_iTeamNum" => Ok(FieldValue::Unsigned8(
            u8::try_from(value).context("m_iTeamNum must fit in Unsigned8")?,
        )),
        _ => bail!("unsupported Controller field {field:?}"),
    }
}

fn numeric_value(value: &FieldValue) -> Option<u32> {
    match value {
        FieldValue::Boolean(value) => Some(u32::from(*value)),
        FieldValue::Unsigned8(value) => Some(u32::from(*value)),
        FieldValue::Unsigned16(value) => Some(u32::from(*value)),
        FieldValue::Unsigned32(value) => Some(*value),
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_output_stays_next_to_final_output() {
        assert_eq!(
            partial_path(Path::new(r"C:\tmp\probe.dem")),
            PathBuf::from(r"C:\tmp\probe.dem.partial")
        );
    }
}
