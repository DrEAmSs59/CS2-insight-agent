use super::entities::PlayerMetaData;
use super::variants::Sticker;
use super::variants::Variant;
use crate::first_pass::prop_controller::*;
use crate::first_pass::read_bits::DemoParserError;
use crate::maps::BUTTONMAP;
use crate::maps::PLAYER_COLOR;
use crate::second_pass::entities::EntityType;
use crate::second_pass::parser_settings::SecondPassParser;
use crate::second_pass::variants::PropColumn;
use crate::second_pass::variants::VarVec;
use csgoproto::maps::AGENTSMAP;
use csgoproto::maps::PAINTKITS;
use csgoproto::maps::STICKER_ID_TO_NAME;
use csgoproto::maps::WEAPINDICIES;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PropType {
    Team,
    Rules,
    Custom,
    Controller,
    Player,
    Weapon,
    Button,
    Name,
    Steamid,
    Tick,
    GameTime,
}

// DONT KNOW IF THESE ARE CORRECT. SEEMS TO GIVE CORRECT VALUES
const CELL_BITS: i32 = 9;
const MAX_COORD: f32 = (1 << 14) as f32;
// https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/constants/constants.go#L11
const IS_AIRBORNE_CONST: u32 = 0xFFFFFF;

#[derive(Debug, Clone)]
pub struct ProjectileRecord {
    pub steamid: Option<u64>,
    pub name: Option<String>,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub z: Option<f32>,
    pub tick: Option<i32>,
    pub grenade_type: Option<String>,
    pub entity_id: Option<i32>,
}
pub enum CoordinateAxis {
    X,
    Y,
    Z,
}


#[derive(Clone, Copy, Debug, Default)]
struct StickerAttrState {
    id: Option<u32>,
    wear: Option<f32>,
    offset_x: Option<f32>,
    offset_y: Option<f32>,
    scale: Option<f32>,
    rotation: Option<f32>,
}

impl StickerAttrState {
    fn into_sticker(self, _slot: u32) -> Option<Sticker> {
        let id = self.id.filter(|value| *value != 0)?;
        let name = STICKER_ID_TO_NAME
            .get(&id)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let wear = self.wear.unwrap_or(0.0).max(0.0);
        let x = self.offset_x.unwrap_or(0.0);
        let y = self.offset_y.unwrap_or(0.0);
        if !wear.is_finite()
            || wear > 1.0
            || !x.is_finite()
            || !y.is_finite()
            || self.scale.is_some_and(|value| !value.is_finite())
            || self.rotation.is_some_and(|value| !value.is_finite())
        {
            return None;
        }
        Some(Sticker {
            id,
            name,
            wear,
            x,
            y,
        })
    }
}

fn stickers_from_econ_attributes(attributes: impl IntoIterator<Item = (u32, f32)>) -> Vec<Sticker> {
    let mut layers = vec![[StickerAttrState::default(); 5]];
    for (definition_index, raw_value) in attributes {
        match definition_index {
            113 | 117 | 121 | 125 | 129 => {
                let slot = ((definition_index - 113) / 4) as usize;
                if layers.last().is_some_and(|layer| layer[slot].id.is_some()) {
                    layers.push([StickerAttrState::default(); 5]);
                }
                let bits = raw_value.to_bits();
                layers.last_mut().expect("sticker layer")[slot].id = (bits != 0).then_some(bits);
            }
            114 | 118 | 122 | 126 | 130 => {
                let slot = ((definition_index - 114) / 4) as usize;
                layers.last_mut().expect("sticker layer")[slot].wear = Some(raw_value);
            }
            115 | 119 | 123 | 127 | 131 => {
                let slot = ((definition_index - 115) / 4) as usize;
                layers.last_mut().expect("sticker layer")[slot].scale = Some(raw_value);
            }
            116 | 120 | 124 | 128 | 132 => {
                let slot = ((definition_index - 116) / 4) as usize;
                layers.last_mut().expect("sticker layer")[slot].rotation = Some(raw_value);
            }
            278..=287 => {
                let slot = ((definition_index - 278) / 2) as usize;
                if slot >= 5 {
                    continue;
                }
                if (definition_index - 278) % 2 == 0 {
                    layers.last_mut().expect("sticker layer")[slot].offset_x = Some(raw_value);
                } else {
                    layers.last_mut().expect("sticker layer")[slot].offset_y = Some(raw_value);
                }
            }
            _ => {}
        }
    }
    (0..5)
        .filter_map(|slot| layers.iter().find_map(|layer| layer[slot].into_sticker(slot as u32)))
        .collect()
}


// This file collects the data that is converted into a dataframe in the end in parser.parse_ticks()

impl<'a> SecondPassParser<'a> {
    pub fn collect_entities(&mut self) {
        if !self.prop_controller.event_with_velocity {
            if !self.wanted_ticks.contains(&self.tick) && self.wanted_ticks.len() != 0 || self.wanted_events.len() != 0 {
                return;
            }
        }
        if self.parse_projectiles && self.parse_infernos {
            self.collect_utility_effect_changes();
            return;
        }
        if self.parse_projectiles {
            self.collect_projectiles();
            return;
        }
        if self.parse_infernos {
            self.collect_infernos();
            return;
        }
        // iterate every player and every wanted prop name
        // if either one is missing then push None to output
        for (entity_id, player) in &self.players {
            // iterate every wanted prop state
            // if any prop's state for this tick is not the wanted state, dont extract info from tick
            for wanted_prop_state_info in &self.prop_controller.wanted_prop_state_infos {
                match self.find_prop(&wanted_prop_state_info.base, entity_id, player) {
                    Ok(prop) => {
                        if prop != wanted_prop_state_info.wanted_prop_state {
                            return;
                        }
                    }
                    Err(_e) => return,
                }
            }

            // Player-constant work hoisted out of the per-prop loop: steamid, the wanted-player
            // filter (same verdict for every prop -> skip the whole player), and the df_per_player
            // bucket init. Behaviour-identical to the per-prop version.
            let player_steamid = player.steamid.unwrap_or(0);
            if !self.wanted_players.is_empty() && !self.wanted_players.contains(&player_steamid) {
                continue;
            }
            let mut velocity_indicies: Option<Vec<usize>> = None;
            let mut button_mask: Option<Option<u64>> = None;
            if self.order_by_steamid {
                for prop_info in &self.prop_controller.prop_infos {
                    // find_prop borrows &self; resolve the value before the &mut df_per_player borrow.
                    let val = self.find_prop_with_collect_cache(prop_info, entity_id, player, &mut velocity_indicies, &mut button_mask);
                    self.df_per_player
                        .entry(player_steamid)
                        .or_default()
                        .entry(prop_info.id)
                        .or_insert_with(PropColumn::new)
                        .push(val);
                }
            } else {
                for prop_info in &self.prop_controller.prop_infos {
                    let val = self.find_prop_with_collect_cache(prop_info, entity_id, player, &mut velocity_indicies, &mut button_mask);
                    self.output
                        .entry(prop_info.id)
                        .or_insert_with(PropColumn::new)
                        .push(val);
                }
            }
        }
    }

    #[inline(always)]
    fn find_prop_with_collect_cache(
        &self,
        prop_info: &PropInfo,
        entity_id: &i32,
        player: &PlayerMetaData,
        velocity_indicies: &mut Option<Vec<usize>>,
        button_mask: &mut Option<Option<u64>>,
    ) -> Option<Variant> {
        match prop_info.id {
            VELOCITY_ID => self.collect_velocity_cached(player, velocity_indicies).ok(),
            VELOCITY_X_ID => self.collect_velocity_axis_cached(player, CoordinateAxis::X, velocity_indicies).ok(),
            VELOCITY_Y_ID => self.collect_velocity_axis_cached(player, CoordinateAxis::Y, velocity_indicies).ok(),
            VELOCITY_Z_ID => self.collect_velocity_axis_cached(player, CoordinateAxis::Z, velocity_indicies).ok(),
            _ if prop_info.prop_type == PropType::Button => self.get_button_prop_cached(prop_info, entity_id, button_mask).ok(),
            _ => self.find_prop(prop_info, entity_id, player).ok(),
        }
    }

