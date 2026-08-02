use anyhow::{Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use serde::Serialize;
use source2_demo::prelude::*;
use source2_demo::proto::{
    CDemoUserCmd, CMsgServerUserCmd, CSvcMsgServerInfo, CSvcMsgUserCommands,
};
use source2_demo::writer::{DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::Instant;

const WORKER_STACK_SIZE: usize = 64 * 1024 * 1024;
const SAMPLE_LIMIT: usize = 96;

#[derive(Debug, ClapParser)]
#[command(name = "demo-usercmd-audit")]
#[command(about = "Fast read-only audit of CS2 demo UserCommands delta baselines")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
}

#[derive(Clone, Debug, Default, Serialize)]
struct SlotStats {
    command_count: usize,
    data_count: usize,
    delta_data_count: usize,
    both_count: usize,
    neither_count: usize,
    delta_without_previous_cmd_in_epoch: usize,
    first_cmd_number: Option<i32>,
    last_cmd_number: Option<i32>,
    first_server_tick: Option<i32>,
    last_server_tick: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
struct CommandSample {
    demo_tick: u32,
    full_packet_epoch_tick: Option<u32>,
    command_index: usize,
    player_slot: i32,
    cmd_number: i32,
    server_tick_executed: Option<i32>,
    client_tick: Option<i32>,
    data_len: usize,
    delta_data_len: usize,
    previous_cmd_seen_in_epoch: bool,
    data_prefix_hex: String,
    delta_prefix_hex: String,
}

#[derive(Clone, Debug, Serialize)]
struct ServerInfoSample {
    demo_tick: u32,
    player_slot: i32,
    is_hltv: bool,
}

#[derive(Clone, Debug, Serialize)]
struct OuterUserCmdSample {
    demo_tick: u32,
    cmd_number: Option<i32>,
    data_len: usize,
    data_prefix_hex: String,
}

#[derive(Default)]
struct UserCmdAudit {
    server_info: Vec<ServerInfoSample>,
    full_packet_count: usize,
    current_full_packet_tick: Option<u32>,
    svc_message_count: usize,
    command_count: usize,
    outer_usercmd_count: usize,
    slots: BTreeMap<i32, SlotStats>,
    seen_cmds_in_epoch: BTreeMap<i32, BTreeSet<i32>>,
    missing_by_full_packet_tick: BTreeMap<u32, usize>,
    samples: Vec<CommandSample>,
    outer_samples: Vec<OuterUserCmdSample>,
    started: Option<Instant>,
    last_progress_tick: u32,
}

impl UserCmdAudit {
    fn report_progress(&mut self, tick: u32) {
        if tick == u32::MAX {
            return;
        }
        if self.started.is_none() {
            self.started = Some(Instant::now());
        }
        if tick >= self.last_progress_tick.saturating_add(30_000) {
            self.last_progress_tick = tick;
            eprintln!(
                "progress tick={tick} svc_usercmd_messages={} commands={}",
                self.svc_message_count, self.command_count
            );
        }
    }

    fn record_command(&mut self, demo_tick: u32, index: usize, command: &CMsgServerUserCmd) {
        let player_slot = command.player_slot.unwrap_or(-1);
        let cmd_number = command.cmd_number.unwrap_or_default();
        let data = command.data.as_deref().unwrap_or_default();
        let delta_data = command.delta_data.as_deref().unwrap_or_default();
        let has_data = !data.is_empty();
        let has_delta = !delta_data.is_empty();
        let previous_cmd_seen = self
            .seen_cmds_in_epoch
            .entry(player_slot)
            .or_default()
            .contains(&cmd_number.saturating_sub(1));

        let stats = self.slots.entry(player_slot).or_default();
        stats.command_count += 1;
        stats.data_count += usize::from(has_data);
        stats.delta_data_count += usize::from(has_delta);
        stats.both_count += usize::from(has_data && has_delta);
        stats.neither_count += usize::from(!has_data && !has_delta);
        if has_delta && !previous_cmd_seen {
            stats.delta_without_previous_cmd_in_epoch += 1;
            if let Some(epoch_tick) = self.current_full_packet_tick {
                *self
                    .missing_by_full_packet_tick
                    .entry(epoch_tick)
                    .or_default() += 1;
            }
        }
        stats.first_cmd_number.get_or_insert(cmd_number);
        stats.last_cmd_number = Some(cmd_number);
        if let Some(server_tick) = command.server_tick_executed {
            stats.first_server_tick.get_or_insert(server_tick);
            stats.last_server_tick = Some(server_tick);
        }

        if self.samples.len() < SAMPLE_LIMIT && (has_delta && !previous_cmd_seen || has_data) {
            self.samples.push(CommandSample {
                demo_tick,
                full_packet_epoch_tick: self.current_full_packet_tick,
                command_index: index,
                player_slot,
                cmd_number,
                server_tick_executed: command.server_tick_executed,
                client_tick: command.client_tick,
                data_len: data.len(),
                delta_data_len: delta_data.len(),
                previous_cmd_seen_in_epoch: previous_cmd_seen,
                data_prefix_hex: hex_prefix(data),
                delta_prefix_hex: hex_prefix(delta_data),
            });
        }

        self.seen_cmds_in_epoch
            .entry(player_slot)
            .or_default()
            .insert(cmd_number);
        self.command_count += 1;
    }
}

impl DemoRewriter for UserCmdAudit {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::DEMO_MESSAGE | RewriteInterests::PACKET_MESSAGE
    }

    fn rewrite_demo_message(
        &mut self,
        _ctx: &Context,
        tick: u32,
        msg_type: EDemoCommands,
        payload: &[u8],
    ) -> Result<MessageRewrite, source2_demo::error::ParserError> {
        self.report_progress(tick);
        if msg_type == EDemoCommands::DemFullPacket {
            self.full_packet_count += 1;
            self.current_full_packet_tick = Some(tick);
            self.seen_cmds_in_epoch.clear();
        } else if msg_type == EDemoCommands::DemUserCmd {
            let command = CDemoUserCmd::decode(payload)?;
            self.outer_usercmd_count += 1;
            if self.outer_samples.len() < SAMPLE_LIMIT {
                let data = command.data.as_deref().unwrap_or_default();
                self.outer_samples.push(OuterUserCmdSample {
                    demo_tick: tick,
                    cmd_number: command.cmd_number,
                    data_len: data.len(),
                    data_prefix_hex: hex_prefix(data),
                });
            }
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
        self.report_progress(tick);
        if msg_type == SvcMessages::SvcServerInfo as i32 {
            let message = CSvcMsgServerInfo::decode(payload)?;
            self.server_info.push(ServerInfoSample {
                demo_tick: tick,
                player_slot: message.player_slot(),
                is_hltv: message.is_hltv(),
            });
        } else if msg_type == SvcMessages::SvcUserCmds as i32 {
            let message = CSvcMsgUserCommands::decode(payload)?;
            self.svc_message_count += 1;
            for (index, command) in message.commands.iter().enumerate() {
                self.record_command(tick, index, command);
            }
        }
        Ok(MessageRewrite::Keep)
    }
}

#[derive(Serialize)]
struct AuditReport {
    format_version: u32,
    probe: &'static str,
    source_demo: String,
    source_bytes: u64,
    elapsed_seconds: f64,
    server_info: Vec<ServerInfoSample>,
    full_packet_count: usize,
    svc_usercmd_message_count: usize,
    svc_usercmd_command_count: usize,
    outer_demo_usercmd_count: usize,
    slots: BTreeMap<i32, SlotStats>,
    full_packets_with_missing_previous_cmd: BTreeMap<u32, usize>,
    command_samples: Vec<CommandSample>,
    outer_usercmd_samples: Vec<OuterUserCmdSample>,
}

#[derive(Default)]
struct NullSeekWriter {
    position: u64,
    length: u64,
}

impl Write for NullSeekWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.position = self.position.saturating_add(buf.len() as u64);
        self.length = self.length.max(self.position);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Seek for NullSeekWriter {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let next = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.length) + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
        };
        if next < 0 || next > i128::from(u64::MAX) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid null-writer seek",
            ));
        }
        self.position = next as u64;
        Ok(self.position)
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-usercmd-audit-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn UserCommands audit worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("UserCommands audit worker panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    let metadata = fs::metadata(&cli.input)
        .with_context(|| format!("failed to stat {}", cli.input.display()))?;
    let input = BufReader::new(
        File::open(&cli.input)
            .with_context(|| format!("failed to open {}", cli.input.display()))?,
    );
    let started = Instant::now();
    let mut writer = DemoWriter::from_reader(input, NullSeekWriter::default())?;
    let state = writer.add_rewriter(UserCmdAudit::default());
    writer.run()?;
    drop(writer);

    let mut state = state.borrow_mut();
    let report = AuditReport {
        format_version: 1,
        probe: "UserCommands full-packet delta-baseline audit",
        source_demo: cli.input.display().to_string(),
        source_bytes: metadata.len(),
        elapsed_seconds: started.elapsed().as_secs_f64(),
        server_info: std::mem::take(&mut state.server_info),
        full_packet_count: state.full_packet_count,
        svc_usercmd_message_count: state.svc_message_count,
        svc_usercmd_command_count: state.command_count,
        outer_demo_usercmd_count: state.outer_usercmd_count,
        slots: std::mem::take(&mut state.slots),
        full_packets_with_missing_previous_cmd: std::mem::take(
            &mut state.missing_by_full_packet_tick,
        ),
        command_samples: std::mem::take(&mut state.samples),
        outer_usercmd_samples: std::mem::take(&mut state.outer_samples),
    };
    drop(state);

    if let Some(parent) = cli.output.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let output = File::create(&cli.output)
        .with_context(|| format!("failed to create {}", cli.output.display()))?;
    serde_json::to_writer_pretty(output, &report)
        .with_context(|| format!("failed to write {}", cli.output.display()))?;

    println!("report={}", cli.output.display());
    println!("elapsed_seconds={:.3}", report.elapsed_seconds);
    println!("full_packet_count={}", report.full_packet_count);
    println!(
        "svc_usercmd_messages={} commands={}",
        report.svc_usercmd_message_count, report.svc_usercmd_command_count
    );
    println!(
        "outer_demo_usercmd_count={}",
        report.outer_demo_usercmd_count
    );
    println!("slot_stats={:?}", report.slots);
    println!(
        "full_packets_with_missing_previous_cmd={}",
        report.full_packets_with_missing_previous_cmd.len()
    );
    Ok(())
}

fn hex_prefix(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}
