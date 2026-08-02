//! Combat log entry parsing for Dota 2.
//!
//! This module provides the [`CombatLogEntry`] type for working with Dota 2
//! combat log entries.

use crate::error::CombatLogError;
use crate::proto::{CMsgDotaCombatLogEntry, DotaCombatlogTypes};
use crate::string_table::StringTable;

/// Wrapper for Dota 2 combat log entries.
///
/// Provides convenient access to combat log data including damage, healing,
/// kills, abilities, items, and modifiers.
///
/// # Examples
///
/// ```no_run
/// use source2_demo::prelude::*;
/// use source2_demo::proto::DotaCombatlogTypes;
///
/// #[derive(Default)]
/// struct CombatLog;
///
/// #[observer]
/// #[uses_combat_log]
/// impl CombatLog {
///     #[on_combat_log]
///     fn on_combat(&mut self, entry: &CombatLogEntry) -> ObserverResult {
///         if entry.r#type() == DotaCombatlogTypes::DotaCombatlogDeath {
///             println!("{} killed {}", entry.attacker_name()?, entry.target_name()?);
///         }
///         Ok(())
///     }
/// }
/// ```
#[derive(Clone)]
pub struct CombatLogEntry<'a> {
    pub(crate) names: &'a StringTable,
    pub(crate) log: CMsgDotaCombatLogEntry,
}

macro_rules! define_combat_log_getters {
    ($($name:ident: $type:ty),*) => {
        $(
            #[doc = concat!("Returns the `", stringify!($name), "` property from the combat log entry.")]
            pub fn $name(&self) -> Result<$type, CombatLogError> {
                self.log.$name.ok_or_else(|| {
                    CombatLogError::EmptyProperty(stringify!($name).into(), format!("{:?}", self.r#type()))
                })
            }
        )*
    };
}

macro_rules! define_name_getter {
    ($($fn_name:ident: $log_prop:ident),*) => {
        $(
            #[doc = concat!("Returns the name associated with the `", stringify!($log_prop), "` property.")]
            pub fn $fn_name(&self) -> Result<&str, CombatLogError> {
                self.log.$log_prop
                    .and_then(|id| self.names.items.get(id as usize).map(|name| name.key.as_ref()))
                    .ok_or_else(|| {
                        CombatLogError::EmptyName(stringify!($fn_name).into(), format!("{:?}", self.r#type()))
                    })
            }
        )*
    };
}

impl<'a> CombatLogEntry<'a> {
    /// Returns the combat log entry type.
    ///
    /// Types include damage, healing, death, ability use, item use, etc.
    pub fn r#type(&self) -> DotaCombatlogTypes {
        self.log.r#type()
    }

    /// Returns the underlying protobuf message.
    ///
    /// Provides direct access to all raw combat log data.
    pub fn log(&self) -> &CMsgDotaCombatLogEntry {
        &self.log
    }

    /// Returns the list of assisting player IDs.
    ///
    /// For kill events, returns the players who assisted in the kill.
    pub fn assist_players(&self) -> &[i32] {
        self.log.assist_players.as_slice()
    }

    define_name_getter! {
        target_name: target_name,
        target_source_name: target_source_name,
        attacker_name: attacker_name,
        damage_source_name: damage_source_name,
        inflictor_name: inflictor_name,
        value_name: value
    }

    define_combat_log_getters! {
        value: u32,
        health: i32,
        timestamp: f32,
        stun_duration: f32,
        slow_duration: f32,
        ability_level: u32,
        location_x: f32,
        location_y: f32,
        gold_reason: u32,
        timestamp_raw: f32,
        modifier_duration: f32,
        xp_reason: u32,
        last_hits: u32,
        attacker_team: u32,
        target_team: u32,
        obs_wards_placed: u32,
        assist_player0: u32,
        assist_player1: u32,
        assist_player2: u32,
        assist_player3: u32,
        stack_count: u32,
        hidden_modifier: bool,
        neutral_camp_type: u32,
        rune_type: u32,
        attacker_hero_level: u32,
        target_hero_level: u32,
        xpm: u32,
        gpm: u32,
        event_location: u32,
        target_is_self: bool,
        damage_type: u32,
        invisibility_modifier: bool,
        damage_category: u32,
        networth: u32,
        building_type: u32,
        modifier_elapsed_duration: f32,
        silence_modifier: bool,
        heal_from_lifesteal: bool,
        modifier_purged: bool,
        spell_evaded: bool,
        motion_controller_modifier: bool,
        long_range_kill: bool,
        modifier_purge_ability: u32,
        modifier_purge_npc: u32,
        root_modifier: bool,
        total_unit_death_count: u32,
        aura_modifier: bool,
        armor_debuff_modifier: bool,
        no_physical_damage_modifier: bool,
        modifier_ability: u32,
        modifier_hidden: bool,
        inflictor_is_stolen_ability: bool,
        kill_eater_event: u32,
        unit_status_label: u32,
        spell_generated_attack: bool,
        is_attacker_illusion: bool,
        is_attacker_hero: bool,
        is_target_illusion: bool,
        is_target_hero: bool,
        is_visible_radiant: bool,
        is_visible_dire: bool,
        is_ability_toggle_on: bool,
        is_ability_toggle_off: bool,
        is_heal_save: bool,
        is_ultimate_ability: bool,
        uses_charges: bool,
        will_reincarnate: bool,
        regenerated_health: f32,
        neutral_camp_team: u32,
        at_night_time: bool,
        is_target_building: bool,
        attacker_has_scepter: bool
    }
}
