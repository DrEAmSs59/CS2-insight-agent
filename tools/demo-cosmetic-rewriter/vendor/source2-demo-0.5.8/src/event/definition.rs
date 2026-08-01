use crate::HashMap;
use std::rc::Rc;

/// Definition for a game event type declared by the replay.
pub struct GameEventDefinition {
    pub(crate) name: String,
    pub(crate) keys: Vec<Rc<GameEventKey>>,
    pub(crate) name_to_key: HashMap<String, Rc<GameEventKey>>,
}

impl GameEventDefinition {
    /// Returns the event definition name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the ordered key definitions for this event.
    pub fn keys(&self) -> impl Iterator<Item = &GameEventKey> {
        self.keys.iter().map(|key| key.as_ref())
    }
}

#[derive(Debug)]
/// Definition for a single field in a game event.
pub struct GameEventKey {
    pub(crate) id: i32,
    pub(crate) name: String,
    pub(crate) type_id: i32,
}

impl GameEventKey {
    /// Returns the zero-based key index.
    pub fn id(&self) -> i32 {
        self.id
    }

    /// Returns the key name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the raw game event key type ID from the replay descriptor.
    pub fn type_id(&self) -> i32 {
        self.type_id
    }

    /// Returns a human-readable game event key type name.
    pub fn type_name(&self) -> &'static str {
        match self.type_id {
            1 => "string",
            2 => "float",
            3 => "long",
            4 => "short",
            5 => "byte",
            6 => "bool",
            7 => "uint64",
            8 => "long",
            9 => "short",
            _ => "unknown",
        }
    }
}
