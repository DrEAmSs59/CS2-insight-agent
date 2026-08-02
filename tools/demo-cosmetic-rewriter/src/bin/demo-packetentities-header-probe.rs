use anyhow::{bail, Context as AnyhowContext, Result};
use clap::{Parser as ClapParser, ValueEnum};
use demo_cosmetic_rewriter::header::validate_demo_layout;
use demo_cosmetic_rewriter::WORKER_STACK_SIZE;
use sha2::{Digest, Sha256};
use source2_demo::prelude::*;
use source2_demo::proto::{CSvcMsgPacketEntities, CSvcMsgServerInfo};
use source2_demo::writer::{DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ProbeMode {
    StripSerializedEntities,
    RebaseFirstDelta,
}

#[derive(Debug, ClapParser)]
#[command(name = "demo-packetentities-header-probe")]
#[command(about = "Apply one narrow PacketEntities header diagnostic to a CS2 demo")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    expected_input_sha256: String,
    #[arg(long, value_enum)]
    mode: ProbeMode,
    #[arg(long, default_value_t = 6)]
    expected_player_slot: i32,
    #[arg(long, default_value_t = false)]
    expected_is_hltv: bool,
}

#[derive(Clone, Debug, Default)]
struct ProbeReport {
    server_info_messages: usize,
    player_slots: BTreeSet<i32>,
    is_hltv_values: BTreeSet<bool>,
    packet_entities_messages: usize,
    replacements: usize,
    stripped_serialized_bytes: u64,
    rebased_demo_ticks: Vec<u32>,
    rebased_server_ticks: Vec<u32>,
    original_delta_from: Vec<i32>,
}

struct PacketEntitiesHeaderProbe {
    mode: ProbeMode,
    awaiting_first_delta_after_full_packet: bool,
    report: ProbeReport,
}

impl DemoRewriter for PacketEntitiesHeaderProbe {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::DEMO_MESSAGE | RewriteInterests::PACKET_MESSAGE
    }

    fn rewrite_demo_message(
        &mut self,
        _ctx: &Context,
        _tick: u32,
        msg_type: EDemoCommands,
        _payload: &[u8],
    ) -> Result<MessageRewrite, source2_demo::error::ParserError> {
        if msg_type == EDemoCommands::DemFullPacket {
            self.awaiting_first_delta_after_full_packet = true;
        }
        Ok(MessageRewrite::Keep)
    }

    fn rewrite_packet_message(
        &mut self,
        _ctx: &Context,
        tick: u32,
        msg_type: i32,
        payload: &[u8],
    ) -> Result<MessageRewrite, source2_demo::error::ParserError> {
        if msg_type == SvcMessages::SvcServerInfo as i32 {
            let message = CSvcMsgServerInfo::decode(payload)?;
            self.report.server_info_messages += 1;
            self.report.player_slots.insert(message.player_slot());
            self.report.is_hltv_values.insert(message.is_hltv());
            return Ok(MessageRewrite::Keep);
        }
        if msg_type != SvcMessages::SvcPacketEntities as i32 {
            return Ok(MessageRewrite::Keep);
        }

        self.report.packet_entities_messages += 1;
        let mut message = CSvcMsgPacketEntities::decode(payload)?;
        match self.mode {
            ProbeMode::StripSerializedEntities => {
                let Some(serialized) = message.serialized_entities.take() else {
                    return Ok(MessageRewrite::Keep);
                };
                self.report.replacements += 1;
                self.report.stripped_serialized_bytes = self
                    .report
                    .stripped_serialized_bytes
                    .saturating_add(serialized.len() as u64);
                Ok(MessageRewrite::Replace(message.encode_to_vec()))
            }
            ProbeMode::RebaseFirstDelta => {
                let Some(delta_from) = message.delta_from.filter(|value| *value >= 0) else {
                    return Ok(MessageRewrite::Keep);
                };
                if !self.awaiting_first_delta_after_full_packet {
                    return Ok(MessageRewrite::Keep);
                }
                self.awaiting_first_delta_after_full_packet = false;
                self.report.replacements += 1;
                self.report.rebased_demo_ticks.push(tick);
                self.report
                    .rebased_server_ticks
                    .push(message.server_tick.unwrap_or_default());
                self.report.original_delta_from.push(delta_from);
                message.delta_from = None;
                message.legacy_is_delta = Some(false);
                Ok(MessageRewrite::Replace(message.encode_to_vec()))
            }
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-packetentities-header-probe-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn PacketEntities header probe worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("PacketEntities header probe worker panicked"))?
}

fn run(cli: Cli) -> Result<()> {
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
    let state = writer.add_rewriter(PacketEntitiesHeaderProbe {
        mode: cli.mode,
        awaiting_first_delta_after_full_packet: false,
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

    println!("probe_mode={:?}", cli.mode);
    println!("input={}", cli.input.display());
    println!("input_sha256={actual_input_sha256}");
    println!("output={}", cli.output.display());
    println!("output_sha256={output_sha256}");
    println!("output_bytes={output_bytes}");
    println!(
        "server_info_messages={} player_slots={:?} is_hltv_values={:?}",
        report.server_info_messages, report.player_slots, report.is_hltv_values
    );
    println!(
        "packet_entities_messages={} replacements={} stripped_serialized_bytes={}",
        report.packet_entities_messages,
        report.replacements,
        report.stripped_serialized_bytes
    );
    println!("rebased_demo_ticks={:?}", report.rebased_demo_ticks);
    println!("rebased_server_ticks={:?}", report.rebased_server_ticks);
    println!("original_delta_from={:?}", report.original_delta_from);
    println!(
        "header_offsets=file_info:{} spawn_groups:{} eof:{}",
        layout.actual_file_info_offset, layout.actual_spawn_groups_offset, layout.file_len
    );
    Ok(())
}

fn validate_report(cli: &Cli, report: &ProbeReport) -> Result<()> {
    if report.server_info_messages == 0 {
        bail!("no svc_ServerInfo message was found");
    }
    let expected_slots = BTreeSet::from([cli.expected_player_slot]);
    if report.player_slots != expected_slots {
        bail!(
            "unexpected ServerInfo player_slot values: expected {:?}, found {:?}",
            expected_slots,
            report.player_slots
        );
    }
    let expected_hltv = BTreeSet::from([cli.expected_is_hltv]);
    if report.is_hltv_values != expected_hltv {
        bail!(
            "unexpected ServerInfo is_hltv values: expected {:?}, found {:?}",
            expected_hltv,
            report.is_hltv_values
        );
    }
    if report.packet_entities_messages == 0 {
        bail!("no svc_PacketEntities message was found");
    }
    if report.replacements == 0 {
        bail!("the selected probe mode made no replacements");
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
