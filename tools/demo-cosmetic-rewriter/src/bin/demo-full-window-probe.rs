use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use demo_cosmetic_rewriter::header::validate_demo_layout;
use demo_cosmetic_rewriter::WORKER_STACK_SIZE;
use sha2::{Digest, Sha256};
use source2_demo::prelude::*;
use source2_demo::proto::{CSvcMsgPacketEntities, CSvcMsgServerInfo};
use source2_demo::writer::{
    materialize_full_packet_entities, DemoRewriter, DemoWriter, MessageRewrite,
    RewriteInterests,
};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

#[derive(Debug, ClapParser)]
#[command(name = "demo-full-window-probe")]
#[command(about = "Materialize every entity snapshot in a short opening window")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    expected_input_sha256: String,
    #[arg(long, default_value_t = 512)]
    window_ticks: u32,
    #[arg(long, default_value_t = 1)]
    start_tick: u32,
    #[arg(long, default_value_t = 6)]
    expected_player_slot: i32,
    #[arg(long, default_value_t = false)]
    expected_is_hltv: bool,
}

#[derive(Clone, Debug)]
struct WindowSample {
    demo_tick: u32,
    server_tick: u32,
    original_delta_from: i32,
    materialized_entity_count: usize,
    materialized_entity_data_len: usize,
}

#[derive(Clone, Debug, Default)]
struct ProbeReport {
    server_info_messages: usize,
    player_slots: BTreeSet<i32>,
    is_hltv_values: BTreeSet<bool>,
    packet_entities_messages: usize,
    materialized_snapshots: usize,
    first_sample: Option<WindowSample>,
    last_sample: Option<WindowSample>,
}

struct FullWindowProbe {
    start_tick: u32,
    end_tick: u32,
    report: ProbeReport,
}

impl DemoRewriter for FullWindowProbe {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGE | RewriteInterests::PACKET_ENTITIES_POST_STATE
    }

    fn rewrite_packet_message(
        &mut self,
        _ctx: &Context,
        _tick: u32,
        msg_type: i32,
        payload: &[u8],
    ) -> Result<MessageRewrite, source2_demo::error::ParserError> {
        if msg_type == SvcMessages::SvcServerInfo as i32 {
            let message = CSvcMsgServerInfo::decode(payload)?;
            self.report.server_info_messages += 1;
            self.report.player_slots.insert(message.player_slot());
            self.report.is_hltv_values.insert(message.is_hltv());
        }
        if msg_type == SvcMessages::SvcPacketEntities as i32 {
            self.report.packet_entities_messages += 1;
        }
        Ok(MessageRewrite::Keep)
    }

    fn rewrite_packet_entities_post_state(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CSvcMsgPacketEntities,
    ) -> Result<MessageRewrite, source2_demo::error::ParserError> {
        if tick < self.start_tick || tick > self.end_tick {
            return Ok(MessageRewrite::Keep);
        }
        let Some(original_delta_from) = message.delta_from.filter(|value| *value >= 0) else {
            return Ok(MessageRewrite::Keep);
        };

        let server_tick = message.server_tick();
        let materialized_entity_count = materialize_full_packet_entities(ctx, message)?;
        let sample = WindowSample {
            demo_tick: tick,
            server_tick,
            original_delta_from,
            materialized_entity_count,
            materialized_entity_data_len: message.entity_data().len(),
        };
        if self.report.first_sample.is_none() {
            self.report.first_sample = Some(sample.clone());
        }
        self.report.last_sample = Some(sample);
        self.report.materialized_snapshots += 1;
        Ok(MessageRewrite::Rewrite)
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-full-window-probe-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn full-window probe worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("full-window probe worker panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    if cli.input == cli.output {
        bail!("input and output paths must differ");
    }
    if cli.output.exists() {
        bail!("output already exists: {}", cli.output.display());
    }
    if cli.window_ticks == 0 {
        bail!("window_ticks must be greater than zero");
    }
    if cli.start_tick == 0 {
        bail!("start_tick must be greater than zero");
    }
    let end_tick = cli
        .start_tick
        .checked_add(cli.window_ticks - 1)
        .context("materialized window end tick overflowed u32")?;

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
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create {}", parent.display()))?;
    let partial = partial_path(&cli.output);
    if partial.exists() {
        bail!("partial output already exists: {}", partial.display());
    }

    let input = BufReader::new(
        File::open(&cli.input)
            .with_context(|| format!("failed to open {}", cli.input.display()))?,
    );
    let output = File::create(&partial)
        .with_context(|| format!("failed to create {}", partial.display()))?;
    let mut writer = DemoWriter::from_reader(input, output)?;
    let state = writer.add_rewriter(FullWindowProbe {
        start_tick: cli.start_tick,
        end_tick,
        report: ProbeReport::default(),
    });
    writer.run()?;
    let (_, output) = writer.into_parts();
    output.sync_all()?;

    let report = state.borrow().report.clone();
    validate_report(&cli, &report)?;
    let layout = validate_demo_layout(&partial)?;
    let output_sha256 = sha256_file(&partial)?;
    let output_bytes = fs::metadata(&partial)?.len();
    fs::rename(&partial, &cli.output).with_context(|| {
        format!(
            "failed to promote {} to {}",
            partial.display(),
            cli.output.display()
        )
    })?;

    println!("probe=materialized full snapshot opening window");
    println!("input={}", cli.input.display());
    println!("input_sha256={actual_input_sha256}");
    println!("output={}", cli.output.display());
    println!("output_sha256={output_sha256}");
    println!("output_bytes={output_bytes}");
    println!(
        "window_start_tick={} window_end_tick={} window_ticks={}",
        cli.start_tick, end_tick, cli.window_ticks
    );
    println!(
        "server_info_messages={} player_slots={:?} is_hltv_values={:?}",
        report.server_info_messages, report.player_slots, report.is_hltv_values
    );
    println!(
        "packet_entities_messages={} materialized_snapshots={}",
        report.packet_entities_messages, report.materialized_snapshots
    );
    print_sample("first", report.first_sample.as_ref());
    print_sample("last", report.last_sample.as_ref());
    println!(
        "header_offsets=file_info:{} spawn_groups:{} eof:{}",
        layout.actual_file_info_offset, layout.actual_spawn_groups_offset, layout.file_len
    );
    Ok(())
}

