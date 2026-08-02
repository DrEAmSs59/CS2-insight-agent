use anyhow::{Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use serde::Serialize;
use source2_demo::prelude::*;
use source2_demo::proto::{CNetMsgTick, CSvcMsgPacketEntities, CSvcMsgServerInfo};
use source2_demo::writer::{DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::Instant;

const WORKER_STACK_SIZE: usize = 64 * 1024 * 1024;
const FIRST_SAMPLE_LIMIT: usize = 96;
const ISSUE_SAMPLE_LIMIT: usize = 256;

#[derive(Debug, ClapParser)]
#[command(name = "demo-snapshot-audit")]
#[command(about = "Fast read-only audit of CS2 PacketEntities snapshot delta chains")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long, default_value_t = 26_354)]
    focus_server_tick: u32,
    #[arg(long, default_value_t = 16)]
    focus_radius: u32,
}

#[derive(Clone, Debug, Serialize)]
struct SnapshotSample {
    demo_tick: u32,
    outer_message_type: String,
    in_full_packet: bool,
    full_packet_epoch: usize,
    full_packet_demo_tick: Option<u32>,
    packet_message_index: usize,
    net_tick: Option<u32>,
    server_tick: Option<u32>,
    delta_from: Option<i32>,
    delta_distance: Option<i64>,
    base_seen_in_epoch: Option<bool>,
    base_seen_anywhere: Option<bool>,
    previous_snapshot_server_tick: Option<u32>,
    delta_matches_previous_snapshot: Option<bool>,
    legacy_is_delta: Option<bool>,
    pending_full_frame: Option<bool>,
    update_baseline: Option<bool>,
    baseline: Option<i32>,
    updated_entries: Option<i32>,
    entity_data_len: usize,
    serialized_entities_len: usize,
    last_cmd_number_executed: Option<u32>,
    last_cmd_number_recv_delta: Option<i32>,
    active_spawngroup_handle: Option<u32>,
    max_spawngroup_creationsequence: Option<u32>,
    alternate_baseline_count: usize,
    has_pvs_vis_bits_deprecated: Option<u32>,
    cmd_recv_status: Vec<i32>,
    non_transmitted_header_count: Option<i32>,
    non_transmitted_data_len: usize,
    cq_starved_command_ticks: Option<u32>,
    cq_discarded_command_ticks: Option<u32>,
    outofpvs_entity_update_count: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
struct NetTickIssue {
    demo_tick: u32,
    previous_net_tick: u32,
    net_tick: u32,
    change: i64,
}

#[derive(Default)]
struct SnapshotAudit {
    current_outer_type: Option<EDemoCommands>,
    current_outer_is_full_packet: bool,
    current_packet_message_index: usize,
    current_full_packet_epoch: usize,
    current_full_packet_demo_tick: Option<u32>,
    current_net_tick: Option<u32>,
    previous_net_tick: Option<u32>,
    previous_snapshot_server_tick: Option<u32>,
    seen_snapshot_ticks_in_epoch: BTreeSet<u32>,
    seen_snapshot_ticks_anywhere: BTreeSet<u32>,
    full_packet_count: usize,
    net_tick_count: usize,
    snapshot_count: usize,
    delta_snapshot_count: usize,
    full_snapshot_count: usize,
    missing_base_in_epoch_count: usize,
    missing_base_anywhere_count: usize,
    delta_matches_previous_count: usize,
    net_tick_server_tick_mismatch_count: usize,
    duplicate_server_tick_count: usize,
    no_server_tick_count: usize,
    delta_distance_counts: BTreeMap<i64, usize>,
    server_info_samples: Vec<CSvcMsgServerInfo>,
    first_samples: Vec<SnapshotSample>,
    full_snapshot_samples: Vec<SnapshotSample>,
    focus_samples: Vec<SnapshotSample>,
    missing_base_samples: Vec<SnapshotSample>,
    net_tick_issues: Vec<NetTickIssue>,
    focus_server_tick: u32,
    focus_radius: u32,
}

impl SnapshotAudit {
    fn new(focus_server_tick: u32, focus_radius: u32) -> Self {
        Self {
            focus_server_tick,
            focus_radius,
            ..Self::default()
        }
    }

    fn record_net_tick(&mut self, demo_tick: u32, net_tick: u32) {
        if let Some(previous) = self.previous_net_tick {
            let change = i64::from(net_tick) - i64::from(previous);
            if (change <= 0 || change > 1) && self.net_tick_issues.len() < ISSUE_SAMPLE_LIMIT {
                self.net_tick_issues.push(NetTickIssue {
                    demo_tick,
                    previous_net_tick: previous,
                    net_tick,
                    change,
                });
            }
        }
        self.previous_net_tick = Some(net_tick);
        self.current_net_tick = Some(net_tick);
        self.net_tick_count += 1;
    }

    fn record_snapshot(&mut self, demo_tick: u32, message: CSvcMsgPacketEntities) {
        let server_tick = message.server_tick;
        let delta_from = message.delta_from;
        let positive_delta_base = delta_from.filter(|value| *value >= 0);
        let base_seen_in_epoch = positive_delta_base
            .map(|value| self.seen_snapshot_ticks_in_epoch.contains(&(value as u32)));
        let base_seen_anywhere = positive_delta_base
            .map(|value| self.seen_snapshot_ticks_anywhere.contains(&(value as u32)));
        let delta_distance = match (server_tick, positive_delta_base) {
            (Some(tick), Some(base)) => Some(i64::from(tick) - i64::from(base)),
            _ => None,
        };
        let delta_matches_previous_snapshot =
            match (positive_delta_base, self.previous_snapshot_server_tick) {
                (Some(base), Some(previous)) => Some(base as u32 == previous),
                (Some(_), None) => Some(false),
                _ => None,
            };

        if let Some(distance) = delta_distance {
            *self.delta_distance_counts.entry(distance).or_default() += 1;
        }
        if positive_delta_base.is_some() {
            self.delta_snapshot_count += 1;
        } else {
            self.full_snapshot_count += 1;
        }
        if base_seen_in_epoch == Some(false) {
            self.missing_base_in_epoch_count += 1;
        }
        if base_seen_anywhere == Some(false) {
            self.missing_base_anywhere_count += 1;
        }
        if delta_matches_previous_snapshot == Some(true) {
            self.delta_matches_previous_count += 1;
        }
        if let (Some(net_tick), Some(snapshot_tick)) = (self.current_net_tick, server_tick) {
            if net_tick != snapshot_tick {
                self.net_tick_server_tick_mismatch_count += 1;
            }
        }
        if let Some(tick) = server_tick {
            if self.seen_snapshot_ticks_anywhere.contains(&tick) {
                self.duplicate_server_tick_count += 1;
            }
        } else {
            self.no_server_tick_count += 1;
        }

        let sample = SnapshotSample {
            demo_tick,
            outer_message_type: self
                .current_outer_type
                .map(|value| format!("{value:?}"))
                .unwrap_or_else(|| "unknown".to_owned()),
            in_full_packet: self.current_outer_is_full_packet,
            full_packet_epoch: self.current_full_packet_epoch,
            full_packet_demo_tick: self.current_full_packet_demo_tick,
            packet_message_index: self.current_packet_message_index,
            net_tick: self.current_net_tick,
            server_tick,
            delta_from,
            delta_distance,
            base_seen_in_epoch,
            base_seen_anywhere,
            previous_snapshot_server_tick: self.previous_snapshot_server_tick,
            delta_matches_previous_snapshot,
            legacy_is_delta: message.legacy_is_delta,
            pending_full_frame: message.pending_full_frame,
            update_baseline: message.update_baseline,
            baseline: message.baseline,
            updated_entries: message.updated_entries,
            entity_data_len: message
                .entity_data
                .as_ref()
                .map(Vec::len)
                .unwrap_or_default(),
            serialized_entities_len: message
                .serialized_entities
                .as_ref()
                .map(Vec::len)
                .unwrap_or_default(),
            last_cmd_number_executed: message.last_cmd_number_executed,
            last_cmd_number_recv_delta: message.last_cmd_number_recv_delta,
            active_spawngroup_handle: message.active_spawngroup_handle,
            max_spawngroup_creationsequence: message.max_spawngroup_creationsequence,
            alternate_baseline_count: message.alternate_baselines.len(),
            has_pvs_vis_bits_deprecated: message.has_pvs_vis_bits_deprecated,
            cmd_recv_status: message.cmd_recv_status.clone(),
            non_transmitted_header_count: message
                .non_transmitted_entities
                .as_ref()
                .and_then(|value| value.header_count),
            non_transmitted_data_len: message
                .non_transmitted_entities
                .as_ref()
                .and_then(|value| value.data.as_ref())
                .map(Vec::len)
                .unwrap_or_default(),
            cq_starved_command_ticks: message.cq_starved_command_ticks,
            cq_discarded_command_ticks: message.cq_discarded_command_ticks,
            outofpvs_entity_update_count: message
                .outofpvs_entity_updates
                .as_ref()
                .and_then(|value| value.count),
        };

        if self.first_samples.len() < FIRST_SAMPLE_LIMIT {
            self.first_samples.push(sample.clone());
        }
        if positive_delta_base.is_none() {
            self.full_snapshot_samples.push(sample.clone());
        }
        if server_tick
            .is_some_and(|tick| tick.abs_diff(self.focus_server_tick) <= self.focus_radius)
        {
            self.focus_samples.push(sample.clone());
        }
        if base_seen_in_epoch == Some(false) && self.missing_base_samples.len() < ISSUE_SAMPLE_LIMIT {
            self.missing_base_samples.push(sample);
        }

        if let Some(tick) = server_tick {
            self.seen_snapshot_ticks_in_epoch.insert(tick);
            self.seen_snapshot_ticks_anywhere.insert(tick);
            self.previous_snapshot_server_tick = Some(tick);
        }
        self.snapshot_count += 1;
    }
}

impl DemoRewriter for SnapshotAudit {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::DEMO_MESSAGE | RewriteInterests::PACKET_MESSAGE
    }

    fn rewrite_demo_message(
        &mut self,
        _ctx: &Context,
        tick: u32,
        msg_type: EDemoCommands,
        _payload: &[u8],
    ) -> Result<MessageRewrite, source2_demo::error::ParserError> {
        self.current_outer_type = Some(msg_type);
        self.current_outer_is_full_packet = msg_type == EDemoCommands::DemFullPacket;
        self.current_packet_message_index = 0;
        if self.current_outer_is_full_packet {
            self.full_packet_count += 1;
            self.current_full_packet_epoch += 1;
            self.current_full_packet_demo_tick = Some(tick);
            self.current_net_tick = None;
            self.previous_snapshot_server_tick = None;
            self.seen_snapshot_ticks_in_epoch.clear();
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
        if msg_type == NetMessages::NetTick as i32 {
            let message = CNetMsgTick::decode(payload)?;
            self.record_net_tick(tick, message.tick());
        } else if msg_type == SvcMessages::SvcServerInfo as i32 {
            self.server_info_samples
                .push(CSvcMsgServerInfo::decode(payload)?);
        } else if msg_type == SvcMessages::SvcPacketEntities as i32 {
            let message = CSvcMsgPacketEntities::decode(payload)?;
            self.record_snapshot(tick, message);
        }
        self.current_packet_message_index += 1;
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
    focus_server_tick: u32,
    focus_radius: u32,
    full_packet_count: usize,
    net_tick_count: usize,
    snapshot_count: usize,
    delta_snapshot_count: usize,
    full_snapshot_count: usize,
    missing_base_in_epoch_count: usize,
    missing_base_anywhere_count: usize,
    delta_matches_previous_count: usize,
    net_tick_server_tick_mismatch_count: usize,
    duplicate_server_tick_count: usize,
    no_server_tick_count: usize,
    delta_distance_counts: BTreeMap<i64, usize>,
    server_info_samples: Vec<CSvcMsgServerInfo>,
    first_snapshot_samples: Vec<SnapshotSample>,
    full_snapshot_samples: Vec<SnapshotSample>,
    focus_snapshot_samples: Vec<SnapshotSample>,
    missing_base_samples: Vec<SnapshotSample>,
    net_tick_issues: Vec<NetTickIssue>,
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
        .name("demo-snapshot-audit-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn snapshot audit worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("snapshot audit worker panicked"))?
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
    let state = writer.add_rewriter(SnapshotAudit::new(
        cli.focus_server_tick,
        cli.focus_radius,
    ));
    writer.run()?;
    drop(writer);

    let mut state = state.borrow_mut();
    let report = AuditReport {
        format_version: 1,
        probe: "PacketEntities snapshot delta-chain audit",
        source_demo: cli.input.display().to_string(),
        source_bytes: metadata.len(),
        elapsed_seconds: started.elapsed().as_secs_f64(),
        focus_server_tick: state.focus_server_tick,
        focus_radius: state.focus_radius,
        full_packet_count: state.full_packet_count,
        net_tick_count: state.net_tick_count,
        snapshot_count: state.snapshot_count,
        delta_snapshot_count: state.delta_snapshot_count,
        full_snapshot_count: state.full_snapshot_count,
        missing_base_in_epoch_count: state.missing_base_in_epoch_count,
        missing_base_anywhere_count: state.missing_base_anywhere_count,
        delta_matches_previous_count: state.delta_matches_previous_count,
        net_tick_server_tick_mismatch_count: state.net_tick_server_tick_mismatch_count,
        duplicate_server_tick_count: state.duplicate_server_tick_count,
        no_server_tick_count: state.no_server_tick_count,
        delta_distance_counts: std::mem::take(&mut state.delta_distance_counts),
        server_info_samples: std::mem::take(&mut state.server_info_samples),
        first_snapshot_samples: std::mem::take(&mut state.first_samples),
        full_snapshot_samples: std::mem::take(&mut state.full_snapshot_samples),
        focus_snapshot_samples: std::mem::take(&mut state.focus_samples),
        missing_base_samples: std::mem::take(&mut state.missing_base_samples),
        net_tick_issues: std::mem::take(&mut state.net_tick_issues),
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
    println!(
        "full_packets={} net_ticks={} snapshots={} deltas={} full={}",
        report.full_packet_count,
        report.net_tick_count,
        report.snapshot_count,
        report.delta_snapshot_count,
        report.full_snapshot_count
    );
    println!(
        "missing_base_in_epoch={} missing_base_anywhere={} delta_matches_previous={}",
        report.missing_base_in_epoch_count,
        report.missing_base_anywhere_count,
        report.delta_matches_previous_count
    );
    println!(
        "net_tick_server_tick_mismatches={} duplicate_server_ticks={} no_server_tick={}",
        report.net_tick_server_tick_mismatch_count,
        report.duplicate_server_tick_count,
        report.no_server_tick_count
    );
    println!(
        "focus_samples={} missing_base_samples={} net_tick_issues={}",
        report.focus_snapshot_samples.len(),
        report.missing_base_samples.len(),
        report.net_tick_issues.len()
    );
    println!("delta_distance_counts={:?}", report.delta_distance_counts);
    Ok(())
}
