use crate::config::{ItemKind, MissingEconPolicy, ValidatedConfig, ValidatedRule};
use crate::entity::{
    custom_name_field, definition_index_field, dynamic_attribute_definition, dynamic_prefix,
    item_prefix, u8_field, BODY_GROUP_FIELD, CHARM_ATTRIBUTE, GLOVE_CHANGED_FIELD,
    KNIFE_SUBCLASS_FIELD, MESH_GROUP_FIELD, MODEL_FIELD, PAINT_ATTRIBUTE, SEED_ATTRIBUTE,
    TEAM_FIELD, WEAR_ATTRIBUTE,
};
use crate::verify::ResolvedTargets;
use anyhow::{bail, Context as AnyhowContext, Result};
use source2_demo::prelude::*;
use source2_demo::writer::*;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone, Debug, Default)]
pub struct RulePassReport {
    pub entity_handles: BTreeSet<u32>,
    pub fields_written: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Default)]
pub struct ReplacementPassReport {
    pub rules: Vec<RulePassReport>,
    pub total_fields_written: usize,
}

#[derive(Clone, Debug, Default)]
pub struct MaterializationReport {
    pub rules: Vec<RulePassReport>,
    pub fields_materialized: usize,
}

struct CosmeticRewriter {
    config: Arc<ValidatedConfig>,
    targets: Arc<ResolvedTargets>,
    seen_created_fields: BTreeMap<(u32, u32), BTreeSet<String>>,
    replacement: ReplacementPassReport,
    materialization: MaterializationReport,
    errors: BTreeSet<String>,
}

impl CosmeticRewriter {
    fn new(config: Arc<ValidatedConfig>, targets: Arc<ResolvedTargets>) -> Self {
        let rule_count = config.rules.len();
        Self {
            config,
            targets,
            seen_created_fields: BTreeMap::new(),
            replacement: ReplacementPassReport {
                rules: vec![RulePassReport::default(); rule_count],
                total_fields_written: 0,
            },
            materialization: MaterializationReport {
                rules: vec![RulePassReport::default(); rule_count],
                fields_materialized: 0,
            },
            errors: BTreeSet::new(),
        }
    }

    fn rule_index(&self, entity: &Entity) -> Option<usize> {
        self.targets.rule_for_handle(entity.handle())
    }

    fn record_error(&mut self, rule_index: usize, entity: &Entity, error: anyhow::Error) {
        self.errors.insert(format!(
            "rule {:?}, entity {}: {error:#}",
            self.config.rules[rule_index].id,
            entity.handle()
        ));
    }
}

impl DemoRewriter for CosmeticRewriter {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::ENTITY_FIELDS
    }

    fn should_track_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        self.rule_index(entity).is_some()
    }

    fn should_rewrite_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        self.rule_index(entity).is_some()
    }

    fn replace_entity_field(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
        field_name: &str,
        current: &FieldValue,
    ) -> Option<FieldValue> {
        let rule_index = self.rule_index(entity)?;
        if event == EntityEvents::Created {
            self.seen_created_fields
                .entry((ctx.tick(), entity.handle()))
                .or_default()
                .insert(field_name.to_owned());
        }
        self.replacement.rules[rule_index]
            .entity_handles
            .insert(entity.handle());
        let rule = &self.config.rules[rule_index];
        let result = if rule.missing_fields.econ == MissingEconPolicy::Materialize {
            materialized_fields(rule, entity).and_then(|fields| {
                let Some((_, desired)) = fields.into_iter().find(|(name, _)| name == field_name)
                else {
                    return Ok(None);
                };
                if desired.type_name() != current.type_name() {
                    bail!(
                        "field {field_name} type mismatch: stream={} replacement={}",
                        current.type_name(),
                        desired.type_name()
                    );
                }
                Ok(Some(desired))
            })
        } else {
            replacement_for_existing_field(rule, entity, field_name, current)
        };
        match result {
            Ok(Some(value)) => {
                *self.replacement.rules[rule_index]
                    .fields_written
                    .entry(field_name.to_owned())
                    .or_default() += 1;
                self.replacement.total_fields_written += 1;
                Some(value)
            }
            Ok(None) => None,
            Err(error) => {
                self.record_error(rule_index, entity, error);
                None
            }
        }
    }

    fn append_entity_fields(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> Vec<(String, FieldValue)> {
        if event != EntityEvents::Created {
            return Vec::new();
        }
        let Some(rule_index) = self.rule_index(entity) else {
            return Vec::new();
        };
        let rule = &self.config.rules[rule_index];
        if rule.missing_fields.econ != MissingEconPolicy::Materialize {
            return Vec::new();
        }
        self.materialization.rules[rule_index]
            .entity_handles
            .insert(entity.handle());
        let seen = self
            .seen_created_fields
            .remove(&(ctx.tick(), entity.handle()))
            .unwrap_or_default();
        let fields = match materialized_fields(rule, entity) {
            Ok(fields) => fields
                .into_iter()
                .filter(|(name, _)| !seen.contains(name))
                .collect::<Vec<_>>(),
            Err(error) => {
                self.record_error(rule_index, entity, error);
                return Vec::new();
            }
        };
        for (name, _) in &fields {
            *self.materialization.rules[rule_index]
                .fields_written
                .entry(name.clone())
                .or_default() += 1;
        }
        self.materialization.fields_materialized += fields.len();
        fields
    }
}

