#![allow(clippy::field_reassign_with_default)]

use crate::error::ParserError;
use crate::parser::{
    Context, DemoRewriter, DemoRunner, DemoWriter, Interests, MessageRewrite, Observer,
    ObserverResult, PacketMessage, Parser, RewriteInterests,
};
use crate::proto::{
    csvc_msg_game_event, csvc_msg_game_event_list, CDemoFileInfo, CDemoPacket, CNetMsgTick,
    CSvcMsgGameEvent, CSvcMsgGameEventList, CSvcMsgServerInfo, CUserMessageSayText2,
    EBaseGameEvents, EBaseUserMessages, EDemoCommands, Message, NetMessages, SvcMessages,
};
#[cfg(feature = "dota")]
use crate::proto::{CDotaUserMsgChatMessage, EDotaUserMessages};
#[cfg(feature = "deadlock")]
use crate::proto::{CitadelUserMessageIds, ECitadelGameEvents};
#[cfg(feature = "cs2")]
use crate::proto::{ECsgoGameEvents, ECstrike15UserMessages};
use crate::reader::{BitsReader, MessageReader, SliceReader};
use crate::writer::{
    write_demo_message, write_demo_message_with_compression, write_var_u64_to_vec, BitsWriter,
    BitstreamWriter,
};
#[cfg(feature = "dota")]
use crate::CombatLogEntry;
use crate::{Entity, EntityEvents, FieldValue, GameEvent, StringTable};
use bitter::{BitReader, LittleEndianReader};
use source2_demo_macros::{
    observer, on_message, rewrite_demo_message, rewrite_field, rewrite_packet_message, rewriter,
};
use std::io::Cursor;

fn read_var_u64_from_bytes(bytes: &[u8]) -> u64 {
    let mut reader = LittleEndianReader::new(bytes);
    let mut value = 0_u64;
    let mut shift = 0;
    loop {
        let byte = reader.read_u8().expect("varint byte");
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return value;
        }
        shift += 7;
    }
}

fn read_var_u32_from_bytes(bytes: &[u8]) -> u32 {
    read_var_u64_from_bytes(bytes) as u32
}

fn decode_zigzag_i32(value: u32) -> i32 {
    ((value >> 1) as i32) ^ (-((value & 1) as i32))
}

fn minimal_replay() -> Vec<u8> {
    replay_with_messages(&[(
        EDemoCommands::DemFileInfo,
        0,
        CDemoFileInfo::default().encode_to_vec(),
    )])
}

fn replay_with_messages(messages: &[(EDemoCommands, u32, Vec<u8>)]) -> Vec<u8> {
    let mut replay = Vec::new();
    replay.extend_from_slice(b"PBDEMS2\0");
    replay.extend_from_slice(&16_u32.to_le_bytes());
    replay.extend_from_slice(&[0; 4]);
    for (msg_type, tick, payload) in messages {
        write_demo_message(&mut replay, *msg_type, *tick, payload).unwrap();
    }
    replay
}

fn replay_with_playback_ticks(
    playback_ticks: i32,
    messages: &[(EDemoCommands, u32, Vec<u8>)],
) -> Vec<u8> {
    let mut file_info = CDemoFileInfo::default();
    file_info.playback_ticks = Some(playback_ticks);
    let mut all_messages = vec![(EDemoCommands::DemFileInfo, 0, file_info.encode_to_vec())];
    all_messages.extend_from_slice(messages);
    replay_with_messages(&all_messages)
}

fn sync_payload() -> Vec<u8> {
    Vec::new()
}

fn demo_packet_payload(messages: &[(i32, &[u8])]) -> Vec<u8> {
    CDemoPacket {
        data: Some(packet_data(messages)),
    }
    .encode_to_vec()
}

