use crate::first_pass::sendtables::Field;
use crate::first_pass::sendtables::Serializer;
use crate::first_pass::sendtables::ValueField;
use crate::maps::BUTTONMAP;
use crate::maps::CUSTOM_PLAYER_PROP_IDS;
use crate::maps::TYPEHM;
use crate::second_pass::collect_data::PropType;
use crate::second_pass::parser_settings::SpecialIDs;
use crate::second_pass::variants::Variant;
use ahash::AHashMap;

pub const PLAYER_ENTITY_HANDLE_MISSING: i32 = 2047;
pub const SPECTATOR_TEAM_NUM: u32 = 1;
pub const BUTTONS_BASEID: u32 = 100000;
pub const NORMAL_PROP_BASEID: u32 = 1000;
pub const WEAPON_SKIN_NAME: u32 = 420420420;
pub const WEAPON_ORIGINGAL_OWNER_ID: u32 = 6942000;
pub const MY_WEAPONS_OFFSET: u32 = 500000;
// Flattened CUtlVector slots for utility area props (CS2 Insight Agent).
pub const VOXEL_FRAME_DATA_OFFSET: u32 = 700000;
pub const VOXEL_FRAME_DATA_MAX: u32 = 4096;
pub const FIRE_POSITIONS_OFFSET: u32 = 710000;
pub const FIRE_POSITIONS_MAX: u32 = 128;
pub const FIRE_BURNING_OFFSET: u32 = 720000;
pub const FIRE_BURNING_MAX: u32 = 128;
pub const FIRE_PARENT_POSITIONS_OFFSET: u32 = 730000;
pub const FIRE_PARENT_POSITIONS_MAX: u32 = 128;
pub const GRENADE_AMMO_ID: u32 = 1111111;
pub const FLASHBANG_AMMO_ID: u32 = 2222222;
pub const INVENTORY_ID: u32 = 100000000;
pub const IS_ALIVE_ID: u32 = 100000001;
pub const GAME_TIME_ID: u32 = 100000002;
pub const ENTITY_ID_ID: u32 = 100000003;
pub const VELOCITY_X_ID: u32 = 100000004;
pub const VELOCITY_Y_ID: u32 = 100000005;
pub const VELOCITY_Z_ID: u32 = 100000006;
pub const VELOCITY_ID: u32 = 100000007;
pub const USERID_ID: u32 = 100000008;
pub const AGENT_SKIN_ID: u32 = 100000009;
pub const WEAPON_NAME_ID: u32 = 100000010;
pub const YAW_ID: u32 = 100000111;
pub const PITCH_ID: u32 = 100000012;
pub const TICK_ID: u32 = 100000013;
pub const STEAMID_ID: u32 = 100000014;
pub const NAME_ID: u32 = 100000015;
pub const PLAYER_X_ID: u32 = 100000016;
pub const PLAYER_Y_ID: u32 = 100000017;
pub const PLAYER_Z_ID: u32 = 100000018;
pub const WEAPON_STICKERS_ID: u32 = 100000019;

pub const WEAPON_SKIN_ID: u32 = 10000000;
pub const WEAPON_ATTRIBUTE_DEF_INDEX_ID: u32 = 11000000;
pub const WEAPON_PAINT_SEED: u32 = 10000001;
pub const WEAPON_FLOAT: u32 = 10000002;
pub const ITEM_PURCHASE_COUNT: u32 = 200000000;
pub const ITEM_PURCHASE_DEF_IDX: u32 = 300000000;
pub const ITEM_PURCHASE_COST: u32 = 400000000;
pub const ITEM_PURCHASE_HANDLE: u32 = 500000000;
pub const ITEM_PURCHASE_NEW_DEF_IDX: u32 = 600000000;
pub const FLATTENED_VEC_MAX_LEN: u32 = 100000;

pub const GLOVE_PAINT_ID: u32 = 20000000;
pub const GLOVE_PAINT_SEED: u32 = 20000001;
pub const GLOVE_PAINT_FLOAT: u32 = 20000002;
pub const GLOVE_SKIN: u32 = 20000003;

