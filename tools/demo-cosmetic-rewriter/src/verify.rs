use crate::config::{
    ItemIdentity, ItemKind, KnifeMappingSource, MissingEconPolicy, Team, ValidatedConfig,
    ValidatedRule,
};
use crate::entity::{
    bool_field, custom_name_field, definition_index_field, dynamic_prefix, entity_account_id,
    entity_item_identity, i32_field, item_prefix, string_field, u16_field, u32_field, u64_field,
    u8_field, value, BODY_GROUP_FIELD, CHARM_ATTRIBUTE, GLOVE_CHANGED_FIELD, KNIFE_SUBCLASS_FIELD,
    MESH_GROUP_FIELD, MODEL_FIELD, ORIGINAL_OWNER_ACCOUNT_FIELD, OWNER_ENTITY_FIELD,
    PAINT_ATTRIBUTE, SEED_ATTRIBUTE, TEAM_FIELD, WEAR_ATTRIBUTE,
};
use crate::header::DemoLayout;
use anyhow::{bail, Context as AnyhowContext, Result};
use sha2::{Digest, Sha256};
use source2_demo::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::Command;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SnapshotValue {
    Boolean(bool),
    String(String),
    Float(u32),
    Vector2D([u32; 2]),
    Vector3D([u32; 3]),
    Vector4D([u32; 4]),
    Signed8(i8),
    Signed16(i16),
    Signed32(i32),
    Signed64(i64),
    Unsigned8(u8),
    Unsigned16(u16),
    Unsigned32(u32),
    Unsigned64(u64),
}