fn packet_data(messages: &[(i32, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut writer = BitstreamWriter::new(&mut out);
    for (msg_type, payload) in messages {
        writer.write_ubit_var(*msg_type as u32).unwrap();
        writer.write_var_u32(payload.len() as u32).unwrap();
        writer.write_bytes(payload).unwrap();
    }
    writer.flush().unwrap();
    drop(writer);
    out
}

fn decode_packet_data(data: &[u8]) -> Vec<(i32, Vec<u8>)> {
    let mut reader = SliceReader::new(data);
    let mut messages = Vec::new();
    while reader.remaining_bytes() != 0 {
        let msg_type = reader.read_ubit_var() as i32;
        let size = reader.read_var_u32();
        messages.push((msg_type, reader.read_bytes(size)));
    }
    messages
}

fn demo_message_types(replay: &[u8]) -> Vec<EDemoCommands> {
    let mut reader = SliceReader::new(replay);
    reader.seek(16);
    let mut messages = Vec::new();
    while let Some(message) = reader.read_next_message().unwrap() {
        messages.push(message.msg_type);
    }
    messages
}

#[test]
fn parser_rejects_wrong_magic_and_truncated_headers() {
    assert!(matches!(
        Parser::from_slice(b""),
        Err(ParserError::WrongMagic)
    ));
    assert!(matches!(
        Parser::from_slice(b"NOTDEMO!12345678"),
        Err(ParserError::WrongMagic)
    ));
}

#[test]
fn parser_reads_file_info_from_slice_header_offset() {
    let replay = replay_with_playback_ticks(321, &[]);
    let parser = Parser::from_slice(&replay).unwrap();

    assert_eq!(parser.replay_info().playback_ticks(), 321);
    assert_eq!(parser.context().tick(), u32::MAX);
}

#[test]
fn parser_from_reader_reads_same_file_info() {
    let replay = replay_with_playback_ticks(654, &[]);
    let parser = Parser::from_reader(Cursor::new(replay)).unwrap();

    assert_eq!(parser.replay_info().playback_ticks(), 654);
}

#[test]
fn ubit_var_round_trips_bucket_boundaries() {
    for value in [0, 1, 15, 16, 255, 256, 4095, 4096, u32::MAX] {
        let mut out = Vec::new();
        let mut writer = BitstreamWriter::new(&mut out);
        writer.write_ubit_var(value).expect("write ubit_var");
        writer.flush().expect("flush");
        drop(writer);

        let mut reader = SliceReader::new(&out);
        assert_eq!(reader.read_ubit_var(), value);
    }
}

#[test]
fn var_u32_round_trips_boundaries() {
    for value in [0, 1, 127, 128, 16_384, u32::MAX] {
        let mut out = Vec::new();
        let mut writer = BitstreamWriter::new(&mut out);
        writer.write_var_u32(value).expect("write var_u32");
        writer.flush().expect("flush");
        drop(writer);

        let mut reader = SliceReader::new(&out);
        assert_eq!(reader.read_var_u32(), value);
    }
}

#[test]
fn var_i32_round_trips_zigzag_edges() {
    for value in [0, 1, -1, 2, -2, i32::MAX, i32::MIN] {
        let mut out = Vec::new();
        let mut writer = BitstreamWriter::new(&mut out);
        writer.write_var_i32(value).expect("write var_i32");
        writer.flush().expect("flush");
        drop(writer);

        assert_eq!(decode_zigzag_i32(read_var_u32_from_bytes(&out)), value);
    }
}

#[test]
fn byte_var_u64_round_trips_boundaries() {
    for value in [0, 1, 127, 128, 16_384, u32::MAX as u64, u64::MAX] {
        let bytes = write_var_u64_to_vec(value);
        assert_eq!(read_var_u64_from_bytes(&bytes), value);
    }
}

#[test]
fn normal_sign_bit_matches_reader_encoding() {
    for (value, expected_sign_bit) in [(1.0, false), (-1.0, true)] {
        let mut out = Vec::new();
        let mut writer = BitstreamWriter::new(&mut out);
        writer.write_normal(value).expect("write normal");
        writer.flush().expect("flush");
        drop(writer);

        let mut reader = LittleEndianReader::new(&out);
        assert_eq!(reader.read_bit(), Some(expected_sign_bit));
    }
}

#[test]
fn demo_message_writer_emits_header_and_payload() {
    let payload = [0xAA, 0xBB, 0xCC];
    let mut out = Vec::new();

    let written = write_demo_message(&mut out, EDemoCommands::DemPacket, 123, &payload)
        .expect("write demo message");

    assert_eq!(written, out.len());

    let mut reader = SliceReader::new(&out);
    assert_eq!(reader.read_var_u32(), EDemoCommands::DemPacket as u32);
    assert_eq!(reader.read_var_u32(), 123);
    assert_eq!(reader.read_var_u32(), payload.len() as u32);
    assert_eq!(reader.read_bytes(payload.len() as u32), payload);
}

#[test]
fn compressed_demo_message_round_trips_through_reader() {
    let payload = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let mut out = Vec::new();

    let written =
        write_demo_message_with_compression(&mut out, EDemoCommands::DemPacket, 123, payload, true)
            .expect("write compressed demo message");

    assert_eq!(written, out.len());

    let mut reader = SliceReader::new(&out);
    let message = reader
        .read_next_message()
        .expect("read message")
        .expect("message");
    assert_eq!(message.msg_type, EDemoCommands::DemPacket);
    assert_eq!(message.tick, 123);
    assert_eq!(message.buf, payload);
    assert!(message.compressed);
}

#[test]
fn demo_writer_without_rewriters_preserves_demo_bytes() {
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (
                EDemoCommands::DemPacket,
                5,
                demo_packet_payload(&[(9999, &[1, 2, 3])]),
            ),
            (EDemoCommands::DemStop, 10, Vec::new()),
        ],
    );
    let parser = Parser::from_slice(&replay).unwrap();
    let output = Cursor::new(Vec::new());
    let mut writer = DemoWriter::new(parser, output);

    writer.run().unwrap();
    let (_, output) = writer.into_parts();

    assert_eq!(output.into_inner(), replay);
}

