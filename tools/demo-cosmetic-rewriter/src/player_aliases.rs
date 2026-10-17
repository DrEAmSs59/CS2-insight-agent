// ---------------------------------------------------------------------------------------------
// Copyright (c) unicbm. All rights reserved.
// Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
// ---------------------------------------------------------------------------------------------

//! Names-only offline rewrite. Identity numbers, entity handles and gameplay stay intact.
use anyhow::{bail, Context as _, Result};
use serde::Serialize;
use source2_demo::error::ParserError;
use source2_demo::prelude::*;
use source2_demo::proto::prost::encoding::{
    decode_key, decode_varint, encode_key, encode_varint, skip_field, WireType,
};
use source2_demo::proto::{
    ccs_usr_msg_end_of_match_all_players_data::PlayerData, CMsgPlayerInfo,
    CMsgSource1LegacyGameEvent, CMsgSource1LegacyGameEventList, Message,
};
use source2_demo::writer::{
    DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests, StringTableEntryUpdate,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::path::Path;

use crate::header::validate_demo_layout;
use crate::workflow::{ensure_same_demo_metadata, resolve_new_output, TempArtifact};

pub fn validate_alias(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.chars().any(char::is_control) {
        bail!("nickname must be nonblank and contain no control characters");
    }
    // Steam's UTF-16 bound plus CS2 char[128], including its trailing NUL.
    if name.encode_utf16().count() > 32 || name.len() > 127 {
        bail!("nickname exceeds 32 UTF-16 units or 127 UTF-8 bytes");
    }
    Ok(())
}

#[derive(Default, Debug, Clone, Serialize)]
pub struct AliasReport {
    pub players: BTreeSet<String>,
    pub replaced_fields: usize,
    pub materialized_fields: usize,
    pub userinfo_entries: usize,
    pub end_match_entries: usize,
    pub event_name_fields: usize,
}

// Preserve every non-name field verbatim, including fields unknown to our protobuf
// version. Only lengths enclosing an edited string/message are re-encoded.
fn edit_bytes_fields(
    mut bytes: &[u8],
    mut edit: impl FnMut(u32, &[u8]) -> std::result::Result<Option<Vec<u8>>, ParserError>,
) -> std::result::Result<Option<Vec<u8>>, ParserError> {
    let mut output = Vec::with_capacity(bytes.len());
    let mut changed = false;
    while !bytes.is_empty() {
        let start = bytes;
        let (tag, wire) = decode_key(&mut bytes)?;
        let value = bytes;
        skip_field(wire, tag, &mut bytes, Default::default())?;
        if wire == WireType::LengthDelimited {
            let mut data = value;
            let len = decode_varint(&mut data)? as usize;
            if let Some(replacement) = edit(tag, &data[..len])? {
                encode_key(tag, wire, &mut output);
                encode_varint(replacement.len() as u64, &mut output);
                output.extend_from_slice(&replacement);
                changed = true;
                continue;
            }
        }
        output.extend_from_slice(&start[..start.len() - bytes.len()]);
    }
    Ok(changed.then_some(output))
}

fn set_name(bytes: &[u8], tag: u32, name: &str) -> std::result::Result<Vec<u8>, ParserError> {
    let mut found = false;
    let result = edit_bytes_fields(bytes, |field, _| {
        if field != tag {
            return Ok(None);
        }
        found = true;
        Ok(Some(name.as_bytes().to_vec()))
    })?;
    let mut output = result.unwrap_or_else(|| bytes.to_vec());
    if !found {
        encode_key(tag, WireType::LengthDelimited, &mut output);
        encode_varint(name.len() as u64, &mut output);
        output.extend_from_slice(name.as_bytes());
    }
    Ok(output)
}

fn parse_network_id(value: &str) -> Option<u64> {
    const INDIVIDUAL_BASE: u64 = 76561197960265728;
    if let Ok(id) = value.parse::<u64>() {
        return (id != 0).then_some(id);
    }
    let account = if let Some(value) = value
        .strip_prefix("[U:1:")
        .and_then(|v| v.strip_suffix(']'))
    {
        value.parse::<u32>().ok()?
    } else {
        let value = value
            .strip_prefix("STEAM_0:")
            .or_else(|| value.strip_prefix("STEAM_1:"))?;
        let (parity, half) = value.split_once(':')?;
        let parity = parity.parse::<u32>().ok().filter(|v| *v <= 1)?;
        half.parse::<u32>()
            .ok()?
            .checked_mul(2)?
            .checked_add(parity)?
    };
    (account != 0).then_some(INDIVIDUAL_BASE + u64::from(account))
}

struct AliasRewriter {
    aliases: BTreeMap<u64, String>,
    report: AliasReport,
    events: BTreeMap<i32, (String, Vec<String>)>,
    user_ids: BTreeMap<i32, u64>,
}

impl AliasRewriter {
    fn track_userinfo(&mut self, info: &CMsgPlayerInfo) {
        if let Some(user_id) = info.userid {
            self.user_ids.remove(&user_id);
            let xuid = info.xuid.filter(|id| *id != 0);
            let steamid = info.steamid.filter(|id| *id != 0);
            if info.fakeplayer == Some(true)
                || matches!((xuid, steamid), (Some(a), Some(b)) if a != b)
            {
                return;
            }
            if let Some(id) = xuid.or(steamid) {
                self.user_ids.insert(user_id, id);
            }
        }
    }

    fn rewrite_event(
        &mut self,
        payload: &[u8],
    ) -> std::result::Result<MessageRewrite, ParserError> {
        let event = CMsgSource1LegacyGameEvent::decode(payload)?;
        let Some((name, fields)) = self.events.get(&event.eventid()) else {
            return Ok(MessageRewrite::Keep);
        };
        if !matches!(
            name.as_str(),
            "player_connect" | "player_connect_client" | "player_changename" | "player_disconnect"
        ) || fields.len() != event.keys.len()
        {
            return Ok(MessageRewrite::Keep);
        }
        let user_id = fields.iter().zip(&event.keys).find_map(|(field, value)| {
            (field == "userid")
                .then(|| value.val_long.or(value.val_short).or(value.val_byte))
                .flatten()
        });
        // Match identities, never display names or controller/player slot guesses.
        // Explicit but unknown identities (BOT, pending, another player) must not
        // fall back to an old userid mapping after a reconnect.
        let mut has_identity = false;
        let mut identities = BTreeSet::new();
        let mut invalid_identity = false;
        for (field, value) in fields.iter().zip(&event.keys) {
            if matches!(
                field.as_str(),
                "networkid" | "steamid" | "steamid64" | "xuid"
            ) {
                has_identity = true;
                let id = value
                    .val_uint64
                    .filter(|id| *id != 0)
                    .or_else(|| value.val_string.as_deref().and_then(parse_network_id));
                if let Some(id) = id {
                    identities.insert(id);
                } else {
                    invalid_identity = true;
                }
            }
        }
        let explicit = (!invalid_identity && identities.len() == 1)
            .then(|| *identities.iter().next().unwrap());
        let connect = matches!(name.as_str(), "player_connect" | "player_connect_client");
        let id = if has_identity || connect {
            explicit
        } else {
            user_id.and_then(|user_id| self.user_ids.get(&user_id).copied())
        };
        if let Some(user_id) = user_id {
            if connect || has_identity || name == "player_disconnect" {
                self.user_ids.remove(&user_id);
            }
            if (connect || has_identity) && name != "player_disconnect" {
                if let Some(id) = id {
                    self.user_ids.insert(user_id, id);
                }
            }
        }
        if name == "player_disconnect" {
            return Ok(MessageRewrite::Keep);
        }
        let Some(alias) = id.and_then(|id| self.aliases.get(&id)) else {
            return Ok(MessageRewrite::Keep);
        };
        let mut index = 0;
        let mut count = 0;
        let changed = edit_bytes_fields(payload, |tag, bytes| {
            if tag != 3 {
                return Ok(None);
            }
            let field = fields.get(index).map(String::as_str);
            let value = event.keys.get(index);
            index += 1;
            let is_name = if connect {
                field == Some("name")
            } else {
                matches!(field, Some("oldname" | "newname"))
            };
            if is_name
                && value
                    .and_then(|value| value.val_string.as_deref())
                    .is_some_and(|current| current != alias)
            {
                count += 1;
                return Ok(Some(set_name(bytes, 2, alias)?));
            }
            Ok(None)
        })?;
        self.report.event_name_fields += count;
        Ok(changed
            .map(MessageRewrite::Replace)
            .unwrap_or(MessageRewrite::Keep))
    }

    fn is_controller(entity: &Entity) -> bool {
        // Index zero is a shared class baseline, never personalize it.
        entity.index() != 0 && entity.class().name() == "CCSPlayerController"
    }

    fn alias(&mut self, entity: &Entity) -> Option<String> {
        let FieldValue::Unsigned64(id) = entity.get_property("m_steamID").ok()? else {
            return None;
        };
        let alias = self.aliases.get(id)?.clone();
        self.report.players.insert(id.to_string());
        Some(alias)
    }
}

impl DemoRewriter for AliasRewriter {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::ENTITY_FIELDS
            | RewriteInterests::STRING_TABLE_ENTRIES
            | RewriteInterests::PACKET_MESSAGE
    }

    fn rewrite_packet_message(
        &mut self,
        _: &Context,
        _: u32,
        msg_type: i32,
        payload: &[u8],
    ) -> std::result::Result<MessageRewrite, ParserError> {
        if msg_type == EBaseGameEvents::GeSource1LegacyGameEventList as i32 {
            let list = CMsgSource1LegacyGameEventList::decode(payload)?;
            self.events = list
                .descriptors
                .into_iter()
                .map(|event| {
                    (
                        event.eventid(),
                        (
                            event.name().to_owned(),
                            event.keys.iter().map(|key| key.name().to_owned()).collect(),
                        ),
                    )
                })
                .collect();
            return Ok(MessageRewrite::Keep);
        }
        if msg_type == EBaseGameEvents::GeSource1LegacyGameEvent as i32 {
            return self.rewrite_event(payload);
        }
        if msg_type != ECstrike15UserMessages::CsUmEndOfMatchAllPlayersData as i32 {
            return Ok(MessageRewrite::Keep);
        }
        let changed = edit_bytes_fields(payload, |tag, bytes| {
            if tag != 1 {
                return Ok(None);
            }
            let player = PlayerData::decode(bytes)?;
            let Some(alias) = self.aliases.get(&player.xuid.unwrap_or_default()) else {
                return Ok(None);
            };
            self.report.end_match_entries += 1;
            Ok(Some(set_name(bytes, 3, alias)?))
        })?;
        Ok(changed
            .map(MessageRewrite::Replace)
            .unwrap_or(MessageRewrite::Keep))
    }

    fn should_track_entity(&mut self, _: &Context, _: EntityEvents, entity: &Entity) -> bool {
        Self::is_controller(entity)
    }

    fn should_rewrite_entity(&mut self, _: &Context, _: EntityEvents, entity: &Entity) -> bool {
        Self::is_controller(entity)
    }

    fn replace_entity_field(
        &mut self,
        _: &Context,
        _: EntityEvents,
        entity: &Entity,
        field: &str,
        value: &FieldValue,
    ) -> Option<FieldValue> {
        if field != "m_iszPlayerName" {
            return None;
        }
        let alias = self.alias(entity)?;
        if matches!(value, FieldValue::String(current) if current == &alias) {
            return None;
        }
        self.report.replaced_fields += 1;
        Some(FieldValue::String(alias))
    }

    fn append_entity_fields(
        &mut self,
        _: &Context,
        _: EntityEvents,
        entity: &Entity,
    ) -> Vec<(String, FieldValue)> {
        let Some(alias) = self.alias(entity) else {
            return Vec::new();
        };
        if matches!(entity.get_property("m_iszPlayerName"), Ok(FieldValue::String(current)) if current == &alias)
        {
            return Vec::new();
        }
        // A player's original name can be inherited entirely from the baseline.
        // Append to this real entity only, including full/seek snapshots.
        self.report.materialized_fields += 1;
        vec![("m_iszPlayerName".to_owned(), FieldValue::String(alias))]
    }

    fn rewrite_string_table_entry(
        &mut self,
        _: &Context,
        _: u32,
        table: &str,
        entry: &mut StringTableEntryUpdate,
    ) -> std::result::Result<(), ParserError> {
        if table != "userinfo" {
            return Ok(());
        }
        let Some(bytes) = entry.value() else {
            return Ok(());
        };
        let info = CMsgPlayerInfo::decode(bytes)?;
        self.track_userinfo(&info);
        let alias = self
            .aliases
            .get(&info.xuid.unwrap_or_default())
            .or_else(|| self.aliases.get(&info.steamid.unwrap_or_default()));
        if let Some(alias) = alias {
            if info.name.as_ref() != Some(alias) {
                entry.set_value(set_name(bytes, 1, alias)?);
                self.report.userinfo_entries += 1;
            }
        }
        Ok(())
    }
}