    pub fn find_prop(&self, prop_info: &PropInfo, entity_id: &i32, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        match prop_info.prop_type {
            PropType::Tick => return self.create_tick(),
            PropType::Name => return self.create_name(player),
            PropType::Steamid => return self.create_steamid(player),
            PropType::Player => return self.get_prop_from_ent(&prop_info.id, &entity_id),
            PropType::Team => return self.find_team_prop(&prop_info.id, &entity_id),
            PropType::Custom => self.create_custom_prop(prop_info, entity_id, player),
            PropType::Weapon => return self.find_weapon_prop(&prop_info.id, &entity_id),
            PropType::Button => return self.get_button_prop(&prop_info, &entity_id),
            PropType::Controller => return self.get_controller_prop(&prop_info.id, player),
            PropType::Rules => return self.get_rules_prop(prop_info),
            PropType::GameTime => return Ok(Variant::F32(self.net_tick as f32 / 64.0)),
        }
    }
    pub fn get_prop_from_ent(&self, prop_id: &u32, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        match self.entities.get(*entity_id as usize) {
            Some(Some(e)) => match e.props.get(&prop_id) {
                None => return Err(PropCollectionError::GetPropFromEntPropNotFound),
                Some(prop) => return Ok(prop.clone()),
            },
            _ => return Err(PropCollectionError::GetPropFromEntEntityNotFound),
        }
    }
    fn create_tick(&self) -> Result<Variant, PropCollectionError> {
        // This can't actually fail
        return Ok(Variant::I32(self.tick));
    }
    pub fn create_steamid(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        match player.steamid {
            Some(steamid) => return Ok(Variant::U64(steamid)),
            // Revisit this as it was related to pandas null support with u64's
            _ => return Ok(Variant::U64(0)),
        }
    }
    pub fn create_name(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        match &player.name {
            Some(name) => return Ok(Variant::String(name.to_string())),
            _ => return Err(PropCollectionError::PlayerMetaDataNameNone),
        }
    }
    pub fn get_button_prop(&self, prop_info: &PropInfo, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        match self.prop_controller.special_ids.buttons {
            None => Err(PropCollectionError::ButtonsSpecialIDNone),
            Some(button_id) => match self.get_prop_from_ent(&button_id, &entity_id) {
                Ok(Variant::U64(button_mask)) => match BUTTONMAP.get(&prop_info.prop_name) {
                    Some(button_flag) => Ok(Variant::Bool(button_mask & button_flag != 0)),
                    None => return Err(PropCollectionError::ButtonsMapNoEntryFound),
                },
                Ok(_) => return Err(PropCollectionError::ButtonMaskNotU64Variant),
                Err(e) => Err(e),
            },
        }
    }
    fn get_button_prop_cached(
        &self,
        prop_info: &PropInfo,
        entity_id: &i32,
        button_mask_cache: &mut Option<Option<u64>>,
    ) -> Result<Variant, PropCollectionError> {
        if button_mask_cache.is_none() {
            *button_mask_cache = Some(match self.prop_controller.special_ids.buttons {
                Some(button_id) => match self.get_prop_from_ent(&button_id, entity_id) {
                    Ok(Variant::U64(mask)) => Some(mask),
                    _ => None,
                },
                None => None,
            });
        }
        match button_mask_cache.unwrap_or(None) {
            Some(button_mask) => match BUTTONMAP.get(&prop_info.prop_name) {
                Some(button_flag) => Ok(Variant::Bool(button_mask & button_flag != 0)),
                None => Err(PropCollectionError::ButtonsMapNoEntryFound),
            },
            None => Err(PropCollectionError::ButtonsSpecialIDNone),
        }
    }
    pub fn get_rules_prop(&self, prop_info: &PropInfo) -> Result<Variant, PropCollectionError> {
        match self.rules_entity_id {
            Some(entid) => return self.get_prop_from_ent(&prop_info.id, &entid),
            None => return Err(PropCollectionError::RulesEntityIdNotSet),
        }
    }
    pub fn get_controller_prop(&self, prop_id: &u32, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        match player.controller_entid {
            Some(entid) => {
                return self.get_prop_from_ent(prop_id, &entid)
            },
            None => return Err(PropCollectionError::ControllerEntityIdNotSet),
        }
    }
    fn find_owner_entid(&self, entity_id: &i32) -> Result<u32, PropCollectionError> {
        let owner_id = match self.prop_controller.special_ids.grenade_owner_id {
            Some(owner_id) => owner_id,
            None => return Err(PropCollectionError::GrenadeOwnerIdNotSet),
        };
        match self.get_prop_from_ent(&owner_id, entity_id) {
            Ok(Variant::U32(prop)) => Ok(prop & 0x7FF),
            Ok(_) => return Err(PropCollectionError::GrenadeOwnerIdPropIncorrectVariant),
            Err(e) => return Err(e),
        }
    }
    pub fn find_player_metadata(&self, entity_id: i32) -> Result<&PlayerMetaData, PropCollectionError> {
        match self.players.get(&entity_id) {
            Some(metadata) => Ok(metadata),
            None => Err(PropCollectionError::PlayerNotFound),
        }
    }
    pub fn find_thrower_steamid(&self, entity_id: &i32) -> Result<u64, PropCollectionError> {
        let owner_entid = self.find_owner_entid(entity_id)?;
        let metadata = self.find_player_metadata(owner_entid as i32)?;
        match metadata.steamid {
            Some(s) => Ok(s),
            // Watch out
            None => Ok(0),
        }
    }
    pub fn find_thrower_name(&self, entity_id: &i32) -> Result<String, PropCollectionError> {
        let owner_entid = self.find_owner_entid(entity_id)?;
        let metadata = self.find_player_metadata(owner_entid as i32)?;
        match &metadata.name {
            Some(s) => Ok(s.to_owned()),
            None => Err(PropCollectionError::PlayerMetaDataNameNone),
        }
    }

    fn find_grenade_type(&self, entity_id: &i32) -> Option<String> {
        if let Some(Some(ent)) = self.entities.get(*entity_id as usize) {
            if let Some(cls) = self.cls_by_id.get(ent.cls_id as usize) {
                return Some(cls.name.to_string());
            }
        }
        None
    }

    pub fn collect_projectiles(&mut self) {
        for projectile_entid in &self.projectiles {
            let grenade_type = match self.find_grenade_type(projectile_entid) {              
                Some(t) => {if !t.contains("Projectile") && !self.parse_grenades{continue}else{t}},
                None => continue,
            };
            let steamid = match self.find_thrower_steamid(projectile_entid) {
                Ok(u) => u,
                _ => continue,
            };
            let name = match self.find_thrower_name(projectile_entid) {
                Ok(x) => x,
                _ => continue,
            };
            // Projectiles are the only ones with coordinates others map to 0.0, map them to None as it is clearer.
            let (x, y, z) = if grenade_type.contains("Project") {
                let x = self.collect_cell_coordinate_grenade(CoordinateAxis::X, projectile_entid).ok();
                let y = self.collect_cell_coordinate_grenade(CoordinateAxis::Y, projectile_entid).ok();
                let z = self.collect_cell_coordinate_grenade(CoordinateAxis::Z, projectile_entid).ok();
                (x, y, z)
            } else {
                (None, None, None)
            };

            // Insert these always
            let pairs = vec![
                (GRENADE_TYPE_ID, Some(Variant::String(grenade_type))),
                (STEAMID_ID, Some(Variant::U64(steamid))),
                (NAME_ID, Some(Variant::String(name))),
                (TICK_ID, Some(Variant::I32(self.tick))),
                (ENTITY_ID_ID, Some(Variant::I32(*projectile_entid))),
                (GRENADE_X, x),
                (GRENADE_Y, y),
                (GRENADE_Z, z),
            ];
            for pair in pairs {
                self.output.entry(pair.0).or_insert_with(|| PropColumn::new()).push(pair.1);
            }

            for prop_info in &self.prop_controller.prop_infos {
                // Do these above, props in this loop are from the weapon entity.
                if prop_info.id == STEAMID_ID
                    || prop_info.id == NAME_ID
                    || prop_info.id == TICK_ID
                    || prop_info.id == GRENADE_TYPE_ID
                    || prop_info.id == ENTITY_ID_ID
                    || prop_info.id == GRENADE_X
                    || prop_info.id == GRENADE_Y
                    || prop_info.id == GRENADE_Z
                {
                    continue;
                }
                let prop = if prop_info.prop_name == "m_VoxelFrameData" || prop_info.prop_friendly_name == "m_VoxelFrameData" {
                    self.find_voxel_frame_data(projectile_entid).ok()
                } else if prop_info.prop_name == "m_firePositions" || prop_info.prop_friendly_name == "m_firePositions" {
                    self.find_fire_positions(projectile_entid).ok()
                } else if prop_info.prop_name == "m_bFireIsBurning" || prop_info.prop_friendly_name == "m_bFireIsBurning" {
                    self.find_fire_burning(projectile_entid).ok()
                } else if prop_info.prop_name == "m_fireParentPositions" || prop_info.prop_friendly_name == "m_fireParentPositions" {
                    self.find_fire_parent_positions(projectile_entid).ok()
                } else {
                    match self.get_prop_from_ent(&prop_info.id, &projectile_entid) {
                        Ok(p) => Some(p),
                        _ => None,
                    }
                };
                match prop {
                    Some(prop) => {
                        self.output.entry(prop_info.id).or_insert_with(|| PropColumn::new()).push(Some(prop));
                    }
                    None => {
                        self.output.entry(prop_info.id).or_insert_with(|| PropColumn::new()).push(None);
                    }
                }
            }
        }
    }

    fn utility_prop_value(&self, prop_info: &PropInfo, entity_id: &i32, smoke: bool) -> Option<Variant> {
        let name = prop_info.prop_name.as_str();
        let friendly_name = prop_info.prop_friendly_name.as_str();
        let is_prop = |wanted: &str| name == wanted || friendly_name == wanted;

        if smoke {
            if is_prop("m_firePositions") || is_prop("m_bFireIsBurning") || is_prop("m_fireParentPositions") {
                return None;
            }
        } else if is_prop("m_VoxelFrameData")
            || is_prop("m_nVoxelFrameDataSize")
            || is_prop("m_nVoxelUpdate")
            || is_prop("m_vSmokeDetonationPos")
            || is_prop("m_bDidSmokeEffect")
            || is_prop("m_nSmokeEffectTickBegin")
        {
            return None;
        }

        if is_prop("m_VoxelFrameData") {
            self.find_voxel_frame_data(entity_id).ok()
        } else if is_prop("m_firePositions") {
            self.find_fire_positions(entity_id).ok()
        } else if is_prop("m_bFireIsBurning") {
            self.find_fire_burning(entity_id).ok()
        } else if is_prop("m_fireParentPositions") {
            self.find_fire_parent_positions(entity_id).ok()
        } else {
            self.get_prop_from_ent(&prop_info.id, entity_id).ok()
        }
    }