#[test]
fn demo_writer_updates_parser_context_tick() {
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (EDemoCommands::DemPacket, 5, demo_packet_payload(&[])),
            (EDemoCommands::DemStop, 10, Vec::new()),
        ],
    );
    let parser = Parser::from_slice(&replay).unwrap();
    let output = Cursor::new(Vec::new());
    let mut writer = DemoWriter::new(parser, output);

    writer.run().unwrap();
    let (parser, _) = writer.into_parts();

    assert_eq!(parser.context().tick(), 10);
}

struct DropOuterDemoPacket;

impl DemoRewriter for DropOuterDemoPacket {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::DEMO_MESSAGE
    }

    fn rewrite_demo_message(
        &mut self,
        _ctx: &Context,
        _tick: u32,
        msg_type: EDemoCommands,
        _payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        if msg_type == EDemoCommands::DemPacket {
            Ok(MessageRewrite::Drop)
        } else {
            Ok(MessageRewrite::Keep)
        }
    }
}

#[test]
fn demo_writer_demo_message_rewriter_can_drop_outer_messages() {
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (
                EDemoCommands::DemPacket,
                5,
                demo_packet_payload(&[(9999, &[1, 2, 3])]),
            ),
            (EDemoCommands::DemStop, 10, Vec::new()),
        ],
    );
    let parser = Parser::from_slice(&replay).unwrap();
    let output = Cursor::new(Vec::new());
    let mut writer = DemoWriter::new(parser, output);
    writer.add_rewriter(DropOuterDemoPacket);

    writer.run().unwrap();
    let (_, output) = writer.into_parts();

    assert_eq!(
        demo_message_types(&output.into_inner()),
        vec![
            EDemoCommands::DemFileInfo,
            EDemoCommands::DemSyncTick,
            EDemoCommands::DemStop,
        ]
    );
}

#[derive(Default)]
struct TypedDemoMessageRewriter {
    file_info_seen: bool,
}

#[rewriter]
impl TypedDemoMessageRewriter {
    #[rewrite_demo_message]
    fn rewrite_file_info(
        &mut self,
        _msg: &mut CDemoFileInfo,
    ) -> Result<MessageRewrite, ParserError> {
        self.file_info_seen = true;
        Ok(MessageRewrite::Keep)
    }
}

#[test]
fn demo_writer_demo_message_rewriter_supports_typed_handlers() {
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (EDemoCommands::DemStop, 10, Vec::new()),
        ],
    );
    let parser = Parser::from_slice(&replay).unwrap();
    let output = Cursor::new(Vec::new());
    let mut writer = DemoWriter::new(parser, output);
    let rc = writer.register_rewriter::<TypedDemoMessageRewriter>();

    writer.run().unwrap();

    assert!(rc.borrow().file_info_seen);
}

#[derive(Default)]
struct DemoLifecycleObserver {
    demo_commands: Vec<(EDemoCommands, u32, usize)>,
    tick_starts: Vec<u32>,
    tick_ends: Vec<u32>,
    stops: usize,
}

impl Observer for DemoLifecycleObserver {
    fn interests(&self) -> Interests {
        Interests::DEMO_MESSAGE
            | Interests::TICK_START
            | Interests::TICK_END
            | Interests::REPLAY_END
    }

    fn on_demo_command(
        &mut self,
        ctx: &Context,
        msg_type: EDemoCommands,
        msg: &[u8],
    ) -> ObserverResult {
        self.demo_commands.push((msg_type, ctx.tick(), msg.len()));
        Ok(())
    }

    fn on_tick_start(&mut self, ctx: &Context) -> ObserverResult {
        self.tick_starts.push(ctx.tick());
        Ok(())
    }

    fn on_tick_end(&mut self, ctx: &Context) -> ObserverResult {
        self.tick_ends.push(ctx.tick());
        Ok(())
    }

    fn on_stop(&mut self, _ctx: &Context) -> ObserverResult {
        self.stops += 1;
        Ok(())
    }
}