pub fn rewrite_player_aliases(
    input: &Path,
    output: &Path,
    aliases: BTreeMap<String, String>,
) -> Result<AliasReport> {
    if aliases.is_empty() || aliases.len() > 64 {
        bail!("expected 1 to 64 player aliases");
    }
    let mut parsed = BTreeMap::new();
    for (id, alias) in aliases {
        let value: u64 = id.parse().context("invalid SteamID64")?;
        if value == 0 || value.to_string() != id {
            bail!("SteamID64 must be canonical nonzero decimal");
        }
        validate_alias(&alias)?;
        parsed.insert(value, alias);
    }
    let input = fs::canonicalize(input)?;
    let output = resolve_new_output(output)?;
    if input == output {
        bail!("input demo cannot be overwritten");
    }
    let original_layout = validate_demo_layout(&input)?;
    let expected: BTreeSet<String> = parsed.keys().map(u64::to_string).collect();
    let (mut temp, file) = TempArtifact::create(&output, "aliases")?;
    let mut writer = DemoWriter::from_reader(File::open(&input)?, file)?;
    let state = writer.add_rewriter(AliasRewriter {
        aliases: parsed,
        report: AliasReport::default(),
        events: BTreeMap::new(),
        user_ids: BTreeMap::new(),
    });
    writer.run()?;
    drop(writer);
    let report = state.borrow().report.clone();
    if report.players != expected {
        bail!(
            "alias targets not present in demo: {:?}",
            &expected - &report.players
        );
    }
    let layout = validate_demo_layout(temp.path())?;
    ensure_same_demo_metadata(&original_layout, &layout)?;
    temp.commit_to(&output)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use source2_demo::proto::c_msg_source1_legacy_game_event::KeyT;

    const PLAYER: u64 = 76561199032006224;

    fn event_rewriter() -> AliasRewriter {
        AliasRewriter {
            aliases: BTreeMap::from([(PLAYER, "新名字".to_owned())]),
            report: AliasReport::default(),
            events: BTreeMap::from([
                (
                    1,
                    (
                        "player_connect".to_owned(),
                        vec!["userid".into(), "networkid".into(), "name".into()],
                    ),
                ),
                (
                    2,
                    (
                        "player_changename".to_owned(),
                        vec!["userid".into(), "oldname".into(), "newname".into()],
                    ),
                ),
                (3, ("player_disconnect".to_owned(), vec!["userid".into()])),
            ]),
            user_ids: BTreeMap::new(),
        }
    }

    fn event(id: i32, strings: &[&str]) -> CMsgSource1LegacyGameEvent {
        let mut keys = vec![KeyT {
            r#type: Some(3),
            val_long: Some(7),
            ..Default::default()
        }];
        keys.extend(strings.iter().map(|value| KeyT {
            r#type: Some(1),
            val_string: Some((*value).to_owned()),
            ..Default::default()
        }));
        CMsgSource1LegacyGameEvent {
            eventid: Some(id),
            keys,
            server_tick: Some(123),
            ..Default::default()
        }
    }

    fn patched(
        rewriter: &mut AliasRewriter,
        event: &CMsgSource1LegacyGameEvent,
    ) -> CMsgSource1LegacyGameEvent {
        match rewriter.rewrite_event(&event.encode_to_vec()).unwrap() {
            MessageRewrite::Replace(bytes) => {
                CMsgSource1LegacyGameEvent::decode(bytes.as_slice()).unwrap()
            }
            MessageRewrite::Keep => event.clone(),
            _ => panic!("unexpected rewrite"),
        }
    }

    #[test]
    fn connection_and_name_change_share_exact_identity_preserving_other_bytes() {
        let mut rewriter = event_rewriter();
        let connect = event(1, &[&PLAYER.to_string(), "old"]);
        let mut input = connect.encode_to_vec();
        // Unknown fields in both the key and event must survive verbatim.
        let key_unknown = [0xf8, 0x07, 0x81, 0x00];
        input = edit_bytes_fields(&input, |tag, bytes| {
            if tag != 3 {
                return Ok(None);
            }
            let mut key = bytes.to_vec();
            key.extend_from_slice(&key_unknown);
            Ok(Some(key))
        })
        .unwrap()
        .unwrap();
        input.extend_from_slice(&key_unknown);
        let MessageRewrite::Replace(output) = rewriter.rewrite_event(&input).unwrap() else {
            panic!("expected alias");
        };
        assert!(output.ends_with(&key_unknown));
        assert_eq!(
            output
                .windows(key_unknown.len())
                .filter(|bytes| *bytes == key_unknown)
                .count(),
            4
        );
        let mut expected = connect;
        expected.keys[2].val_string = Some("新名字".into());
        assert_eq!(
            CMsgSource1LegacyGameEvent::decode(output.as_slice()).unwrap(),
            expected
        );
        let mut expected = event(2, &["old", "later"]);
        let output = patched(&mut rewriter, &expected);
        expected.keys[1].val_string = Some("新名字".into());
        expected.keys[2].val_string = Some("新名字".into());
        assert_eq!(output, expected);
    }

    #[test]
    fn reconnects_unknown_identities_and_disconnects_cannot_inherit_aliases() {
        for next_identity in ["BOT", "STEAM_ID_PENDING", "76561199032006225"] {
            let mut rewriter = event_rewriter();
            patched(&mut rewriter, &event(1, &[&PLAYER.to_string(), "same"]));
            let other = event(1, &[next_identity, "same"]);
            assert_eq!(patched(&mut rewriter, &other), other);
            let change = event(2, &["same", "same"]);
            assert_eq!(patched(&mut rewriter, &change), change);
        }
        let mut rewriter = event_rewriter();
        rewriter.user_ids.insert(7, PLAYER);
        patched(&mut rewriter, &event(3, &[]));
        let change = event(2, &["same", "same"]);
        assert_eq!(patched(&mut rewriter, &change), change);
    }

    #[test]
    fn unknown_events_malformed_shapes_and_explicit_mismatches_are_untouched() {
        let mut rewriter = event_rewriter();
        rewriter.user_ids.insert(7, PLAYER);
        for candidate in [event(99, &["old", "new"]), event(2, &["missing"])] {
            assert_eq!(patched(&mut rewriter, &candidate), candidate);
        }
        rewriter.events.get_mut(&2).unwrap().1.push("xuid".into());
        let mut candidate = event(2, &["old", "new"]);
        candidate.keys.push(KeyT {
            val_uint64: Some(PLAYER + 1),
            ..Default::default()
        });
        assert_eq!(patched(&mut rewriter, &candidate), candidate);
    }

    #[test]
    fn userinfo_binds_userid_and_clears_bots_and_conflicting_identities() {
        let mut rewriter = event_rewriter();
        let info = CMsgPlayerInfo {
            userid: Some(7),
            xuid: Some(PLAYER),
            ..Default::default()
        };
        rewriter.track_userinfo(&info);
        let change = event(2, &["old", "new"]);
        assert_eq!(
            patched(&mut rewriter, &change).keys[2]
                .val_string
                .as_deref(),
            Some("新名字")
        );
        for replacement in [
            CMsgPlayerInfo {
                fakeplayer: Some(true),
                ..info.clone()
            },
            CMsgPlayerInfo {
                steamid: Some(PLAYER + 1),
                ..info.clone()
            },
            CMsgPlayerInfo {
                xuid: Some(0),
                ..info.clone()
            },
        ] {
            rewriter.track_userinfo(&info);
            rewriter.track_userinfo(&replacement);
            assert_eq!(patched(&mut rewriter, &change), change);
        }
    }

    #[test]
    fn event_descriptors_are_registered_through_packet_callback() {
        use source2_demo::proto::c_msg_source1_legacy_game_event_list::{DescriptorT, KeyT};
        let mut rewriter = event_rewriter();
        rewriter.events.clear();
        let descriptors = CMsgSource1LegacyGameEventList {
            descriptors: vec![DescriptorT {
                eventid: Some(1),
                name: Some("player_connect_client".into()),
                keys: ["userid", "networkid", "name"]
                    .iter()
                    .map(|name| KeyT {
                        name: Some((*name).into()),
                        ..Default::default()
                    })
                    .collect(),
            }],
        };
        let ctx = Context::default();
        rewriter
            .rewrite_packet_message(
                &ctx,
                0,
                EBaseGameEvents::GeSource1LegacyGameEventList as i32,
                &descriptors.encode_to_vec(),
            )
            .unwrap();
        let MessageRewrite::Replace(bytes) = rewriter
            .rewrite_packet_message(
                &ctx,
                1,
                EBaseGameEvents::GeSource1LegacyGameEvent as i32,
                &event(1, &[&PLAYER.to_string(), "old"]).encode_to_vec(),
            )
            .unwrap()
        else {
            panic!("expected connection alias");
        };
        assert_eq!(
            CMsgSource1LegacyGameEvent::decode(bytes.as_slice())
                .unwrap()
                .keys[2]
                .val_string
                .as_deref(),
            Some("新名字")
        );
    }

    #[test]
    fn network_id_formats_are_exact_and_checked() {
        let account = PLAYER as u32;
        for value in [
            PLAYER.to_string(),
            format!("[U:1:{account}]"),
            format!("STEAM_0:{}:{}", account % 2, account / 2),
            format!("STEAM_1:{}:{}", account % 2, account / 2),
        ] {
            assert_eq!(parse_network_id(&value), Some(PLAYER));
        }
        for value in [
            "BOT",
            "0",
            "[U:1:4294967296]",
            "STEAM_1:2:10",
            "STEAM_1:1:4294967295",
        ] {
            assert_eq!(parse_network_id(value), None);
        }
    }
    #[test]
    fn unicode_names_are_not_an_ascii_whitelist() {
        for name in [
            "京介",
            "Умри",
            "a b",
            "<donk>&\"",
            "🦋 player",
            "名字\u{200d}✨",
            " same ",
        ] {
            assert!(validate_alias(name).is_ok(), "{name}");
        }
        assert!(validate_alias(&"a".repeat(32)).is_ok());
        assert!(validate_alias(&"🦋".repeat(16)).is_ok());
    }
    #[test]
    fn rejects_unsafe_or_oversized_names() {
        for name in ["", "  ", "x\0y", "x\ny", "x\ry", "x\ty"] {
            assert!(validate_alias(name).is_err());
        }
        assert!(validate_alias(&"a".repeat(33)).is_err());
        assert!(validate_alias(&"🦋".repeat(17)).is_err());
    }

    #[test]
    fn protobuf_name_patch_preserves_unknown_fields_and_identity() {
        let info = CMsgPlayerInfo {
            name: Some("old".into()),
            xuid: Some(76561199032006224),
            userid: Some(7),
            ..Default::default()
        };
        let mut bytes = info.encode_to_vec();
        let unknown = [0xf8, 0x07, 0x81, 0x00]; // Unknown field 127, noncanonical varint kept byte-for-byte.
        bytes.extend_from_slice(&unknown);
        let output = set_name(&bytes, 1, "京介 🦋").unwrap();
        assert!(output.ends_with(&unknown));
        let patched = CMsgPlayerInfo::decode(output.as_slice()).unwrap();
        assert_eq!(
            patched,
            CMsgPlayerInfo {
                name: Some("京介 🦋".into()),
                ..info
            }
        );
    }
}