fn print_sample(label: &str, sample: Option<&WindowSample>) {
    if let Some(sample) = sample {
        println!(
            "{label}_snapshot demo_tick={} server_tick={} original_delta_from={} materialized_entities={} materialized_bytes={}",
            sample.demo_tick,
            sample.server_tick,
            sample.original_delta_from,
            sample.materialized_entity_count,
            sample.materialized_entity_data_len
        );
    }
}

fn validate_report(cli: &Cli, report: &ProbeReport) -> Result<()> {
    if report.server_info_messages == 0 {
        bail!("no svc_ServerInfo message was found");
    }
    if report.player_slots != BTreeSet::from([cli.expected_player_slot]) {
        bail!("unexpected ServerInfo player_slot values: {:?}", report.player_slots);
    }
    if report.is_hltv_values != BTreeSet::from([cli.expected_is_hltv]) {
        bail!("unexpected ServerInfo is_hltv values: {:?}", report.is_hltv_values);
    }
    if report.materialized_snapshots != cli.window_ticks as usize {
        bail!(
            "expected {} materialized snapshots, found {}",
            cli.window_ticks,
            report.materialized_snapshots
        );
    }
    let Some(first) = report.first_sample.as_ref() else {
        bail!("no first materialized snapshot was recorded");
    };
    let Some(last) = report.last_sample.as_ref() else {
        bail!("no last materialized snapshot was recorded");
    };
    let expected_last_tick = cli
        .start_tick
        .checked_add(cli.window_ticks - 1)
        .context("materialized window end tick overflowed u32")?;
    if first.demo_tick != cli.start_tick || last.demo_tick != expected_last_tick {
        bail!(
            "unexpected materialized window: first={}, last={}",
            first.demo_tick,
            last.demo_tick
        );
    }
    if first.materialized_entity_count == 0 || last.materialized_entity_count == 0 {
        bail!("a materialized boundary snapshot contains no entities");
    }
    Ok(())
}

fn partial_path(output: &Path) -> PathBuf {
    let extension = output
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("dem");
    output.with_extension(format!("{extension}.partial"))
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