#[test]
fn parser_run_to_end_dispatches_demo_tick_and_stop_observers() {
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (
                EDemoCommands::DemPacket,
                5,
                demo_packet_payload(&[(9999, &[1, 2, 3])]),
            ),
            (EDemoCommands::DemStop, 10, Vec::new()),
        ],
    );
    let mut parser = Parser::from_slice(&replay).unwrap();
    let observer = parser.register_observer::<DemoLifecycleObserver>();

    parser.run_to_end().unwrap();
    let observer = observer.borrow();

    assert_eq!(observer.tick_starts, vec![5, 10]);
    assert_eq!(observer.tick_ends, vec![5, 10]);
    assert_eq!(observer.stops, 1);
    assert_eq!(
        observer
            .demo_commands
            .iter()
            .map(|(msg_type, tick, _)| (*msg_type, *tick))
            .collect::<Vec<_>>(),
        vec![
            (EDemoCommands::DemFileInfo, u32::MAX),
            (EDemoCommands::DemSyncTick, u32::MAX),
            (EDemoCommands::DemPacket, 5),
            (EDemoCommands::DemStop, 10),
        ]
    );
}

#[test]
fn parser_run_to_tick_stops_after_target_tick() {
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (EDemoCommands::DemPacket, 5, demo_packet_payload(&[])),
            (EDemoCommands::DemPacket, 10, demo_packet_payload(&[])),
        ],
    );
    let mut parser = Parser::from_slice(&replay).unwrap();
    let observer = parser.register_observer::<DemoLifecycleObserver>();

    parser.run_to_tick(5).unwrap();

    assert_eq!(parser.context().tick(), 5);
    assert_eq!(observer.borrow().tick_starts, vec![5]);
}

#[derive(Default)]
struct PacketDispatchObserver {
    net_ticks: Vec<u32>,
    svc_messages: Vec<SvcMessages>,
    base_user_messages: Vec<(EBaseUserMessages, usize)>,
    #[cfg(feature = "dota")]
    dota_user_messages: Vec<(EDotaUserMessages, usize)>,
}

impl Observer for PacketDispatchObserver {
    fn interests(&self) -> Interests {
        let interests =
            Interests::NET_MESSAGE | Interests::SVC_MESSAGE | Interests::BASE_USER_MESSAGE;
        #[cfg(feature = "dota")]
        let interests = interests | Interests::DOTA_USER_MESSAGE;
        interests
    }

    fn on_net_message(
        &mut self,
        ctx: &Context,
        msg_type: NetMessages,
        _msg: &[u8],
    ) -> ObserverResult {
        assert_eq!(msg_type, NetMessages::NetTick);
        self.net_ticks.push(ctx.net_tick());
        Ok(())
    }

    fn on_svc_message(
        &mut self,
        ctx: &Context,
        msg_type: SvcMessages,
        _msg: &[u8],
    ) -> ObserverResult {
        self.svc_messages.push(msg_type);
        if msg_type == SvcMessages::SvcServerInfo {
            assert_eq!(ctx.game_build(), 7777);
        }
        Ok(())
    }

    fn on_base_user_message(
        &mut self,
        _ctx: &Context,
        msg_type: EBaseUserMessages,
        msg: &[u8],
    ) -> ObserverResult {
        self.base_user_messages.push((msg_type, msg.len()));
        Ok(())
    }

    #[cfg(feature = "dota")]
    fn on_dota_user_message(
        &mut self,
        _ctx: &Context,
        msg_type: EDotaUserMessages,
        msg: &[u8],
    ) -> ObserverResult {
        self.dota_user_messages.push((msg_type, msg.len()));
        Ok(())
    }
}

