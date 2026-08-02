//! Parser context containing the current replay state.
//!
//! The [`Context`] struct maintains all the state information about the replay
//! as it's being parsed, including entities, string tables, game events, and
//! the current tick.

use crate::entity::field::*;
use crate::entity::*;
use crate::event::*;
use crate::string_table::*;
use crate::{FieldValue, HashMap};
use source2_demo_protobufs::CDemoFileInfo;
use std::rc::Rc;

/// Current replay state accessible to observers.
///
/// The context is passed to all observer callbacks and provides access to:
/// - Entity state and properties
/// - String tables
/// - Game event definitions
/// - Current tick and timing information
/// - Replay metadata
///
/// # Examples
///
/// ## Accessing entities
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// #[derive(Default)]
/// struct HeroStats;
///
/// #[observer]
/// #[uses_entities]
/// impl HeroStats {
///     #[on_tick_start]
///     fn on_tick_start(&mut self, ctx: &Context) -> ObserverResult {
///         for entity in ctx.entities().iter() {
///             if entity.class().name().starts_with("CDOTA_Unit_Hero_") {
///                 let health: i32 = property!(entity, "m_iHealth");
///                 println!("{}: {}", entity.class().name(), health);
///             }
///         }
///         Ok(())
///     }
/// }
/// ```
///
/// ## Accessing string tables
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// #[derive(Default)]
/// struct TableReader;
///
/// #[observer]
/// #[uses_string_tables]
/// impl TableReader {
///     #[on_tick_start]
///     fn on_tick_start(&mut self, ctx: &Context) -> ObserverResult {
///         if let Ok(table) = ctx.string_tables().get_by_name("ActiveModifiers") {
///             println!("Active modifiers: {}", table.iter().count());
///         }
///         Ok(())
///     }
/// }
/// ```
pub struct Context {
    pub(crate) classes: Classes,
    pub(crate) entities: Entities,
    pub(crate) string_tables: StringTables,
    pub(crate) game_events: GameEventList,

    pub(crate) tick: u32,
    pub(crate) previous_tick: u32,
    pub(crate) net_tick: u32,

    pub(crate) game_build: u32,
    pub(crate) replay_info: CDemoFileInfo,

    pub(crate) baselines: BaselineContainer,
    pub(crate) serializers: HashMap<Box<str>, Rc<Serializer>>,
    pub(crate) last_full_packet_tick: u32,
}

impl Default for Context {
    fn default() -> Self {
        Context {
            classes: Classes::default(),
            entities: Entities::default(),
            string_tables: StringTables::default(),
            game_events: Default::default(),
            tick: u32::MAX,
            previous_tick: u32::MAX,
            net_tick: u32::MAX,
            game_build: 0,
            replay_info: CDemoFileInfo::default(),
            baselines: BaselineContainer::default(),
            serializers: HashMap::default(),
            last_full_packet_tick: u32::MAX,
        }
    }
}

impl Context {
    pub(crate) fn new(replay_info: CDemoFileInfo) -> Self {
        Context {
            classes: Classes::default(),
            entities: Entities::default(),
            string_tables: StringTables::default(),
            game_events: GameEventList::default(),
            tick: u32::MAX,
            previous_tick: u32::MAX,
            net_tick: u32::MAX,
            game_build: 0,
            replay_info,
            baselines: BaselineContainer::default(),
            serializers: HashMap::default(),
            last_full_packet_tick: u32::MAX,
        }
    }
}

impl Context {
    /// Returns a reference to the entity container.
    ///
    /// Use this to access all entities in the game and query their properties.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// // Get entity by index
    /// let entity = ctx.entities().get_by_index(0)?;
    ///
    /// // Find entity by class name
    /// let player_resource = ctx.entities().get_by_class_name("CDOTA_PlayerResource")?;
    ///
    /// // Iterate all entities
    /// for entity in ctx.entities().iter() {
    ///     println!("{}", entity.class().name());
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub fn classes(&self) -> &Classes {
        &self.classes
    }

    /// Returns a reference to the entity container.
    ///
    /// Provides access to all game entities and their properties.
    /// Requires `Interests::ENTITY_STATE` to be populated.
    pub fn entities(&self) -> &Entities {
        &self.entities
    }

    /// Returns a reference to the string tables.
    ///
    /// String tables contain game data like hero names, item names, etc.
    /// Requires `Interests::STRING_TABLE_STATE` to be populated.
    pub fn string_tables(&self) -> &StringTables {
        &self.string_tables
    }

    /// Returns a reference to the game event list.
    ///
    /// Contains definitions for all game events in the replay.
    pub fn game_events(&self) -> &GameEventList {
        &self.game_events
    }

    /// Returns the current tick number.
    ///
    /// The tick represents the current game simulation step.
    /// Typically runs at 30 ticks per second.
    pub fn tick(&self) -> u32 {
        self.tick
    }

    /// Returns the previous tick number.
    ///
    /// This is the last tick observed before the current tick advanced.
    pub fn previous_tick(&self) -> u32 {
        self.previous_tick
    }

    /// Returns the current network tick.
    ///
    /// The network tick from the last processed packet.
    pub fn net_tick(&self) -> u32 {
        self.net_tick
    }

    /// Returns the game build number.
    ///
    /// Identifies the specific version of the game that created this replay.
    pub fn game_build(&self) -> u32 {
        self.game_build
    }

    /// Returns replay file metadata.
    ///
    /// Contains information about the replay including duration, map, and game
    /// info.
    pub fn replay_info(&self) -> &CDemoFileInfo {
        &self.replay_info
    }

    /// Returns the baseline entity classes currently known to the parser.
    ///
    /// Baselines are keyed by entity class id rather than live entity index.
    /// This method is primarily useful for replay inspection and debugging
    /// tools.
    pub fn baseline_entities(&self) -> Vec<BaselineEntity> {
        let mut entities = self
            .baselines
            .states
            .keys()
            .filter_map(|&class_id| {
                self.classes
                    .get_by_id(class_id as usize)
                    .ok()
                    .map(|class| BaselineEntity {
                        class_id,
                        class_name: class.name().to_string(),
                    })
            })
            .collect::<Vec<_>>();

        entities.sort_by_key(|entity| entity.class_id);
        entities
    }

    /// Returns all fields for a baseline entity class id.
    ///
    /// Returns `None` if the baseline or matching class serializer is not
    /// present in the current parser context.
    pub fn baseline_fields(&self, class_id: i32) -> Option<Vec<EntityField<'_>>> {
        let state = self.baselines.states.get(&class_id)?;
        let class = self.classes.get_by_id(class_id as usize).ok()?;
        class
            .serializer
            .get_paths(&mut FieldPath::default(), state)
            .into_iter()
            .map(|fp| {
                let value = state.get_value(&fp);
                EntityField {
                    path: (0..=fp.last).map(|idx| fp.path[idx]).collect(),
                    name: class.serializer.get_name(&fp).to_string(),
                    field_type: class.serializer.get_type(&fp).to_string(),
                    decoded_type: value.map(FieldValue::type_name),
                    value,
                }
            })
            .collect::<Vec<_>>()
            .into()
    }
}
