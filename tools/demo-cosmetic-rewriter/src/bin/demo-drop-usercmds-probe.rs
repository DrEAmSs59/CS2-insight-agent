use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use demo_cosmetic_rewriter::header::validate_demo_layout;
use demo_cosmetic_rewriter::WORKER_STACK_SIZE;
use sha2::{Digest, Sha256};
use source2_demo::prelude::*;
use source2_demo::proto::{CSvcMsgServerInfo, CSvcMsgUserCommands};
use source2_demo::writer::{DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

#[derive(Debug, ClapParser)]
#[command(name = "demo-drop-usercmds-probe")]
#[command(about = "Drop only svc_UserCmds from an existing non-HLTV CS2 demo probe")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    expected_input_sha256: String,
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
    server_info_ticks: BTreeSet<u32>,
    dropped_messages: usize,
    dropped_commands: usize,
    dropped_payload_bytes: u64,
    dropped_by_player_slot: BTreeMap<i32, usize>,
    first_drop_tick: Option<u32>,
    last_drop_tick: Option<u32>,
    retained_packet_entities: usize,
}

#[derive(Default)]
struct DropUserCmdsProbe {
    report: ProbeReport,
}

impl DemoRewriter for DropUserCmdsProbe {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGE
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
            self.report.server_info_ticks.insert(tick);
            return Ok(MessageRewrite::Keep);
        }

        if msg_type == SvcMessages::SvcPacketEntities as i32 {
            self.report.retained_packet_entities += 1;
            return Ok(MessageRewrite::Keep);
        }

        if msg_type != SvcMessages::SvcUserCmds as i32 {
            return Ok(MessageRewrite::Keep);
        }

        let message = CSvcMsgUserCommands::decode(payload)?;
        self.report.dropped_messages += 1;
        self.report.dropped_commands += message.commands.len();
        self.report.dropped_payload_bytes = self
            .report
            .dropped_payload_bytes
            .saturating_add(payload.len() as u64);
        self.report.first_drop_tick.get_or_insert(tick);
        self.report.last_drop_tick = Some(tick);
        for command in message.commands {
            *self
                .report
                .dropped_by_player_slot
                .entry(command.player_slot.unwrap_or(-1))
                .or_default() += 1;
        }
        Ok(MessageRewrite::Drop)
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-drop-usercmds-probe-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn drop-UserCmds probe worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("drop-UserCmds probe worker panicked"))?
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
    let state = writer.add_rewriter(DropUserCmdsProbe::default());
    writer.run()?;
    let (_, output) = writer.into_parts();
    output.sync_all()?;

    let report = state.borrow().report.clone();
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
    if report.dropped_messages == 0 {
        bail!("no svc_UserCmds message was found");
    }
    if report.retained_packet_entities == 0 {
        bail!("no svc_PacketEntities message was retained");
    }

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

    println!("probe=5A drop only svc_UserCmds from existing non-HLTV input");
    println!("input={}", cli.input.display());
    println!("input_sha256={actual_input_sha256}");
    println!("output={}", cli.output.display());
    println!("output_sha256={output_sha256}");
    println!("output_bytes={output_bytes}");
    println!(
        "server_info_messages={} ticks={:?} player_slots={:?} is_hltv_values={:?}",
        report.server_info_messages,
        report.server_info_ticks,
        report.player_slots,
        report.is_hltv_values
    );
    println!(
        "dropped_messages={} dropped_commands={} dropped_payload_bytes={}",
        report.dropped_messages, report.dropped_commands, report.dropped_payload_bytes
    );
    println!(
        "dropped_by_player_slot={:?}",
        report.dropped_by_player_slot
    );
    println!(
        "drop_ticks={:?}..{:?} retained_packet_entities={}",
        report.first_drop_tick, report.last_drop_tick, report.retained_packet_entities
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
