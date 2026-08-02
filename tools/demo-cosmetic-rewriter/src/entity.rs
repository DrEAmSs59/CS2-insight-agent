use crate::config::{ItemIdentity, ItemKind};
use source2_demo::prelude::{Entity, FieldValue};

pub const TEAM_FIELD: &str = "m_iTeamNum";
pub const KNIFE_SUBCLASS_FIELD: &str = "m_nSubclassID";
pub const MODEL_FIELD: &str = "CBodyComponent.m_skeletonInstance.m_modelState.m_hModel";
pub const MESH_GROUP_FIELD: &str = "CBodyComponent.m_skeletonInstance.m_modelState.m_MeshGroupMask";
pub const BODY_GROUP_FIELD: &str =
    "CBodyComponent.m_skeletonInstance.m_modelState.m_nBodyGroupChoices.0000";
pub const GLOVE_CHANGED_FIELD: &str = "m_nEconGlovesChanged";
pub const OWNER_ENTITY_FIELD: &str = "m_hOwnerEntity";
pub const ORIGINAL_OWNER_ACCOUNT_FIELD: &str = "m_OriginalOwnerXuidLow";

pub const PAINT_ATTRIBUTE: u16 = 6;
pub const SEED_ATTRIBUTE: u16 = 7;
pub const WEAR_ATTRIBUTE: u16 = 8;
pub const CHARM_ATTRIBUTE: u16 = 299;

pub fn item_prefix(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Glove => "m_EconGloves",
        ItemKind::Knife | ItemKind::Weapon => "m_AttributeManager.m_Item",
    }
}

pub fn dynamic_prefix(kind: ItemKind) -> String {
    format!(
        "{}.m_NetworkedDynamicAttributes.m_Attributes",
        item_prefix(kind)
    )
}

pub fn definition_index_field(kind: ItemKind) -> String {
    format!("{}.m_iItemDefinitionIndex", item_prefix(kind))
}

pub fn custom_name_field(kind: ItemKind) -> String {
    format!("{}.m_szCustomName", item_prefix(kind))
}

pub fn value<'a>(entity: &'a Entity, wanted: &str) -> Option<&'a FieldValue> {
    entity.get_property(wanted).ok()
}

pub fn u64_field(entity: &Entity, wanted: &str) -> Option<u64> {
    match value(entity, wanted) {
        Some(FieldValue::Unsigned64(value)) => Some(*value),
        _ => None,
    }
}

pub fn u32_field(entity: &Entity, wanted: &str) -> Option<u32> {
    match value(entity, wanted) {
        Some(FieldValue::Unsigned32(value)) => Some(*value),
        _ => None,
    }
}

pub fn u16_field(entity: &Entity, wanted: &str) -> Option<u16> {
    match value(entity, wanted) {
        Some(FieldValue::Unsigned16(value)) => Some(*value),
        _ => None,
    }
}

pub fn u8_field(entity: &Entity, wanted: &str) -> Option<u8> {
    match value(entity, wanted) {
        Some(FieldValue::Unsigned8(value)) => Some(*value),
        _ => None,
    }
}

pub fn i32_field(entity: &Entity, wanted: &str) -> Option<i32> {
    match value(entity, wanted) {
        Some(FieldValue::Signed32(value)) => Some(*value),
        _ => None,
    }
}

pub fn bool_field(entity: &Entity, wanted: &str) -> Option<bool> {
    match value(entity, wanted) {
        Some(FieldValue::Boolean(value)) => Some(*value),
        _ => None,
    }
}

pub fn string_field(entity: &Entity, wanted: &str) -> Option<String> {
    match value(entity, wanted) {
        Some(FieldValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

pub fn entity_item_identity(entity: &Entity, kind: ItemKind) -> Option<ItemIdentity> {
    let prefix = item_prefix(kind);
    Some(ItemIdentity {
        high: u32_field(entity, &format!("{prefix}.m_iItemIDHigh"))?,
        low: u32_field(entity, &format!("{prefix}.m_iItemIDLow"))?,
    })
}

pub fn entity_account_id(entity: &Entity, kind: ItemKind) -> Option<u32> {
    u32_field(entity, &format!("{}.m_iAccountID", item_prefix(kind)))
}

pub fn dynamic_attribute_definition(
    entity: &Entity,
    kind: ItemKind,
    field_name: &str,
) -> Option<u16> {
    let dynamic_prefix = dynamic_prefix(kind);
    if !field_name.starts_with(&dynamic_prefix) {
        return None;
    }
    let stem = field_name
        .strip_suffix(".m_iRawValue32")
        .or_else(|| field_name.strip_suffix(".m_flInitialValue"))?;
    u16_field(entity, &format!("{stem}.m_iAttributeDefinitionIndex"))
}