pub const USERCMD_VIEWANGLE_X: u32 = 100000022;
pub const USERCMD_VIEWANGLE_Y: u32 = 100000023;
pub const USERCMD_VIEWANGLE_Z: u32 = 100000024;
pub const USERCMD_FORWARDMOVE: u32 = 100000025;
pub const USERCMD_IMPULSE: u32 = 100000026;
pub const USERCMD_MOUSE_DX: u32 = 100000027;
pub const USERCMD_MOUSE_DY: u32 = 100000028;
pub const USERCMD_BUTTONSTATE_1: u32 = 100000029;
pub const USERCMD_BUTTONSTATE_2: u32 = 100000030;
pub const USERCMD_BUTTONSTATE_3: u32 = 100000031;
pub const USERCMD_CONSUMED_SERVER_ANGLE_CHANGES: u32 = 100000032;
pub const USERCMD_LEFTMOVE: u32 = 100000033;
pub const USERCMD_WEAPON_SELECT: u32 = 100000034;
pub const USERCMD_SUBTICK_MOVE_ANALOG_FORWARD_DELTA: u32 = 100000035;
pub const USERCMD_SUBTICK_MOVE_ANALOG_LEFT_DELTA: u32 = 100000036;
pub const USERCMD_SUBTICK_MOVE_BUTTON: u32 = 100000037;
pub const USERCMD_SUBTICK_MOVE_WHEN: u32 = 100000038;
pub const USERCMD_SUBTICK_LEFT_HAND_DESIRED: u32 = 100000039;

pub const USERCMD_ATTACK_START_HISTORY_INDEX_1: u32 = 100000040;
pub const USERCMD_ATTACK_START_HISTORY_INDEX_2: u32 = 100000041;
pub const USERCMD_ATTACK_START_HISTORY_INDEX_3: u32 = 100000042;

pub const USERCMD_INPUT_HISTORY_BASEID: u32 = 100001000;
pub const INPUT_HISTORY_X_OFFSET: u32 = 0;
pub const INPUT_HISTORY_Y_OFFSET: u32 = 1;
pub const INPUT_HISTORY_Z_OFFSET: u32 = 2;
pub const INPUT_HISTORY_RENDER_TICK_COUNT_OFFSET: u32 = 3;
pub const INPUT_HISTORY_RENDER_TICK_FRACTION_OFFSET: u32 = 4;
pub const INPUT_HISTORY_PLAYER_TICK_COUNT_OFFSET: u32 = 5;
pub const INPUT_HISTORY_PLAYER_TICK_FRACTION_OFFSET: u32 = 6;

pub const INVENTORY_AS_IDS_ID: u32 = 100100020;
pub const IS_AIRBORNE_ID: u32 = 100100021;
pub const GRENADE_TYPE_ID: u32 = 100100022;
pub const GRENADE_X: u32 = 100100023;
pub const GRENADE_Y: u32 = 100100024;
pub const GRENADE_Z: u32 = 100100025;
pub const INVENTORY_AS_IDS_BITMASK: u32 = 100100026;