    fn utility_named_prop(&self, entity_id: &i32, wanted: &str) -> Option<Variant> {
        self.prop_controller
            .prop_infos
            .iter()
            .find(|prop_info| prop_info.prop_name == wanted || prop_info.prop_friendly_name == wanted)
            .and_then(|prop_info| self.get_prop_from_ent(&prop_info.id, entity_id).ok())
    }

    fn push_utility_effect_row(
        &mut self,
        entity_id: i32,
        grenade_type: String,
        steamid: Option<u64>,
        name: Option<String>,
        values: Vec<(u32, Option<Variant>)>,
    ) {
        let x = self.collect_cell_coordinate_grenade(CoordinateAxis::X, &entity_id).ok();
        let y = self.collect_cell_coordinate_grenade(CoordinateAxis::Y, &entity_id).ok();
        let z = self.collect_cell_coordinate_grenade(CoordinateAxis::Z, &entity_id).ok();
        let pairs = [
            (GRENADE_TYPE_ID, Some(Variant::String(grenade_type))),
            (STEAMID_ID, steamid.map(Variant::U64)),
            (NAME_ID, name.map(Variant::String)),
            (TICK_ID, Some(Variant::I32(self.tick))),
            (ENTITY_ID_ID, Some(Variant::I32(entity_id))),
            (GRENADE_X, x),
            (GRENADE_Y, y),
            (GRENADE_Z, z),
        ];
        for (prop_id, value) in pairs {
            self.output.entry(prop_id).or_insert_with(PropColumn::new).push(value);
        }
        for (prop_id, value) in values {
            self.output.entry(prop_id).or_insert_with(PropColumn::new).push(value);
        }
    }

    /// Collect only utility-area state transitions. The combined Python API enables
    /// both parser modes, which lets smoke and inferno share one full demo pass.
    /// Smoke voxel bytes are copied only when the networked voxel update changes.
    pub fn collect_utility_effect_changes(&mut self) {
        self.utility_last_smoke_state
            .retain(|entity_id, _| self.projectiles.contains(entity_id));
        self.utility_last_inferno_state
            .retain(|entity_id, _| self.infernos.contains(entity_id));

        let prop_infos = self.prop_controller.prop_infos.clone();
        let projectile_ids: Vec<i32> = self.projectiles.iter().copied().collect();
        for entity_id in projectile_ids {
            let grenade_type = match self.find_grenade_type(&entity_id) {
                Some(grenade_type) if grenade_type == "CSmokeGrenadeProjectile" => grenade_type,
                _ => continue,
            };
            let did_smoke_effect = self.utility_named_prop(&entity_id, "m_bDidSmokeEffect");
            let is_active = matches!(
                did_smoke_effect,
                Some(Variant::Bool(true)) | Some(Variant::U32(1)) | Some(Variant::I32(1))
            );
            if !is_active {
                continue;
            }

            let voxel_update = self.utility_named_prop(&entity_id, "m_nVoxelUpdate");
            let smoke_begin = self.utility_named_prop(&entity_id, "m_nSmokeEffectTickBegin");
            let state = vec![voxel_update.clone(), smoke_begin];
            if voxel_update.is_some()
                && self.utility_last_smoke_state.get(&entity_id) == Some(&state)
            {
                continue;
            }
            self.utility_last_smoke_state.insert(entity_id, state);

            let values = prop_infos
                .iter()
                .filter(|prop_info| {
                    prop_info.id != STEAMID_ID
                        && prop_info.id != NAME_ID
                        && prop_info.id != TICK_ID
                        && prop_info.id != GRENADE_TYPE_ID
                        && prop_info.id != ENTITY_ID_ID
                        && prop_info.id != GRENADE_X
                        && prop_info.id != GRENADE_Y
                        && prop_info.id != GRENADE_Z
                })
                .map(|prop_info| {
                    (
                        prop_info.id,
                        self.utility_prop_value(prop_info, &entity_id, true),
                    )
                })
                .collect();
            self.push_utility_effect_row(
                entity_id,
                grenade_type,
                self.find_thrower_steamid(&entity_id).ok(),
                self.find_thrower_name(&entity_id).ok(),
                values,
            );
        }

        let inferno_ids: Vec<i32> = self.infernos.iter().copied().collect();
        for entity_id in inferno_ids {
            let values: Vec<(u32, Option<Variant>)> = prop_infos
                .iter()
                .filter(|prop_info| {
                    prop_info.id != STEAMID_ID
                        && prop_info.id != NAME_ID
                        && prop_info.id != TICK_ID
                        && prop_info.id != GRENADE_TYPE_ID
                        && prop_info.id != ENTITY_ID_ID
                        && prop_info.id != GRENADE_X
                        && prop_info.id != GRENADE_Y
                        && prop_info.id != GRENADE_Z
                })
                .map(|prop_info| {
                    (
                        prop_info.id,
                        self.utility_prop_value(prop_info, &entity_id, false),
                    )
                })
                .collect();
            let mut state: Vec<Option<Variant>> =
                values.iter().map(|(_, value)| value.clone()).collect();
            // Keep sparse rows close enough for the Python lifecycle splitter to
            // distinguish a long-lived inferno from later reuse of the entity id.
            state.push(Some(Variant::I32(self.tick.div_euclid(64))));
            if self.utility_last_inferno_state.get(&entity_id) == Some(&state) {
                continue;
            }
            self.utility_last_inferno_state.insert(entity_id, state);
            self.push_utility_effect_row(
                entity_id,
                "CInferno".to_string(),
                None,
                None,
                values,
            );
        }
    }

    pub fn find_voxel_frame_data(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let len = match self.get_prop_from_ent(&VOXEL_FRAME_DATA_OFFSET, entity_id) {
            Ok(Variant::U32(n)) => n.min(VOXEL_FRAME_DATA_MAX) as usize,
            Ok(Variant::U8Vec(v)) => return Ok(Variant::U8Vec(v)),
            _ => {
                // Length update may be missing; scan filled slots up to known max.
                let mut bytes = Vec::new();
                for i in 0..VOXEL_FRAME_DATA_MAX {
                    match self.get_prop_from_ent(&(VOXEL_FRAME_DATA_OFFSET + 1 + i), entity_id) {
                        Ok(Variant::U32(b)) => bytes.push((b & 0xFF) as u8),
                        Ok(Variant::I32(b)) => bytes.push((b & 0xFF) as u8),
                        _ => {
                            if bytes.is_empty() {
                                continue;
                            }
                            break;
                        }
                    }
                }
                if bytes.is_empty() {
                    return Err(PropCollectionError::GetPropFromEntPropNotFound);
                }
                return Ok(Variant::U8Vec(bytes));
            }
        };
        let mut bytes = Vec::with_capacity(len);
        for i in 0..len as u32 {
            match self.get_prop_from_ent(&(VOXEL_FRAME_DATA_OFFSET + 1 + i), entity_id) {
                Ok(Variant::U32(b)) => bytes.push((b & 0xFF) as u8),
                Ok(Variant::I32(b)) => bytes.push((b & 0xFF) as u8),
                _ => bytes.push(0),
            }
        }
        Ok(Variant::U8Vec(bytes))
    }

    pub fn find_fire_positions(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let len = match self.get_prop_from_ent(&FIRE_POSITIONS_OFFSET, entity_id) {
            Ok(Variant::U32(n)) => n.min(FIRE_POSITIONS_MAX) as usize,
            Ok(Variant::VecXYZList(v)) => return Ok(Variant::VecXYZList(v)),
            _ => FIRE_POSITIONS_MAX as usize,
        };
        let mut positions = Vec::new();
        for i in 0..len as u32 {
            match self.get_prop_from_ent(&(FIRE_POSITIONS_OFFSET + 1 + i), entity_id) {
                Ok(Variant::VecXYZ(v)) => positions.push(v),
                _ => {
                    if positions.is_empty() && i + 1 < len as u32 {
                        continue;
                    }
                    if i as usize >= positions.len() && !positions.is_empty() {
                        break;
                    }
                }
            }
        }
        if positions.is_empty() {
            return Err(PropCollectionError::GetPropFromEntPropNotFound);
        }
        Ok(Variant::VecXYZList(positions))
    }

    pub fn find_fire_parent_positions(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let len = match self.get_prop_from_ent(&FIRE_PARENT_POSITIONS_OFFSET, entity_id) {
            Ok(Variant::U32(n)) => n.min(FIRE_PARENT_POSITIONS_MAX) as usize,
            Ok(Variant::VecXYZList(v)) => return Ok(Variant::VecXYZList(v)),
            _ => FIRE_PARENT_POSITIONS_MAX as usize,
        };
        let mut positions = Vec::new();
        for i in 0..len as u32 {
            match self.get_prop_from_ent(&(FIRE_PARENT_POSITIONS_OFFSET + 1 + i), entity_id) {
                Ok(Variant::VecXYZ(v)) => positions.push(v),
                _ => {
                    if !positions.is_empty() {
                        break;
                    }
                }
            }
        }
        if positions.is_empty() {
            return Err(PropCollectionError::GetPropFromEntPropNotFound);
        }
        Ok(Variant::VecXYZList(positions))
    }

