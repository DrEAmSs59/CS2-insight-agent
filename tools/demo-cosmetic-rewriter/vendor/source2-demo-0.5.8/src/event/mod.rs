//! Game event system for handling in-game events.
//!
//! This module provides types for working with game events - structured events
//! that occur during gameplay like player kills, item purchases, ability uses,
//! etc.
//!
//! # Overview
//!
//! Game events are defined by the game and contain named key-value pairs.
//! Each event has a name (e.g., "dota_player_kill") and a set of values.
//!
//! # Examples
//!
//! ## Handling game events
//!
//! ```no_run
//! use source2_demo::prelude::*;
//!
//! #[derive(Default)]
//! struct EventLogger;
//!
//! #[observer]
//! #[uses_game_events]
//! impl EventLogger {
//!     #[on_game_event]
//!     fn on_game_event(&mut self, ctx: &Context, ge: &GameEvent) -> ObserverResult {
//!         println!("Event: {}", ge.name());
//!
//!         // Iterate all key-value pairs
//!         for (key, value) in ge.iter() {
//!             println!("  {}: {:?}", key, value);
//!         }
//!
//!         // Get specific value
//!         if let Ok(player_id) = ge.get_value("player_id") {
//!             let id: i32 = player_id.try_into()?;
//!             println!("Player ID: {}", id);
//!         }
//!
//!         Ok(())
//!     }
//! }
//! ```

#[cfg(feature = "dota")]
mod combat_log;
mod definition;
mod list;
mod value;

#[cfg(feature = "dota")]
pub use combat_log::*;
pub use definition::*;
pub use list::*;
pub use value::*;

use crate::error::GameEventError;
use crate::proto::CSvcMsgGameEvent;

/// Represents a game event with its name and values.
///
/// Game events are structured in-game occurrences. Each event has a name and a
/// set of named values.
///
/// # Examples
///
/// ## Accessing event data
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ge: &GameEvent) -> anyhow::Result<()> {
/// // Get the event name
/// println!("Event: {}", ge.name());
///
/// // Iterate all key-value pairs
/// for (key, value) in ge.iter() {
///     println!("{}: {:?}", key, value);
/// }
///
/// // Get a specific value
/// let player_id: i32 = ge.get_value("player_id")?.try_into()?;
/// # Ok(())
/// # }
/// ```
pub struct GameEvent<'a> {
    id: i32,
    list: &'a GameEventList,
    keys: Vec<EventValue>,
}

impl<'a> GameEvent<'a> {
    pub(crate) fn new(list: &'a GameEventList, ge: CSvcMsgGameEvent) -> Self {
        let id = ge.eventid();
        let keys = ge
            .keys
            .iter()
            .map(|key| match key.r#type() {
                1 => EventValue::String(key.val_string().into()),
                2 => EventValue::Float(key.val_float()),
                3 => EventValue::Int(key.val_long()),
                4 => EventValue::Int(key.val_short()),
                5 => EventValue::Byte(key.val_byte() as u8),
                6 => EventValue::Bool(key.val_bool()),
                7 => EventValue::U64(key.val_uint64()),
                8 => EventValue::Int(key.val_long()),
                9 => EventValue::Int(key.val_short()),
                _ => unreachable!("Unknown event type: {}", key.r#type()),
            })
            .collect::<Vec<_>>();

        Self { id, list, keys }
    }

    /// Returns the event's numeric ID.
    pub fn id(&self) -> i32 {
        self.id
    }

    /// Returns the event's name.
    ///
    /// Event names are strings
    pub fn name(&self) -> &str {
        &self.list.list[&self.id].name
    }

    /// Returns an iterator over all key-value pairs in the event.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ge: &GameEvent) {
    /// for (key, value) in ge.iter() {
    ///     println!("{}: {:?}", key, value);
    /// }
    /// # }
    /// ```
    pub fn iter(&self) -> impl Iterator<Item = (&str, &EventValue)> {
        self.keys
            .iter()
            .zip(self.list.list[&self.id].keys.iter())
            .map(|(value, key)| (key.name.as_str(), value))
    }

    /// Gets the value for a specific key.
    ///
    /// # Arguments
    ///
    /// * `key` - The name of the key to look up
    ///
    /// # Errors
    ///
    /// Returns [`GameEventError::UnknownKey`] if the key doesn't exist for this
    /// event.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ge: &GameEvent) -> anyhow::Result<()> {
    /// // Get a value and convert it
    /// let player_id: i32 = ge.get_value("player_id")?.try_into()?;
    /// let hero_name: String = ge.get_value("hero_name")?.try_into()?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_value(&self, key: &str) -> Result<&EventValue, GameEventError> {
        let key = self.list.list[&self.id]
            .name_to_key
            .get(key)
            .ok_or_else(|| GameEventError::UnknownKey(key.to_string()))?;
        Ok(&self.keys[key.id as usize])
    }
}