pub fn run_rewrite_pass(
    input: &Path,
    output: File,
    config: Arc<ValidatedConfig>,
    targets: Arc<ResolvedTargets>,
) -> Result<(ReplacementPassReport, Option<MaterializationReport>)> {
    let input_file = File::open(input)
        .with_context(|| format!("failed to open input demo {}", input.display()))?;
    let mut writer = DemoWriter::from_reader(input_file, output)?;
    let state = writer.add_rewriter(CosmeticRewriter::new(config.clone(), targets.clone()));
    writer.run()?;
    drop(writer);

    let state = state.borrow();
    if !state.errors.is_empty() {
        bail!(
            "cosmetic rewrite failed:\n{}",
            state.errors.iter().cloned().collect::<Vec<_>>().join("\n")
        );
    }
    for (rule_index, rule) in config.rules.iter().enumerate() {
        let missing = targets.handles_for_rule(rule_index)
            - &state.replacement.rules[rule_index].entity_handles;
        if !missing.is_empty() {
            bail!(
                "rule {:?} did not rewrite resolved handles {:?}",
                rule.id,
                missing
            );
        }
    }
    let materialization = config
        .has_materialization()
        .then(|| state.materialization.clone());
    Ok((state.replacement.clone(), materialization))
}

fn materialized_fields(rule: &ValidatedRule, entity: &Entity) -> Result<Vec<(String, FieldValue)>> {
    let replacement = &rule.replacement;
    let item_id = replacement
        .item_id
        .expect("validated materialization has replacement item_id");
    let definition = replacement
        .definition_index
        .expect("validated materialization has definition_index");
    let paint = replacement
        .paint_kit
        .expect("validated materialization has paint") as f32;
    let seed = replacement
        .pattern_seed
        .expect("validated materialization has seed");
    let wear = replacement
        .wear
        .expect("validated materialization has wear");
    let prefix = item_prefix(rule.entity.kind);
    let quality = match rule.entity.kind {
        ItemKind::Glove | ItemKind::Knife => 3,
        ItemKind::Weapon => 4,
    };
    let inventory_position = if rule.entity.kind == ItemKind::Glove {
        48
    } else {
        0
    };
    let mut fields = vec![
        (
            format!("{prefix}.m_iItemDefinitionIndex"),
            FieldValue::Unsigned16(definition),
        ),
        (
            format!("{prefix}.m_iEntityQuality"),
            FieldValue::Signed32(quality),
        ),
        (
            format!("{prefix}.m_iEntityLevel"),
            FieldValue::Unsigned32(1),
        ),
        (
            format!("{prefix}.m_iItemIDHigh"),
            FieldValue::Unsigned32(item_id.high),
        ),
        (
            format!("{prefix}.m_iItemIDLow"),
            FieldValue::Unsigned32(item_id.low),
        ),
        (
            format!("{prefix}.m_iAccountID"),
            FieldValue::Unsigned32(rule.account_id),
        ),
        (
            format!("{prefix}.m_iInventoryPosition"),
            FieldValue::Unsigned32(inventory_position),
        ),
        (
            format!("{prefix}.m_bInitialized"),
            FieldValue::Boolean(true),
        ),
        (dynamic_prefix(rule.entity.kind), FieldValue::Unsigned32(3)),
    ];
    for (slot, definition, value) in [(0, 6, paint), (1, 7, seed), (2, 8, wear)] {
        let stem = format!("{}.{slot:04}", dynamic_prefix(rule.entity.kind));
        fields.extend([
            (
                format!("{stem}.m_iAttributeDefinitionIndex"),
                FieldValue::Unsigned16(definition),
            ),
            (format!("{stem}.m_iRawValue32"), FieldValue::Float(value)),
            (format!("{stem}.m_flInitialValue"), FieldValue::Float(value)),
            (
                format!("{stem}.m_nRefundableCurrency"),
                FieldValue::Signed32(0),
            ),
            (format!("{stem}.m_bSetBonus"), FieldValue::Boolean(false)),
        ]);
    }
    if let Some(custom_name) = &replacement.custom_name {
        fields.push((
            custom_name_field(rule.entity.kind),
            FieldValue::String(custom_name.clone()),
        ));
    }
    if rule.entity.kind == ItemKind::Glove {
        fields.push((GLOVE_CHANGED_FIELD.to_owned(), FieldValue::Unsigned8(1)));
    } else {
        fields.extend([
            ("m_nFallbackPaintKit".to_owned(), FieldValue::Signed32(0)),
            ("m_nFallbackSeed".to_owned(), FieldValue::Signed32(0)),
            ("m_flFallbackWear".to_owned(), FieldValue::Float(0.0)),
            ("m_nFallbackStatTrak".to_owned(), FieldValue::Signed32(-1)),
        ]);
    }
    if let Some(variant) = &replacement.knife_variant {
        fields.extend([
            (
                KNIFE_SUBCLASS_FIELD.to_owned(),
                FieldValue::Unsigned32(variant.subclass_token),
            ),
            (
                MODEL_FIELD.to_owned(),
                FieldValue::Unsigned64(variant.model_resource_handle),
            ),
        ]);
    }
    let visual = if let Some(visual) = &replacement.visual_state {
        (visual.mesh_group_mask, visual.body_group)
    } else if rule.entity.kind == ItemKind::Glove {
        match u8_field(entity, TEAM_FIELD).or_else(|| rule.team.number()) {
            Some(2) => (2, 1),
            Some(3) => (9, 0),
            team => bail!("cannot choose glove visual state without T/CT team (observed {team:?})"),
        }
    } else {
        unreachable!("validated non-glove materialization has visual state")
    };
    fields.extend([
        (
            MESH_GROUP_FIELD.to_owned(),
            FieldValue::Unsigned64(visual.0),
        ),
        (BODY_GROUP_FIELD.to_owned(), FieldValue::Signed32(visual.1)),
    ]);
    Ok(fields)
}