impl From<&FieldValue> for SnapshotValue {
    fn from(value: &FieldValue) -> Self {
        match value {
            FieldValue::Boolean(value) => Self::Boolean(*value),
            FieldValue::String(value) => Self::String(value.clone()),
            FieldValue::Float(value) => Self::Float(value.to_bits()),
            FieldValue::Vector2D(value) => Self::Vector2D(value.map(f32::to_bits)),
            FieldValue::Vector3D(value) => Self::Vector3D(value.map(f32::to_bits)),
            FieldValue::Vector4D(value) => Self::Vector4D(value.map(f32::to_bits)),
            FieldValue::Signed8(value) => Self::Signed8(*value),
            FieldValue::Signed16(value) => Self::Signed16(*value),
            FieldValue::Signed32(value) => Self::Signed32(*value),
            FieldValue::Signed64(value) => Self::Signed64(*value),
            FieldValue::Unsigned8(value) => Self::Unsigned8(*value),
            FieldValue::Unsigned16(value) => Self::Unsigned16(*value),
            FieldValue::Unsigned32(value) => Self::Unsigned32(*value),
            FieldValue::Unsigned64(value) => Self::Unsigned64(*value),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CosmeticState {
    pub kind: ItemKind,
    pub class: String,
    pub team: Option<u8>,
    pub account_id: u32,
    pub item_id: ItemIdentity,
    pub definition_index: Option<u16>,
    pub entity_quality: Option<i32>,
    pub entity_level: Option<u32>,
    pub inventory_position: Option<u32>,
    pub initialized: Option<bool>,
    pub subclass_token: Option<u32>,
    pub model_resource_handle: Option<u64>,
    pub mesh_group_mask: Option<u64>,
    pub body_group: Option<i32>,
    pub custom_name: Option<String>,
    pub glove_changed: Option<u8>,
    pub fallback_paint_kit: Option<i32>,
    pub fallback_seed: Option<i32>,
    pub fallback_wear: Option<u32>,
    pub fallback_stattrak: Option<i32>,
    pub dynamic_attribute_count: Option<u32>,
    pub dynamic_fields: BTreeMap<String, SnapshotValue>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CosmeticSnapshot {
    pub tick: u32,
    pub handle: u32,
    pub state: CosmeticState,
}

#[derive(Clone, Debug, Default)]
pub struct DemoCapture {
    pub snapshots: Vec<CosmeticSnapshot>,
    pub player_names: BTreeMap<u64, BTreeSet<String>>,
    entity_candidates: BTreeMap<u32, EntityCandidate>,
    steam_controllers: BTreeMap<u64, BTreeSet<u32>>,
    controller_pawns: BTreeMap<u32, BTreeSet<u32>>,
    pawn_controllers: BTreeMap<u32, BTreeSet<u32>>,
}

#[derive(Clone, Debug, Default)]
struct EntityCandidate {
    class: String,
    teams: BTreeSet<u8>,
    account_ids: BTreeSet<u32>,
    item_ids: BTreeSet<ItemIdentity>,
    definition_indices: BTreeSet<u16>,
    original_owner_accounts: BTreeSet<u32>,
    owner_handles: BTreeSet<u32>,
}

#[derive(Clone, Debug)]
pub struct ResolvedTargets {
    by_handle: BTreeMap<u32, usize>,
    per_rule: Vec<BTreeSet<u32>>,
}

impl ResolvedTargets {
    pub fn rule_for_handle(&self, handle: u32) -> Option<usize> {
        self.by_handle.get(&handle).copied()
    }

    pub fn handles_for_rule(&self, rule_index: usize) -> &BTreeSet<u32> {
        &self.per_rule[rule_index]
    }

    fn contains(&self, handle: u32) -> bool {
        self.by_handle.contains_key(&handle)
    }
}

#[derive(Clone, Debug, Default)]
pub struct VerificationSummary {
    pub target_snapshots: usize,
    pub target_entity_handles: usize,
    pub preserved_target_snapshots: usize,
    pub unchanged_non_target_knives: usize,
    pub unchanged_non_target_econ_snapshots: usize,
    pub rule_entity_counts: BTreeMap<String, usize>,
}

struct CaptureObserver {
    tracked_classes: BTreeSet<String>,
    snapshots: Vec<CosmeticSnapshot>,
    last_states: HashMap<u32, CosmeticState>,
    player_names: BTreeMap<u64, BTreeSet<String>>,
    entity_candidates: BTreeMap<u32, EntityCandidate>,
    steam_controllers: BTreeMap<u64, BTreeSet<u32>>,
    controller_pawns: BTreeMap<u32, BTreeSet<u32>>,
    pawn_controllers: BTreeMap<u32, BTreeSet<u32>>,
}

impl CaptureObserver {
    fn new(config: &ValidatedConfig) -> Self {
        Self {
            tracked_classes: config
                .rules
                .iter()
                .map(|rule| rule.entity.class.clone())
                .collect(),
            snapshots: Vec::new(),
            last_states: HashMap::new(),
            player_names: BTreeMap::new(),
            entity_candidates: BTreeMap::new(),
            steam_controllers: BTreeMap::new(),
            controller_pawns: BTreeMap::new(),
            pawn_controllers: BTreeMap::new(),
        }
    }

    fn relevant_class(&self, entity: &Entity) -> bool {
        let class = entity.class().name();
        class == "CCSPlayerController"
            || class == "CCSPlayerPawn"
            || class == "CKnife"
            || self.tracked_classes.contains(class)
    }

    fn state_differs(previous: &CosmeticState, entity: &Entity) -> bool {
        let kind = previous.kind;
        let prefix = item_prefix(kind);
        if u8_field(entity, TEAM_FIELD) != previous.team
            || entity_account_id(entity, kind) != Some(previous.account_id)
            || entity_item_identity(entity, kind) != Some(previous.item_id)
            || u16_field(entity, &definition_index_field(kind)) != previous.definition_index
            || i32_field(entity, &format!("{prefix}.m_iEntityQuality")) != previous.entity_quality
            || u32_field(entity, &format!("{prefix}.m_iEntityLevel")) != previous.entity_level
            || u32_field(entity, &format!("{prefix}.m_iInventoryPosition"))
                != previous.inventory_position
            || bool_field(entity, &format!("{prefix}.m_bInitialized")) != previous.initialized
            || u32_field(entity, KNIFE_SUBCLASS_FIELD) != previous.subclass_token
            || u64_field(entity, MODEL_FIELD) != previous.model_resource_handle
            || u64_field(entity, MESH_GROUP_FIELD) != previous.mesh_group_mask
            || i32_field(entity, BODY_GROUP_FIELD) != previous.body_group
            || (kind == ItemKind::Glove
                && u8_field(entity, GLOVE_CHANGED_FIELD) != previous.glove_changed)
            || i32_field(entity, "m_nFallbackPaintKit") != previous.fallback_paint_kit
            || i32_field(entity, "m_nFallbackSeed") != previous.fallback_seed
            || value(entity, "m_flFallbackWear").and_then(|value| match value {
                FieldValue::Float(value) => Some(value.to_bits()),
                _ => None,
            }) != previous.fallback_wear
            || i32_field(entity, "m_nFallbackStatTrak") != previous.fallback_stattrak
            || u32_field(entity, &dynamic_prefix(kind)) != previous.dynamic_attribute_count
        {
            return true;
        }
        let current_name = match value(entity, &custom_name_field(kind)) {
            Some(FieldValue::String(name)) => Some(name.as_str()),
            _ => None,
        };
        if current_name != previous.custom_name.as_deref() {
            return true;
        }
        previous.dynamic_fields.iter().any(|(name, expected)| {
            value(entity, name).map(SnapshotValue::from).as_ref() != Some(expected)
        })
    }

    fn discover(&mut self, entity: &Entity) {
        let class = entity.class().name();
        if class == "CCSPlayerController" {
            if let Some(steam_id) = u64_field(entity, "m_steamID").filter(|value| *value != 0) {
                self.steam_controllers
                    .entry(steam_id)
                    .or_default()
                    .insert(entity.handle());
            }
            for field in ["m_hPawn", "m_hPlayerPawn"] {
                if let Some(pawn) = u32_field(entity, field).filter(|value| *value != 0) {
                    self.controller_pawns
                        .entry(entity.handle())
                        .or_default()
                        .insert(pawn);
                }
            }
            return;
        }

        let candidate = self.entity_candidates.entry(entity.handle()).or_default();
        if candidate.class.is_empty() {
            candidate.class = class.to_owned();
        }
        if let Some(team) = u8_field(entity, TEAM_FIELD).filter(|team| *team != 0) {
            candidate.teams.insert(team);
        }
        let kind = if class == "CCSPlayerPawn" {
            for field in [
                "m_hController",
                "m_hDefaultController",
                "m_hOriginalController",
            ] {
                if let Some(controller) = u32_field(entity, field).filter(|value| *value != 0) {
                    self.pawn_controllers
                        .entry(entity.handle())
                        .or_default()
                        .insert(controller);
                }
            }
            ItemKind::Glove
        } else if class == "CKnife" {
            ItemKind::Knife
        } else {
            ItemKind::Weapon
        };
        if let Some(account) = entity_account_id(entity, kind).filter(|value| *value != 0) {
            candidate.account_ids.insert(account);
        }
        if let Some(item_id) = entity_item_identity(entity, kind) {
            candidate.item_ids.insert(item_id);
        }
        if let Some(definition) = u16_field(entity, &definition_index_field(kind)) {
            candidate.definition_indices.insert(definition);
        }
        if let Some(account) =
            u32_field(entity, ORIGINAL_OWNER_ACCOUNT_FIELD).filter(|value| *value != 0)
        {
            candidate.original_owner_accounts.insert(account);
        }
        if let Some(owner) = u32_field(entity, OWNER_ENTITY_FIELD).filter(|value| *value != 0) {
            candidate.owner_handles.insert(owner);
        }
    }

    fn capture(&mut self, ctx: &Context, event: EntityEvents, entity: &Entity) {
        if entity.class().name() == "CCSPlayerController" {
            if let (Some(steam_id), Some(name)) = (
                u64_field(entity, "m_steamID"),
                string_field(entity, "m_iszPlayerName"),
            ) {
                if steam_id != 0 && !name.trim().is_empty() {
                    self.player_names.entry(steam_id).or_default().insert(name);
                }
            }
            return;
        }

        if event == EntityEvents::Created {
            self.last_states.remove(&entity.handle());
        }
        let Some(state) = cosmetic_state(entity) else {
            return;
        };
        if self.last_states.get(&entity.handle()) == Some(&state) {
            return;
        }
        self.last_states.insert(entity.handle(), state.clone());
        self.snapshots.push(CosmeticSnapshot {
            tick: ctx.tick(),
            handle: entity.handle(),
            state,
        });
    }
}

impl Observer for CaptureObserver {
    fn interests(&self) -> Interests {
        Interests::ENTITY_STATE | Interests::ENTITY_EVENTS
    }

    fn on_entity(&mut self, ctx: &Context, event: EntityEvents, entity: &Entity) -> ObserverResult {
        if event == EntityEvents::Deleted {
            self.last_states.remove(&entity.handle());
            return Ok(());
        }
        if !self.relevant_class(entity) {
            return Ok(());
        }
        self.discover(entity);
        if entity.class().name() == "CCSPlayerController" {
            self.capture(ctx, event, entity);
            return Ok(());
        }
        if event == EntityEvents::Created {
            self.last_states.remove(&entity.handle());
        }
        let kind = if entity.class().name() == "CCSPlayerPawn" {
            ItemKind::Glove
        } else if entity.class().name() == "CKnife" {
            ItemKind::Knife
        } else {
            ItemKind::Weapon
        };
        let should_capture = self.last_states.get(&entity.handle()).map_or_else(
            || {
                entity_account_id(entity, kind).is_some_and(|account| account != 0)
                    && entity_item_identity(entity, kind).is_some_and(|item| item.combined() != 0)
            },
            |previous| Self::state_differs(previous, entity),
        );
        if should_capture {
            self.capture(ctx, event, entity);
        }
        Ok(())
    }
}

pub fn collect_demo(path: &Path, config: &ValidatedConfig) -> Result<DemoCapture> {
    let input = BufReader::new(
        File::open(path).with_context(|| format!("failed to open demo {}", path.display()))?,
    );
    let mut parser = Parser::from_reader(input)?;
    let state = parser.add_observer(CaptureObserver::new(config));
    parser.run_to_end()?;
    drop(parser);
    let state = state.borrow();
    Ok(DemoCapture {
        snapshots: state.snapshots.clone(),
        player_names: state.player_names.clone(),
        entity_candidates: state.entity_candidates.clone(),
        steam_controllers: state.steam_controllers.clone(),
        controller_pawns: state.controller_pawns.clone(),
        pawn_controllers: state.pawn_controllers.clone(),
    })
}

pub fn validate_config_against_input(
    config: &ValidatedConfig,
    capture: &DemoCapture,
    layout: &DemoLayout,
) -> Result<ResolvedTargets> {
    for player in &config.players {
        if let Some(name_hint) = &player.name_hint {
            let names = capture
                .player_names
                .get(&player.steam_id64)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "player {:?} ({}) was not found in CCSPlayerController state",
                        player.id,
                        player.steam_id64
                    )
                })?;
            if !names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(name_hint))
            {
                bail!(
                    "player {:?} name_hint {:?} does not match observed names {:?}",
                    player.id,
                    name_hint,
                    names
                );
            }
        }
    }