    pub fn find_fire_burning(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let len = match self.get_prop_from_ent(&FIRE_BURNING_OFFSET, entity_id) {
            Ok(Variant::U32(n)) => n.min(FIRE_BURNING_MAX) as usize,
            Ok(Variant::BoolVec(v)) => return Ok(Variant::BoolVec(v)),
            _ => FIRE_BURNING_MAX as usize,
        };
        let mut flags = Vec::new();
        for i in 0..len as u32 {
            match self.get_prop_from_ent(&(FIRE_BURNING_OFFSET + 1 + i), entity_id) {
                Ok(Variant::Bool(b)) => flags.push(b),
                Ok(Variant::U32(b)) => flags.push(b != 0),
                _ => {
                    if !flags.is_empty() {
                        break;
                    }
                }
            }
        }
        if flags.is_empty() {
            return Err(PropCollectionError::GetPropFromEntPropNotFound);
        }
        Ok(Variant::BoolVec(flags))
    }

    pub fn collect_infernos(&mut self) {
        let inferno_ids: Vec<i32> = self.infernos.iter().copied().collect();
        for entity_id in inferno_ids {
            let x = self.collect_cell_coordinate_grenade(CoordinateAxis::X, &entity_id).ok();
            let y = self.collect_cell_coordinate_grenade(CoordinateAxis::Y, &entity_id).ok();
            let z = self.collect_cell_coordinate_grenade(CoordinateAxis::Z, &entity_id).ok();
            let pairs = vec![
                (GRENADE_TYPE_ID, Some(Variant::String("CInferno".to_string()))),
                (TICK_ID, Some(Variant::I32(self.tick))),
                (ENTITY_ID_ID, Some(Variant::I32(entity_id))),
                (GRENADE_X, x),
                (GRENADE_Y, y),
                (GRENADE_Z, z),
                (STEAMID_ID, None),
                (NAME_ID, None),
            ];
            for pair in pairs {
                self.output.entry(pair.0).or_insert_with(|| PropColumn::new()).push(pair.1);
            }
            for prop_info in &self.prop_controller.prop_infos {
                if prop_info.id == STEAMID_ID
                    || prop_info.id == NAME_ID
                    || prop_info.id == TICK_ID
                    || prop_info.id == GRENADE_TYPE_ID
                    || prop_info.id == ENTITY_ID_ID
                    || prop_info.id == GRENADE_X
                    || prop_info.id == GRENADE_Y
                    || prop_info.id == GRENADE_Z
                {
                    continue;
                }
                let prop = if prop_info.prop_name == "m_firePositions" || prop_info.prop_friendly_name == "m_firePositions" {
                    self.find_fire_positions(&entity_id).ok()
                } else if prop_info.prop_name == "m_bFireIsBurning" || prop_info.prop_friendly_name == "m_bFireIsBurning" {
                    self.find_fire_burning(&entity_id).ok()
                } else if prop_info.prop_name == "m_fireParentPositions" || prop_info.prop_friendly_name == "m_fireParentPositions" {
                    self.find_fire_parent_positions(&entity_id).ok()
                } else {
                    match self.get_prop_from_ent(&prop_info.id, &entity_id) {
                        Ok(p) => Some(p),
                        _ => None,
                    }
                };
                match prop {
                    Some(prop) => {
                        self.output.entry(prop_info.id).or_insert_with(|| PropColumn::new()).push(Some(prop));
                    }
                    None => {
                        self.output.entry(prop_info.id).or_insert_with(|| PropColumn::new()).push(None);
                    }
                }
            }
        }
    }