#[derive(Clone, Debug)]
pub struct PropController {
    pub id: u32,
    pub wanted_player_props: Vec<String>,
    pub wanted_prop_ids: Vec<u32>,
    pub prop_infos: Vec<PropInfo>,
    pub name_to_id: AHashMap<String, u32>,
    pub id_to_name: AHashMap<u32, String>,
    pub special_ids: SpecialIDs,
    pub real_name_to_og_name: AHashMap<String, String>,
    pub name_to_special_id: AHashMap<String, u32>,
    pub wanted_other_props: Vec<String>,
    pub event_with_velocity: bool,
    pub needs_velocity: bool,
    pub path_to_name: AHashMap<[i32; 7], String>,
    pub wanted_prop_states: AHashMap<String, Variant>,
    pub wanted_prop_state_infos: Vec<WantedPropStateInfo>,
    pub parse_projectiles: bool,
    pub parse_infernos: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PropInfo {
    pub id: u32,
    pub prop_type: PropType,
    pub prop_name: String,
    pub prop_friendly_name: String,
    pub is_player_prop: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WantedPropStateInfo {
    pub base: PropInfo,
    pub wanted_prop_state: Variant,
}

pub enum PropCollectionType {
    Player,
    Rules,
    Team,
}

impl PropController {
    pub fn new(
        wanted_player_props: Vec<String>,
        wanted_other_props: Vec<String>,
        wanted_prop_states: AHashMap<String, Variant>,
        real_name_to_og_name: AHashMap<String, String>,
        needs_velocty: bool,
        wanted_events: &[String],
        parse_projectiles: bool,
        parse_infernos: bool,
    ) -> Self {
        PropController {
            id: NORMAL_PROP_BASEID,
            wanted_player_props,
            wanted_prop_ids: vec![],
            prop_infos: vec![],
            name_to_id: AHashMap::default(),
            special_ids: SpecialIDs::new(),
            id_to_name: AHashMap::default(),
            name_to_special_id: AHashMap::default(),
            wanted_other_props,
            real_name_to_og_name,
            event_with_velocity: !wanted_events.is_empty() && needs_velocty,
            path_to_name: AHashMap::default(),
            needs_velocity: needs_velocty,
            wanted_prop_states,
            wanted_prop_state_infos: vec![],
            parse_projectiles: parse_projectiles,
            parse_infernos: parse_infernos,
        }
    }

    pub fn set_custom_propinfos(&mut self) {
        let button_names = BUTTONMAP.keys();
        let mut someid = BUTTONS_BASEID;
        let mut someid2 = BUTTONS_BASEID;
        for bn in button_names {
            if self.wanted_player_props.contains(&(bn.to_string())) {
                self.prop_infos.push(PropInfo {
                    id: someid,
                    prop_type: PropType::Button,
                    prop_name: bn.to_string(),
                    prop_friendly_name: bn.to_string(),
                    is_player_prop: true,
                });
                someid += 1;
            }
            if let Some(wanted_state) = self.wanted_prop_states.get(&(bn.to_string())) {
                self.wanted_prop_state_infos.push(WantedPropStateInfo {
                    base: PropInfo {
                        id: someid2,
                        prop_type: PropType::Button,
                        prop_name: bn.to_string(),
                        prop_friendly_name: bn.to_string(),
                        is_player_prop: true,
                    },
                    wanted_prop_state: wanted_state.clone(),
                });
                someid2 += 1;
            }
        }

        for (custom_prop_name, custom_prop_id) in CUSTOM_PLAYER_PROP_IDS.entries() {
            if self.wanted_player_props.contains(&(custom_prop_name.to_string())) {
                self.prop_infos.push(PropInfo {
                    id: *custom_prop_id,
                    prop_type: *TYPEHM.get(&custom_prop_name).unwrap_or(&PropType::Custom),
                    prop_name: custom_prop_name.to_string(),
                    prop_friendly_name: self
                        .real_name_to_og_name
                        .get(&custom_prop_name.to_string())
                        .unwrap_or(&custom_prop_name.to_string())
                        .to_string(),
                    is_player_prop: true,
                })
            }
            if let Some(wanted_state) = self.wanted_prop_states.get(&(custom_prop_name.to_string())) {
                self.wanted_prop_state_infos.push(WantedPropStateInfo {
                    base: PropInfo {
                        id: *custom_prop_id,
                        prop_type: *TYPEHM.get(&custom_prop_name).unwrap_or(&PropType::Custom),
                        prop_name: custom_prop_name.to_string(),
                        prop_friendly_name: self
                            .real_name_to_og_name
                            .get(&custom_prop_name.to_string())
                            .unwrap_or(&custom_prop_name.to_string())
                            .to_string(),
                        is_player_prop: true,
                    },
                    wanted_prop_state: wanted_state.clone(),
                })
            }
        }

        if self.wanted_player_props.contains(&("game_time".to_string())) {
            self.prop_infos.push(PropInfo {
                id: GAME_TIME_ID,
                prop_type: PropType::GameTime,
                prop_name: "game_time".to_string(),
                prop_friendly_name: "game_time".to_string(),
                is_player_prop: true,
            });
        }
        if self.wanted_player_props.contains(&("glove_paint_id".to_string())) {
            self.prop_infos.push(PropInfo {
                id: GLOVE_PAINT_ID,
                prop_type: PropType::Custom,
                prop_name: "glove_paint_id".to_string(),
                prop_friendly_name: "glove_paint_id".to_string(),
                is_player_prop: true,
            });
        }
        if self.wanted_player_props.contains(&("glove_paint_seed".to_string())) {
            self.prop_infos.push(PropInfo {
                id: GLOVE_PAINT_SEED,
                prop_type: PropType::Custom,
                prop_name: "glove_paint_seed".to_string(),
                prop_friendly_name: "glove_paint_seed".to_string(),
                is_player_prop: true,
            });
        }
        if self.wanted_player_props.contains(&("glove_paint_float".to_string())) {
            self.prop_infos.push(PropInfo {
                id: GLOVE_PAINT_FLOAT,
                prop_type: PropType::Custom,
                prop_name: "glove_paint_float".to_string(),
                prop_friendly_name: "glove_paint_float".to_string(),
                is_player_prop: true,
            });
        }

        if let Some(wanted_state) = self.wanted_prop_states.get(&("game_time".to_string())) {
            self.wanted_prop_state_infos.push(WantedPropStateInfo {
                base: PropInfo {
                    id: GAME_TIME_ID,
                    prop_type: PropType::GameTime,
                    prop_name: "game_time".to_string(),
                    prop_friendly_name: "game_time".to_string(),
                    is_player_prop: true,
                },
                wanted_prop_state: wanted_state.clone(),
            });
        }

        // Can also be non-player prop
        if self.wanted_other_props.contains(&("game_time".to_string())) {
            self.prop_infos.push(PropInfo {
                id: GAME_TIME_ID,
                prop_type: PropType::GameTime,
                prop_name: "game_time".to_string(),
                prop_friendly_name: "game_time".to_string(),
                is_player_prop: false,
            });
        }
        // Parse grenades / infernos specific
        if self.parse_projectiles || self.parse_infernos {
            self.prop_infos.push(PropInfo {
                id: GRENADE_TYPE_ID,
                prop_type: PropType::Tick,
                prop_name: "grenade_type".to_string(),
                prop_friendly_name: "grenade_type".to_string(),
                is_player_prop: true,
            });
            self.prop_infos.push(PropInfo {
                id: ENTITY_ID_ID,
                prop_type: PropType::Custom,
                prop_name: "grenade_entity_id".to_string(),
                prop_friendly_name: "grenade_entity_id".to_string(),
                is_player_prop: true,
            });
            self.prop_infos.push(PropInfo {
                id: GRENADE_X,
                prop_type: PropType::Custom,
                prop_name: "x".to_string(),
                prop_friendly_name: "x".to_string(),
                is_player_prop: true,
            });
            self.prop_infos.push(PropInfo {
                id: GRENADE_Y,
                prop_type: PropType::Custom,
                prop_name: "y".to_string(),
                prop_friendly_name: "y".to_string(),
                is_player_prop: true,
            });
            self.prop_infos.push(PropInfo {
                id: GRENADE_Z,
                prop_type: PropType::Custom,
                prop_name: "z".to_string(),
                prop_friendly_name: "z".to_string(),
                is_player_prop: true,
            });
        }
        self.prop_infos.push(PropInfo {
            id: TICK_ID,
            prop_type: PropType::Tick,
            prop_name: "tick".to_string(),
            prop_friendly_name: "tick".to_string(),
            is_player_prop: true,
        });
        self.prop_infos.push(PropInfo {
            id: STEAMID_ID,
            prop_type: PropType::Steamid,
            prop_name: "steamid".to_string(),
            prop_friendly_name: "steamid".to_string(),
            is_player_prop: true,
        });
        self.prop_infos.push(PropInfo {
            id: NAME_ID,
            prop_type: PropType::Name,
            prop_name: "name".to_string(),
            prop_friendly_name: "name".to_string(),
            is_player_prop: true,
        });
    }
    pub fn find_prop_name_paths(&mut self, ser: &mut Serializer) {
        self.traverse_fields(&mut ser.fields, ser.name.clone(), vec![])
    }
    fn set_id(&mut self, weap_prop: &str, f: &mut ValueField, is_grenade_or_weapon: bool) {
        match self.name_to_id.get(weap_prop) {
            // If we already have an id for prop of same name then use that id.
            // Mainly for weapon props. For example CAK47.m_iClip1 and CWeaponSCAR20.m_iClip1
            // are the "same" prop. (they have same path and we want to refer to it with one id not ~20)
            Some(id) => {
                f.prop_id = *id as u32;
                self.id_to_name.insert(*id, weap_prop.to_string());
                self.set_special_ids(&weap_prop, is_grenade_or_weapon, *id);
                return;
            }
            None => {
                self.name_to_id.insert(weap_prop.to_string(), self.id);
                self.id_to_name.insert(self.id, weap_prop.to_string());
                f.prop_id = self.id as u32;
                self.set_special_ids(&weap_prop, is_grenade_or_weapon, self.id);
            }
        }
    }

    fn insert_propinfo(&mut self, prop_name: &str, f: &mut ValueField) {
        let split_at_dot: Vec<&str> = prop_name.split(".").collect();

        let grenade_or_weapon = is_grenade_or_weapon(&prop_name);
        let prop_name = split_weapon_prefix_from_prop_name(&prop_name);

        let prop_name = match grenade_or_weapon {
            true => split_at_dot[1..].join("."),
            false => prop_name.to_string(),
        };
        let mut prefix_type = match prop_name.split(".").next() {
            Some("CCSGameRulesProxy") => Some(PropType::Rules),
            Some("CCSTeam") => Some(PropType::Team),
            Some("CCSPlayerPawn") => Some(PropType::Player),
            Some("CCSPlayerController") => Some(PropType::Controller),
            _ => None,
        };

        if grenade_or_weapon {
            prefix_type = Some(PropType::Weapon);
        }

        // If any custom mapping found use that one
        if let Some(mapping) = TYPEHM.get(&prop_name) {
            prefix_type = Some(*mapping);
        }

        if let Some(prop_type) = prefix_type {
            if self.wanted_player_props.contains(&prop_name.to_string()) {
                self.prop_infos.push(PropInfo {
                    id: f.prop_id as u32,
                    prop_type: prop_type,
                    prop_name: prop_name.to_string(),
                    prop_friendly_name: self
                        .real_name_to_og_name
                        .get(&prop_name.to_string())
                        .unwrap_or(&prop_name.to_string())
                        .to_string(),
                    is_player_prop: true,
                });
            }
            if self.wanted_other_props.contains(&prop_name.to_string()) {
                self.prop_infos.push(PropInfo {
                    id: f.prop_id as u32,
                    prop_type: prop_type,
                    prop_name: prop_name.to_string(),
                    prop_friendly_name: self
                        .real_name_to_og_name
                        .get(&prop_name.to_string())
                        .unwrap_or(&(prop_name.to_string()))
                        .to_string(),
                    is_player_prop: false,
                })
            }
            if let Some(wanted_state) = self.wanted_prop_states.get(&prop_name.to_string()) {
                self.wanted_prop_state_infos.push(WantedPropStateInfo {
                    base: PropInfo {
                        id: f.prop_id as u32,
                        prop_type: prop_type,
                        prop_name: prop_name.to_string(),
                        prop_friendly_name: self
                            .real_name_to_og_name
                            .get(&prop_name.to_string())
                            .unwrap_or(&(prop_name.to_string()))
                            .to_string(),
                        is_player_prop: true,
                    },
                    wanted_prop_state: wanted_state.clone(),
                });
            }
        }
    }
    pub fn handle_prop(&mut self, full_name: &str, f: &mut ValueField, path: Vec<i32>) {
        f.full_name = full_name.to_string();

        let prop_name = split_weapon_prefix_from_prop_name(full_name);

        let mut a = [0, 0, 0, 0, 0, 0, 0];
        for (idx, v) in path.iter().enumerate() {
            a[idx] = *v;
        }
        self.path_to_name.insert(a, prop_name.to_string());
        let grenade_or_weapon = is_grenade_or_weapon(full_name);

        let prop_already_exists = self.name_to_id.contains_key(&(prop_name).to_string());
        self.set_id(&prop_name, f, grenade_or_weapon);

        if !prop_already_exists {
            self.insert_propinfo(&full_name, f);
        }
        f.should_parse = true;

        if full_name == "CCSPlayerPawn.CCSPlayer_WeaponServices.m_hMyWeapons" {
            f.prop_id = MY_WEAPONS_OFFSET as u32;
        }
        // CS2 Insight: keep CUtlVector utility arrays under stable base IDs so
        // elements can be flattened (path index) instead of overwriting one slot.
        if full_name.ends_with(".m_VoxelFrameData") || full_name == "m_VoxelFrameData" {
            f.prop_id = VOXEL_FRAME_DATA_OFFSET;
            self.name_to_id.insert(prop_name.to_string(), VOXEL_FRAME_DATA_OFFSET);
            for info in self.prop_infos.iter_mut() {
                if info.prop_name == "m_VoxelFrameData" || info.prop_friendly_name == "m_VoxelFrameData" {
                    info.id = VOXEL_FRAME_DATA_OFFSET;
                }
            }
        }
        if full_name.ends_with(".m_firePositions") || full_name == "m_firePositions" {
            f.prop_id = FIRE_POSITIONS_OFFSET;
            self.name_to_id.insert(prop_name.to_string(), FIRE_POSITIONS_OFFSET);
            for info in self.prop_infos.iter_mut() {
                if info.prop_name == "m_firePositions" || info.prop_friendly_name == "m_firePositions" {
                    info.id = FIRE_POSITIONS_OFFSET;
                }
            }
        }
        if full_name.ends_with(".m_bFireIsBurning") || full_name == "m_bFireIsBurning" {
            f.prop_id = FIRE_BURNING_OFFSET;
            self.name_to_id.insert(prop_name.to_string(), FIRE_BURNING_OFFSET);
            for info in self.prop_infos.iter_mut() {
                if info.prop_name == "m_bFireIsBurning" || info.prop_friendly_name == "m_bFireIsBurning" {
                    info.id = FIRE_BURNING_OFFSET;
                }
            }
        }
        if full_name.ends_with(".m_fireParentPositions") || full_name == "m_fireParentPositions" {
            f.prop_id = FIRE_PARENT_POSITIONS_OFFSET;
            self.name_to_id.insert(prop_name.to_string(), FIRE_PARENT_POSITIONS_OFFSET);
            for info in self.prop_infos.iter_mut() {
                if info.prop_name == "m_fireParentPositions" || info.prop_friendly_name == "m_fireParentPositions" {
                    info.id = FIRE_PARENT_POSITIONS_OFFSET;
                }
            }
        }
        if full_name == "CCSPlayerPawn.CCSPlayer_ActionTrackingServices.WeaponPurchaseCount_t.m_nCount" {
            f.prop_id = ITEM_PURCHASE_COUNT as u32;
        }
        if full_name == "CCSPlayerPawn.CCSPlayer_BuyServices.SellbackPurchaseEntry_t.m_unDefIdx" {
            f.prop_id = ITEM_PURCHASE_DEF_IDX as u32;
        }
        if full_name == "CCSPlayerPawn.CCSPlayer_BuyServices.SellbackPurchaseEntry_t.m_nCost" {
            f.prop_id = ITEM_PURCHASE_COST as u32;
        }
        if full_name == "CCSPlayerPawn.CCSPlayer_ActionTrackingServices.WeaponPurchaseCount_t.m_nItemDefIndex" {
            f.prop_id = ITEM_PURCHASE_NEW_DEF_IDX as u32;
        }
        if full_name == "CCSPlayerPawn.CCSPlayer_BuyServices.SellbackPurchaseEntry_t.m_hItem" {
            f.prop_id = ITEM_PURCHASE_HANDLE as u32;
        }
        if !full_name.starts_with("CCSPlayerPawn") && prop_name.contains("CEconItemAttribute.m_iAttributeDefinitionIndex") {
            f.prop_id = WEAPON_ATTRIBUTE_DEF_INDEX_ID as u32;
        }
        if !full_name.starts_with("CCSPlayerPawn") && prop_name.contains("CEconItemAttribute.m_iRawValue32") {
            f.prop_id = WEAPON_SKIN_ID as u32;
        }
        if full_name.starts_with("CCSPlayerPawn") && prop_name.contains("CEconItemAttribute.m_iRawValue32") {
            f.prop_id = GLOVE_PAINT_ID as u32;
        }
        if full_name == "CCSPlayerPawn.CCSPlayer_WeaponServices.m_iAmmo"{
            f.prop_id = GRENADE_AMMO_ID;
        }
        self.id += 1;
    }

    fn set_special_ids(&mut self, name: &str, is_grenade_or_weapon: bool, id: u32) {
        if is_grenade_or_weapon {
            match name {
                "m_bIsIncGrenade" => self.special_ids.is_incendiary_grenade = Some(id),
                "m_hOwnerEntity" => self.special_ids.h_owner_entity = Some(id),
                "m_nOwnerId" => self.special_ids.grenade_owner_id = Some(id),
                "CBodyComponentBaseAnimGraph.m_vecX" => self.special_ids.m_vec_x_grenade = Some(id),
                "CBodyComponentBaseAnimGraph.m_vecY" => self.special_ids.m_vec_y_grenade = Some(id),
                "CBodyComponentBaseAnimGraph.m_vecZ" => self.special_ids.m_vec_z_grenade = Some(id),
                "CBodyComponentBaseAnimGraph.m_cellX" => self.special_ids.m_cell_x_grenade = Some(id),
                "CBodyComponentBaseAnimGraph.m_cellY" => self.special_ids.m_cell_y_grenade = Some(id),
                "CBodyComponentBaseAnimGraph.m_cellZ" => self.special_ids.m_cell_z_grenade = Some(id),
                "m_iItemDefinitionIndex" => self.special_ids.item_def = Some(id),
                "m_OriginalOwnerXuidLow" => self.special_ids.orig_own_low = Some(id),
                "m_OriginalOwnerXuidHigh" => self.special_ids.orig_own_high = Some(id),
                "m_szCustomName" => self.special_ids.custom_name = Some(id),
                _ => {}
            };
        } else {
            match name {
                "CCSGameRulesProxy.CCSGameRules.m_nRoundStartCount" => self.special_ids.round_start_count = Some(id),
                "CCSGameRulesProxy.CCSGameRules.m_nRoundEndCount" => self.special_ids.round_end_count = Some(id),
                "CCSGameRulesProxy.CCSGameRules.m_nMatchEndCount" => self.special_ids.match_end_count = Some(id),
                "CCSGameRulesProxy.CCSGameRules.m_eRoundWinReason" => self.special_ids.round_win_reason = Some(id),
                "CCSGameRulesProxy.CCSGameRules.m_totalRoundsPlayed" => self.special_ids.total_rounds_played = Some(id),
                "CCSTeam.m_iTeamNum" => self.special_ids.team_team_num = Some(id),
                "CCSPlayerPawn.m_iTeamNum" => self.special_ids.player_team_pointer = Some(id),
                "CBasePlayerWeapon.m_nOwnerId" => self.special_ids.weapon_owner_pointer = Some(id),
                "CCSPlayerController.m_iTeamNum" => self.special_ids.teamnum = Some(id),
                "CCSPlayerController.m_iszPlayerName" => self.special_ids.player_name = Some(id),
                "CCSPlayerController.m_steamID" => self.special_ids.steamid = Some(id),
                "CCSPlayerController.m_hPlayerPawn" => self.special_ids.player_pawn = Some(id),
                "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_cellX" => self.special_ids.cell_x_player = Some(id),
                "CCSPlayerPawn.CCSPlayer_MovementServices.m_nButtonDownMaskPrev" => self.special_ids.buttons = Some(id),
                "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_vecX" => self.special_ids.cell_x_offset_player = Some(id),
                "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_cellY" => self.special_ids.cell_y_player = Some(id),
                "CCSPlayerPawn.m_angEyeAngles" => self.special_ids.eye_angles = Some(id),
                "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_vecY" => self.special_ids.cell_y_offset_player = Some(id),
                "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_cellZ" => self.special_ids.cell_z_player = Some(id),
                "CCSPlayerPawn.CBodyComponentBaseAnimGraph.m_vecZ" => self.special_ids.cell_z_offset_player = Some(id),
                "CCSPlayerPawn.CCSPlayer_WeaponServices.m_hActiveWeapon" => self.special_ids.active_weapon = Some(id),
                "CCSPlayerPawn.m_lifeState" => self.special_ids.life_state = Some(id),
                "CCSPlayerController.m_nPawnCharacterDefIndex" => self.special_ids.agent_skin_idx = Some(id),
                "CCSPlayerPawn.m_bInBuyZone" => self.special_ids.in_buy_zone = Some(id),
                "CCSPlayerPawn.m_hGroundEntity" => self.special_ids.is_airborn = Some(id),
                _ => {}
            };
        }
    }
    fn traverse_fields(&mut self, fields: &mut [Field], ser_name: String, path_og: Vec<i32>) {
        for (idx, f) in fields.iter_mut().enumerate() {
            let mut path = path_og.clone();
            path.push(idx as i32);
            match f {
                Field::Value(x) => {
                    let full_name = ser_name.clone() + "." + &x.name;
                    self.handle_prop(&full_name, x, path);
                }
                Field::Serializer(ser) => self.traverse_fields(&mut ser.serializer.fields, ser_name.clone() + "." + &ser.serializer.name, path.clone()),
                Field::Pointer(ser) => self.traverse_fields(&mut ser.serializer.fields, ser_name.clone() + "." + &ser.serializer.name, path.clone()),
                Field::Array(ser) => match &mut ser.field_enum.as_mut() {
                    Field::Value(v) => {
                        self.handle_prop(&(ser_name.clone() + "." + &v.name), v, path);
                    }
                    _ => {}
                },
                Field::Vector(_x) => {
                    let vec_path = path.clone();
                    if let Ok(inner) = f.get_inner_mut(0) {
                        match inner {
                            Field::Serializer(s) => {
                                for (inner_idx, f) in &mut s.serializer.fields.iter_mut().enumerate() {
                                    match f {
                                        Field::Value(v) => {
                                            let mut myp = vec_path.clone();
                                            myp.push(inner_idx as i32);
                                            self.handle_prop(&(ser_name.clone() + "." + &v.name), v, myp);
                                        }
                                        _ => {}
                                    }
                                }
                                self.traverse_fields(&mut s.serializer.fields, ser_name.clone() + "." + &s.serializer.name, path_og.clone())
                            }
                            Field::Value(x) => {
                                self.handle_prop(&(ser_name.clone() + "." + &x.name), x, path.clone());
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

pub fn split_weapon_prefix_from_prop_name(full_name: &str) -> String {
    let split_at_dot: Vec<&str> = full_name.split(".").collect();
    let grenade_or_weapon = is_grenade_or_weapon(full_name);
    // Strip first part of name from grenades and weapons.
    // if weapon prop: CAK47.m_iClip1 => m_iClip1
    // if grenade: CSmokeGrenadeProjectile.CBodyComponentBaseAnimGraph.m_cellX => CBodyComponentBaseAnimGraph.m_cellX
    match grenade_or_weapon {
        true => split_at_dot[1..].join("."),
        false => full_name.to_string(),
    }
}

pub fn is_grenade_or_weapon(full_name: &str) -> bool {
    let split_at_dot: Vec<&str> = full_name.split(".").collect();
    let is_weapon_prop = (split_at_dot[0].contains("Weapon") || split_at_dot[0].contains("AK")) && !split_at_dot[0].contains("Player")
        || split_at_dot[0].contains("Knife")
        || split_at_dot[0].contains("CDEagle")
        || split_at_dot[0].contains("C4")
        || split_at_dot[0].contains("Molo")
        || split_at_dot[0].contains("Inc")
        || split_at_dot[0].contains("Infer");

    let is_projectile_prop = (split_at_dot[0].contains("Projectile") || split_at_dot[0].contains("Grenade") || split_at_dot[0].contains("Flash"))
        && !split_at_dot[0].contains("Player");
    is_weapon_prop || is_projectile_prop
}