    let targets = resolve_targets(config, capture)?;

    for rule in &config.rules {
        let Some(variant) = &rule.replacement.knife_variant else {
            continue;
        };
        match &variant.mapping_source {
            KnifeMappingSource::ObservedInInput => {
                let wanted_defindex = rule
                    .replacement
                    .definition_index
                    .expect("validated knife definition index");
                let observed = capture.snapshots.iter().any(|snapshot| {
                    snapshot.state.kind == ItemKind::Knife
                        && snapshot.state.definition_index == Some(wanted_defindex)
                        && snapshot.state.subclass_token == Some(variant.subclass_token)
                        && snapshot.state.model_resource_handle
                            == Some(variant.model_resource_handle)
                });
                if !observed {
                    bail!(
                        "rule {:?} knife mapping def={} subclass={} model={} was not observed in the input demo",
                        rule.id,
                        wanted_defindex,
                        variant.subclass_token,
                        variant.model_resource_handle
                    );
                }
            }
            KnifeMappingSource::Versioned {
                patch_versions,
                source,
            } => {
                let patch = layout.metadata.patch_version.ok_or_else(|| {
                    anyhow::anyhow!(
                        "rule {:?} uses a versioned knife mapping but the demo has no patch_version",
                        rule.id
                    )
                })?;
                if !patch_versions.contains(&patch) {
                    bail!(
                        "rule {:?} knife mapping source {:?} is not approved for input patch {}",
                        rule.id,
                        source,
                        patch
                    );
                }
            }
        }
    }
    Ok(targets)
}

fn resolve_targets(config: &ValidatedConfig, capture: &DemoCapture) -> Result<ResolvedTargets> {
    let mut player_pawns = BTreeMap::<u32, BTreeSet<u32>>::new();
    for player in &config.players {
        let controllers = capture
            .steam_controllers
            .get(&player.steam_id64)
            .cloned()
            .unwrap_or_default();
        let mut pawns = BTreeSet::new();
        for controller in &controllers {
            if let Some(linked) = capture.controller_pawns.get(controller) {
                pawns.extend(linked);
            }
        }
        for (pawn, linked_controllers) in &capture.pawn_controllers {
            if linked_controllers
                .iter()
                .any(|handle| controllers.contains(handle))
            {
                pawns.insert(*pawn);
            }
        }
        player_pawns.insert(player.account_id, pawns);
    }

    let mut per_rule = Vec::with_capacity(config.rules.len());
    let mut by_handle = BTreeMap::new();
    for (rule_index, rule) in config.rules.iter().enumerate() {
        let handles = if rule.entity.item_id.combined() != 0 {
            let selected = capture
                .snapshots
                .iter()
                .any(|snapshot| rule_matches_state(rule, &snapshot.state));
            if !selected {
                BTreeSet::new()
            } else {
                capture
                    .snapshots
                    .iter()
                    .filter(|snapshot| rule_matches_source_identity(rule, &snapshot.state))
                    .map(|snapshot| snapshot.handle)
                    .collect()
            }
        } else {
            let pawns = player_pawns
                .get(&rule.account_id)
                .cloned()
                .unwrap_or_default();
            capture
                .entity_candidates
                .iter()
                .filter_map(|(handle, candidate)| {
                    materialized_candidate_matches(rule, *handle, candidate, &pawns, capture)
                        .then_some(*handle)
                })
                .collect()
        };

        if handles.is_empty() {
            bail!(
                "rule {:?} did not resolve any original entity handle for player/account/class/item/source definition/team",
                rule.id
            );
        }
        for handle in &handles {
            if let Some(previous) = by_handle.insert(*handle, rule_index) {
                bail!(
                    "rules {:?} and {:?} resolve the same entity handle {}",
                    config.rules[previous].id,
                    rule.id,
                    handle
                );
            }
        }
        per_rule.push(handles);
    }
    Ok(ResolvedTargets {
        by_handle,
        per_rule,
    })
}