    fn find_weapon_name(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let item_def_id = match self.prop_controller.special_ids.item_def {
            Some(x) => x,
            None => return Err(PropCollectionError::SpecialidsItemDefNotSet),
        };
        match self.find_weapon_prop(&item_def_id, entity_id) {
            Ok(Variant::U32(def_idx)) => {
                match WEAPINDICIES.get(&def_idx) {
                    Some(v) => return Ok(Variant::String(v.to_string())),
                    None => return Err(PropCollectionError::WeaponIdxMappingNotFound),
                };
            }
            Ok(_) => return Err(PropCollectionError::WeaponDefVariantWrongType),
            Err(e) => Err(e),
        }
    }
    pub fn collect_cell_coordinate_player(&self, axis: CoordinateAxis, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let coordinate = match axis {
            CoordinateAxis::X => {
                let x_prop_id = match self.prop_controller.special_ids.cell_x_player {
                    Some(x) => x,
                    None => return Err(PropCollectionError::PlayerSpecialIDCellXMissing),
                };
                let x_offset_id = match self.prop_controller.special_ids.cell_x_offset_player {
                    Some(x) => x,
                    None => return Err(PropCollectionError::PlayerSpecialIDOffsetXMissing),
                };
                let offset = self.get_prop_from_ent(&x_offset_id, entity_id);
                let cell = self.get_prop_from_ent(&x_prop_id, entity_id);
                coord_from_cell(cell, offset)
            }
            CoordinateAxis::Y => {
                let y_prop_id = match self.prop_controller.special_ids.cell_y_player {
                    Some(y) => y,
                    None => return Err(PropCollectionError::PlayerSpecialIDCellYMissing),
                };
                let y_offset_id = match self.prop_controller.special_ids.cell_y_offset_player {
                    Some(y) => y,
                    None => return Err(PropCollectionError::PlayerSpecialIDOffsetYMissing),
                };
                let offset = self.get_prop_from_ent(&y_offset_id, entity_id);
                let cell = self.get_prop_from_ent(&y_prop_id, entity_id);
                coord_from_cell(cell, offset)
            }
            CoordinateAxis::Z => {
                let z_prop_id = match self.prop_controller.special_ids.cell_z_player {
                    Some(z) => z,
                    None => return Err(PropCollectionError::PlayerSpecialIDCellZMissing),
                };
                let z_offset_id = match self.prop_controller.special_ids.cell_z_offset_player {
                    Some(z) => z,
                    None => return Err(PropCollectionError::PlayerSpecialIDOffsetZMissing),
                };
                let offset = self.get_prop_from_ent(&z_offset_id, entity_id);
                let cell = self.get_prop_from_ent(&z_prop_id, entity_id);
                coord_from_cell(cell, offset)
            }
        };
        Ok(Variant::F32(coordinate?))
    }
    pub fn collect_cell_coordinate_grenade(&self, axis: CoordinateAxis, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        // Todo rename to be consistent with player special ids
        let coordinate = match axis {
            CoordinateAxis::X => {
                let x_prop_id = match self.prop_controller.special_ids.m_cell_x_grenade {
                    Some(x) => x,
                    None => return Err(PropCollectionError::GrenadeSpecialIDCellXMissing),
                };
                let x_offset_id = match self.prop_controller.special_ids.m_vec_x_grenade {
                    Some(x) => x,
                    None => return Err(PropCollectionError::GrenadeSpecialIDOffsetXMissing),
                };
                let offset = self.get_prop_from_ent(&x_offset_id, entity_id);
                let cell = self.get_prop_from_ent(&x_prop_id, entity_id);
                coord_from_cell(cell, offset)
            }
            CoordinateAxis::Y => {
                let y_prop_id = match self.prop_controller.special_ids.m_cell_y_grenade {
                    Some(y) => y,
                    None => return Err(PropCollectionError::GrenadeSpecialIDCellYMissing),
                };
                let y_offset_id = match self.prop_controller.special_ids.m_vec_y_grenade {
                    Some(y) => y,
                    None => return Err(PropCollectionError::GrenadeSpecialIDOffsetYMissing),
                };

                let offset = self.get_prop_from_ent(&y_offset_id, entity_id);
                let cell = self.get_prop_from_ent(&y_prop_id, entity_id);
                coord_from_cell(cell, offset)
            }
            CoordinateAxis::Z => {
                let z_prop_id = match self.prop_controller.special_ids.m_cell_z_grenade {
                    Some(z) => z,
                    None => return Err(PropCollectionError::GrenadeSpecialIDCellZMissing),
                };
                let z_offset_id = match self.prop_controller.special_ids.m_vec_z_grenade {
                    Some(z) => z,
                    None => return Err(PropCollectionError::GrenadeSpecialIDOffsetZMissing),
                };
                let offset = self.get_prop_from_ent(&z_offset_id, entity_id);
                let cell = self.get_prop_from_ent(&z_prop_id, entity_id);
                coord_from_cell(cell, offset)
            }
        };
        Ok(Variant::F32(coordinate?))
    }
    fn find_pitch_or_yaw(&self, entity_id: &i32, idx: usize) -> Result<Variant, PropCollectionError> {
        match self.prop_controller.special_ids.eye_angles {
            Some(prop_id) => match self.get_prop_from_ent(&prop_id, entity_id) {
                Ok(Variant::VecXYZ(v)) => return Ok(Variant::F32(v[idx])),
                Ok(_) => return Err(PropCollectionError::EyeAnglesWrongVariant),
                Err(e) => return Err(e),
            },
            None => Err(PropCollectionError::SpecialidsEyeAnglesNotSet),
        }
    }
    pub fn create_custom_prop(&self, prop_info: &PropInfo, entity_id: &i32, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        match prop_info.id {
            PLAYER_X_ID => self.collect_cell_coordinate_player(CoordinateAxis::X, entity_id),
            PLAYER_Y_ID => self.collect_cell_coordinate_player(CoordinateAxis::Y, entity_id),
            PLAYER_Z_ID => self.collect_cell_coordinate_player(CoordinateAxis::Z, entity_id),
            VELOCITY_ID => self.collect_velocity(player),
            VELOCITY_X_ID => self.collect_velocity_axis(player, CoordinateAxis::X),
            VELOCITY_Y_ID => self.collect_velocity_axis(player, CoordinateAxis::Y),
            VELOCITY_Z_ID => self.collect_velocity_axis(player, CoordinateAxis::Z),
            PITCH_ID => self.find_pitch_or_yaw(entity_id, 0),
            YAW_ID => self.find_pitch_or_yaw(entity_id, 1),
            WEAPON_NAME_ID => self.find_weapon_name(entity_id),
            WEAPON_SKIN_NAME => self.find_weapon_skin_from_player(entity_id),
            WEAPON_SKIN_ID => self.find_weapon_skin_id_from_player(entity_id),
            WEAPON_PAINT_SEED => self.find_skin_paint_seed(player),
            WEAPON_FLOAT => self.find_skin_float(player),
            WEAPON_STICKERS_ID => self.find_stickers_from_active_weapon(player),
            WEAPON_ORIGINGAL_OWNER_ID => self.find_weapon_original_owner(entity_id),
            INVENTORY_ID => self.find_my_inventory(entity_id),
            INVENTORY_AS_IDS_ID => self.find_my_inventory_as_ids(entity_id),
            INVENTORY_AS_IDS_BITMASK => self.find_my_inventory_as_bitmask(entity_id),
            ENTITY_ID_ID => Ok(Variant::I32(*entity_id)),
            IS_ALIVE_ID => self.find_is_alive(entity_id),
            USERID_ID => self.get_userid(player),
            IS_AIRBORNE_ID => self.find_is_airborne(player),
            AGENT_SKIN_ID => self.find_agent_skin(player),
            USERCMD_INPUT_HISTORY_BASEID => self.get_prop_from_ent(&USERCMD_INPUT_HISTORY_BASEID, entity_id),
            GLOVE_PAINT_ID => self.find_glove_skin_id(entity_id),
            GLOVE_SKIN => self.find_glove_skin(entity_id),
            GLOVE_PAINT_SEED => self.find_glove_paint_seed(entity_id),
            GLOVE_PAINT_FLOAT => self.find_glove_paint_float(entity_id),
            _ => match prop_info.prop_name.as_str() {
                "CCSPlayerPawn.m_bSpottedByMask" => self.find_spotted(entity_id, prop_info),
                "CCSPlayerController.m_iCompTeammateColor" => self.find_player_color(player, prop_info),
                _ => Err(PropCollectionError::UnknownCustomPropName),
            },
        }
    }
    pub fn get_userid(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        for (_, st_player) in &self.stringtable_players {
            if player.steamid == Some(st_player.steamid) {
                return Ok(Variant::I32(st_player.userid));
            }
        }
        Err(PropCollectionError::UseridNotFound)
    }
    pub fn find_player_color(&self, player: &PlayerMetaData, prop_info: &PropInfo) -> Result<Variant, PropCollectionError> {
        if let Ok(Variant::I32(v)) = self.get_controller_prop(&prop_info.id, player) {
            let color = if let Some(col) = PLAYER_COLOR.get(&v) {
                col.to_string()
            } else {
                v.to_string()
            };
            return Ok(Variant::String(color));
        }
        Err(PropCollectionError::UseridNotFound)
    }
    pub fn find_is_airborne(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        if let Some(player_entity_id) = &player.player_entity_id {
            if let Some(id) = self.prop_controller.special_ids.is_airborn {
                if let Ok(Variant::U32(airborn_h)) = self.get_prop_from_ent(&id, &player_entity_id) {
                    return Ok(Variant::Bool(airborn_h == IS_AIRBORNE_CONST));
                }
            }
        }
        Ok(Variant::Bool(false))
    }
    pub fn find_skin_float(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        if let Some(player_entity_id) = &player.player_entity_id {
            return self.find_weapon_prop(&WEAPON_FLOAT, &player_entity_id);
        }
        Err(PropCollectionError::PlayerNotFound)
    }
    pub fn find_stickers_from_active_weapon(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        let p = match self.prop_controller.special_ids.active_weapon {
            Some(p) => p,
            None => return Err(PropCollectionError::SpecialidsActiveWeaponNotSet),
        };
        if let Some(eid) = player.player_entity_id {
            return match self.get_prop_from_ent(&p, &eid) {
                Ok(Variant::U32(weap_handle)) => {
                    // Could be more specific
                    let weapon_entity_id = (weap_handle & 0x7FF) as i32;
                    self.find_stickers(&weapon_entity_id)
                }
                Ok(_) => Err(PropCollectionError::WeaponHandleIncorrectVariant),
                Err(e) => Err(e),
            };
        }
        Err(PropCollectionError::PlayerNotFound)
    }

    pub fn find_stickers(&self, weapon_entity_id: &i32) -> Result<Variant, PropCollectionError> {
        // Attribute-index based sticker decode (ported from unicbm/demotracer with permission).
        // Upstream fixed-offset WEAPON_SKIN_ID+4..24 misreads CS2 econ attribute lists.
        let mut sticker_attributes = Vec::new();
        for idx in 0..64 {
            let def = self.get_prop_from_ent(&(WEAPON_ATTRIBUTE_DEF_INDEX_ID + idx), weapon_entity_id);
            let definition_index = match def {
                Ok(Variant::U32(value)) => value,
                Ok(Variant::I32(value)) if value >= 0 => value as u32,
                _ => continue,
            };
            let Ok(Variant::F32(raw_value)) =
                self.get_prop_from_ent(&(WEAPON_SKIN_ID + idx), weapon_entity_id)
            else {
                continue;
            };
            sticker_attributes.push((definition_index, raw_value));
        }
        Ok(Variant::Stickers(stickers_from_econ_attributes(sticker_attributes)))
    }

