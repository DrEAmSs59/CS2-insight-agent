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
    ccs_usr_msg_end_of_match_all_players_data::PlayerData, CMsgPlayerInfo, Message,
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

struct AliasRewriter {
    aliases: BTreeMap<u64, String>,
    report: AliasReport,
}

impl AliasRewriter {
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