fn materialized_candidate_matches(
    rule: &ValidatedRule,
    handle: u32,
    candidate: &EntityCandidate,
    player_pawns: &BTreeSet<u32>,
    capture: &DemoCapture,
) -> bool {
    if rule.missing_fields.econ != MissingEconPolicy::Materialize
        || candidate.class != rule.entity.class
    {
        return false;
    }
    if rule.entity.kind == ItemKind::Glove {
        return player_pawns.contains(&handle)
            && candidate_matches_team(rule.team, candidate, capture);
    }
    if !rule
        .entity
        .source_definition_index
        .is_some_and(|definition| candidate.definition_indices.contains(&definition))
    {
        return false;
    }
    let owned = candidate.original_owner_accounts.contains(&rule.account_id)
        || candidate.account_ids.contains(&rule.account_id)
        || candidate
            .owner_handles
            .iter()
            .any(|owner| player_pawns.contains(owner));
    owned && candidate_matches_team(rule.team, candidate, capture)
}

fn candidate_matches_team(
    wanted: Team,
    candidate: &EntityCandidate,
    capture: &DemoCapture,
) -> bool {
    if wanted == Team::Any {
        return true;
    }
    if candidate
        .teams
        .iter()
        .copied()
        .any(|team| wanted.matches(Some(team)))
    {
        return true;
    }
    candidate.owner_handles.iter().any(|owner| {
        capture.entity_candidates.get(owner).is_some_and(|pawn| {
            pawn.teams
                .iter()
                .copied()
                .any(|team| wanted.matches(Some(team)))
        })
    })
}

pub fn verify_captures(
    original: &DemoCapture,
    rewritten: &DemoCapture,
    config: &ValidatedConfig,
    targets: &ResolvedTargets,
) -> Result<VerificationSummary> {
    verify_unconfigured_snapshots_unchanged(original, rewritten, targets)?;
    let preserved_target_snapshots =
        verify_configured_snapshot_fields_preserved(original, rewritten, config, targets)?;

    let mut per_rule_handles = vec![BTreeSet::new(); config.rules.len()];
    let mut per_rule_fields = config
        .rules
        .iter()
        .map(required_rule_fields)
        .collect::<Vec<_>>();
    let mut target_snapshots = 0_usize;
    for snapshot in &rewritten.snapshots {
        let Some(rule_index) = targets.rule_for_handle(snapshot.handle) else {
            continue;
        };
        let rule = &config.rules[rule_index];
        let observations = observe_requested_fields(rule, &snapshot.state);
        let mut observed_any = false;
        for (field, present) in observations {
            if present {
                per_rule_fields[rule_index].insert(field, true);
                observed_any = true;
            }
        }
        if observed_any {
            per_rule_handles[rule_index].insert(snapshot.handle);
            target_snapshots += 1;
        }
    }

    for (index, fields) in per_rule_fields.iter().enumerate() {
        let missing = fields
            .iter()
            .filter_map(|(field, present)| (!present).then_some(field.as_str()))
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            bail!(
                "rule {:?} never materialized requested fields {:?}; transient states are allowed, but every requested field must appear",
                config.rules[index].id,
                missing
            );
        }
        let missing_handles = targets.handles_for_rule(index) - &per_rule_handles[index];
        if !missing_handles.is_empty() {
            bail!(
                "rule {:?} has rewritten handles with no verified cosmetic state: {:?}",
                config.rules[index].id,
                missing_handles
            );
        }
    }

    let unchanged_non_target_econ_snapshots = original
        .snapshots
        .iter()
        .filter(|snapshot| !targets.contains(snapshot.handle))
        .count();
    let unchanged_non_target_knives = original
        .snapshots
        .iter()
        .filter(|snapshot| {
            snapshot.state.kind == ItemKind::Knife && !targets.contains(snapshot.handle)
        })
        .count();

    let rule_entity_counts = config
        .rules
        .iter()
        .enumerate()
        .map(|(index, rule)| (rule.id.clone(), per_rule_handles[index].len()))
        .collect();
    let target_entity_handles = per_rule_handles
        .iter()
        .flatten()
        .copied()
        .collect::<BTreeSet<_>>()
        .len();
    Ok(VerificationSummary {
        target_snapshots,
        target_entity_handles,
        preserved_target_snapshots,
        unchanged_non_target_knives,
        unchanged_non_target_econ_snapshots,
        rule_entity_counts,
    })
}

