//! Authoritative CS2 input extraction from the demo `svc_UserCmds` stream.
//!
//! The three `CInButtonStatePB` values are bit planes of `EInButtonState`, not
//! three interchangeable button masks. For one input bit, the assembled value
//! describes the complete transition sequence in a command: 0 UP, 1 DOWN,
//! 2 DOWN_UP, 3 UP_DOWN, 4 UP_DOWN_UP, 5 DOWN_UP_DOWN,
//! 6 DOWN_UP_DOWN_UP, 7 UP_DOWN_UP_DOWN.

use anyhow::{bail, Context as AnyhowContext, Result};
use prost::Message;
use serde::Serialize;
use source2_demo::prelude::*;
use source2_demo::proto::{CMsgPlayerInfo, CMsgServerUserCmd, CSvcMsgUserCommands};
use source2_demo::writer::{
    DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests, StringTableEntryUpdate,
};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Instant;

/// Panorama output order: W A S D, jump, crouch, walk, reload, fire, scope.
pub const HUD_INPUT_BITS: [u32; 10] = [3, 9, 4, 10, 1, 2, 16, 13, 0, 11];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct KnownButton {
    pub name: &'static str,
    pub bit: u32,
    pub mask_hex: &'static str,
    pub common_binding: &'static str,
}

/// `common_binding` is UI context only; DEM stores masks, not personal binds.
pub const KNOWN_BUTTONS: [KnownButton; 18] = [
    KnownButton {
        name: "IN_ATTACK",
        bit: 0,
        mask_hex: "0x0000000000000001",
        common_binding: "MOUSE1",
    },
    KnownButton {
        name: "IN_JUMP",
        bit: 1,
        mask_hex: "0x0000000000000002",
        common_binding: "SPACE",
    },
    KnownButton {
        name: "IN_DUCK",
        bit: 2,
        mask_hex: "0x0000000000000004",
        common_binding: "CTRL",
    },
    KnownButton {
        name: "IN_FORWARD",
        bit: 3,
        mask_hex: "0x0000000000000008",
        common_binding: "W",
    },
    KnownButton {
        name: "IN_BACK",
        bit: 4,
        mask_hex: "0x0000000000000010",
        common_binding: "S",
    },
    KnownButton {
        name: "IN_USE",
        bit: 5,
        mask_hex: "0x0000000000000020",
        common_binding: "E",
    },
    KnownButton {
        name: "IN_TURNLEFT",
        bit: 7,
        mask_hex: "0x0000000000000080",
        common_binding: "",
    },
    KnownButton {
        name: "IN_TURNRIGHT",
        bit: 8,
        mask_hex: "0x0000000000000100",
        common_binding: "",
    },
    KnownButton {
        name: "IN_MOVELEFT",
        bit: 9,
        mask_hex: "0x0000000000000200",
        common_binding: "A",
    },
    KnownButton {
        name: "IN_MOVERIGHT",
        bit: 10,
        mask_hex: "0x0000000000000400",
        common_binding: "D",
    },
    KnownButton {
        name: "IN_ATTACK2",
        bit: 11,
        mask_hex: "0x0000000000000800",
        common_binding: "MOUSE2",
    },
    KnownButton {
        name: "IN_RELOAD",
        bit: 13,
        mask_hex: "0x0000000000002000",
        common_binding: "R",
    },
    KnownButton {
        name: "IN_SPEED",
        bit: 16,
        mask_hex: "0x0000000000010000",
        common_binding: "SHIFT",
    },
    KnownButton {
        name: "IN_JOYAUTOSPRINT",
        bit: 17,
        mask_hex: "0x0000000000020000",
        common_binding: "",
    },
    KnownButton {
        name: "IN_USEORRELOAD",
        bit: 32,
        mask_hex: "0x0000000100000000",
        common_binding: "",
    },
    KnownButton {
        name: "IN_SCORE",
        bit: 33,
        mask_hex: "0x0000000200000000",
        common_binding: "TAB",
    },
    KnownButton {
        name: "IN_ZOOM",
        bit: 34,
        mask_hex: "0x0000000400000000",
        common_binding: "",
    },
    KnownButton {
        name: "IN_LOOK_AT_WEAPON",
        bit: 35,
        mask_hex: "0x0000000800000000",
        common_binding: "F",
    },
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ButtonStatePlanes {
    pub buttonstate1: u64,
    pub buttonstate2: u64,
    pub buttonstate3: u64,
}

impl ButtonStatePlanes {
    pub fn state_code(self, bit: u32) -> u8 {
        let mask = 1_u64 << bit;
        u8::from(self.buttonstate1 & mask != 0)
            | (u8::from(self.buttonstate2 & mask != 0) << 1)
            | (u8::from(self.buttonstate3 & mask != 0) << 2)
    }

    pub fn held_mask(self) -> u64 {
        self.buttonstate1
    }

    pub fn rising_mask(self) -> u64 {
        self.buttonstate3 | (self.buttonstate1 & self.buttonstate2)
    }

    pub fn falling_mask(self) -> u64 {
        self.buttonstate3 | (!self.buttonstate1 & self.buttonstate2)
    }

    pub fn changed_mask(self) -> u64 {
        self.buttonstate2 | self.buttonstate3
    }

    pub fn active_or_pressed_mask(self) -> u64 {
        self.held_mask() | self.rising_mask()
    }
}

pub fn button_state_name(code: u8) -> &'static str {
    match code {
        0 => "UP",
        1 => "DOWN",
        2 => "DOWN_UP",
        3 => "UP_DOWN",
        4 => "UP_DOWN_UP",
        5 => "DOWN_UP_DOWN",
        6 => "DOWN_UP_DOWN_UP",
        7 => "UP_DOWN_UP_DOWN",
        _ => unreachable!("button state code is three bits"),
    }
}

