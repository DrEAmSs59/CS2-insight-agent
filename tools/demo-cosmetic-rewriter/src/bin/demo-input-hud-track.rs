use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use prost::Message;
use serde::Serialize;
use source2_demo::prelude::*;
use source2_demo::proto::{CMsgServerUserCmd, CSvcMsgUserCommands};
use source2_demo::writer::{DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufReader, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::Instant;

const WORKER_STACK_SIZE: usize = 64 * 1024 * 1024;

// The compact Panorama mask is intentionally stable and independent of Valve's
// sparse bit positions: W A S D, jump, crouch, walk, reload, fire, scope.
const INPUT_BITS: [u32; 10] = [3, 9, 4, 10, 1, 2, 17, 13, 0, 11];

#[derive(Debug, ClapParser)]
#[command(name = "demo-input-hud-track")]
#[command(about = "Extract exact svc_UserCmd button transitions for a Panorama input HUD")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Message)]
struct ButtonsPb {
    #[prost(uint64, optional, tag = "1")]
    buttonstate1: Option<u64>,
    #[prost(uint64, optional, tag = "2")]
    buttonstate2: Option<u64>,
    #[prost(uint64, optional, tag = "3")]
    buttonstate3: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Message)]
struct SubtickMovePb {
    #[prost(uint64, optional, tag = "1")]
    button: Option<u64>,
    #[prost(bool, optional, tag = "2")]
    pressed: Option<bool>,
    #[prost(float, optional, tag = "3")]
    when: Option<f32>,
    #[prost(float, optional, tag = "4")]
    analog_forward_delta: Option<f32>,
    #[prost(float, optional, tag = "5")]
    analog_left_delta: Option<f32>,
    #[prost(float, optional, tag = "8")]
    pitch_delta: Option<f32>,
    #[prost(float, optional, tag = "9")]
    yaw_delta: Option<f32>,
}

#[derive(Clone, PartialEq, Message)]
struct FullBaseUserCmdPb {
    #[prost(message, optional, tag = "3")]
    buttons_pb: Option<ButtonsPb>,
    #[prost(message, repeated, tag = "18")]
    subtick_moves: Vec<SubtickMovePb>,
}

#[derive(Clone, PartialEq, Message)]
struct FullCsgoUserCmdPb {
    #[prost(message, optional, tag = "1")]
    base: Option<FullBaseUserCmdPb>,
}

// July 2026 CS2 demos encode delta commands with a protobuf-compatible outer
// shape and codegen-delta reset markers inside it. Repeated subtick children
// remain opaque until decoded separately below.
#[derive(Clone, PartialEq, Message)]
struct DeltaBaseUserCmdPb {
    #[prost(message, optional, tag = "3")]
    buttons_pb: Option<ButtonsPb>,
    #[prost(bytes = "vec", repeated, tag = "18")]
    subtick_moves_delta: Vec<Vec<u8>>,
}

#[derive(Clone, PartialEq, Message)]
struct DeltaCsgoUserCmdPb {
    #[prost(message, optional, tag = "1")]
    base: Option<DeltaBaseUserCmdPb>,
}

#[derive(Clone, Copy)]
enum DeltaSchema {
    CsgoUserCmd,
    BaseUserCmd,
    Buttons,
    SubtickMove,
}

impl DeltaSchema {
    fn field_wire_type(self, field: u64) -> Option<u8> {
        match self {
            Self::CsgoUserCmd => match field {
                1 | 2 => Some(2),
                6 | 7 | 9 | 11 | 12 | 13 => Some(0),
                _ => None,
            },
            Self::BaseUserCmd => match field {
                1 | 2 | 8 | 9 | 10 | 11 | 12 | 14 | 17 | 20 | 21 => Some(0),
                3 | 4 | 18 | 19 | 22 => Some(2),
                5 | 6 | 7 => Some(5),
                _ => None,
            },
            Self::Buttons => match field {
                1..=3 => Some(0),
                _ => None,
            },
            Self::SubtickMove => match field {
                1 | 2 => Some(0),
                3 | 4 | 5 | 8 | 9 => Some(5),
                _ => None,
            },
        }
    }