fn verify_configured_snapshot_fields_preserved(
    original: &DemoCapture,
    rewritten: &DemoCapture,
    config: &ValidatedConfig,
    targets: &ResolvedTargets,
) -> Result<usize> {
    let mut originals = BTreeMap::<(u32, u32), Vec<CosmeticState>>::new();
    for snapshot in &original.snapshots {
        let Some(rule_index) = targets.rule_for_handle(snapshot.handle) else {
            continue;
        };
        let rule = &config.rules[rule_index];
        let mut normalized = snapshot.state.clone();
        mask_requested_fields(&mut normalized, rule);
        originals
            .entry((snapshot.tick, snapshot.handle))
            .or_default()
            .push(normalized);
    }

    let mut checked = 0;
    for snapshot in &rewritten.snapshots {
        let Some(rule_index) = targets.rule_for_handle(snapshot.handle) else {
            continue;
        };
        let rule = &config.rules[rule_index];
        let mut normalized = snapshot.state.clone();
        mask_requested_fields(&mut normalized, rule);
        let Some(states) = originals.get(&(snapshot.tick, snapshot.handle)) else {
            continue;
        };
        let preserved = states.contains(&normalized);
        if !preserved {
            bail!(
                "rule {:?} changed non-requested target fields at tick {} handle {}",
                rule.id,
                snapshot.tick,
                snapshot.handle
            );
        }
        checked += 1;
    }
    Ok(checked)
}