#[test]
fn parser_dispatches_packet_net_svc_base_and_dota_messages() {
    let game_dir = if cfg!(feature = "dota") {
        "dota_v7777/game"
    } else if cfg!(feature = "deadlock") {
        "citadel_v7777/game"
    } else {
        "unknown7777/game"
    };
    let mut server_info = CSvcMsgServerInfo::default();
    server_info.max_classes = Some(128);
    server_info.game_dir = Some(game_dir.to_string());
    let server_info = server_info.encode_to_vec();
    let mut net_tick = CNetMsgTick::default();
    net_tick.tick = Some(42);
    let net_tick = net_tick.encode_to_vec();
    let mut say_text = CUserMessageSayText2::default();
    say_text.chat = Some(true);
    say_text.messagename = Some("hello".to_string());
    let say_text = say_text.encode_to_vec();
    #[cfg(feature = "dota")]
    let dota_chat = {
        let mut msg = CDotaUserMsgChatMessage::default();
        msg.source_player_id = Some(7);
        msg.message_text = Some("hi".to_string());
        msg.encode_to_vec()
    };
    #[cfg(feature = "dota")]
    let packet_messages = vec![
        (SvcMessages::SvcServerInfo as i32, server_info.as_slice()),
        (NetMessages::NetTick as i32, net_tick.as_slice()),
        (EBaseUserMessages::UmSayText2 as i32, say_text.as_slice()),
        (
            EDotaUserMessages::DotaUmChatMessage as i32,
            dota_chat.as_slice(),
        ),
    ];
    #[cfg(not(feature = "dota"))]
    let packet_messages = vec![
        (SvcMessages::SvcServerInfo as i32, server_info.as_slice()),
        (NetMessages::NetTick as i32, net_tick.as_slice()),
        (EBaseUserMessages::UmSayText2 as i32, say_text.as_slice()),
    ];

    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (
                EDemoCommands::DemPacket,
                5,
                demo_packet_payload(&packet_messages),
            ),
        ],
    );
    let mut parser = Parser::from_slice(&replay).unwrap();
    let observer = parser.register_observer::<PacketDispatchObserver>();

    parser.run_to_end().unwrap();
    let observer = observer.borrow();

    assert_eq!(observer.svc_messages, vec![SvcMessages::SvcServerInfo]);
    assert_eq!(observer.net_ticks, vec![42]);
    assert_eq!(
        observer.base_user_messages,
        vec![(EBaseUserMessages::UmSayText2, say_text.len())]
    );
    #[cfg(feature = "dota")]
    assert_eq!(
        observer.dota_user_messages,
        vec![(EDotaUserMessages::DotaUmChatMessage, dota_chat.len())]
    );
}

#[derive(Default)]
struct RawMessageMacroObserver {
    svc_messages: Vec<(SvcMessages, usize)>,
}

#[observer]
impl RawMessageMacroObserver {
    #[on_message]
    fn raw_svc(&mut self, _ctx: &Context, msg_type: SvcMessages, payload: &[u8]) -> ObserverResult {
        self.svc_messages.push((msg_type, payload.len()));
        Ok(())
    }
}

#[test]
fn observer_macro_can_receive_raw_message_payloads() {
    let mut server_info = CSvcMsgServerInfo::default();
    server_info.max_classes = Some(128);
    server_info.game_dir = Some("unknown7777/game".to_string());
    let server_info = server_info.encode_to_vec();
    let mut net_tick = CNetMsgTick::default();
    net_tick.tick = Some(42);
    let net_tick = net_tick.encode_to_vec();

    let packet_messages = vec![
        (SvcMessages::SvcServerInfo as i32, server_info.as_slice()),
        (NetMessages::NetTick as i32, net_tick.as_slice()),
    ];
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (
                EDemoCommands::DemPacket,
                5,
                demo_packet_payload(&packet_messages),
            ),
        ],
    );
    let mut parser = Parser::from_slice(&replay).unwrap();
    let observer = parser.register_observer::<RawMessageMacroObserver>();

    parser.run_to_end().unwrap();

    assert_eq!(
        observer.borrow().svc_messages,
        vec![(SvcMessages::SvcServerInfo, server_info.len())]
    );
}

#[derive(Default)]
struct AllModeObserver;

#[observer(all)]
impl AllModeObserver {}

#[derive(Default)]
struct UsesAllObserver;

#[observer]
#[source2_demo_macros::uses_all]
impl UsesAllObserver {}

#[derive(Default)]
struct UsesAllMethodObserver;

#[observer]
impl UsesAllMethodObserver {
    #[allow(dead_code)]
    #[source2_demo_macros::uses_all]
    fn enable_all(&mut self) {}
}

#[test]
fn observer_all_mode_and_uses_all_marker_enable_every_interest() {
    assert_eq!(AllModeObserver.interests(), Interests::all());
    assert_eq!(UsesAllObserver.interests(), Interests::all());
    assert_eq!(UsesAllMethodObserver.interests(), Interests::all());
}

#[derive(Default)]
struct GameEventObserver {
    base_events: Vec<EBaseGameEvents>,
    named_events: Vec<(i32, String, i32)>,
}

impl Observer for GameEventObserver {
    fn interests(&self) -> Interests {
        Interests::BASE_GAME_EVENT
    }

    fn on_base_game_event(
        &mut self,
        _ctx: &Context,
        msg_type: EBaseGameEvents,
        _msg: &[u8],
    ) -> ObserverResult {
        self.base_events.push(msg_type);
        Ok(())
    }

    fn on_game_event(&mut self, _ctx: &Context, ge: &GameEvent) -> ObserverResult {
        self.named_events.push((
            ge.id(),
            ge.name().to_string(),
            ge.get_value("score").unwrap().try_into().unwrap(),
        ));
        Ok(())
    }
}