    pub fn find_skin_paint_seed(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        if let Some(player_entity_id) = &player.player_entity_id {
            if let Ok(Variant::F32(f)) = self.find_weapon_prop(&WEAPON_PAINT_SEED, &player_entity_id) {
                return Ok(Variant::U32(f as u32));
            }
        }
        return Ok(Variant::U32(0));
    }
    pub fn find_agent_skin(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        let id = match self.prop_controller.special_ids.agent_skin_idx {
            Some(i) => i,
            None => return Err(PropCollectionError::AgentSpecialIdNotSet),
        };
        match self.get_controller_prop(&id, player) {
            Ok(Variant::U32(agent_id)) => match AGENTSMAP.get(&agent_id) {
                Some(agent) => return Ok(Variant::String(agent.to_string())),
                None => return Err(PropCollectionError::AgentIdNotFound),
            },
            Ok(_) => return Err(PropCollectionError::AgentIncorrectVariant),
            Err(_) => return Err(PropCollectionError::AgentPropNotFound),
        }
    }
    pub fn collect_velocity(&self, player: &PlayerMetaData) -> Result<Variant, PropCollectionError> {
        if let Some(s) = player.steamid {
            let steamids = self.output.get(&STEAMID_ID);
            let indicies = self.find_wanted_indicies(steamids, s);

            let x = self.velocity_from_indicies(&indicies, CoordinateAxis::X)?;
            let y = self.velocity_from_indicies(&indicies, CoordinateAxis::Y)?;

            if let (Variant::F32(x), Variant::F32(y)) = (x, y) {
                return Ok(Variant::F32((f32::powi(x, 2) + f32::powi(y, 2)).sqrt()));
            }
        }
        return Err(PropCollectionError::PlayerNotFound);
    }
    fn collect_velocity_cached(&self, player: &PlayerMetaData, indicies_cache: &mut Option<Vec<usize>>) -> Result<Variant, PropCollectionError> {
        let indicies = self.cached_velocity_indicies(player, indicies_cache)?;
        let x = self.velocity_from_indicies(indicies, CoordinateAxis::X)?;
        let y = self.velocity_from_indicies(indicies, CoordinateAxis::Y)?;

        if let (Variant::F32(x), Variant::F32(y)) = (x, y) {
            return Ok(Variant::F32((f32::powi(x, 2) + f32::powi(y, 2)).sqrt()));
        }
        Err(PropCollectionError::VelocityNotFound)
    }
    pub fn collect_velocity_axis(&self, player: &PlayerMetaData, axis: CoordinateAxis) -> Result<Variant, PropCollectionError> {
        if let Some(s) = player.steamid {
            let steamids = self.output.get(&STEAMID_ID);
            let indicies = self.find_wanted_indicies(steamids, s);
            return Ok(self.velocity_from_indicies(&indicies, axis)?);
        }
        return Err(PropCollectionError::PlayerNotFound);
    }
    fn collect_velocity_axis_cached(
        &self,
        player: &PlayerMetaData,
        axis: CoordinateAxis,
        indicies_cache: &mut Option<Vec<usize>>,
    ) -> Result<Variant, PropCollectionError> {
        let indicies = self.cached_velocity_indicies(player, indicies_cache)?;
        self.velocity_from_indicies(indicies, axis)
    }
    fn cached_velocity_indicies<'b>(
        &self,
        player: &PlayerMetaData,
        indicies_cache: &'b mut Option<Vec<usize>>,
    ) -> Result<&'b [usize], PropCollectionError> {
        if indicies_cache.is_none() {
            let steamid = player.steamid.ok_or(PropCollectionError::PlayerNotFound)?;
            *indicies_cache = Some(self.find_wanted_indicies(self.output.get(&STEAMID_ID), steamid));
        }
        Ok(indicies_cache.as_deref().unwrap_or(&[]))
    }
    fn find_most_recent_coordinate_idx(&self, optv: Option<&PropColumn>, wanted_steamid: u64) -> Option<usize> {
        if let Some(v) = optv {
            if let Some(VarVec::U64(steamid_vec)) = &v.data {
                for idx in (0..steamid_vec.len()).rev() {
                    if steamid_vec[idx] == Some(wanted_steamid) {
                        return Some(idx);
                    }
                }
            }
        }
        None
    }
    fn find_last_coordinate_idx(&self, optv: Option<&PropColumn>, wanted_steamid: u64, cur_idx: Option<usize>) -> Option<usize> {
        let cur_idx = cur_idx?;
        if let VarVec::U64(steamid_vec) = optv?.data.as_ref()? {
            // iterate backwards until steamid is our wanted player and > 1sec ago
            for idx in (0..steamid_vec.len()).rev() {
                let sid = steamid_vec[idx];
                if sid == Some(wanted_steamid) && idx != cur_idx {
                    return Some(idx);
                }
            }
        }
        None
    }
    fn find_wanted_indicies(&self, optv: Option<&PropColumn>, wanted_steamid: u64) -> Vec<usize> {
        let idx1 = self.find_most_recent_coordinate_idx(optv, wanted_steamid);
        let idx2 = self.find_last_coordinate_idx(optv, wanted_steamid, idx1);
        if let (Some(idx1), Some(idx2)) = (idx1, idx2) {
            return vec![idx1, idx2];
        }
        vec![]
    }

    fn velocity_from_indicies(&self, indicies: &[usize], axis: CoordinateAxis) -> Result<Variant, PropCollectionError> {
        let col = match axis {
            CoordinateAxis::X => self.output.get(&PLAYER_X_ID),
            CoordinateAxis::Y => self.output.get(&PLAYER_Y_ID),
            CoordinateAxis::Z => self.output.get(&PLAYER_Z_ID),
        };
        if let Some(c) = col {
            if let Some((Some(v1), Some(v2))) = self.index_coordinates_from_propcol(c, indicies) {
                return Ok(Variant::F32((v1 * 64.0) - (v2 * 64.0)));
            }
        }
        return Err(PropCollectionError::VelocityNotFound);
    }
    fn index_coordinates_from_propcol(&self, propcol: &PropColumn, indicies: &[usize]) -> Option<(Option<f32>, Option<f32>)> {
        if indicies.len() != 2 {
            return None;
        }
        if let Some(VarVec::F32(steamid_vec)) = &propcol.data {
            let first = steamid_vec[indicies[0]];
            let second = steamid_vec[indicies[1]];
            return Some((first, second));
        }
        None
    }

    pub fn find_is_alive(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        match self.prop_controller.special_ids.life_state {
            Some(id) => match self.get_prop_from_ent(&id, entity_id) {
                Ok(Variant::U32(0)) => return Ok(Variant::Bool(true)),
                Ok(_) => {}
                Err(_) => {}
            },
            None => {}
        }
        Ok(Variant::Bool(false))
    }
    pub fn find_spotted(&self, entity_id: &i32, prop_info: &PropInfo) -> Result<Variant, PropCollectionError> {
        match self.get_prop_from_ent(&prop_info.id, entity_id) {
            Ok(Variant::U32(mask)) => {
                return Ok(Variant::U64Vec(self.steamids_from_mask(mask)));
            }
            Ok(_) => return Err(PropCollectionError::SpottedIncorrectVariant),
            Err(e) => return Err(e),
        }
    }
    fn steamids_from_mask(&self, uid: u32) -> Vec<u64> {
        let mut steamids = vec![];
        for i in 0..16 {
            if (uid & (1 << i)) != 0 {
                if let Some(user) = self.find_user_by_controller_id((i + 1) as i32) {
                    steamids.push(user.steamid.unwrap_or(0))
                }
            }
        }
        steamids
    }
    pub fn find_my_inventory(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let mut names = vec![];
        let mut unique_eids = vec![];

        match self.find_is_alive(entity_id) {
            Ok(Variant::Bool(true)) => {}
            _ => return Ok(Variant::StringVec(vec![])),
        };
        let inventory_max_len = match self.get_prop_from_ent(&(MY_WEAPONS_OFFSET as u32), entity_id) {
            Ok(Variant::U32(p)) => p,
            _ => return Err(PropCollectionError::InventoryMaxNotFound),
        };
        for i in 1..inventory_max_len + 1 {
            let prop_id = MY_WEAPONS_OFFSET + i;
            match self.get_prop_from_ent(&(prop_id as u32), entity_id) {
                Err(_e) => {}
                Ok(Variant::U32(x)) => {
                    let eid = (x & ((1 << 14) - 1)) as i32;
                    // Sometimes multiple references to same eid?
                    if unique_eids.contains(&eid) {
                        continue;
                    }
                    unique_eids.push(eid);

                    if let Some(item_def_id) = &self.prop_controller.special_ids.item_def {
                        let res = match self.get_prop_from_ent(item_def_id, &eid) {
                            Err(_e) => continue,
                            Ok(def) => def,
                        };
                        self.insert_equipment_name(&mut names, res, entity_id);
                    }
                }
                _ => {}
            }
        }
        Ok(Variant::StringVec(names))
    }
    pub fn find_my_inventory_as_ids(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let mut names = vec![];
        let mut unique_eids = vec![];

        match self.find_is_alive(entity_id) {
            Ok(Variant::Bool(true)) => {}
            _ => return Ok(Variant::U32Vec(vec![])),
        };
        let inventory_max_len = match self.get_prop_from_ent(&(MY_WEAPONS_OFFSET as u32), entity_id) {
            Ok(Variant::U32(p)) => p,
            _ => return Err(PropCollectionError::InventoryMaxNotFound),
        };

        for i in 1..inventory_max_len + 1 {
            let prop_id = MY_WEAPONS_OFFSET + i;
            match self.get_prop_from_ent(&(prop_id as u32), entity_id) {
                Err(_e) => {}
                Ok(Variant::U32(x)) => {
                    let eid = (x & ((1 << 14) - 1)) as i32;
                    // Sometimes multiple references to same eid?
                    if unique_eids.contains(&eid) {
                        continue;
                    }
                    unique_eids.push(eid);
                    if let Some(item_def_id) = &self.prop_controller.special_ids.item_def {
                        let res = match self.get_prop_from_ent(item_def_id, &eid) {
                            Err(_e) => continue,
                            Ok(def) => def,
                        };
                        self.insert_equipment_id(&mut names, res, entity_id);
                    }
                }
                _ => {}
            }
        }
        Ok(Variant::U32Vec(names))
    }
    pub fn find_my_inventory_as_bitmask(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let mut bitmask = 0;
        let mut unique_eids = vec![];

        match self.find_is_alive(entity_id) {
            Ok(Variant::Bool(true)) => {}
            _ => return Ok(Variant::U64(0)),
        };
        let inventory_max_len = match self.get_prop_from_ent(&(MY_WEAPONS_OFFSET as u32), entity_id) {
            Ok(Variant::U32(p)) => p,
            _ => return Err(PropCollectionError::InventoryMaxNotFound),
        };

        for i in 1..inventory_max_len + 1 {
            let prop_id = MY_WEAPONS_OFFSET + i;
            match self.get_prop_from_ent(&(prop_id as u32), entity_id) {
                Err(_e) => {}
                Ok(Variant::U32(x)) => {
                    let eid = (x & ((1 << 14) - 1)) as i32;
                    // Sometimes multiple references to same eid?
                    if unique_eids.contains(&eid) {
                        continue;
                    }
                    unique_eids.push(eid);
                    if let Some(item_def_id) = &self.prop_controller.special_ids.item_def {
                        let res = match self.get_prop_from_ent(item_def_id, &eid) {
                            Err(_e) => continue,
                            Ok(def) => def,
                        };
                        self.insert_equipment_id_bitmask(&mut bitmask, res, entity_id);
                    }
                }
                _ => {}
            }
        }
        Ok(Variant::U64(bitmask))
    }

    fn insert_equipment_id_bitmask(&self, bitmask: &mut u64, res: Variant, player_entid: &i32) {
        if let Variant::U32(def_idx) = res {
            match WEAPINDICIES.get(&def_idx) {
                None => return,
                Some(weap_name) => {
                    match weap_name {
                        // Check how many flashbangs player has (only prop that works like this)
                        &"Flashbang" => {
                            if let Ok(Variant::U32(2)) = self.get_prop_from_ent(&GRENADE_AMMO_ID, player_entid) {
                                *bitmask |= 1 << def_idx;
                            }
                            *bitmask |= 1 << def_idx;
                        }
                        // c4 seems bugged. Find c4 entity and check owner from it.
                        &"C4 Explosive" => {
                            if let Some(c4_owner_id) = self.find_c4_owner() {
                                if *player_entid == c4_owner_id {
                                    *bitmask |= 1 << def_idx;
                                }
                            }
                        }
                        _ => {
                            *bitmask |= 1 << def_idx;
                        }
                    }
                }
            };
        }
    }
    fn insert_equipment_id(&self, names: &mut Vec<u32>, res: Variant, player_entid: &i32) {
        if let Variant::U32(def_idx) = res {
            match WEAPINDICIES.get(&def_idx) {
                None => return,
                Some(weap_name) => {
                    match weap_name {
                        // Check how many flashbangs player has (only prop that works like this)
                        &"Flashbang" => {
                            if let Ok(Variant::U32(2)) = self.get_prop_from_ent(&FLASHBANG_AMMO_ID, player_entid) {
                                names.push(def_idx);
                            }
                            names.push(def_idx);
                        }
                        // c4 seems bugged. Find c4 entity and check owner from it.
                        &"C4 Explosive" => {
                            if let Some(c4_owner_id) = self.find_c4_owner() {
                                if *player_entid == c4_owner_id {
                                    names.push(def_idx);
                                }
                            }
                        }
                        _ => {
                            names.push(def_idx);
                        }
                    }
                }
            };
        }
    }

    fn insert_equipment_name(&self, names: &mut Vec<String>, res: Variant, player_entid: &i32) {
        if let Variant::U32(def_idx) = res {
            match WEAPINDICIES.get(&def_idx) {
                None => return,
                Some(weap_name) => {
                    match weap_name {
                        // Check how many flashbangs player has (only prop that works like this)
                        &"Flashbang" => {
                            if let Ok(Variant::U32(2)) = self.get_prop_from_ent(&FLASHBANG_AMMO_ID, player_entid) {
                                names.push(weap_name.to_string());
                            }
                            names.push(weap_name.to_string());
                        }
                        // c4 seems bugged. Find c4 entity and check owner from it.
                        &"C4 Explosive" => {
                            if let Some(c4_owner_id) = self.find_c4_owner() {
                                if *player_entid == c4_owner_id {
                                    names.push(weap_name.to_string());
                                }
                            }
                        }
                        _ => {
                            names.push(weap_name.to_string());
                        }
                    }
                }
            };
        }
    }
    fn find_c4_owner(&self) -> Option<i32> {
        if let Some(c4ent) = self.c4_entity_id {
            if let Some(id) = self.prop_controller.special_ids.h_owner_entity {
                if let Ok(Variant::U32(u)) = self.get_prop_from_ent(&id, &c4ent) {
                    return Some((u & 0x7FF) as i32);
                }
            }
        }
        None
    }
    pub fn find_weapon_original_owner(&self, entity_id: &i32) -> Result<Variant, PropCollectionError> {
        let low_id = match self.prop_controller.special_ids.orig_own_low {
            Some(id) => id,
            None => return Err(PropCollectionError::OriginalOwnerXuidIdLowNotSet),
        };
        let high_id = match self.prop_controller.special_ids.orig_own_high {
            Some(id) => id,
            None => return Err(PropCollectionError::OriginalOwnerXuidIdHighNotSet),
        };
        let low_bits = match self.find_weapon_prop(&low_id, entity_id) {
            Ok(Variant::U32(val)) => val,
            Ok(_) => return Err(PropCollectionError::OriginalOwnerXuidlowIncorrectVariant),
            Err(_e) => return Err(PropCollectionError::OriginalOwnerXuidLowNotFound),
        };
        let high_bits = match self.find_weapon_prop(&high_id, entity_id) {
            Ok(Variant::U32(val)) => val,
            Ok(_) => return Err(PropCollectionError::OriginalOwnerXuidHighIncorrectVariant),
            Err(_e) => return Err(PropCollectionError::OriginalOwnerXuidHighNotFound),
        };
        let combined = (high_bits as u64) << 32 | (low_bits as u64);
        Ok(Variant::String(combined.to_string()))
    }

    pub fn find_weapon_skin(&self, weapon_entity_id: &i32) -> Result<Variant, PropCollectionError> {
        match self.get_prop_from_ent(&WEAPON_SKIN_ID, weapon_entity_id) {
            Ok(Variant::F32(f)) => {
                // The value is stored as a float for some reason
                if f.fract() == 0.0 && f >= 0.0 {
                    let idx = f as u32;
                    match PAINTKITS.get(&idx) {
                        Some(kit) => Ok(Variant::String(kit.to_string())),
                        None => Err(PropCollectionError::WeaponSkinNoSkinMapping),
                    }
                } else {
                    return Err(PropCollectionError::WeaponSkinFloatConvertionError);
                }
            }
            Ok(_) => return Err(PropCollectionError::WeaponSkinIdxIncorrectVariant),
            Err(e) => return Err(e),
        }
    }
    pub fn find_weapon_skin_id_from_player(&self, player_entid: &i32) -> Result<Variant, PropCollectionError> {
        let p = match self.prop_controller.special_ids.active_weapon {
            Some(p) => p,
            None => return Err(PropCollectionError::SpecialidsActiveWeaponNotSet),
        };
        return match self.get_prop_from_ent(&p, player_entid) {
            Ok(Variant::U32(weap_handle)) => {
                let weapon_entity_id = (weap_handle & 0x7FF) as i32;
                self.find_weapon_skin_id(&weapon_entity_id)
            }
            Ok(_) => Err(PropCollectionError::WeaponHandleIncorrectVariant),
            Err(e) => Err(e),
        };
    }
    pub fn find_weapon_skin_id(&self, weapon_entity_id: &i32) -> Result<Variant, PropCollectionError> {
        match self.get_prop_from_ent(&WEAPON_SKIN_ID, weapon_entity_id) {
            Ok(Variant::F32(f)) => {
                // The value is stored as a float for some reason
                if f.fract() == 0.0 && f >= 0.0 {
                    return Ok(Variant::U32(f as u32));
                } else {
                    return Err(PropCollectionError::WeaponSkinFloatConvertionError);
                }
            }
            Ok(_) => return Err(PropCollectionError::WeaponSkinIdxIncorrectVariant),
            Err(e) => return Err(e),
        }
    }
    pub fn find_weapon_skin_from_player(&self, player_entid: &i32) -> Result<Variant, PropCollectionError> {
        let p = match self.prop_controller.special_ids.active_weapon {
            Some(p) => p,
            None => return Err(PropCollectionError::SpecialidsActiveWeaponNotSet),
        };
        return match self.get_prop_from_ent(&p, player_entid) {
            Ok(Variant::U32(weap_handle)) => {
                let weapon_entity_id = (weap_handle & 0x7FF) as i32;
                self.find_weapon_skin(&weapon_entity_id)
            }
            Ok(_) => Err(PropCollectionError::WeaponHandleIncorrectVariant),
            Err(e) => Err(e),
        };
    }
    pub fn find_glove_skin_id(&self, player_entid: &i32) -> Result<Variant, PropCollectionError> {
        match self.get_prop_from_ent(&GLOVE_PAINT_ID, player_entid) {
            Ok(Variant::F32(f)) => {
                // The value is stored as a float for some reason
                if f.fract() == 0.0 && f >= 0.0 {
                    return Ok(Variant::U32(f as u32));
                } else {
                    return Err(PropCollectionError::GloveSkinFloatConvertionError);
                }
            }
            Ok(_) => return Err(PropCollectionError::GloveSkinIdxIncorrectVariant),
            Err(e) => return Err(e),
        }
    }

    pub fn find_glove_skin(&self, player_entid: &i32) -> Result<Variant, PropCollectionError> {
        match self.get_prop_from_ent(&GLOVE_PAINT_ID, player_entid) {
            Ok(Variant::F32(f)) => {
                // The value is stored as a float for some reason
                if f.fract() == 0.0 && f >= 0.0 {
                    let idx = f as u32;
                    match PAINTKITS.get(&idx) {
                        Some(kit) => Ok(Variant::String(kit.to_string())),
                        None => Err(PropCollectionError::GloveSkinNoSkinMapping),
                    }
                } else {
                    return Err(PropCollectionError::GloveSkinFloatConvertionError);
                }
            }
            Ok(_) => return Err(PropCollectionError::GloveSkinIdxIncorrectVariant),
            Err(e) => return Err(e),
        }
    }

    pub fn find_glove_paint_seed(&self, player_entid: &i32) -> Result<Variant, PropCollectionError> {
        match self.get_prop_from_ent(&GLOVE_PAINT_SEED, player_entid) {
            Ok(p) => Ok(p),
            Err(e) => return Err(e),
        }
    }

    pub fn find_glove_paint_float(&self, player_entid: &i32) -> Result<Variant, PropCollectionError> {
        match self.get_prop_from_ent(&GLOVE_PAINT_FLOAT, player_entid) {
            Ok(p) => Ok(p),
            Err(e) => return Err(e),
        }
    }

    pub fn find_weapon_prop(&self, prop: &u32, player_entid: &i32) -> Result<Variant, PropCollectionError> {
        let p = match self.prop_controller.special_ids.active_weapon {
            Some(p) => p,
            None => return Err(PropCollectionError::SpecialidsActiveWeaponNotSet),
        };
        match self.get_prop_from_ent(&p, player_entid) {
            Ok(Variant::U32(weap_handle)) => {
                // Could be more specific
                let weapon_entity_id = (weap_handle & 0x7FF) as i32;
                match self.get_prop_from_ent(&prop, &weapon_entity_id) {
                    Ok(p) => Ok(p),
                    Err(e) => match e {
                        PropCollectionError::GetPropFromEntEntityNotFound => Err(PropCollectionError::WeaponEntityNotFound),
                        PropCollectionError::GetPropFromEntPropNotFound => Err(PropCollectionError::WeaponEntityWantedPropNotFound),
                        _ => Err(e),
                    },
                }
            }
            Ok(_) => Err(PropCollectionError::WeaponHandleIncorrectVariant),
            Err(e) => Err(e),
        }
    }
    pub fn find_team_prop(&self, prop: &u32, player_entid: &i32) -> Result<Variant, PropCollectionError> {
        match self.prop_controller.special_ids.player_team_pointer {
            None => return Err(PropCollectionError::SpecialidsPlayerTeamPointerNotSet),
            Some(p) => {
                match self.get_prop_from_ent(&p, player_entid) {
                    Ok(Variant::U32(team_num)) => {
                        let team_entid = match team_num {
                            // 1 should be spectator
                            1 => self.teams.team1_entid,
                            2 => self.teams.team2_entid,
                            3 => self.teams.team3_entid,
                            _ => return Err(PropCollectionError::IllegalTeamValue),
                        };
                        // Get prop from team entity
                        match team_entid {
                            Some(eid) => return self.get_prop_from_ent(prop, &eid),
                            None => return Err(PropCollectionError::TeamEntityIdNotSet),
                        }
                    }
                    Ok(_) => Err(PropCollectionError::TeamNumIncorrectVariant),
                    Err(e) => Err(e),
                }
            }
        }
    }
    pub fn gather_extra_info(&mut self, entity_id: &i32, is_baseline: bool) -> Result<(), DemoParserError> {
        // Boring stuff.. function does some bookkeeping
        let entity = match self.entities.get(*entity_id as usize) {
            Some(Some(entity)) => entity,
            _ => return Err(DemoParserError::EntityNotFound),
        };
        if !(entity.entity_type == EntityType::PlayerController || entity.entity_type == EntityType::Team) {
            return Ok(());
        }
        if entity.entity_type == EntityType::Team && !is_baseline {
            if let Some(team_num_id) = self.prop_controller.special_ids.team_team_num {
                if let Ok(Variant::U32(t)) = self.get_prop_from_ent(&team_num_id, entity_id) {
                    match t {
                        1 => self.teams.team1_entid = Some(*entity_id),
                        2 => self.teams.team2_entid = Some(*entity_id),
                        3 => self.teams.team3_entid = Some(*entity_id),
                        _ => {}
                    }
                }
            }
        }
        if entity.entity_type == EntityType::PlayerController {
            let team_num = match self.prop_controller.special_ids.teamnum {
                Some(team_num_id) => match self.get_prop_from_ent(&team_num_id, entity_id) {
                    Ok(Variant::U32(team_num)) => Some(team_num),
                    Ok(_) => return Err(DemoParserError::IncorrectMetaDataProp),
                    Err(_) => None,
                },
                _ => None,
            };
            let name = match self.prop_controller.special_ids.player_name {
                Some(id) => match self.get_prop_from_ent(&id, entity_id) {
                    Ok(Variant::String(name)) => Some(name),
                    Ok(_) => return Err(DemoParserError::IncorrectMetaDataProp),
                    Err(_) => None,
                },
                _ => None,
            };
            let steamid = match self.prop_controller.special_ids.steamid {
                Some(id) => match self.get_prop_from_ent(&id, entity_id) {
                    Ok(Variant::U64(sid)) => Some(sid),
                    Ok(_) => return Err(DemoParserError::IncorrectMetaDataProp),
                    Err(_) => None,
                },
                _ => None,
            };
            let player_entid = match self.prop_controller.special_ids.player_pawn {
                Some(id) => match self.get_prop_from_ent(&id, entity_id) {
                    Ok(Variant::U32(handle)) => Some((handle & ((1 << 14) - 1)) as i32),
                    Ok(_) => return Err(DemoParserError::IncorrectMetaDataProp),
                    Err(_) => None,
                },
                _ => None,
            };
            if let Some(e) = player_entid {
                if e != PLAYER_ENTITY_HANDLE_MISSING && steamid != Some(0) && team_num != Some(SPECTATOR_TEAM_NUM) {
                    match self.should_remove(steamid) {
                        Some(eid) => {
                            self.players.remove(&eid);
                        }
                        None => {}
                    }
                    self.players.insert(
                        e,
                        PlayerMetaData {
                            name,
                            team_num,
                            player_entity_id: player_entid,
                            steamid,
                            controller_entid: Some(*entity_id),
                        },
                    );
                }
            }
        }
        Ok(())
    }
    pub fn should_remove(&self, steamid: Option<u64>) -> Option<i32> {
        for (entid, player) in &self.players {
            if player.steamid == steamid {
                return Some(*entid);
            }
        }
        None
    }
}