pub fn compact_hud_mask(raw: u64) -> u16 {
    HUD_INPUT_BITS
        .iter()
        .enumerate()
        .fold(0_u16, |mask, (output_bit, input_bit)| {
            mask | (u16::from(raw & (1_u64 << input_bit) != 0) << output_bit)
        })
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
                5..=7 => Some(5),
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
                out.extend_from_slice(bytes.get(..8)?);
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
                out.extend_from_slice(bytes.get(..4)?);
                bytes = bytes.get(4..)?;
            }
            _ => return None,
        }
    }
    Some(out)
}

impl SubtickMovePb {
    fn apply_delta(&mut self, delta: Self) {
        if delta.button.is_some() {
            self.button = delta.button;
        }
        if delta.pressed.is_some() {
            self.pressed = delta.pressed;
        }
        if delta.when.is_some() {
            self.when = delta.when;
        }
        if delta.analog_forward_delta.is_some() {
            self.analog_forward_delta = delta.analog_forward_delta;
        }
        if delta.analog_left_delta.is_some() {
            self.analog_left_delta = delta.analog_left_delta;
        }
        if delta.pitch_delta.is_some() {
            self.pitch_delta = delta.pitch_delta;
        }
        if delta.yaw_delta.is_some() {
            self.yaw_delta = delta.yaw_delta;
        }
    }
}

struct DecodedSubtickDelta {
    state: Vec<SubtickMovePb>,
    updates: Vec<SubtickMovePb>,
}

