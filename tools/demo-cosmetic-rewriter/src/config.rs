use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

const STEAM_ID64_ACCOUNT_BASE: u64 = 76_561_197_960_265_728;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema_version: u32,
    pub players: Vec<PlayerConfig>,
    pub rewrites: Vec<RewriteRule>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlayerConfig {
    pub id: String,
    #[serde(default)]
    pub account_id: Option<u32>,
    #[serde(default)]
    pub steam_id64: Option<String>,
    #[serde(default)]
    pub name_hint: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RewriteRule {
    pub id: String,
    pub player: String,
    #[serde(default)]
    pub team: Team,
    pub entity: EntitySelector,
    pub replacement: CosmeticReplacement,
    #[serde(default)]
    pub missing_fields: MissingFields,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntitySelector {
    pub kind: ItemKind,
    pub class: String,
    pub item_id: ItemIdentity,
    #[serde(default)]
    pub source_definition_index: Option<u16>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Glove,
    Knife,
    Weapon,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(deny_unknown_fields)]
pub struct ItemIdentity {
    pub high: u32,
    pub low: u32,
}

impl ItemIdentity {
    pub fn combined(self) -> u64 {
        (u64::from(self.high) << 32) | u64::from(self.low)
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
pub enum Team {
    #[default]
    #[serde(rename = "ANY", alias = "any")]
    Any,
    #[serde(rename = "T", alias = "t")]
    T,
    #[serde(rename = "CT", alias = "ct")]
    Ct,
}

impl Team {
    pub fn number(self) -> Option<u8> {
        match self {
            Self::Any => None,
            Self::T => Some(2),
            Self::Ct => Some(3),
        }
    }

    pub fn matches(self, actual: Option<u8>) -> bool {
        match self.number() {
            Some(wanted) => actual == Some(wanted),
            None => true,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CosmeticReplacement {
    #[serde(default)]
    pub item_id: Option<ItemIdentity>,
    #[serde(default)]
    pub definition_index: Option<u16>,
    #[serde(default)]
    pub paint_kit: Option<u32>,
    #[serde(default)]
    pub pattern_seed: Option<f32>,
    #[serde(default)]
    pub wear: Option<f32>,
    #[serde(default)]
    pub knife_variant: Option<KnifeVariant>,
    #[serde(default)]
    pub custom_name: Option<String>,
    #[serde(default)]
    pub stickers: Vec<StickerReplacement>,
    #[serde(default)]
    pub charm: Option<CharmReplacement>,
    #[serde(default)]
    pub visual_state: Option<VisualState>,
}

impl CosmeticReplacement {
    pub fn has_finish(&self) -> bool {
        self.paint_kit.is_some() || self.pattern_seed.is_some() || self.wear.is_some()
    }

    pub fn is_empty(&self) -> bool {
        self.item_id.is_none()
            && self.definition_index.is_none()
            && !self.has_finish()
            && self.knife_variant.is_none()
            && self.custom_name.is_none()
            && self.stickers.is_empty()
            && self.charm.is_none()
            && self.visual_state.is_none()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VisualState {
    pub mesh_group_mask: String,
    pub body_group: i32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnifeVariant {
    pub subclass_token: u32,
    pub model_resource_handle: String,
    pub mapping_source: KnifeMappingSource,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KnifeMappingSource {
    ObservedInInput,
    Versioned {
        patch_versions: Vec<i32>,
        source: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StickerReplacement {
    pub slot: u8,
    pub sticker_id: u32,
    #[serde(default)]
    pub expected_current_id: Option<u32>,
}

impl StickerReplacement {
    pub fn attribute_definition_index(&self) -> u16 {
        113 + u16::from(self.slot) * 4
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CharmReplacement {
    pub charm_id: u32,
    #[serde(default)]
    pub expected_current_id: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissingFields {
    #[serde(default)]
    pub econ: MissingEconPolicy,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MissingEconPolicy {
    #[default]
    ExistingOnly,
    Materialize,
}

#[derive(Clone, Debug)]
pub struct ValidatedConfig {
    pub players: Vec<ValidatedPlayer>,
    pub rules: Vec<ValidatedRule>,
}

#[derive(Clone, Debug)]
pub struct ValidatedPlayer {
    pub id: String,
    pub account_id: u32,
    pub steam_id64: u64,
    pub name_hint: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ValidatedRule {
    pub id: String,
    pub player_id: String,
    pub account_id: u32,
    pub team: Team,
    pub entity: EntitySelector,
    pub replacement: ValidatedReplacement,
    pub missing_fields: MissingFields,
}

#[derive(Clone, Debug)]
pub struct ValidatedReplacement {
    pub item_id: Option<ItemIdentity>,
    pub definition_index: Option<u16>,
    pub paint_kit: Option<u32>,
    pub pattern_seed: Option<f32>,
    pub wear: Option<f32>,
    pub knife_variant: Option<ValidatedKnifeVariant>,
    pub custom_name: Option<String>,
    pub stickers: Vec<StickerReplacement>,
    pub charm: Option<CharmReplacement>,
    pub visual_state: Option<ValidatedVisualState>,
}

#[derive(Clone, Debug)]
pub struct ValidatedVisualState {
    pub mesh_group_mask: u64,
    pub body_group: i32,
}

#[derive(Clone, Debug)]
pub struct ValidatedKnifeVariant {
    pub subclass_token: u32,
    pub model_resource_handle: u64,
    pub mapping_source: KnifeMappingSource,
}

impl Config {
    pub fn from_path(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path)
            .with_context(|| format!("failed to read config {}", path.display()))?;
        serde_json::from_str(&text)
            .with_context(|| format!("failed to parse config {}", path.display()))
    }

    pub fn validate(self) -> Result<ValidatedConfig> {
        if self.schema_version != 1 {
            bail!(
                "unsupported config schema_version {}; expected 1",
                self.schema_version
            );
        }
        if self.players.is_empty() {
            bail!("config must define at least one player");
        }
        if self.rewrites.is_empty() {
            bail!("config must define at least one rewrite rule");
        }

        let mut players_by_id = BTreeMap::new();
        let mut players = Vec::with_capacity(self.players.len());
        for raw in self.players {
            let id = nonempty(&raw.id, "player id")?.to_owned();
            if players_by_id.contains_key(&id) {
                bail!("duplicate player id {id:?}");
            }
            let parsed_steam_id = raw
                .steam_id64
                .as_deref()
                .map(|value| parse_decimal_u64(value, "steam_id64"))
                .transpose()?;
            let derived_account = parsed_steam_id
                .map(account_id_from_steam_id64)
                .transpose()?;
            let account_id = match (raw.account_id, derived_account) {
                (Some(account), Some(derived)) if account != derived => bail!(
                    "player {id:?} account_id {account} does not match steam_id64 account {derived}"
                ),
                (Some(account), _) => account,
                (None, Some(account)) => account,
                (None, None) => bail!(
                    "player {id:?} needs account_id or steam_id64; name_hint is auxiliary only"
                ),
            };
            if account_id == 0 {
                bail!("player {id:?} account_id must be non-zero");
            }
            let steam_id64 =
                parsed_steam_id.unwrap_or(STEAM_ID64_ACCOUNT_BASE + u64::from(account_id));
            let name_hint = raw
                .name_hint
                .map(|name| nonempty(&name, "name_hint").map(str::to_owned))
                .transpose()?;
            let player = ValidatedPlayer {
                id: id.clone(),
                account_id,
                steam_id64,
                name_hint,
            };
            players_by_id.insert(id, player.clone());
            players.push(player);
        }

        let mut rule_ids = BTreeSet::new();
        let mut rules = Vec::with_capacity(self.rewrites.len());
        for raw in self.rewrites {
            let id = nonempty(&raw.id, "rewrite rule id")?.to_owned();
            if !rule_ids.insert(id.clone()) {
                bail!("duplicate rewrite rule id {id:?}");
            }
            let player = players_by_id.get(&raw.player).ok_or_else(|| {
                anyhow::anyhow!("rule {id:?} references unknown player {:?}", raw.player)
            })?;
            validate_entity(&id, &raw.entity, raw.missing_fields.econ)?;
            let replacement = validate_replacement(
                &id,
                raw.entity.kind,
                raw.missing_fields.econ,
                raw.replacement,
            )?;
            rules.push(ValidatedRule {
                id,
                player_id: player.id.clone(),
                account_id: player.account_id,
                team: raw.team,
                entity: raw.entity,
                replacement,
                missing_fields: raw.missing_fields,
            });
        }

        for left_index in 0..rules.len() {
            for right_index in (left_index + 1)..rules.len() {
                let left = &rules[left_index];
                let right = &rules[right_index];
                if left.account_id == right.account_id
                    && left.entity.kind == right.entity.kind
                    && left.entity.class == right.entity.class
                    && left.entity.item_id == right.entity.item_id
                    && left.entity.source_definition_index == right.entity.source_definition_index
                {
                    bail!(
                        "rewrite rules {:?} and {:?} select the same stable econ identity; a reused item is rewritten identity-wide and cannot have separate team variants",
                        left.id,
                        right.id
                    );
                }
            }
        }

        Ok(ValidatedConfig { players, rules })
    }
}

impl ValidatedConfig {
    pub fn load(path: &Path) -> Result<Self> {
        Config::from_path(path)?.validate()
    }

    pub fn has_materialization(&self) -> bool {
        self.rules
            .iter()
            .any(|rule| rule.missing_fields.econ == MissingEconPolicy::Materialize)
    }

    pub fn tracked_classes(&self) -> BTreeSet<&str> {
        self.rules
            .iter()
            .map(|rule| rule.entity.class.as_str())
            .collect()
    }
}

fn validate_entity(
    rule_id: &str,
    entity: &EntitySelector,
    missing_econ: MissingEconPolicy,
) -> Result<()> {
    nonempty(&entity.class, "entity class")?;
    let zero_identity = entity.item_id.combined() == 0;
    if zero_identity && missing_econ != MissingEconPolicy::Materialize {
        bail!(
            "rule {rule_id:?} may select a zero item identity only with missing_fields.econ=materialize"
        );
    }
    if entity.source_definition_index == Some(0) {
        bail!("rule {rule_id:?} source_definition_index must be non-zero");
    }
    if !zero_identity && entity.source_definition_index.is_some() {
        bail!("rule {rule_id:?} source_definition_index is only valid for a zero item identity");
    }
    if missing_econ == MissingEconPolicy::ExistingOnly && entity.source_definition_index.is_some() {
        bail!(
            "rule {rule_id:?} source_definition_index is only valid with missing_fields.econ=materialize"
        );
    }
    match entity.kind {
        ItemKind::Glove if entity.class != "CCSPlayerPawn" => {
            bail!("rule {rule_id:?} glove entity class must be CCSPlayerPawn")
        }
        ItemKind::Glove if entity.source_definition_index.is_some() => {
            bail!("rule {rule_id:?} glove selectors do not use source_definition_index")
        }
        ItemKind::Knife if entity.class != "CKnife" => {
            bail!("rule {rule_id:?} knife entity class must be CKnife")
        }
        ItemKind::Weapon if entity.class == "CCSPlayerPawn" || entity.class == "CKnife" => {
            bail!("rule {rule_id:?} weapon entity class is not a normal weapon")
        }
        _ => {}
    }
    if zero_identity && entity.kind != ItemKind::Glove && entity.source_definition_index.is_none() {
        bail!(
            "rule {rule_id:?} needs source_definition_index to materialize a zero-ID knife or weapon"
        );
    }
    Ok(())
}

fn validate_replacement(
    rule_id: &str,
    kind: ItemKind,
    missing_econ: MissingEconPolicy,
    replacement: CosmeticReplacement,
) -> Result<ValidatedReplacement> {
    if replacement.is_empty() {
        bail!("rule {rule_id:?} replacement is empty");
    }
    let finish_count = [
        replacement.paint_kit.is_some(),
        replacement.pattern_seed.is_some(),
        replacement.wear.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count();
    if finish_count != 0 && finish_count != 3 {
        bail!("rule {rule_id:?} must provide paint_kit, pattern_seed, and wear together");
    }
    if let Some(paint) = replacement.paint_kit {
        if paint == 0 || paint > 16_777_216 {
            bail!("rule {rule_id:?} paint_kit is outside exact f32 integer range");
        }
    }
    if let Some(seed) = replacement.pattern_seed {
        if !seed.is_finite() || !(0.0..=16_777_216.0).contains(&seed) {
            bail!("rule {rule_id:?} pattern_seed must be finite and between 0 and 16777216");
        }
    }
    if let Some(wear) = replacement.wear {
        if !wear.is_finite() || !(0.0..=1.0).contains(&wear) {
            bail!("rule {rule_id:?} wear must be finite and between 0 and 1");
        }
    }
    if replacement.definition_index == Some(0) {
        bail!("rule {rule_id:?} definition_index must be non-zero");
    }
    if replacement
        .item_id
        .is_some_and(|item_id| item_id.combined() == 0)
    {
        bail!("rule {rule_id:?} replacement item identity must be non-zero");
    }
    if replacement.item_id.is_some() && missing_econ != MissingEconPolicy::Materialize {
        bail!(
            "rule {rule_id:?} replacement item_id is only valid with missing_fields.econ=materialize"
        );
    }
    if missing_econ == MissingEconPolicy::Materialize {
        if replacement.item_id.is_none() {
            bail!("rule {rule_id:?} materialization needs a non-zero replacement item_id");
        }
        if replacement.definition_index.is_none() || finish_count != 3 {
            bail!("rule {rule_id:?} materialization needs definition_index and a complete finish");
        }
        if kind != ItemKind::Glove && replacement.visual_state.is_none() {
            bail!("rule {rule_id:?} knife/weapon materialization needs an explicit visual_state");
        }
        if !replacement.stickers.is_empty() || replacement.charm.is_some() {
            bail!("rule {rule_id:?} materialization does not support sticker or charm rewrites");
        }
    }

    let custom_name = replacement
        .custom_name
        .map(|name| nonempty(&name, "custom_name").map(str::to_owned))
        .transpose()?;
    let visual_state = replacement
        .visual_state
        .map(|state| {
            Ok::<ValidatedVisualState, anyhow::Error>(ValidatedVisualState {
                mesh_group_mask: parse_decimal_u64(
                    &state.mesh_group_mask,
                    "visual_state.mesh_group_mask",
                )?,
                body_group: state.body_group,
            })
        })
        .transpose()?;

    let mut sticker_slots = BTreeSet::new();
    for sticker in &replacement.stickers {
        if sticker.slot > 4 {
            bail!(
                "rule {rule_id:?} sticker slot {} is outside 0..=4",
                sticker.slot
            );
        }
        if !sticker_slots.insert(sticker.slot) {
            bail!("rule {rule_id:?} repeats sticker slot {}", sticker.slot);
        }
        if sticker.sticker_id == 0 {
            bail!("rule {rule_id:?} sticker_id must be non-zero");
        }
    }
    if replacement
        .charm
        .as_ref()
        .is_some_and(|charm| charm.charm_id == 0)
    {
        bail!("rule {rule_id:?} charm_id must be non-zero");
    }

    match kind {
        ItemKind::Glove => {
            if replacement.definition_index.is_none() || finish_count != 3 {
                bail!(
                    "rule {rule_id:?} glove replacement needs definition_index and a complete finish"
                );
            }
            if replacement.knife_variant.is_some()
                || !replacement.stickers.is_empty()
                || replacement.charm.is_some()
            {
                bail!("rule {rule_id:?} glove replacement contains unsupported fields");
            }
        }
        ItemKind::Knife => {
            if replacement.definition_index.is_none()
                || finish_count != 3
                || replacement.knife_variant.is_none()
            {
                bail!(
                    "rule {rule_id:?} knife replacement needs definition_index, complete finish, and knife_variant"
                );
            }
            if !replacement.stickers.is_empty() || replacement.charm.is_some() {
                bail!("rule {rule_id:?} knife attachments are not supported");
            }
        }
        ItemKind::Weapon => {
            if replacement.knife_variant.is_some() {
                bail!("rule {rule_id:?} normal weapon rules cannot contain knife_variant");
            }
            if missing_econ == MissingEconPolicy::ExistingOnly
                && replacement.definition_index.is_some()
            {
                bail!(
                    "rule {rule_id:?} existing normal weapon rules cannot change definition_index"
                );
            }
            if finish_count == 0
                && replacement.stickers.is_empty()
                && replacement.charm.is_none()
                && custom_name.is_none()
                && visual_state.is_none()
            {
                bail!("rule {rule_id:?} normal weapon replacement has no supported change");
            }
        }
    }

    let knife_variant = replacement
        .knife_variant
        .map(|variant| {
            let model_resource_handle = parse_decimal_u64(
                &variant.model_resource_handle,
                "knife model_resource_handle",
            )?;
            if model_resource_handle == 0 || variant.subclass_token == 0 {
                bail!("rule {rule_id:?} knife model and subclass must be non-zero");
            }
            if let KnifeMappingSource::Versioned {
                patch_versions,
                source,
            } = &variant.mapping_source
            {
                if patch_versions.is_empty() {
                    bail!("rule {rule_id:?} versioned knife mapping needs patch_versions");
                }
                nonempty(source, "knife mapping source")?;
            }
            Ok(ValidatedKnifeVariant {
                subclass_token: variant.subclass_token,
                model_resource_handle,
                mapping_source: variant.mapping_source,
            })
        })
        .transpose()?;

    Ok(ValidatedReplacement {
        item_id: replacement.item_id,
        definition_index: replacement.definition_index,
        paint_kit: replacement.paint_kit,
        pattern_seed: replacement.pattern_seed,
        wear: replacement.wear,
        knife_variant,
        custom_name,
        stickers: replacement.stickers,
        charm: replacement.charm,
        visual_state,
    })
}

fn parse_decimal_u64(value: &str, label: &str) -> Result<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("{label} must be a decimal string");
    }
    trimmed
        .parse::<u64>()
        .with_context(|| format!("{label} is outside u64 range"))
}

fn account_id_from_steam_id64(steam_id64: u64) -> Result<u32> {
    let account = steam_id64
        .checked_sub(STEAM_ID64_ACCOUNT_BASE)
        .ok_or_else(|| anyhow::anyhow!("steam_id64 is below the individual-account base"))?;
    u32::try_from(account).context("steam_id64 account component is outside u32 range")
}

fn nonempty<'a>(value: &'a str, label: &str) -> Result<&'a str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("{label} must not be empty");
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<ValidatedConfig> {
        serde_json::from_str::<Config>(text)?.validate()
    }

    #[test]
    fn name_is_never_a_stable_selector() {
        let error = parse(
            r#"{
                "schema_version": 1,
                "players": [{"id":"p", "name_hint":"name"}],
                "rewrites": [{
                  "id":"w", "player":"p",
                  "entity":{"kind":"weapon","class":"CWeaponGlock","item_id":{"high":1,"low":2}},
                  "replacement":{"paint_kit":1,"pattern_seed":2,"wear":0.1}
                }]
            }"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("name_hint is auxiliary only"));
    }

    #[test]
    fn steam_id_and_account_must_agree() {
        let error = parse(
            r#"{
                "schema_version": 1,
                "players": [{"id":"p", "account_id":1, "steam_id64":"76561197960265730"}],
                "rewrites": [{
                  "id":"w", "player":"p",
                  "entity":{"kind":"weapon","class":"CWeaponGlock","item_id":{"high":1,"low":2}},
                  "replacement":{"paint_kit":1,"pattern_seed":2,"wear":0.1}
                }]
            }"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn team_variants_for_the_same_econ_identity_are_rejected() {
        let error = parse(
            r#"{
              "schema_version":1,
              "players":[{"id":"p","account_id":1}],
              "rewrites":[
                {"id":"a","player":"p","team":"CT","entity":{"kind":"weapon","class":"CWeaponGlock","item_id":{"high":1,"low":2}},"replacement":{"paint_kit":1,"pattern_seed":2,"wear":0.1}},
                {"id":"b","player":"p","team":"T","entity":{"kind":"weapon","class":"CWeaponGlock","item_id":{"high":1,"low":2}},"replacement":{"paint_kit":2,"pattern_seed":3,"wear":0.2}}
              ]
            }"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("rewritten identity-wide"));
    }

    #[test]
    fn fractional_pattern_seed_is_preserved_for_materialization() -> Result<()> {
        let config = parse(
            r#"{
              "schema_version":1,
              "players":[{"id":"p","account_id":1}],
              "rewrites":[{
                "id":"g","player":"p","team":"CT",
                "entity":{"kind":"glove","class":"CCSPlayerPawn","item_id":{"high":0,"low":0}},
                "replacement":{
                  "item_id":{"high":1,"low":2},
                  "definition_index":5030,
                  "paint_kit":10038,
                  "pattern_seed":900.15515,
                  "wear":0.06000001
                },
                "missing_fields":{"econ":"materialize"}
              }]
            }"#,
        )?;
        assert_eq!(config.rules[0].replacement.pattern_seed, Some(900.15515));
        Ok(())
    }

    #[test]
    fn checked_in_examples_validate() -> Result<()> {
        parse(include_str!("../examples/all-features.json"))?;
        parse(include_str!("../examples/zont1x-t-loadout.json"))?;
        Ok(())
    }
}