fn coord_from_cell(cell: Result<Variant, PropCollectionError>, offset: Result<Variant, PropCollectionError>) -> Result<f32, PropCollectionError> {
    // Both cell and offset are needed for calculation
    match (offset, cell) {
        (Ok(Variant::F32(offset)), Ok(Variant::U32(cell))) => {
            let cell_coord = ((cell as f32 * (1 << CELL_BITS) as f32) - MAX_COORD) as f32;
            Ok(cell_coord + offset)
        }
        (Err(_), Err(_)) => Err(PropCollectionError::CoordinateBothNone),
        (Ok(Variant::F32(_offset)), Err(_)) => Err(PropCollectionError::CoordinateCellNone),
        (Err(_), Ok(Variant::U32(_cell))) => Err(PropCollectionError::CoordinateOffsetNone),
        (_, _) => Err(PropCollectionError::CoordinateIncorrectTypes),
    }
}
#[derive(Debug, PartialEq)]
pub enum PropCollectionError {
    PlayerSpecialIDCellXMissing,
    PlayerSpecialIDCellYMissing,
    PlayerSpecialIDCellZMissing,
    PlayerSpecialIDOffsetXMissing,
    PlayerSpecialIDOffsetYMissing,
    PlayerSpecialIDOffsetZMissing,
    GrenadeSpecialIDCellXMissing,
    GrenadeSpecialIDCellYMissing,
    GrenadeSpecialIDCellZMissing,
    GrenadeSpecialIDOffsetXMissing,
    GrenadeSpecialIDOffsetYMissing,
    GrenadeSpecialIDOffsetZMissing,
    CoordinateOffsetNone,
    CoordinateCellNone,
    CoordinateIncorrectTypes,
    CoordinateBothNone,
    GrenadeOffsetVariantNone,
    PlayerMetaDataNameNone,
    ButtonsSpecialIDNone,
    ButtonsMapNoEntryFound,
    GetPropFromEntEntityNotFound,
    GetPropFromEntPropNotFound,
    ButtonMaskNotU64Variant,
    RulesEntityIdNotSet,
    ControllerEntityIdNotSet,
    SpecialidsEyeAnglesNotSet,
    SpecialidsItemDefNotSet,
    EyeAnglesWrongVariant,
    WeaponIdxMappingNotFound,
    WeaponDefVariantWrongType,
    SpecialidsPlayerTeamPointerNotSet,
    TeamNumIncorrectVariant,
    IllegalTeamValue,
    TeamEntityIdNotSet,
    GrenadeOwnerIdNotSet,
    GrenadeOwnerIdPropIncorrectVariant,
    PlayerNotFound,
    SpecialidsActiveWeaponNotSet,
    WeaponHandleIncorrectVariant,
    UnknownCustomPropName,
    UnknownCoordinateAxis,
    WeaponEntityNotFound,
    WeaponEntityWantedPropNotFound,
    WeaponSkinFloatConvertionError,
    WeaponSkinNoSkinMapping,
    WeaponSkinIdxIncorrectVariant,
    OriginalOwnerXuidIdLowNotSet,
    OriginalOwnerXuidIdHighNotSet,
    OriginalOwnerXuidLowNotFound,
    OriginalOwnerXuidHighNotFound,
    OriginalOwnerXuidlowIncorrectVariant,
    OriginalOwnerXuidHighIncorrectVariant,
    SpottedIncorrectVariant,
    VelocityNotFound,
    AgentIdNotFound,
    AgentIncorrectVariant,
    AgentPropNotFound,
    AgentSpecialIdNotSet,
    UseridNotFound,
    InventoryMaxNotFound,
    GloveSkinFloatConvertionError,
    GloveSkinIdxIncorrectVariant,
    GloveSkinNoSkinMapping,
}
impl std::error::Error for PropCollectionError {}
impl fmt::Display for PropCollectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self)
    }
}