    fn child(self, field: u64) -> Option<Self> {
        match (self, field) {
            (Self::CsgoUserCmd, 1) => Some(Self::BaseUserCmd),
            (Self::BaseUserCmd, 3) => Some(Self::Buttons),
            _ => None,
        }
    }

    fn explicit_defaults(self) -> Vec<u8> {
        let fields: &[(u64, u8)] = match self {
            Self::Buttons => &[(1, 0), (2, 0), (3, 0)],
            Self::BaseUserCmd => &[
                (3, 2),
                (4, 2),
                (5, 5),
                (6, 5),
                (7, 5),
                (8, 0),
                (9, 0),
                (11, 0),
                (12, 0),
                (20, 0),
            ],
            Self::CsgoUserCmd => &[(1, 2), (9, 0)],
            Self::SubtickMove => &[(1, 0), (2, 0), (3, 5), (4, 5), (5, 5), (8, 5), (9, 5)],
        };
        let mut out = Vec::new();
        for &(field, wire_type) in fields {
            write_varint((field << 3) | u64::from(wire_type), &mut out);
            match wire_type {
                0 => out.push(0),
                2 => {
                    let nested = self
                        .child(field)
                        .map(Self::explicit_defaults)
                        .unwrap_or_default();
                    write_varint(nested.len() as u64, &mut out);
                    out.extend_from_slice(&nested);
                }
                5 => out.extend_from_slice(&[0; 4]),
                _ => unreachable!(),
            }
        }
        out
    }
}

fn read_varint(bytes: &mut &[u8]) -> Option<u64> {
    let mut value = 0_u64;
    for shift in (0..70).step_by(7) {
        let (&byte, rest) = bytes.split_first()?;
        *bytes = rest;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn write_varint(mut value: u64, out: &mut Vec<u8>) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn sanitize_delta_message(mut bytes: &[u8], schema: DeltaSchema) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len());
    while !bytes.is_empty() {
        let key = read_varint(&mut bytes)?;
        let field = key >> 3;
        let wire_type = (key & 7) as u8;
        if field == 0 {
            return None;
        }
        if wire_type == 7 {
            let normal = schema.field_wire_type(field)?;
            write_varint((field << 3) | u64::from(normal), &mut out);
            match normal {
                0 => out.push(0),
                1 => out.extend_from_slice(&[0; 8]),
                2 => {
                    let nested = schema
                        .child(field)
                        .map(DeltaSchema::explicit_defaults)
                        .unwrap_or_default();
                    write_varint(nested.len() as u64, &mut out);
                    out.extend_from_slice(&nested);
                }
                5 => out.extend_from_slice(&[0; 4]),
                _ => return None,
            }
            continue;
        }
        write_varint(key, &mut out);
        match wire_type {
            0 => write_varint(read_varint(&mut bytes)?, &mut out),
            1 => {
                let value = bytes.get(..8)?;
                out.extend_from_slice(value);
                bytes = bytes.get(8..)?;
            }
            2 => {
                let length = usize::try_from(read_varint(&mut bytes)?).ok()?;
                let value = bytes.get(..length)?;
                let value = if let Some(child) = schema.child(field) {
                    sanitize_delta_message(value, child)?
                } else {
                    value.to_vec()
                };
                write_varint(value.len() as u64, &mut out);
                out.extend_from_slice(&value);
                bytes = bytes.get(length..)?;
            }
            5 => {
                let value = bytes.get(..4)?;
                out.extend_from_slice(value);
                bytes = bytes.get(4..)?;
            }
            _ => return None,
        }
    }
    Some(out)
}

fn decode_delta_repeated<M>(payloads: &[Vec<u8>], schema: DeltaSchema) -> Option<Vec<M>>
where
    M: Message + Default,
{
    let mut messages = Vec::new();
    for payload in payloads {
        let mut bytes = payload.as_slice();
        if bytes.first() == Some(&0x0f) {
            bytes = &bytes[1..];
        }
        while !bytes.is_empty() {
            let key = read_varint(&mut bytes)?;
            if key & 7 != 2 {
                return None;
            }
            let index = usize::try_from(key >> 3).ok()?;
            if index != messages.len() {
                return None;
            }
            let length = usize::try_from(read_varint(&mut bytes)?).ok()?;
            let value = bytes.get(..length)?;
            let sanitized = sanitize_delta_message(value, schema)?;
            messages.push(M::decode(sanitized.as_slice()).ok()?);
            bytes = bytes.get(length..)?;
        }
    }
    Some(messages)
}

