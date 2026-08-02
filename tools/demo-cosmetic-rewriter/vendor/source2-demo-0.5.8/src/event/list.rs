use crate::event::*;
use crate::HashMap;
use source2_demo_protobufs::CSvcMsgGameEventList;
use std::rc::Rc;

/// Container for all game event definitions in a replay.
///
/// This stores the complete definitions for all game events that can occur
/// during replay parsing. Each event definition specifies:
/// - Event ID: Unique identifier
/// - Event name: Human-readable name
/// - Key definitions: Names and types of fields in the event
///
/// # Examples
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) {
/// // Game events are automatically parsed from the event definitions
/// // You access them through the observer callbacks or game event iteration
/// # }
/// ```
#[derive(Default)]
pub struct GameEventList {
    pub(crate) list: HashMap<i32, Rc<GameEventDefinition>>,
}

impl GameEventList {
    pub(crate) fn new(list: CSvcMsgGameEventList) -> Self {
        let list = list
            .descriptors
            .into_iter()
            .map(|descriptor| {
                let keys = descriptor
                    .keys
                    .clone()
                    .into_iter()
                    .enumerate()
                    .map(|(i, key)| {
                        Rc::new(GameEventKey {
                            id: i as i32,
                            name: key.name().into(),
                            type_id: key.r#type(),
                        })
                    })
                    .collect::<Vec<_>>();
                let definition = Rc::new(GameEventDefinition {
                    name: descriptor.name().into(),
                    keys: keys.clone(),
                    name_to_key: keys
                        .into_iter()
                        .map(|key| (key.name.clone(), key))
                        .collect(),
                });
                (descriptor.eventid(), definition)
            })
            .collect::<HashMap<_, _>>();

        Self { list }
    }

    /// Returns an iterator over all game event definitions by event ID.
    pub fn iter(&self) -> impl Iterator<Item = (i32, &GameEventDefinition)> {
        self.list
            .iter()
            .map(|(event_id, definition)| (*event_id, definition.as_ref()))
    }
}