#[test]
fn parser_builds_game_event_definitions_and_dispatches_named_events() {
    let list = CSvcMsgGameEventList {
        descriptors: vec![csvc_msg_game_event_list::DescriptorT {
            eventid: Some(12),
            name: Some("score_event".to_string()),
            keys: vec![csvc_msg_game_event_list::KeyT {
                r#type: Some(3),
                name: Some("score".to_string()),
            }],
        }],
    }
    .encode_to_vec();
    let mut key = csvc_msg_game_event::KeyT::default();
    key.r#type = Some(3);
    key.val_long = Some(9001);
    let mut event = CSvcMsgGameEvent::default();
    event.eventid = Some(12);
    event.keys = vec![key];
    let event = event.encode_to_vec();
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (
                EDemoCommands::DemPacket,
                5,
                demo_packet_payload(&[
                    (EBaseGameEvents::GeSource1LegacyGameEventList as i32, &list),
                    (EBaseGameEvents::GeSource1LegacyGameEvent as i32, &event),
                ]),
            ),
        ],
    );
    let mut parser = Parser::from_slice(&replay).unwrap();
    let observer = parser.register_observer::<GameEventObserver>();

    parser.run_to_end().unwrap();
    let observer = observer.borrow();

    assert_eq!(
        observer.base_events,
        vec![
            EBaseGameEvents::GeSource1LegacyGameEventList,
            EBaseGameEvents::GeSource1LegacyGameEvent,
        ]
    );
    assert_eq!(
        observer.named_events,
        vec![(12, "score_event".to_string(), 9001)]
    );
}

struct FailingTickObserver;

impl Observer for FailingTickObserver {
    fn interests(&self) -> Interests {
        Interests::TICK_START
    }

    fn on_tick_start(&mut self, _ctx: &Context) -> ObserverResult {
        anyhow::bail!("tick failed")
    }
}

#[test]
fn parser_propagates_observer_errors() {
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (EDemoCommands::DemPacket, 5, demo_packet_payload(&[])),
        ],
    );
    let mut parser = Parser::from_slice(&replay).unwrap();
    parser.add_observer(FailingTickObserver);

    let err = parser.run_to_end().unwrap_err();
    assert!(matches!(err, ParserError::ObserverError(_)));
}

#[derive(Default)]
struct QualifiedAttributeObserver {
    ticks: usize,
}

#[source2_demo_macros::observer]
impl QualifiedAttributeObserver {
    #[source2_demo_macros::on_tick_start]
    fn tick_start(&mut self) -> ObserverResult {
        self.ticks += 1;
        Ok(())
    }
}

#[test]
fn observer_macro_accepts_path_qualified_handler_attributes() {
    let replay = replay_with_playback_ticks(
        20,
        &[
            (EDemoCommands::DemSyncTick, 0, sync_payload()),
            (EDemoCommands::DemPacket, 5, demo_packet_payload(&[])),
        ],
    );
    let mut parser = Parser::from_slice(&replay).unwrap();
    let observer = parser.register_observer::<QualifiedAttributeObserver>();

    parser.run_to_end().unwrap();

    assert_eq!(observer.borrow().ticks, 1);
}

struct QualifiedAttributeRewriter;

#[source2_demo_macros::rewriter]
impl QualifiedAttributeRewriter {
    #[source2_demo_macros::rewrite_packet_message]
    fn drop_packet_message(
        &mut self,
        _msg_type: i32,
        _payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        Ok(MessageRewrite::Drop)
    }
}

#[test]
fn rewriter_macro_accepts_path_qualified_handler_attributes() {
    assert!(QualifiedAttributeRewriter
        .interests()
        .contains(RewriteInterests::PACKET_MESSAGE));
}

#[test]
fn packet_message_encodes_decodes_and_replaces_protobuf_payload() {
    let mut original = CSvcMsgServerInfo::default();
    original.max_classes = Some(128);
    original.game_dir = Some("dota_v1234/game".to_string());
    let mut packet = PacketMessage::encoded(1, &original);

    let decoded: CSvcMsgServerInfo = packet.decode().unwrap();
    assert_eq!(decoded.max_classes(), 128);
    assert_eq!(decoded.game_dir(), "dota_v1234/game");

    let mut replacement = CSvcMsgServerInfo::default();
    replacement.max_classes = Some(256);
    replacement.game_dir = Some("dota_v5678/game".to_string());
    packet.replace_with(&replacement);

    let decoded: CSvcMsgServerInfo = packet.decode().unwrap();
    assert_eq!(decoded.max_classes(), 256);
    assert_eq!(decoded.game_dir(), "dota_v5678/game");
}