#[derive(Default)]
struct SlotState {
    held: u64,
    pulse: u64,
    seen: bool,
    changes: Vec<(u32, u16)>,
}

impl SlotState {
    fn apply_full_buttons(&mut self, buttons: ButtonsPb) {
        self.held = buttons.buttonstate1.unwrap_or_default();
        self.pulse |= buttons.buttonstate2.unwrap_or_default();
        self.seen = true;
    }

    fn apply_delta_buttons(&mut self, buttons: ButtonsPb) {
        if let Some(value) = buttons.buttonstate1 {
            self.held = value;
        }
        if let Some(value) = buttons.buttonstate2 {
            self.pulse |= value;
        }
        self.seen = true;
    }

    fn apply_subticks(&mut self, moves: impl IntoIterator<Item = SubtickMovePb>) -> usize {
        let mut count = 0;
        for movement in moves {
            let Some(button) = movement.button else {
                continue;
            };
            count += 1;
            if movement.pressed.unwrap_or_default() {
                self.held |= button;
                self.pulse |= button;
            } else {
                self.held &= !button;
            }
            self.seen = true;
        }
        count
    }

    fn compact_mask(&self) -> u16 {
        let raw = self.held | self.pulse;
        INPUT_BITS
            .iter()
            .enumerate()
            .fold(0_u16, |mask, (output_bit, input_bit)| {
                mask | (u16::from(raw & (1_u64 << input_bit) != 0) << output_bit)
            })
    }

    fn flush(&mut self, tick: u32) {
        if !self.seen {
            self.pulse = 0;
            return;
        }
        let mask = self.compact_mask();
        if self.changes.last().is_some_and(|change| change.1 == mask) {
            self.pulse = 0;
            return;
        }
        self.changes.push((tick, mask));
        self.pulse = 0;
    }
}

#[derive(Default)]
struct InputTrackExtractor {
    current_tick: Option<u32>,
    slots: BTreeMap<i32, SlotState>,
    svc_messages: usize,
    commands: usize,
    full_commands: usize,
    delta_commands: usize,
    button_updates: usize,
    subtick_steps: usize,
    malformed_commands: usize,
}

impl InputTrackExtractor {
    fn begin_tick(&mut self, tick: u32) {
        if self.current_tick == Some(tick) {
            return;
        }
        if let Some(previous) = self.current_tick {
            for state in self.slots.values_mut() {
                state.flush(previous);
            }
        }
        self.current_tick = Some(tick);
    }

    fn finish(&mut self) {
        if let Some(tick) = self.current_tick.take() {
            for state in self.slots.values_mut() {
                state.flush(tick);
            }
        }
    }

    fn record_command(&mut self, command: &CMsgServerUserCmd) {
        self.commands += 1;
        let slot = command.player_slot.unwrap_or(-1);
        if slot < 0 {
            self.malformed_commands += 1;
            return;
        }
        let state = self.slots.entry(slot).or_default();
        if let Some(data) = command.data.as_deref().filter(|data| !data.is_empty()) {
            self.full_commands += 1;
            let Ok(user_cmd) = FullCsgoUserCmdPb::decode(data) else {
                self.malformed_commands += 1;
                return;
            };
            if let Some(base) = user_cmd.base {
                if let Some(buttons) = base.buttons_pb {
                    state.apply_full_buttons(buttons);
                    self.button_updates += 1;
                }
                self.subtick_steps += state.apply_subticks(base.subtick_moves);
            }
            return;
        }
        if let Some(data) = command
            .delta_data
            .as_deref()
            .filter(|data| !data.is_empty())
        {
            self.delta_commands += 1;
            let Some(sanitized) = sanitize_delta_message(data, DeltaSchema::CsgoUserCmd) else {
                self.malformed_commands += 1;
                return;
            };
            let Ok(user_cmd) = DeltaCsgoUserCmdPb::decode(sanitized.as_slice()) else {
                self.malformed_commands += 1;
                return;
            };
            if let Some(base) = user_cmd.base {
                if let Some(buttons) = base.buttons_pb {
                    state.apply_delta_buttons(buttons);
                    self.button_updates += 1;
                }
                match decode_delta_repeated::<SubtickMovePb>(
                    &base.subtick_moves_delta,
                    DeltaSchema::SubtickMove,
                ) {
                    Some(moves) => self.subtick_steps += state.apply_subticks(moves),
                    None if !base.subtick_moves_delta.is_empty() => self.malformed_commands += 1,
                    None => {}
                }
            }
            return;
        }
        self.malformed_commands += 1;
    }
}