fn mask_requested_fields(state: &mut CosmeticState, rule: &ValidatedRule) {
    let replacement = &rule.replacement;
    if replacement.item_id.is_some() {
        state.item_id = ItemIdentity { high: 0, low: 0 };
    }
    if replacement.definition_index.is_some() {
        state.definition_index = None;
    }
    if replacement.knife_variant.is_some() {
        state.subclass_token = None;
        state.model_resource_handle = None;
    }
    if replacement.custom_name.is_some() {
        state.custom_name = None;
    }
    if state.kind == ItemKind::Glove {
        state.glove_changed = None;
    }
    if replacement.visual_state.is_some()
        || (state.kind == ItemKind::Glove
            && rule.missing_fields.econ == MissingEconPolicy::Materialize)
    {
        state.mesh_group_mask = None;
        state.body_group = None;
    }
    if rule.missing_fields.econ == MissingEconPolicy::Materialize {
        state.account_id = 0;
        state.entity_quality = None;
        state.entity_level = None;
        state.inventory_position = None;
        state.initialized = None;
        state.dynamic_attribute_count = None;
        let dynamic = dynamic_prefix(state.kind);
        for slot in 0..3 {
            let stem = format!("{dynamic}.{slot:04}");
            for suffix in [
                "m_iAttributeDefinitionIndex",
                "m_iRawValue32",
                "m_flInitialValue",
                "m_nRefundableCurrency",
                "m_bSetBonus",
            ] {
                state.dynamic_fields.remove(&format!("{stem}.{suffix}"));
            }
        }
        if state.kind != ItemKind::Glove {
            state.fallback_paint_kit = None;
            state.fallback_seed = None;
            state.fallback_wear = None;
            state.fallback_stattrak = None;
        }
    }

    let mut definitions = BTreeSet::new();
    if replacement.paint_kit.is_some() {
        definitions.insert(PAINT_ATTRIBUTE);
    }
    if replacement.pattern_seed.is_some() {
        definitions.insert(SEED_ATTRIBUTE);
    }
    if replacement.wear.is_some() {
        definitions.insert(WEAR_ATTRIBUTE);
    }
    definitions.extend(
        replacement
            .stickers
            .iter()
            .map(|sticker| sticker.attribute_definition_index()),
    );
    if replacement.charm.is_some() {
        definitions.insert(CHARM_ATTRIBUTE);
    }

    let definition_suffix = ".m_iAttributeDefinitionIndex";
    let stems = state
        .dynamic_fields
        .iter()
        .filter_map(|(name, value)| {
            let SnapshotValue::Unsigned16(definition) = value else {
                return None;
            };
            definitions
                .contains(definition)
                .then(|| name.strip_suffix(definition_suffix))
                .flatten()
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    for stem in stems {
        state
            .dynamic_fields
            .remove(&format!("{stem}.m_iRawValue32"));
        state
            .dynamic_fields
            .remove(&format!("{stem}.m_flInitialValue"));
    }
}

fn required_rule_fields(rule: &ValidatedRule) -> BTreeMap<String, bool> {
    let replacement = &rule.replacement;
    let mut fields = BTreeMap::new();
    if replacement.item_id.is_some() {
        fields.insert("item_id".to_owned(), false);
    }
    if replacement.definition_index.is_some() {
        fields.insert("definition_index".to_owned(), false);
    }
    if replacement.knife_variant.is_some() {
        fields.insert("knife_subclass".to_owned(), false);
        fields.insert("knife_model".to_owned(), false);
    }
    if replacement.custom_name.is_some() {
        fields.insert("custom_name".to_owned(), false);
    }
    if replacement.visual_state.is_some()
        || (rule.entity.kind == ItemKind::Glove
            && rule.missing_fields.econ == MissingEconPolicy::Materialize)
    {
        fields.insert("visual_mesh".to_owned(), false);
        fields.insert("visual_body".to_owned(), false);
    }
    if rule.entity.kind == ItemKind::Glove {
        fields.insert("glove_changed".to_owned(), false);
    }
    if rule.missing_fields.econ == MissingEconPolicy::Materialize {
        for field in [
            "account_id",
            "entity_quality",
            "entity_level",
            "inventory_position",
            "initialized",
            "dynamic_attribute_count",
        ] {
            fields.insert(field.to_owned(), false);
        }
        if rule.entity.kind != ItemKind::Glove {
            for field in [
                "fallback_paint",
                "fallback_seed",
                "fallback_wear",
                "fallback_stattrak",
            ] {
                fields.insert(field.to_owned(), false);
            }
        }
    }
    if replacement.paint_kit.is_some() {
        add_attribute_requirements(&mut fields, "paint");
    }
    if replacement.pattern_seed.is_some() {
        add_attribute_requirements(&mut fields, "seed");
    }
    if replacement.wear.is_some() {
        add_attribute_requirements(&mut fields, "wear");
    }
    for sticker in &replacement.stickers {
        add_attribute_requirements(&mut fields, &format!("sticker_slot_{}", sticker.slot));
    }
    if replacement.charm.is_some() {
        add_attribute_requirements(&mut fields, "charm");
    }
    fields
}

fn add_attribute_requirements(fields: &mut BTreeMap<String, bool>, label: &str) {
    fields.insert(format!("{label}.raw"), false);
    fields.insert(format!("{label}.initial"), false);
}

fn observe_requested_fields(rule: &ValidatedRule, state: &CosmeticState) -> BTreeMap<String, bool> {
    let replacement = &rule.replacement;
    let mut fields = BTreeMap::new();
    if let Some(item_id) = replacement.item_id {
        fields.insert("item_id".to_owned(), state.item_id == item_id);
    }
    if let Some(definition_index) = replacement.definition_index {
        fields.insert(
            "definition_index".to_owned(),
            state.definition_index == Some(definition_index),
        );
    }
    if let Some(variant) = &replacement.knife_variant {
        fields.insert(
            "knife_subclass".to_owned(),
            state.subclass_token == Some(variant.subclass_token),
        );
        fields.insert(
            "knife_model".to_owned(),
            state.model_resource_handle == Some(variant.model_resource_handle),
        );
    }
    if let Some(custom_name) = &replacement.custom_name {
        fields.insert(
            "custom_name".to_owned(),
            state.custom_name.as_deref() == Some(custom_name),
        );
    }
    if let Some((mesh, body)) = expected_visual_state(rule, state.team) {
        fields.insert(
            "visual_mesh".to_owned(),
            state.mesh_group_mask == Some(mesh),
        );
        fields.insert("visual_body".to_owned(), state.body_group == Some(body));
    }
    if rule.entity.kind == ItemKind::Glove {
        fields.insert("glove_changed".to_owned(), state.glove_changed == Some(1));
    }
    if rule.missing_fields.econ == MissingEconPolicy::Materialize {
        fields.insert("account_id".to_owned(), state.account_id == rule.account_id);
        let quality = match rule.entity.kind {
            ItemKind::Glove | ItemKind::Knife => 3,
            ItemKind::Weapon => 4,
        };
        let inventory_position = if rule.entity.kind == ItemKind::Glove {
            48
        } else {
            0
        };
        fields.insert(
            "entity_quality".to_owned(),
            state.entity_quality == Some(quality),
        );
        fields.insert("entity_level".to_owned(), state.entity_level == Some(1));
        fields.insert(
            "inventory_position".to_owned(),
            state.inventory_position == Some(inventory_position),
        );
        fields.insert("initialized".to_owned(), state.initialized == Some(true));
        fields.insert(
            "dynamic_attribute_count".to_owned(),
            state.dynamic_attribute_count == Some(3),
        );
        if rule.entity.kind != ItemKind::Glove {
            fields.insert(
                "fallback_paint".to_owned(),
                state.fallback_paint_kit == Some(0),
            );
            fields.insert("fallback_seed".to_owned(), state.fallback_seed == Some(0));
            fields.insert(
                "fallback_wear".to_owned(),
                state.fallback_wear == Some(0.0_f32.to_bits()),
            );
            fields.insert(
                "fallback_stattrak".to_owned(),
                state.fallback_stattrak == Some(-1),
            );
        }
    }
    if let Some(paint) = replacement.paint_kit {
        observe_attribute(
            &mut fields,
            state,
            PAINT_ATTRIBUTE,
            (paint as f32).to_bits(),
            "paint",
        );
    }
    if let Some(seed) = replacement.pattern_seed {
        observe_attribute(&mut fields, state, SEED_ATTRIBUTE, seed.to_bits(), "seed");
    }
    if let Some(wear) = replacement.wear {
        observe_attribute(&mut fields, state, WEAR_ATTRIBUTE, wear.to_bits(), "wear");
    }
    for sticker in &replacement.stickers {
        observe_attribute(
            &mut fields,
            state,
            sticker.attribute_definition_index(),
            sticker.sticker_id,
            &format!("sticker_slot_{}", sticker.slot),
        );
    }
    if let Some(charm) = &replacement.charm {
        observe_attribute(&mut fields, state, CHARM_ATTRIBUTE, charm.charm_id, "charm");
    }
    fields
}

fn expected_visual_state(rule: &ValidatedRule, team: Option<u8>) -> Option<(u64, i32)> {
    if let Some(visual) = &rule.replacement.visual_state {
        return Some((visual.mesh_group_mask, visual.body_group));
    }
    if rule.entity.kind == ItemKind::Glove
        && rule.missing_fields.econ == MissingEconPolicy::Materialize
    {
        return match team {
            Some(2) => Some((2, 1)),
            Some(3) => Some((9, 0)),
            _ => None,
        };
    }
    None
}

fn observe_attribute(
    observations: &mut BTreeMap<String, bool>,
    state: &CosmeticState,
    definition_index: u16,
    desired_bits: u32,
    label: &str,
) {
    let definition_suffix = ".m_iAttributeDefinitionIndex";
    let stems = state.dynamic_fields.iter().filter_map(|(name, value)| {
        if name.ends_with(definition_suffix)
            && *value == SnapshotValue::Unsigned16(definition_index)
        {
            name.strip_suffix(definition_suffix)
        } else {
            None
        }
    });
    let mut raw = false;
    let mut initial = false;
    for stem in stems {
        raw |= state.dynamic_fields.get(&format!("{stem}.m_iRawValue32"))
            == Some(&SnapshotValue::Float(desired_bits));
        initial |= state
            .dynamic_fields
            .get(&format!("{stem}.m_flInitialValue"))
            == Some(&SnapshotValue::Float(desired_bits));
    }
    observations.insert(format!("{label}.raw"), raw);
    observations.insert(format!("{label}.initial"), initial);
}

fn verify_unconfigured_snapshots_unchanged(
    original: &DemoCapture,
    rewritten: &DemoCapture,
    targets: &ResolvedTargets,
) -> Result<()> {
    let original_untouched = original
        .snapshots
        .iter()
        .filter(|snapshot| !targets.contains(snapshot.handle))
        .collect::<Vec<_>>();
    let rewritten_untouched = rewritten
        .snapshots
        .iter()
        .filter(|snapshot| !targets.contains(snapshot.handle))
        .collect::<Vec<_>>();
    if original_untouched == rewritten_untouched {
        return Ok(());
    }
    if original_untouched.len() != rewritten_untouched.len() {
        bail!(
            "unconfigured cosmetic snapshot count changed: {} -> {}",
            original_untouched.len(),
            rewritten_untouched.len()
        );
    }
    let index = original_untouched
        .iter()
        .zip(&rewritten_untouched)
        .position(|(before, after)| before != after)
        .expect("vectors differ");
    bail!(
        "unconfigured cosmetic snapshot {index} changed\noriginal={:#?}\nrewritten={:#?}",
        original_untouched[index],
        rewritten_untouched[index]
    )
}

pub fn run_independent_demoparser2(python: &Path, demo: &Path) -> Result<String> {
    if !python.is_file() {
        bail!(
            "demoparser2 Python executable does not exist: {}",
            python.display()
        );
    }
    const SCRIPT: &str = r#"
import json
import sys
from demoparser2 import DemoParser

def rows(table):
    if not isinstance(table, dict) or not table:
        return 0
    return max((len(value) for value in table.values() if hasattr(value, '__len__')), default=0)

parser = DemoParser(sys.argv[1])
header = parser.parse_header()
players = parser.parse_player_info()
skins = parser.parse_skins()
round_ends = parser.parse_event('round_end')
if not isinstance(header, dict) or not header.get('demo_file_stamp', '').startswith('PBDEMS2'):
    raise RuntimeError('demoparser2 did not return a valid CS2 header')
player_rows = rows(players)
round_end_rows = rows(round_ends)
if player_rows == 0 or round_end_rows == 0:
    raise RuntimeError(f'demoparser2 returned no player or round_end rows: players={player_rows}, round_ends={round_end_rows}')
print(json.dumps({'map': header.get('map_name'), 'players': player_rows, 'skins': rows(skins), 'round_ends': round_end_rows}, sort_keys=True))
"#;
    let output = Command::new(python)
        .arg("-c")
        .arg(SCRIPT)
        .arg(demo)
        .output()
        .with_context(|| {
            format!(
                "failed to launch independent demoparser2 through {}",
                python.display()
            )
        })?;
    if !output.status.success() {
        bail!(
            "independent demoparser2 rejected {} (exit {:?}): {}",
            demo.display(),
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("failed to open {} for SHA-256", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn cosmetic_state(entity: &Entity) -> Option<CosmeticState> {
    let (kind, account_id, item_id) = if entity.class().name() == "CCSPlayerPawn" {
        (
            ItemKind::Glove,
            entity_account_id(entity, ItemKind::Glove)?,
            entity_item_identity(entity, ItemKind::Glove)?,
        )
    } else {
        let kind = if entity.class().name() == "CKnife" {
            ItemKind::Knife
        } else {
            ItemKind::Weapon
        };
        (
            kind,
            entity_account_id(entity, kind)?,
            entity_item_identity(entity, kind)?,
        )
    };
    if account_id == 0 || item_id.combined() == 0 {
        return None;
    }

    let prefix = item_prefix(kind);
    let dynamic = dynamic_prefix(kind);
    let dynamic_fields = entity
        .fields()
        .iter()
        .filter(|field| field.name.starts_with(&dynamic))
        .filter_map(|field| {
            field
                .value
                .map(|value| (field.name.to_string(), SnapshotValue::from(value)))
        })
        .collect();
    Some(CosmeticState {
        kind,
        class: entity.class().name().to_owned(),
        team: u8_field(entity, TEAM_FIELD),
        account_id,
        item_id,
        definition_index: u16_field(entity, &definition_index_field(kind)),
        entity_quality: i32_field(entity, &format!("{prefix}.m_iEntityQuality")),
        entity_level: u32_field(entity, &format!("{prefix}.m_iEntityLevel")),
        inventory_position: u32_field(entity, &format!("{prefix}.m_iInventoryPosition")),
        initialized: bool_field(entity, &format!("{prefix}.m_bInitialized")),
        subclass_token: u32_field(entity, KNIFE_SUBCLASS_FIELD),
        model_resource_handle: u64_field(entity, MODEL_FIELD),
        mesh_group_mask: u64_field(entity, MESH_GROUP_FIELD),
        body_group: i32_field(entity, BODY_GROUP_FIELD),
        custom_name: string_field(entity, &custom_name_field(kind)),
        glove_changed: (kind == ItemKind::Glove)
            .then(|| u8_field(entity, GLOVE_CHANGED_FIELD))
            .flatten(),
        fallback_paint_kit: i32_field(entity, "m_nFallbackPaintKit"),
        fallback_seed: i32_field(entity, "m_nFallbackSeed"),
        fallback_wear: value(entity, "m_flFallbackWear").and_then(|value| match value {
            FieldValue::Float(value) => Some(value.to_bits()),
            _ => None,
        }),
        fallback_stattrak: i32_field(entity, "m_nFallbackStatTrak"),
        dynamic_attribute_count: u32_field(entity, &dynamic),
        dynamic_fields,
    })
}

fn rule_matches_state(rule: &ValidatedRule, state: &CosmeticState) -> bool {
    state.kind == rule.entity.kind
        && state.class == rule.entity.class
        && state.account_id == rule.account_id
        && state.item_id == rule.entity.item_id
        && rule.team.matches(state.team)
}

fn rule_matches_source_identity(rule: &ValidatedRule, state: &CosmeticState) -> bool {
    state.kind == rule.entity.kind
        && state.class == rule.entity.class
        && state.account_id == rule.account_id
        && state.item_id == rule.entity.item_id
}

#[cfg(test)]
fn replace_attribute(
    state: &mut CosmeticState,
    definition_index: u16,
    desired_bits: u32,
    expected_current_bits: Option<u32>,
    label: &str,
) -> Result<()> {
    let suffix = ".m_iAttributeDefinitionIndex";
    let stems = state
        .dynamic_fields
        .iter()
        .filter_map(|(name, value)| {
            if name.ends_with(suffix) && *value == SnapshotValue::Unsigned16(definition_index) {
                name.strip_suffix(suffix).map(str::to_owned)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if stems.len() != 1 {
        bail!(
            "{label} attribute definition {definition_index} expected once, found {}",
            stems.len()
        );
    }
    for suffix in ["m_iRawValue32", "m_flInitialValue"] {
        let name = format!("{}.{}", stems[0], suffix);
        let current = state
            .dynamic_fields
            .get(&name)
            .ok_or_else(|| anyhow::anyhow!("{label} attribute is missing required field {name}"))?;
        let SnapshotValue::Float(current_bits) = current else {
            bail!("{label} field {name} is not float32");
        };
        if expected_current_bits.is_some_and(|expected| *current_bits != expected) {
            bail!(
                "{label} expected current raw ID {:?}, found {}",
                expected_current_bits,
                current_bits
            );
        }
        state
            .dynamic_fields
            .insert(name, SnapshotValue::Float(desired_bits));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EntitySelector, MissingFields, Team, ValidatedReplacement, ValidatedRule};

    fn state(team: u8) -> CosmeticState {
        let stem = "m_AttributeManager.m_Item.m_NetworkedDynamicAttributes.m_Attributes.0000";
        CosmeticState {
            kind: ItemKind::Weapon,
            class: "CWeaponGlock".to_owned(),
            team: Some(team),
            account_id: 7,
            item_id: ItemIdentity { high: 1, low: 2 },
            definition_index: Some(4),
            entity_quality: Some(4),
            entity_level: Some(1),
            inventory_position: Some(0),
            initialized: Some(true),
            subclass_token: None,
            model_resource_handle: None,
            mesh_group_mask: Some(1),
            body_group: Some(0),
            custom_name: Some(String::new()),
            glove_changed: None,
            fallback_paint_kit: Some(0),
            fallback_seed: Some(0),
            fallback_wear: Some(0),
            fallback_stattrak: Some(-1),
            dynamic_attribute_count: Some(1),
            dynamic_fields: BTreeMap::from([
                (
                    format!("{stem}.m_iAttributeDefinitionIndex"),
                    SnapshotValue::Unsigned16(PAINT_ATTRIBUTE),
                ),
                (
                    format!("{stem}.m_iRawValue32"),
                    SnapshotValue::Float(1.0_f32.to_bits()),
                ),
                (
                    format!("{stem}.m_flInitialValue"),
                    SnapshotValue::Float(1.0_f32.to_bits()),
                ),
            ]),
        }
    }

    fn t_rule() -> ValidatedRule {
        ValidatedRule {
            id: "t-only".to_owned(),
            player_id: "p".to_owned(),
            account_id: 7,
            team: Team::T,
            entity: EntitySelector {
                kind: ItemKind::Weapon,
                class: "CWeaponGlock".to_owned(),
                item_id: ItemIdentity { high: 1, low: 2 },
                source_definition_index: None,
            },
            replacement: ValidatedReplacement {
                item_id: None,
                definition_index: None,
                paint_kit: Some(38),
                pattern_seed: None,
                wear: None,
                knife_variant: None,
                custom_name: None,
                stickers: Vec::new(),
                charm: None,
                visual_state: None,
            },
            missing_fields: MissingFields::default(),
        }
    }

    fn snapshot(tick: u32, team: u8, paint: f32) -> CosmeticSnapshot {
        let mut state = state(team);
        let stem = "m_AttributeManager.m_Item.m_NetworkedDynamicAttributes.m_Attributes.0000";
        for suffix in ["m_iRawValue32", "m_flInitialValue"] {
            state.dynamic_fields.insert(
                format!("{stem}.{suffix}"),
                SnapshotValue::Float(paint.to_bits()),
            );
        }
        CosmeticSnapshot {
            tick,
            handle: 42,
            state,
        }
    }

    #[test]
    fn team_selects_the_item_but_rewrite_scope_is_stable_identity() {
        let rule = t_rule();
        assert!(rule_matches_state(&rule, &state(2)));
        assert!(!rule_matches_state(&rule, &state(3)));
        assert!(rule_matches_source_identity(&rule, &state(2)));
        assert!(rule_matches_source_identity(&rule, &state(3)));
    }

    #[test]
    fn attribute_replacement_preserves_unrelated_layout_fields() -> Result<()> {
        let mut state = state(2);
        let unrelated = "m_AttributeManager.m_Item.m_NetworkedDynamicAttributes.m_Attributes.0000.m_nRefundableCurrency";
        state
            .dynamic_fields
            .insert(unrelated.to_owned(), SnapshotValue::Signed32(9));
        replace_attribute(
            &mut state,
            PAINT_ATTRIBUTE,
            38.0_f32.to_bits(),
            None,
            "paint",
        )?;
        assert_eq!(
            state.dynamic_fields.get(unrelated),
            Some(&SnapshotValue::Signed32(9))
        );
        Ok(())
    }

    #[test]
    fn verifier_accepts_delayed_econ_materialization_after_team_changes() -> Result<()> {
        let config = ValidatedConfig {
            players: Vec::new(),
            rules: vec![t_rule()],
        };
        let original = DemoCapture {
            snapshots: vec![
                snapshot(10, 3, 1.0),
                snapshot(20, 2, 1.0),
                snapshot(30, 3, 1.0),
            ],
            player_names: BTreeMap::new(),
            ..DemoCapture::default()
        };
        let rewritten = DemoCapture {
            snapshots: vec![snapshot(10, 3, 38.0), snapshot(20, 2, 38.0)],
            player_names: BTreeMap::new(),
            ..DemoCapture::default()
        };
        let targets = ResolvedTargets {
            by_handle: BTreeMap::from([(42, 0)]),
            per_rule: vec![BTreeSet::from([42])],
        };
        let summary = verify_captures(&original, &rewritten, &config, &targets)?;
        assert_eq!(summary.target_snapshots, 2);
        assert_eq!(summary.target_entity_handles, 1);
        Ok(())
    }
}