#[derive(Default)]
struct TypedFieldRewriter;

#[rewriter]
impl TypedFieldRewriter {
    #[rewrite_field(class = "", field = "m_iszPlayerName")]
    fn player_name(&mut self, _ctx: &Context, value: &str) -> String {
        format!("{value}_anon")
    }

    #[rewrite_field(class = "", field = any(starts_with("m_i"), contains("Score")))]
    fn integer_field(&mut self, value: i32) -> Option<i32> {
        Some(value + 1)
    }

    #[rewrite_field(class = "", field = not(ends_with("Keep")))]
    fn bool_field(&mut self, field_name: &str, value: bool) -> Option<bool> {
        if field_name.starts_with("m_b") {
            Some(!value)
        } else {
            None
        }
    }

    #[rewrite_field(class = "", field = "m_iState")]
    fn stateful_field(&mut self, _entity: &Entity, value: i32) -> i32 {
        value
    }

    #[rewrite_field(class = "")]
    fn class_field(&mut self, field_name: &str, value: &FieldValue) -> Option<FieldValue> {
        match (field_name, value) {
            ("m_nClassOnly", FieldValue::Signed32(value)) => {
                Some(FieldValue::Signed32(value + 100))
            }
            _ => None,
        }
    }
}

#[test]
fn rewrite_field_macro_supports_predicates_and_typed_values() {
    let ctx = Context::default();
    let entity = crate::Entity::default();
    let mut rewriter = TypedFieldRewriter;

    assert_eq!(
        DemoRewriter::replace_entity_field(
            &mut rewriter,
            &ctx,
            crate::EntityEvents::Updated,
            &entity,
            "m_iszPlayerName",
            &crate::FieldValue::String("Player".to_string()),
        ),
        Some(crate::FieldValue::String("Player_anon".to_string()))
    );
    assert_eq!(
        DemoRewriter::replace_entity_field(
            &mut rewriter,
            &ctx,
            crate::EntityEvents::Updated,
            &entity,
            "m_iScore",
            &crate::FieldValue::Signed32(10),
        ),
        Some(crate::FieldValue::Signed32(11))
    );
    assert_eq!(
        DemoRewriter::replace_entity_field(
            &mut rewriter,
            &ctx,
            crate::EntityEvents::Updated,
            &entity,
            "m_bVisible",
            &crate::FieldValue::Boolean(true),
        ),
        Some(crate::FieldValue::Boolean(false))
    );
    assert_eq!(
        DemoRewriter::replace_entity_field(
            &mut rewriter,
            &ctx,
            crate::EntityEvents::Updated,
            &entity,
            "m_bKeep",
            &crate::FieldValue::Boolean(true),
        ),
        None
    );
    assert_eq!(
        DemoRewriter::replace_entity_field(
            &mut rewriter,
            &ctx,
            crate::EntityEvents::Updated,
            &entity,
            "m_nClassOnly",
            &crate::FieldValue::Signed32(3),
        ),
        Some(crate::FieldValue::Signed32(103))
    );
}

#[derive(Default)]
struct AppendPacketMessage;

impl DemoRewriter for AppendPacketMessage {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGES
    }

    fn rewrite_packet_messages(
        &mut self,
        _ctx: &Context,
        _tick: u32,
        messages: &mut Vec<PacketMessage>,
    ) -> Result<(), ParserError> {
        messages.push(PacketMessage::new(11, [7, 8, 9]));
        Ok(())
    }
}

#[test]
fn registered_demo_rewriter_can_append_packet_message() {
    let replay = minimal_replay();
    let parser = Parser::from_slice(&replay).unwrap();
    let output = Cursor::new(Vec::new());
    let mut writer = DemoWriter::new(parser, output);

    writer.add_rewriter(AppendPacketMessage);

    let input = packet_data(&[(7, &[1, 2, 3])]);
    let output = writer.rewrite_packet_data(0, &input, false).unwrap();
    let mut reader = SliceReader::new(&output);

    assert_eq!(reader.read_ubit_var(), 7);
    assert_eq!(reader.read_var_u32(), 3);
    assert_eq!(reader.read_bytes(3), [1, 2, 3]);
    assert_eq!(reader.read_ubit_var(), 11);
    assert_eq!(reader.read_var_u32(), 3);
    assert_eq!(reader.read_bytes(3), [7, 8, 9]);
    assert_eq!(reader.remaining_bytes(), 0);
}

struct ReplaceAndDropPacketMessages;

