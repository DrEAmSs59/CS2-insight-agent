use anyhow::{Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use serde::Serialize;
use source2_demo::prelude::*;
use source2_demo::proto::*;
use source2_demo::writer::{DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::Instant;

const WORKER_STACK_SIZE: usize = 64 * 1024 * 1024;
const SPECIAL_SAMPLE_LIMIT: usize = 128;

#[derive(Debug, ClapParser)]
#[command(name = "demo-netmessage-audit")]
#[command(about = "Fast read-only map of CS2 demo packet and user-message types")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
}

#[derive(Clone, Debug, Default, Serialize)]
struct MessageStats {
    name: String,
    count: usize,
    first_tick: u32,
    last_tick: u32,
    min_payload_len: usize,
    max_payload_len: usize,
    payload_lengths: BTreeMap<usize, usize>,
}

impl MessageStats {
    fn record(&mut self, name: String, tick: u32, payload_len: usize) {
        if self.count == 0 {
            self.name = name;
            self.first_tick = tick;
            self.min_payload_len = payload_len;
        }
        self.count += 1;
        self.last_tick = tick;
        self.min_payload_len = self.min_payload_len.min(payload_len);
        self.max_payload_len = self.max_payload_len.max(payload_len);
        *self.payload_lengths.entry(payload_len).or_default() += 1;
    }
}

#[derive(Clone, Debug, Serialize)]
struct WrappedUserMessageSample {
    tick: u32,
    message_type: i32,
    message_name: String,
    payload_len: usize,
    passthrough: Option<i32>,
    payload_prefix_hex: String,
}

#[derive(Clone, Debug, Serialize)]
struct SetViewSample {
    tick: u32,
    entity_index: i32,
    slot: i32,
}

#[derive(Clone, Debug, Serialize)]
struct VoiceDataSample {
    tick: u32,
    xuid: Option<u64>,
    entity: i32,
    audible_mask: Option<i32>,
    voice_tick: Option<u32>,
    audio_bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
struct ResetHudSample {
    tick: u32,
    reset: Option<bool>,
    wrapped: bool,
}

#[derive(Clone, Debug, Serialize)]
struct StopSpectatorSample {
    tick: u32,
    dummy: Option<i32>,
    wrapped: bool,
}

#[derive(Clone, Debug, Serialize)]
struct DecodeFailure {
    tick: u32,
    message_type: i32,
    message_name: String,
    error: String,
}

#[derive(Default)]
struct NetMessageAudit {
    packet_types: BTreeMap<i32, MessageStats>,
    outer_types: BTreeMap<i32, MessageStats>,
    wrapped_user_types: BTreeMap<i32, MessageStats>,
    wrapped_user_samples: Vec<WrappedUserMessageSample>,
    set_view_samples: Vec<SetViewSample>,
    voice_samples: Vec<VoiceDataSample>,
    reset_hud_samples: Vec<ResetHudSample>,
    stop_spectator_samples: Vec<StopSpectatorSample>,
    kill_cam_ticks: BTreeSet<u32>,
    decode_failures: Vec<DecodeFailure>,
    started: Option<Instant>,
    last_progress_tick: u32,
}

impl NetMessageAudit {
    fn report_progress(&mut self, tick: u32) {
        if tick == u32::MAX {
            return;
        }
        if self.started.is_none() {
            self.started = Some(Instant::now());
        }
        if tick >= self.last_progress_tick.saturating_add(30_000) {
            self.last_progress_tick = tick;
            let count: usize = self.packet_types.values().map(|stats| stats.count).sum();
            eprintln!("progress tick={tick} packet_messages={count}");
        }
    }

    fn record_failure(&mut self, tick: u32, msg_type: i32, name: &str, error: impl ToString) {
        if self.decode_failures.len() < SPECIAL_SAMPLE_LIMIT {
            self.decode_failures.push(DecodeFailure {
                tick,
                message_type: msg_type,
                message_name: name.to_owned(),
                error: error.to_string(),
            });
        }
    }

    fn record_wrapped_user_message(
        &mut self,
        tick: u32,
        message: CSvcMsgUserMessage,
    ) {
        let msg_type = message.msg_type.unwrap_or_default();
        let data = message.msg_data.as_deref().unwrap_or_default();
        let name = describe_user_message_type(msg_type);
        self.wrapped_user_types
            .entry(msg_type)
            .or_default()
            .record(name.clone(), tick, data.len());
        if self.wrapped_user_samples.len() < SPECIAL_SAMPLE_LIMIT {
            self.wrapped_user_samples.push(WrappedUserMessageSample {
                tick,
                message_type: msg_type,
                message_name: name,
                payload_len: data.len(),
                passthrough: message.passthrough,
                payload_prefix_hex: hex_prefix(data),
            });
        }
        self.decode_hud_special(tick, msg_type, data, true);
    }

    fn decode_hud_special(&mut self, tick: u32, msg_type: i32, data: &[u8], wrapped: bool) {
        if msg_type == ECstrike15UserMessages::CsUmResetHud as i32 {
            match CCsUsrMsgResetHud::decode(data) {
                Ok(message) => self.reset_hud_samples.push(ResetHudSample {
                    tick,
                    reset: message.reset,
                    wrapped,
                }),
                Err(error) => self.record_failure(tick, msg_type, "CsUmResetHud", error),
            }
        } else if msg_type == ECstrike15UserMessages::CsUmStopSpectatorMode as i32 {
            match CCsUsrMsgStopSpectatorMode::decode(data) {
                Ok(message) => self
                    .stop_spectator_samples
                    .push(StopSpectatorSample {
                        tick,
                        dummy: message.dummy,
                        wrapped,
                    }),
                Err(error) => {
                    self.record_failure(tick, msg_type, "CsUmStopSpectatorMode", error)
                }
            }
        } else if msg_type == ECstrike15UserMessages::CsUmKillCam as i32 {
            match CCsUsrMsgKillCam::decode(data) {
                Ok(_) => {
                    self.kill_cam_ticks.insert(tick);
                }
                Err(error) => self.record_failure(tick, msg_type, "CsUmKillCam", error),
            }
        }
    }
}

impl DemoRewriter for NetMessageAudit {
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
        self.outer_types
            .entry(msg_type as i32)
            .or_default()
            .record(format!("{msg_type:?}"), tick, payload.len());
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
        self.packet_types
            .entry(msg_type)
            .or_default()
            .record(describe_packet_message_type(msg_type), tick, payload.len());

        if msg_type == SvcMessages::SvcUserMessage as i32 {
            match CSvcMsgUserMessage::decode(payload) {
                Ok(message) => self.record_wrapped_user_message(tick, message),
                Err(error) => self.record_failure(tick, msg_type, "SvcUserMessage", error),
            }
        } else if msg_type == SvcMessages::SvcSetView as i32 {
            match CSvcMsgSetView::decode(payload) {
                Ok(message) if self.set_view_samples.len() < SPECIAL_SAMPLE_LIMIT => {
                    self.set_view_samples.push(SetViewSample {
                        tick,
                        entity_index: message.entity_index(),
                        slot: message.slot(),
                    });
                }
                Ok(_) => {}
                Err(error) => self.record_failure(tick, msg_type, "SvcSetView", error),
            }
        } else if msg_type == SvcMessages::SvcVoiceData as i32 {
            match CSvcMsgVoiceData::decode(payload) {
                Ok(message) if self.voice_samples.len() < SPECIAL_SAMPLE_LIMIT => {
                    let audio_bytes = message
                        .audio
                        .as_ref()
                        .and_then(|audio| audio.voice_data.as_ref())
                        .map(Vec::len)
                        .unwrap_or_default();
                    self.voice_samples.push(VoiceDataSample {
                        tick,
                        xuid: message.xuid,
                        entity: message.entity(),
                        audible_mask: message.audible_mask,
                        voice_tick: message.tick,
                        audio_bytes,
                    });
                }
                Ok(_) => {}
                Err(error) => self.record_failure(tick, msg_type, "SvcVoiceData", error),
            }
        }

        if ECstrike15UserMessages::try_from(msg_type).is_ok() {
            self.decode_hud_special(tick, msg_type, payload, false);
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
    outer_message_types: BTreeMap<i32, MessageStats>,
    packet_message_types: BTreeMap<i32, MessageStats>,
    wrapped_user_message_types: BTreeMap<i32, MessageStats>,
    wrapped_user_message_samples: Vec<WrappedUserMessageSample>,
    set_view_samples: Vec<SetViewSample>,
    voice_data_samples: Vec<VoiceDataSample>,
    reset_hud_samples: Vec<ResetHudSample>,
    stop_spectator_mode_samples: Vec<StopSpectatorSample>,
    kill_cam_ticks: BTreeSet<u32>,
    decode_failures: Vec<DecodeFailure>,
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
        .name("demo-netmessage-audit-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn netmessage audit worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("netmessage audit worker panicked"))?
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
    let state = writer.add_rewriter(NetMessageAudit::default());
    writer.run()?;
    drop(writer);

    let mut state = state.borrow_mut();
    let report = AuditReport {
        format_version: 1,
        probe: "Complete packet and user-message type map",
        source_demo: cli.input.display().to_string(),
        source_bytes: metadata.len(),
        elapsed_seconds: started.elapsed().as_secs_f64(),
        outer_message_types: std::mem::take(&mut state.outer_types),
        packet_message_types: std::mem::take(&mut state.packet_types),
        wrapped_user_message_types: std::mem::take(&mut state.wrapped_user_types),
        wrapped_user_message_samples: std::mem::take(&mut state.wrapped_user_samples),
        set_view_samples: std::mem::take(&mut state.set_view_samples),
        voice_data_samples: std::mem::take(&mut state.voice_samples),
        reset_hud_samples: std::mem::take(&mut state.reset_hud_samples),
        stop_spectator_mode_samples: std::mem::take(&mut state.stop_spectator_samples),
        kill_cam_ticks: std::mem::take(&mut state.kill_cam_ticks),
        decode_failures: std::mem::take(&mut state.decode_failures),
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
        "outer_types={} packet_types={} wrapped_user_types={}",
        report.outer_message_types.len(),
        report.packet_message_types.len(),
        report.wrapped_user_message_types.len()
    );
    println!(
        "set_view_samples={} voice_samples={} reset_hud={} stop_spectator={} kill_cam_ticks={}",
        report.set_view_samples.len(),
        report.voice_data_samples.len(),
        report.reset_hud_samples.len(),
        report.stop_spectator_mode_samples.len(),
        report.kill_cam_ticks.len()
    );
    println!("decode_failures={}", report.decode_failures.len());
    Ok(())
}

fn describe_packet_message_type(msg_type: i32) -> String {
    if let Ok(message) = ECstrike15UserMessages::try_from(msg_type) {
        format!("CS2User::{message:?}")
    } else if let Ok(message) = ECsgoGameEvents::try_from(msg_type) {
        format!("CS2GameEvent::{message:?}")
    } else if let Ok(message) = SvcMessages::try_from(msg_type) {
        format!("Svc::{message:?}")
    } else if let Ok(message) = EBaseUserMessages::try_from(msg_type) {
        format!("BaseUser::{message:?}")
    } else if let Ok(message) = EBaseGameEvents::try_from(msg_type) {
        format!("BaseGameEvent::{message:?}")
    } else if let Ok(message) = NetMessages::try_from(msg_type) {
        format!("Net::{message:?}")
    } else {
        "Unknown".to_owned()
    }
}

fn describe_user_message_type(msg_type: i32) -> String {
    if let Ok(message) = ECstrike15UserMessages::try_from(msg_type) {
        format!("CS2User::{message:?}")
    } else if let Ok(message) = EBaseUserMessages::try_from(msg_type) {
        format!("BaseUser::{message:?}")
    } else {
        "UnknownUserMessage".to_owned()
    }
}

fn hex_prefix(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