fn replacement_for_existing_field(
    rule: &ValidatedRule,
    entity: &Entity,
    field_name: &str,
    current: &FieldValue,
) -> Result<Option<FieldValue>> {
    let replacement = &rule.replacement;
    if replacement.definition_index.is_some()
        && field_name == definition_index_field(rule.entity.kind)
    {
        let FieldValue::Unsigned16(_) = current else {
            bail!(
                "definition index field has unexpected type {}",
                current.type_name()
            );
        };
        return Ok(replacement.definition_index.map(FieldValue::Unsigned16));
    }
    if rule.entity.kind == ItemKind::Glove && field_name == GLOVE_CHANGED_FIELD {
        let FieldValue::Unsigned8(_) = current else {
            bail!(
                "glove change field has unexpected type {}",
                current.type_name()
            );
        };
        return Ok(Some(FieldValue::Unsigned8(1)));
    }
    if let Some(variant) = &replacement.knife_variant {
        if field_name == KNIFE_SUBCLASS_FIELD {
            let FieldValue::Unsigned32(_) = current else {
                bail!(
                    "knife subclass field has unexpected type {}",
                    current.type_name()
                );
            };
            return Ok(Some(FieldValue::Unsigned32(variant.subclass_token)));
        }
        if field_name == MODEL_FIELD {
            let FieldValue::Unsigned64(_) = current else {
                bail!(
                    "knife model field has unexpected type {}",
                    current.type_name()
                );
            };
            return Ok(Some(FieldValue::Unsigned64(variant.model_resource_handle)));
        }
    }
    if let Some(visual) = &replacement.visual_state {
        if field_name == MESH_GROUP_FIELD {
            return Ok(Some(FieldValue::Unsigned64(visual.mesh_group_mask)));
        }
        if field_name == BODY_GROUP_FIELD {
            return Ok(Some(FieldValue::Signed32(visual.body_group)));
        }
    }
    if let Some(custom_name) = &replacement.custom_name {
        if field_name == custom_name_field(rule.entity.kind) {
            let FieldValue::String(_) = current else {
                bail!(
                    "custom name field has unexpected type {}",
                    current.type_name()
                );
            };
            return Ok(Some(FieldValue::String(custom_name.clone())));
        }
    }

    let Some(attribute) = dynamic_attribute_definition(entity, rule.entity.kind, field_name) else {
        return Ok(None);
    };
    let FieldValue::Float(current_float) = current else {
        bail!(
            "dynamic attribute {attribute} has unexpected type {}",
            current.type_name()
        );
    };
    let numeric = match attribute {
        PAINT_ATTRIBUTE => replacement.paint_kit.map(|value| value as f32),
        SEED_ATTRIBUTE => replacement.pattern_seed,
        WEAR_ATTRIBUTE => replacement.wear,
        _ => None,
    };
    if let Some(value) = numeric {
        return Ok(Some(FieldValue::Float(value)));
    }

    for sticker in &replacement.stickers {
        if attribute != sticker.attribute_definition_index() {
            continue;
        }
        if sticker
            .expected_current_id
            .is_some_and(|expected| current_float.to_bits() != expected)
        {
            bail!(
                "sticker slot {} expected current ID {:?}, found {}",
                sticker.slot,
                sticker.expected_current_id,
                current_float.to_bits()
            );
        }
        return Ok(Some(FieldValue::Float(f32::from_bits(sticker.sticker_id))));
    }
    if let Some(charm) = &replacement.charm {
        if attribute == CHARM_ATTRIBUTE {
            if charm
                .expected_current_id
                .is_some_and(|expected| current_float.to_bits() != expected)
            {
                bail!(
                    "charm expected current ID {:?}, found {}",
                    charm.expected_current_id,
                    current_float.to_bits()
                );
            }
            return Ok(Some(FieldValue::Float(f32::from_bits(charm.charm_id))));
        }
    }
    Ok(None)
}