/// Reconstruct the stateful codegen-delta list while returning only elements
/// updated by this command.  A leading wire-type 7 key carries the target list
/// length in its field-number bits; following length-delimited fields use their
/// field number as a zero-based element index and may be sparse.  Unmentioned
/// elements remain part of the decoder baseline, but are not new input edges.
fn decode_delta_subticks(
    payloads: &[Vec<u8>],
    previous: &[SubtickMovePb],
) -> Option<DecodedSubtickDelta> {
    let mut messages = previous.to_vec();
    let mut updated_indexes = Vec::new();
    let mut declared_count = None;
    for payload in payloads {
        let mut bytes = payload.as_slice();
        if !bytes.is_empty() {
            let mut after_marker = bytes;
            let marker = read_varint(&mut after_marker)?;
            if marker & 7 == 7 {
                if declared_count.is_some() {
                    return None;
                }
                let count = usize::try_from(marker >> 3).ok()?;
                messages.resize(count, SubtickMovePb::default());
                declared_count = Some(count);
                bytes = after_marker;
            }
        }
        while !bytes.is_empty() {
            let key = read_varint(&mut bytes)?;
            if key & 7 != 2 {
                return None;
            }
            let index = usize::try_from(key >> 3).ok()?;
            let length = usize::try_from(read_varint(&mut bytes)?).ok()?;
            let value = bytes.get(..length)?;
            let sanitized = sanitize_delta_message(value, DeltaSchema::SubtickMove)?;
            let delta = SubtickMovePb::decode(sanitized.as_slice()).ok()?;
            messages.get_mut(index)?.apply_delta(delta);
            if !updated_indexes.contains(&index) {
                updated_indexes.push(index);
            }
            bytes = bytes.get(length..)?;
        }
    }
    if declared_count.is_some_and(|count| count != messages.len()) {
        return None;
    }
    let updates = updated_indexes
        .into_iter()
        .map(|index| messages[index])
        .collect();
    Some(DecodedSubtickDelta {
        state: messages,
        updates,
    })
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ObservedBitStats {
    pub bit: u32,
    pub name: String,
    pub common_binding: String,
    pub state_code_counts: [usize; 8],
    pub rising_commands: usize,
    pub falling_commands: usize,
    pub subtick_pressed: usize,
    pub subtick_released: usize,
    pub subtick_pressed_missing: usize,
}

impl ObservedBitStats {
    fn new(bit: u32) -> Self {
        let known = KNOWN_BUTTONS.iter().find(|button| button.bit == bit);
        Self {
            bit,
            name: known
                .map(|button| button.name)
                .unwrap_or("UNKNOWN")
                .to_owned(),
            common_binding: known
                .map(|button| button.common_binding)
                .unwrap_or("")
                .to_owned(),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RawButtonUpdateEvidence {
    pub buttonstate1_hex: Option<String>,
    pub buttonstate2_hex: Option<String>,
    pub buttonstate3_hex: Option<String>,
}

impl From<ButtonsPb> for RawButtonUpdateEvidence {
    fn from(buttons: ButtonsPb) -> Self {
        Self {
            buttonstate1_hex: buttons.buttonstate1.map(mask_hex),
            buttonstate2_hex: buttons.buttonstate2.map(mask_hex),
            buttonstate3_hex: buttons.buttonstate3.map(mask_hex),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RawSubtickEvidence {
    pub button_mask_hex: Option<String>,
    pub pressed: Option<bool>,
    pub when: Option<f32>,
    pub analog_forward_delta: Option<f32>,
    pub analog_left_delta: Option<f32>,
    pub pitch_delta: Option<f32>,
    pub yaw_delta: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RawCommandEvidence {
    pub demo_tick: u32,
    pub player_slot: i32,
    pub command_index: usize,
    pub cmd_number: i32,
    pub server_tick_executed: Option<i32>,
    pub client_tick: Option<i32>,
    pub encoding: &'static str,
    pub raw_button_update: Option<RawButtonUpdateEvidence>,
    pub buttonstate1_hex: String,
    pub buttonstate2_hex: String,
    pub buttonstate3_hex: String,
    pub rising_mask_hex: String,
    pub falling_mask_hex: String,
    pub raw_subtick_delta_payloads_hex: Vec<String>,
    pub subtick_updates: Vec<RawSubtickEvidence>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlayerIdentityUpdate {
    pub demo_tick: u32,
    pub player_slot: i32,
    pub xuid: u64,
    pub steamid: u64,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SubtickDecodeErrorSample {
    pub demo_tick: u32,
    pub player_slot: i32,
    pub payloads_hex: Vec<String>,
}

fn hex_sample(bytes: &[u8]) -> String {
    const MAX_BYTES: usize = 128;
    let mut value = hex_bytes(&bytes[..bytes.len().min(MAX_BYTES)]);
    if bytes.len() > MAX_BYTES {
        value.push_str("...");
    }
    value
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Default)]
struct SlotState {
    planes: ButtonStatePlanes,
    has_button_data: bool,
    tick_pressed: u64,
    tick_subtick_pressed: u64,
    seen: bool,
    commands: usize,
    button_updates: usize,
    subticks: Vec<SubtickMovePb>,
    changes: Vec<(u32, u16)>,
}

impl SlotState {
    fn apply_full_buttons(&mut self, buttons: Option<ButtonsPb>) -> bool {
        let has_buttons = buttons.is_some();
        self.planes =
            buttons.map_or_else(ButtonStatePlanes::default, |buttons| ButtonStatePlanes {
                buttonstate1: buttons.buttonstate1.unwrap_or_default(),
                buttonstate2: buttons.buttonstate2.unwrap_or_default(),
                buttonstate3: buttons.buttonstate3.unwrap_or_default(),
            });
        self.has_button_data = has_buttons;
        has_buttons
    }

    fn apply_delta_buttons(&mut self, buttons: Option<ButtonsPb>) -> bool {
        let Some(buttons) = buttons else {
            return false;
        };
        if let Some(value) = buttons.buttonstate1 {
            self.planes.buttonstate1 = value;
        }
        if let Some(value) = buttons.buttonstate2 {
            self.planes.buttonstate2 = value;
        }
        if let Some(value) = buttons.buttonstate3 {
            self.planes.buttonstate3 = value;
        }
        self.has_button_data = true;
        true
    }

    fn observe_command(&mut self) {
        self.commands += 1;
        self.seen |= self.has_button_data;
        self.tick_pressed |= self.planes.rising_mask();
    }

    fn flush(&mut self, tick: u32) {
        if !self.seen {
            self.tick_pressed = 0;
            self.tick_subtick_pressed = 0;
            return;
        }
        let visible = self.planes.held_mask() | self.tick_pressed | self.tick_subtick_pressed;
        let mask = compact_hud_mask(visible);
        if !self.changes.last().is_some_and(|change| change.1 == mask) {
            self.changes.push((tick, mask));
        }
        self.tick_pressed = 0;
        self.tick_subtick_pressed = 0;
    }
}

#[derive(Default)]
pub struct InputCommandExtractor {
    include_evidence: bool,
    current_tick: Option<u32>,
    slots: BTreeMap<i32, SlotState>,
    observed_bits: BTreeMap<u32, ObservedBitStats>,
    evidence: Vec<RawCommandEvidence>,
    identity_updates: Vec<PlayerIdentityUpdate>,
    last_identity_by_slot: BTreeMap<i32, (u64, u64, String)>,
    svc_messages: usize,
    commands: usize,
    full_commands: usize,
    delta_commands: usize,
    empty_commands: usize,
    button_updates: usize,
    subtick_steps: usize,
    subtick_button_steps: usize,
    subtick_without_button: usize,
    subtick_pressed_missing: usize,
    subtick_when_missing: usize,
    subtick_when_non_finite: usize,
    subtick_when_below_zero: usize,
    subtick_when_above_one: usize,
    subtick_when_min: Option<f32>,
    subtick_when_max: Option<f32>,
    subtick_when_out_of_order: usize,
    commands_without_player_slot: usize,
    full_decode_errors: usize,
    delta_sanitize_errors: usize,
    delta_decode_errors: usize,
    subtick_decode_errors: usize,
    subtick_decode_error_samples: Vec<SubtickDecodeErrorSample>,
    observed_mask: u64,
}

impl InputCommandExtractor {
    pub fn new(include_evidence: bool) -> Self {
        Self {
            include_evidence,
            ..Self::default()
        }
    }

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

    fn record_userinfo(&mut self, tick: u32, entry: &StringTableEntryUpdate) {
        let Some(value) = entry.value() else {
            return;
        };
        let Ok(player) = CMsgPlayerInfo::decode(value) else {
            return;
        };
        let slot = entry.index();
        let xuid = player.xuid.unwrap_or_default();
        let steamid = player.steamid.unwrap_or_default();
        let name = player.name.unwrap_or_default();
        let identity = (xuid, steamid, name.clone());
        if self.last_identity_by_slot.get(&slot) == Some(&identity) {
            return;
        }
        self.last_identity_by_slot.insert(slot, identity);
        self.identity_updates.push(PlayerIdentityUpdate {
            demo_tick: if tick == u32::MAX { 0 } else { tick },
            player_slot: slot,
            xuid,
            steamid,
            name,
        });
    }

    fn finish(&mut self) {
        if let Some(tick) = self.current_tick.take() {
            for state in self.slots.values_mut() {
                state.flush(tick);
            }
        }
    }

    fn observe_planes(&mut self, planes: ButtonStatePlanes) {
        self.observed_mask |= planes.buttonstate1 | planes.buttonstate2 | planes.buttonstate3;
        let mask = planes.buttonstate1 | planes.buttonstate2 | planes.buttonstate3;
        for bit in bits(mask) {
            let code = planes.state_code(bit);
            let stats = self
                .observed_bits
                .entry(bit)
                .or_insert_with(|| ObservedBitStats::new(bit));
            stats.state_code_counts[usize::from(code)] += 1;
            stats.rising_commands += usize::from(planes.rising_mask() & (1_u64 << bit) != 0);
            stats.falling_commands += usize::from(planes.falling_mask() & (1_u64 << bit) != 0);
        }
    }

    fn observe_subticks(&mut self, slot: i32, moves: &[SubtickMovePb]) -> Vec<RawSubtickEvidence> {
        let mut raw = Vec::with_capacity(moves.len());
        let mut previous_when = None;
        for movement in moves {
            self.subtick_steps += 1;
            match movement.when {
                Some(when) if when.is_finite() => {
                    self.subtick_when_min = Some(
                        self.subtick_when_min
                            .map_or(when, |current| current.min(when)),
                    );
                    self.subtick_when_max = Some(
                        self.subtick_when_max
                            .map_or(when, |current| current.max(when)),
                    );
                    self.subtick_when_below_zero += usize::from(when < 0.0);
                    self.subtick_when_above_one += usize::from(when > 1.0);
                    if previous_when.is_some_and(|previous| when < previous) {
                        self.subtick_when_out_of_order += 1;
                    }
                    previous_when = Some(when);
                }
                Some(_) => self.subtick_when_non_finite += 1,
                None => self.subtick_when_missing += 1,
            }

            if let Some(button) = movement.button {
                self.subtick_button_steps += 1;
                self.observed_mask |= button;
                if movement.pressed == Some(true) {
                    if let Some(state) = self.slots.get_mut(&slot) {
                        state.tick_subtick_pressed |= button;
                    }
                }
                for bit in bits(button) {
                    let stats = self
                        .observed_bits
                        .entry(bit)
                        .or_insert_with(|| ObservedBitStats::new(bit));
                    match movement.pressed {
                        Some(true) => stats.subtick_pressed += 1,
                        Some(false) => stats.subtick_released += 1,
                        None => stats.subtick_pressed_missing += 1,
                    }
                }
            } else {
                self.subtick_without_button += 1;
            }
            if movement.pressed.is_none() {
                self.subtick_pressed_missing += 1;
            }

            if self.include_evidence {
                raw.push(RawSubtickEvidence {
                    button_mask_hex: movement.button.map(mask_hex),
                    pressed: movement.pressed,
                    when: movement.when,
                    analog_forward_delta: movement.analog_forward_delta,
                    analog_left_delta: movement.analog_left_delta,
                    pitch_delta: movement.pitch_delta,
                    yaw_delta: movement.yaw_delta,
                });
            }
        }
        raw
    }

    #[allow(clippy::too_many_arguments)]
    fn record_decoded_command(
        &mut self,
        demo_tick: u32,
        command_index: usize,
        command: &CMsgServerUserCmd,
        encoding: &'static str,
        buttons: Option<ButtonsPb>,
        subtick_state: Vec<SubtickMovePb>,
        subtick_updates: Vec<SubtickMovePb>,
        raw_subtick_delta_payloads_hex: Vec<String>,
        full: bool,
    ) {
        let slot = command.player_slot.unwrap_or(-1);
        if slot < 0 {
            self.commands_without_player_slot += 1;
            return;
        }
        let raw_button_update = buttons.map(RawButtonUpdateEvidence::from);
        let button_update = {
            let state = self.slots.entry(slot).or_default();
            let updated = if full {
                state.apply_full_buttons(buttons)
            } else {
                state.apply_delta_buttons(buttons)
            };
            if updated {
                state.button_updates += 1;
            }
            state.observe_command();
            state.subticks = subtick_state;
            updated
        };
        if button_update {
            self.button_updates += 1;
        }
        let planes = self.slots[&slot].planes;
        if self.slots[&slot].has_button_data {
            self.observe_planes(planes);
        }
        let raw_subticks = self.observe_subticks(slot, &subtick_updates);
        if self.include_evidence
            && (button_update
                || !subtick_updates.is_empty()
                || !raw_subtick_delta_payloads_hex.is_empty())
        {
            self.evidence.push(RawCommandEvidence {
                demo_tick,
                player_slot: slot,
                command_index,
                cmd_number: command.cmd_number.unwrap_or_default(),
                server_tick_executed: command.server_tick_executed,
                client_tick: command.client_tick,
                encoding,
                raw_button_update,
                buttonstate1_hex: mask_hex(planes.buttonstate1),
                buttonstate2_hex: mask_hex(planes.buttonstate2),
                buttonstate3_hex: mask_hex(planes.buttonstate3),
                rising_mask_hex: mask_hex(planes.rising_mask()),
                falling_mask_hex: mask_hex(planes.falling_mask()),
                raw_subtick_delta_payloads_hex,
                subtick_updates: raw_subticks,
            });
        }
    }

    fn record_command(&mut self, demo_tick: u32, index: usize, command: &CMsgServerUserCmd) {
        self.commands += 1;
        if let Some(data) = command.data.as_deref().filter(|data| !data.is_empty()) {
            self.full_commands += 1;
            let Ok(user_cmd) = FullCsgoUserCmdPb::decode(data) else {
                self.full_decode_errors += 1;
                return;
            };
            let (buttons, subticks) = user_cmd
                .base
                .map(|base| (base.buttons_pb, base.subtick_moves))
                .unwrap_or_default();
            self.record_decoded_command(
                demo_tick,
                index,
                command,
                "full",
                buttons,
                subticks.clone(),
                subticks,
                Vec::new(),
                true,
            );
            return;
        }
        if let Some(data) = command
            .delta_data
            .as_deref()
            .filter(|data| !data.is_empty())
        {
            self.delta_commands += 1;
            let Some(sanitized) = sanitize_delta_message(data, DeltaSchema::CsgoUserCmd) else {
                self.delta_sanitize_errors += 1;
                return;
            };
            let Ok(user_cmd) = DeltaCsgoUserCmdPb::decode(sanitized.as_slice()) else {
                self.delta_decode_errors += 1;
                return;
            };
            let Some(base) = user_cmd.base else {
                let subtick_state = self
                    .slots
                    .get(&command.player_slot.unwrap_or(-1))
                    .map(|state| state.subticks.clone())
                    .unwrap_or_default();
                self.record_decoded_command(
                    demo_tick,
                    index,
                    command,
                    "delta",
                    None,
                    subtick_state,
                    Vec::new(),
                    Vec::new(),
                    false,
                );
                return;
            };
            let previous_subticks = self
                .slots
                .get(&command.player_slot.unwrap_or(-1))
                .map(|state| state.subticks.as_slice())
                .unwrap_or_default();
            let subticks = match decode_delta_subticks(&base.subtick_moves_delta, previous_subticks)
            {
                Some(value) => value,
                None if !base.subtick_moves_delta.is_empty() => {
                    self.subtick_decode_errors += 1;
                    if self.subtick_decode_error_samples.len() < 8 {
                        self.subtick_decode_error_samples
                            .push(SubtickDecodeErrorSample {
                                demo_tick,
                                player_slot: command.player_slot.unwrap_or(-1),
                                payloads_hex: base
                                    .subtick_moves_delta
                                    .iter()
                                    .map(|payload| hex_sample(payload))
                                    .collect(),
                            });
                    }
                    DecodedSubtickDelta {
                        state: previous_subticks.to_vec(),
                        updates: Vec::new(),
                    }
                }
                None => DecodedSubtickDelta {
                    state: previous_subticks.to_vec(),
                    updates: Vec::new(),
                },
            };
            self.record_decoded_command(
                demo_tick,
                index,
                command,
                "delta",
                base.buttons_pb,
                subticks.state,
                subticks.updates,
                base.subtick_moves_delta
                    .iter()
                    .map(|payload| hex_bytes(payload))
                    .collect(),
                false,
            );
            return;
        }
        self.empty_commands += 1;
    }

    fn into_report(
        mut self,
        source_demo: String,
        source_bytes: u64,
        elapsed_seconds: f64,
    ) -> InputTrackReport {
        self.finish();
        let tracks = self
            .slots
            .iter()
            .filter(|(_, slot)| slot.seen && !slot.changes.is_empty())
            .map(|(&slot, state)| EncodedTrack {
                slot,
                changes: state.changes.len(),
                encoded: encode_changes(&state.changes),
            })
            .collect::<Vec<_>>();
        let slot_stats = self
            .slots
            .iter()
            .filter(|(_, slot)| slot.seen)
            .map(|(&slot, state)| SlotInputStats {
                slot,
                commands: state.commands,
                button_updates: state.button_updates,
                final_buttonstate1_hex: mask_hex(state.planes.buttonstate1),
                final_buttonstate2_hex: mask_hex(state.planes.buttonstate2),
                final_buttonstate3_hex: mask_hex(state.planes.buttonstate3),
            })
            .collect();
        let decode_errors = self.full_decode_errors
            + self.delta_sanitize_errors
            + self.delta_decode_errors
            + self.subtick_decode_errors;
        InputTrackReport {
            format_version: 3,
            source_demo,
            source_bytes,
            elapsed_seconds,
            carrier: "svc_UserCmds(76).commands[].data|delta_data -> CCSGOUserCmdPB.base.buttons_pb/subtick_moves",
            button_state_model: "three bit planes of EInButtonState; state1=final held, rising=state3|(state1&state2), falling=state3|(!state1&state2)",
            subtick_delta_model: "stateful codegen-delta list; wire-type 7 field number declares length, indexed elements are sparse, only updated elements are new subtick evidence",
            svc_usercmd_messages: self.svc_messages,
            commands: self.commands,
            full_commands: self.full_commands,
            delta_commands: self.delta_commands,
            empty_commands: self.empty_commands,
            button_updates: self.button_updates,
            subtick_steps: self.subtick_steps,
            subtick_button_steps: self.subtick_button_steps,
            subtick_without_button: self.subtick_without_button,
            subtick_pressed_missing: self.subtick_pressed_missing,
            subtick_when_missing: self.subtick_when_missing,
            subtick_when_non_finite: self.subtick_when_non_finite,
            subtick_when_below_zero: self.subtick_when_below_zero,
            subtick_when_above_one: self.subtick_when_above_one,
            subtick_when_min: self.subtick_when_min,
            subtick_when_max: self.subtick_when_max,
            subtick_when_out_of_order: self.subtick_when_out_of_order,
            commands_without_player_slot: self.commands_without_player_slot,
            full_decode_errors: self.full_decode_errors,
            delta_sanitize_errors: self.delta_sanitize_errors,
            delta_decode_errors: self.delta_decode_errors,
            subtick_decode_errors: self.subtick_decode_errors,
            subtick_decode_error_samples: self.subtick_decode_error_samples,
            decode_errors,
            observed_mask_hex: mask_hex(self.observed_mask),
            known_buttons: KNOWN_BUTTONS.to_vec(),
            state_codes: (0_u8..=7).map(|code| ButtonStateCodeDescription { code, name: button_state_name(code) }).collect(),
            observed_bits: self.observed_bits.into_values().collect(),
            player_identity_updates: self.identity_updates,
            slot_stats,
            tracks,
            raw_evidence: self.evidence,
        }
    }
}

impl DemoRewriter for InputCommandExtractor {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGE | RewriteInterests::STRING_TABLE_ENTRIES
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
        for (index, command) in message.commands.iter().enumerate() {
            self.record_command(tick, index, command);
        }
        Ok(MessageRewrite::Keep)
    }

    fn rewrite_string_table_entry(
        &mut self,
        _ctx: &Context,
        tick: u32,
        table_name: &str,
        entry: &mut StringTableEntryUpdate,
    ) -> Result<(), source2_demo::error::ParserError> {
        if table_name == "userinfo" {
            self.record_userinfo(tick, entry);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct EncodedTrack {
    pub slot: i32,
    pub changes: usize,
    pub encoded: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SlotInputStats {
    pub slot: i32,
    pub commands: usize,
    pub button_updates: usize,
    pub final_buttonstate1_hex: String,
    pub final_buttonstate2_hex: String,
    pub final_buttonstate3_hex: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ButtonStateCodeDescription {
    pub code: u8,
    pub name: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct InputTrackReport {
    pub format_version: u32,
    pub source_demo: String,
    pub source_bytes: u64,
    pub elapsed_seconds: f64,
    pub carrier: &'static str,
    pub button_state_model: &'static str,
    pub subtick_delta_model: &'static str,
    pub svc_usercmd_messages: usize,
    pub commands: usize,
    pub full_commands: usize,
    pub delta_commands: usize,
    pub empty_commands: usize,
    pub button_updates: usize,
    pub subtick_steps: usize,
    pub subtick_button_steps: usize,
    pub subtick_without_button: usize,
    pub subtick_pressed_missing: usize,
    pub subtick_when_missing: usize,
    pub subtick_when_non_finite: usize,
    pub subtick_when_below_zero: usize,
    pub subtick_when_above_one: usize,
    pub subtick_when_min: Option<f32>,
    pub subtick_when_max: Option<f32>,
    pub subtick_when_out_of_order: usize,
    pub commands_without_player_slot: usize,
    pub full_decode_errors: usize,
    pub delta_sanitize_errors: usize,
    pub delta_decode_errors: usize,
    pub subtick_decode_errors: usize,
    pub subtick_decode_error_samples: Vec<SubtickDecodeErrorSample>,
    pub decode_errors: usize,
    pub observed_mask_hex: String,
    pub known_buttons: Vec<KnownButton>,
    pub state_codes: Vec<ButtonStateCodeDescription>,
    pub observed_bits: Vec<ObservedBitStats>,
    pub player_identity_updates: Vec<PlayerIdentityUpdate>,
    pub slot_stats: Vec<SlotInputStats>,
    pub tracks: Vec<EncodedTrack>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub raw_evidence: Vec<RawCommandEvidence>,
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

pub fn extract_input_report(input_path: &Path, include_evidence: bool) -> Result<InputTrackReport> {
    let metadata = input_path
        .metadata()
        .with_context(|| format!("failed to stat {}", input_path.display()))?;
    let input = BufReader::new(
        File::open(input_path)
            .with_context(|| format!("failed to open {}", input_path.display()))?,
    );
    let started = Instant::now();
    let mut writer = DemoWriter::from_reader(input, NullSeekWriter::default())?;
    let state = writer.add_rewriter(InputCommandExtractor::new(include_evidence));
    writer.run()?;
    drop(writer);
    let state = std::mem::take(&mut *state.borrow_mut());
    let report = state.into_report(
        input_path.display().to_string(),
        metadata.len(),
        started.elapsed().as_secs_f64(),
    );
    if report.tracks.is_empty() || report.button_updates == 0 {
        bail!("demo contains no decodable svc_UserCmd button track");
    }
    Ok(report)
}

fn bits(mut mask: u64) -> impl Iterator<Item = u32> {
    std::iter::from_fn(move || {
        if mask == 0 {
            return None;
        }
        let bit = mask.trailing_zeros();
        mask &= mask - 1;
        Some(bit)
    })
}

fn mask_hex(mask: u64) -> String {
    format!("0x{mask:016x}")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_planes_reconstruct_all_eight_sequences() {
        for code in 0_u8..=7 {
            let planes = ButtonStatePlanes {
                buttonstate1: u64::from(code & 1 != 0) << 5,
                buttonstate2: u64::from(code & 2 != 0) << 5,
                buttonstate3: u64::from(code & 4 != 0) << 5,
            };
            assert_eq!(planes.state_code(5), code);
        }
    }

    #[test]
    fn release_is_not_treated_as_press() {
        let down_up = ButtonStatePlanes {
            buttonstate2: 1 << 1,
            ..ButtonStatePlanes::default()
        };
        assert_eq!(down_up.state_code(1), 2);
        assert_eq!(down_up.rising_mask() & (1 << 1), 0);
        assert_ne!(down_up.falling_mask() & (1 << 1), 0);
    }

    #[test]
    fn state3_preserves_fast_tap_with_final_up_state() {
        let fast_tap = ButtonStatePlanes {
            buttonstate3: 1 << 1,
            ..ButtonStatePlanes::default()
        };
        assert_eq!(fast_tap.state_code(1), 4);
        assert_ne!(fast_tap.rising_mask() & (1 << 1), 0);
        assert_ne!(fast_tap.falling_mask() & (1 << 1), 0);
        assert_ne!(fast_tap.active_or_pressed_mask() & (1 << 1), 0);
    }

    #[test]
    fn compact_hud_uses_in_speed_not_joyautosprint() {
        assert_ne!(compact_hud_mask(1 << 16) & (1 << 6), 0);
        assert_eq!(compact_hud_mask(1 << 17) & (1 << 6), 0);
    }

    #[test]
    fn repeated_delta_marker_declares_more_than_one_subtick() {
        let payload = vec![
            0x17, 0x02, 0x09, 0x08, 0x01, 0x10, 0x01, 0x1d, 0x00, 0x00, 0xb0, 0x3e, 0x0a, 0x0a,
            0x08, 0x80, 0x10, 0x10, 0x01, 0x1d, 0x00, 0x00, 0xb0, 0x3e,
        ];
        let decoded = decode_delta_subticks(&[payload], &[]).unwrap();
        assert_eq!(decoded.state.len(), 2);
        assert_eq!(decoded.updates.len(), 2);
        assert_eq!(decoded.state[0].button, Some(1));
        assert_eq!(decoded.state[1].button, Some(2048));
        assert_eq!(decoded.state[0].pressed, Some(true));
        assert_eq!(decoded.state[0].when, Some(0.34375));
    }

    #[test]
    fn repeated_delta_marker_creates_default_sparse_entries() {
        let one_entry_declared_as_two = vec![0x17, 0x02, 0x02, 0x08, 0x01];
        let decoded = decode_delta_subticks(&[one_entry_declared_as_two], &[]).unwrap();
        assert_eq!(decoded.state.len(), 2);
        assert_eq!(decoded.updates.len(), 1);
        assert_eq!(decoded.state[0].button, Some(1));
        assert_eq!(decoded.state[1], SubtickMovePb::default());
    }

    #[test]
    fn repeated_delta_allows_sparse_later_indexes() {
        let previous = vec![
            SubtickMovePb::default(),
            SubtickMovePb {
                button: Some(2),
                pressed: Some(true),
                ..SubtickMovePb::default()
            },
        ];
        let grow_and_set_index_two = vec![0x1f, 0x12, 0x02, 0x08, 0x04];
        let decoded = decode_delta_subticks(&[grow_and_set_index_two], &previous).unwrap();
        assert_eq!(decoded.state.len(), 3);
        assert_eq!(decoded.updates.len(), 1);
        assert_eq!(decoded.state[1].button, Some(2));
        assert_eq!(decoded.state[1].pressed, Some(true));
        assert_eq!(decoded.state[2].button, Some(4));
        assert_eq!(decoded.updates[0].button, Some(4));
    }
}