impl DemoRewriter for InputTrackExtractor {
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
        if msg_type != SvcMessages::SvcUserCmds as i32 {
            return Ok(MessageRewrite::Keep);
        }
        self.begin_tick(tick);
        let message = CSvcMsgUserCommands::decode(payload)?;
        self.svc_messages += 1;
        for command in &message.commands {
            self.record_command(command);
        }
        Ok(MessageRewrite::Keep)
    }
}

#[derive(Serialize)]
struct EncodedTrack {
    slot: i32,
    changes: usize,
    encoded: String,
}

#[derive(Serialize)]
struct InputTrackReport {
    format_version: u32,
    source_demo: String,
    source_bytes: u64,
    elapsed_seconds: f64,
    svc_usercmd_messages: usize,
    commands: usize,
    full_commands: usize,
    delta_commands: usize,
    button_updates: usize,
    subtick_steps: usize,
    malformed_commands: usize,
    tracks: Vec<EncodedTrack>,
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
                "invalid seek",
            ));
        }
        self.position = next as u64;
        Ok(self.position)
    }
}

fn base36(mut value: u32) -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut reversed = Vec::new();
    while value > 0 {
        reversed.push(ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    reversed.reverse();
    String::from_utf8(reversed).expect("base36 is ASCII")
}

fn encode_changes(changes: &[(u32, u16)]) -> String {
    let mut previous_tick = 0_u32;
    changes
        .iter()
        .map(|&(tick, mask)| {
            let encoded = format!(
                "{}.{}",
                base36(tick.saturating_sub(previous_tick)),
                base36(mask.into())
            );
            previous_tick = tick;
            encoded
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-input-track-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn input-track worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("input-track worker panicked"))?
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
    let state = writer.add_rewriter(InputTrackExtractor::default());
    writer.run()?;
    drop(writer);

    let mut state = state.borrow_mut();
    state.finish();
    let tracks = state
        .slots
        .iter()
        .filter(|(_, slot)| slot.seen && !slot.changes.is_empty())
        .map(|(&slot, state)| EncodedTrack {
            slot,
            changes: state.changes.len(),
            encoded: encode_changes(&state.changes),
        })
        .collect::<Vec<_>>();
    if tracks.is_empty() || state.button_updates == 0 {
        bail!("demo contains no decodable svc_UserCmd button track");
    }
    let report = InputTrackReport {
        format_version: 1,
        source_demo: cli.input.display().to_string(),
        source_bytes: metadata.len(),
        elapsed_seconds: started.elapsed().as_secs_f64(),
        svc_usercmd_messages: state.svc_messages,
        commands: state.commands,
        full_commands: state.full_commands,
        delta_commands: state.delta_commands,
        button_updates: state.button_updates,
        subtick_steps: state.subtick_steps,
        malformed_commands: state.malformed_commands,
        tracks,
    };
    drop(state);

    if let Some(parent) = cli
        .output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
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
        "commands={} button_updates={} subtick_steps={}",
        report.commands, report.button_updates, report.subtick_steps
    );
    println!(
        "tracks={} changes={} encoded_bytes={}",
        report.tracks.len(),
        report
            .tracks
            .iter()
            .map(|track| track.changes)
            .sum::<usize>(),
        report
            .tracks
            .iter()
            .map(|track| track.encoded.len())
            .sum::<usize>()
    );
    Ok(())
}