impl DemoRewriter for ReplaceAndDropPacketMessages {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGE
    }

    fn rewrite_packet_message(
        &mut self,
        _ctx: &Context,
        _tick: u32,
        msg_type: i32,
        _payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        match msg_type {
            7 => Ok(MessageRewrite::Replace(vec![9, 9])),
            8 => Ok(MessageRewrite::Drop),
            _ => Ok(MessageRewrite::Keep),
        }
    }
}

#[test]
fn packet_rewriter_can_replace_and_drop_individual_messages() {
    let replay = minimal_replay();
    let parser = Parser::from_slice(&replay).unwrap();
    let output = Cursor::new(Vec::new());
    let mut writer = DemoWriter::new(parser, output);
    writer.add_rewriter(ReplaceAndDropPacketMessages);

    let input = packet_data(&[(7, &[1, 2, 3]), (8, &[4, 5]), (9, &[6])]);
    let output = writer.rewrite_packet_data(0, &input, false).unwrap();

    assert_eq!(
        decode_packet_data(&output),
        vec![(7, vec![9, 9]), (9, vec![6])]
    );
}

struct ReplacePacketList;

impl DemoRewriter for ReplacePacketList {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGES
    }

    fn rewrite_packet_messages(
        &mut self,
        _ctx: &Context,
        _tick: u32,
        messages: &mut Vec<PacketMessage>,
    ) -> Result<(), ParserError> {
        messages.clear();
        messages.push(PacketMessage::new(100, [1]));
        messages.push(PacketMessage::new(101, [2, 3]));
        Ok(())
    }
}

#[test]
fn packet_list_rewriter_can_replace_entire_packet_contents() {
    let replay = minimal_replay();
    let parser = Parser::from_slice(&replay).unwrap();
    let output = Cursor::new(Vec::new());
    let mut writer = DemoWriter::new(parser, output);
    writer.add_rewriter(ReplacePacketList);

    let input = packet_data(&[(7, &[1, 2, 3])]);
    let output = writer.rewrite_packet_data(0, &input, false).unwrap();

    assert_eq!(
        decode_packet_data(&output),
        vec![(100, vec![1]), (101, vec![2, 3])]
    );
}

#[derive(Default)]
struct CountingPacketRewriter {
    packets: usize,
}

impl DemoRewriter for CountingPacketRewriter {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGES
    }

    fn rewrite_packet_messages(
        &mut self,
        _ctx: &Context,
        _tick: u32,
        messages: &mut Vec<PacketMessage>,
    ) -> Result<(), ParserError> {
        self.packets += messages.len();
        Ok(())
    }
}

#[test]
fn registered_rewriter_returns_rewriter_state_handle() {
    let replay = minimal_replay();
    let parser = Parser::from_slice(&replay).unwrap();
    let output = Cursor::new(Vec::new());
    let mut writer = DemoWriter::new(parser, output);

    let rewriter = writer.register_rewriter::<CountingPacketRewriter>();

    let input = packet_data(&[(7, &[1, 2, 3])]);
    writer.rewrite_packet_data(0, &input, false).unwrap();

    assert_eq!(rewriter.borrow().packets, 1);
}

#[derive(Default)]
struct ContextAwarePacketRewriter {
    context_tick: u32,
    typed_msg_type: i32,
}

#[rewriter]
impl ContextAwarePacketRewriter {
    #[rewrite_packet_message]
    fn packet_with_context(
        &mut self,
        ctx: &Context,
        _tick: u32,
        _msg_type: i32,
        _payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        self.context_tick = ctx.tick();
        Ok(MessageRewrite::Keep)
    }

    #[rewrite_packet_message]
    fn typed_packet_with_msg_type(
        &mut self,
        _message: CNetMsgTick,
        msg_type: i32,
    ) -> Result<MessageRewrite, ParserError> {
        self.typed_msg_type = msg_type;
        Ok(MessageRewrite::Keep)
    }
}

#[test]
fn writer_macro_packet_callback_can_receive_context() {
    let mut ctx = Context::default();
    ctx.tick = 77;
    let mut rewriter = ContextAwarePacketRewriter::default();

    DemoRewriter::rewrite_packet_message(&mut rewriter, &ctx, 77, 9, &[]).unwrap();

    assert_eq!(rewriter.context_tick, 77);
}

#[test]
fn writer_macro_typed_packet_callback_can_receive_msg_type() {
    let ctx = Context::default();
    let mut rewriter = ContextAwarePacketRewriter::default();
    let payload = CNetMsgTick::default().encode_to_vec();

    DemoRewriter::rewrite_packet_message(
        &mut rewriter,
        &ctx,
        77,
        NetMessages::NetTick as i32,
        &payload,
    )
    .unwrap();

    assert_eq!(rewriter.typed_msg_type, NetMessages::NetTick as i32);
}
