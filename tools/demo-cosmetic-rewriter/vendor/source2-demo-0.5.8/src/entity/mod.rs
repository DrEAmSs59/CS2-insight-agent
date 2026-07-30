//! # Overview
//!
//! Entities have:
//! - A unique index and serial number
//! - A class that defines their type
//! - A state containing all their properties
//!
//! # Examples
//!
//! ## Getting entity properties
//!
//! ```no_run
//! use source2_demo::prelude::*;
//!
//! # fn example(entity: &Entity) -> anyhow::Result<()> {
//! // Using try_into
//! let health: i32 = entity.get_property("m_iHealth")?.try_into()?;
//!
//! // Using property! macro
//! let mana: i32 = property!(entity, "m_flMana");
//!
//! // With type annotation
//! let team = property!(entity, u32, "m_iTeamNum");
//!
//! // Formatted property names
//! let player_id = 5;
//! let name: String = property!(entity, "m_vecPlayerData.{:04}.m_iszPlayerName", player_id);
//! # Ok(())
//! # }
//! ```
//!
//! ## Filtering entities
//!
//! ```no_run
//! use source2_demo::prelude::*;
//!
//! # fn example(ctx: &Context) -> anyhow::Result<()> {
//! // Find all heroes on Radiant team
//! let radiant_heroes: Vec<&Entity> = ctx
//!     .entities()
//!     .iter()
//!     .filter(|e| {
//!         e.class().name().starts_with("CDOTA_Unit_Hero_")
//!             && try_property!(e, u32, "m_iTeamNum") == Some(2)
//!     })
//!     .collect();
//! # Ok(())
//! # }
//! ```

mod baseline;
mod class;
mod container;

pub(crate) use baseline::*;
pub(crate) mod field;
pub use class::*;
pub use container::*;

use crate::error::EntityError;
use crate::field::{FieldPath, FieldState};
use crate::FieldValue;
use std::rc::Rc;

/// Events that can occur to entities during replay parsing.
///
/// These events are passed to the `Observer::on_entity` callback when
/// an entity is created, updated, or deleted.
///
/// # Examples
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// #[derive(Default)]
/// struct EntityTracker {
///     created: usize,
///     updated: usize,
///     deleted: usize,
/// }
///
/// #[observer]
/// #[uses_entities]
/// impl EntityTracker {
///     fn on_entity(
///         &mut self,
///         ctx: &Context,
///         event: EntityEvents,
///         entity: &Entity,
///     ) -> ObserverResult {
///         match event {
///             EntityEvents::Created => self.created += 1,
///             EntityEvents::Updated => self.updated += 1,
///             EntityEvents::Deleted => self.deleted += 1,
///         }
///         Ok(())
///     }
/// }
/// ```
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum EntityEvents {
    /// Entity was created and added
    Created,
    /// Entity properties were updated
    Updated,
    /// Entity was removed
    Deleted,
}

/// A read-only entity field entry for inspection UIs and debugging tools.
pub struct EntityField<'a> {
    /// Numeric field path used by the demo stream.
    pub path: Vec<u16>,
    /// Human-readable dotted field path.
    pub name: String,
    /// Source 2 field type reported by the serializer.
    pub field_type: String,
    /// Decoded value type used by `source2-demo`.
    pub decoded_type: Option<&'static str>,
    /// Current field value, if the field is present in the state.
    pub value: Option<&'a FieldValue>,
}

/// A baseline entity entry keyed by class id.
pub struct BaselineEntity {
    /// Entity class id used to look up the baseline.
    pub class_id: i32,
    /// Human-readable entity class name.
    pub class_name: String,
}

impl EntityEvents {
    #[inline]
    pub(crate) fn from_cmd(cmd: u32) -> Self {
        match cmd {
            0 => EntityEvents::Updated,
            2 => EntityEvents::Created,
            3 => EntityEvents::Deleted,
            _ => unreachable!(),
        }
    }
}

/// Represents a game entity with its properties and state.
///
/// Entities are the fundamental objects in Source 2 games, representing
/// everything from players and heroes to items and buildings. Each entity has:
/// - An index (position in the entity list)
/// - A serial number (for handle-based lookups)
/// - A class (defines what type of entity it is)
/// - A state (contains all property values)
///
/// # Property Access
///
/// Entity properties can be accessed in multiple ways:
///
/// 1. Using [`get_property`](Entity::get_property) and converting manually
/// 2. Using the `property!` macro
/// 3. Using the `try_property!` macro for optional properties
///
/// # Examples
///
/// ## Basic property access
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(entity: &Entity) -> anyhow::Result<()> {
/// // Get a property and convert it
/// let health: i32 = entity.get_property("m_iHealth")?.try_into()?;
///
/// // Using the property! macro (simpler)
/// let max_health: i32 = property!(entity, "m_iHealth");
///
/// // With type annotation
/// let position = property!(entity, i32, "m_iHealth.m_vecPosition");
/// # Ok(())
/// # }
/// ```
///
/// ## Working with arrays (formatted property names)
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(entity: &Entity) -> anyhow::Result<()> {
/// // Access array element using formatting
/// let player_id = 3;
/// let name: String = property!(entity, "m_vecPlayerData.{:04}.m_iszPlayerName", player_id);
/// # Ok(())
/// # }
/// ```
///
/// ## Optional properties
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(entity: &Entity) {
/// // Returns None if property doesn't exist or can't be converted
/// if let Some(health) = try_property!(entity, i32, "m_iHealth") {
///     println!("Health: {}", health);
/// }
/// # }
/// ```
#[derive(Clone)]
pub struct Entity {
    pub(crate) index: u32,
    pub(crate) serial: u32,
    pub(crate) class: Rc<Class>,
    pub(crate) state: FieldState,
}

impl Default for Entity {
    fn default() -> Self {
        Entity {
            index: u32::MAX,
            serial: 0,
            class: Class::default().into(),
            state: FieldState::default(),
        }
    }
}

impl Entity {
    pub(crate) fn new(index: u32, serial: u32, class: Rc<Class>, state: FieldState) -> Self {
        Entity {
            index,
            serial,
            class,
            state,
        }
    }

    /// Returns the entity's index in the entity list.
    ///
    /// The index is the position of this entity in the internal entity array.
    /// Valid entities have indices in the range 0..8192.
    pub fn index(&self) -> u32 {
        self.index
    }

    /// Returns the entity's serial number.
    ///
    /// The serial number is used for handle-based entity lookups and is
    /// incremented each time an entity slot is reused.
    pub fn serial(&self) -> u32 {
        self.serial
    }

    /// Returns the entity's handle.
    ///
    /// The handle combines the serial number and index into a single value
    /// that uniquely identifies this entity. It's calculated as:
    /// `(serial << 14) | index`
    pub fn handle(&self) -> u32 {
        self.serial << 14 | self.index
    }

    /// Returns all serializer-backed fields for this entity.
    ///
    /// This is intended for generic inspection tools that need to enumerate an
    /// entity without knowing property names ahead of time.
    pub fn fields(&self) -> Vec<EntityField<'_>> {
        self.class
            .serializer
            .get_paths(&mut FieldPath::default(), &self.state)
            .into_iter()
            .map(|fp| {
                let value = self.state.get_value(&fp);
                EntityField {
                    path: (0..=fp.last).map(|idx| fp.path[idx]).collect(),
                    name: self.class.serializer.get_name(&fp).to_string(),
                    field_type: self.class.serializer.get_type(&fp).to_string(),
                    decoded_type: value.map(FieldValue::type_name),
                    value,
                }
            })
            .collect()
    }

    /// Returns a reference to the entity's class.
    ///
    /// The class defines what type of entity this is (e.g.,
    /// "CDOTA_Unit_Hero_Axe"). It also contains the serializer that defines
    /// what properties the entity has.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(entity: &Entity) {
    /// let class = entity.class();
    /// println!("Class name: {}", class.name());
    /// println!("Class ID: {}", class.id());
    ///
    /// // Check if entity is a hero
    /// if class.name().starts_with("CDOTA_Unit_Hero_") {
    ///     println!("This is a hero!");
    /// }
    /// # }
    /// ```
    pub fn class(&self) -> &Class {
        &self.class
    }

    /// See [`get_property`](Entity::get_property) - this method is deprecated
    /// in favor of the more clearly named `get_property`.
    #[deprecated]
    pub fn get_property_by_name(&self, name: &str) -> Result<&FieldValue, EntityError> {
        self.get_property_by_path(&self.class.serializer.get_path(name)?)
    }

    /// Gets the value of an entity property by its name.
    ///
    /// This method looks up a property by its string name (e.g., "m_iHealth")
    /// and returns a reference to its [`FieldValue`]. The value can then be
    /// converted to the desired Rust type using [`TryInto`].
    ///
    /// # Property Names
    ///
    /// Property names use dot notation for nested properties:
    /// - Simple: `"m_iHealth"`, `"m_flMana"`
    /// - Nested: `"CBodyComponent.m_cellX"`
    /// - Arrays: `"m_vecPlayerData.0000.m_iszPlayerName"` (use formatting for
    ///   indices)
    ///
    /// # Recommended Alternatives
    ///
    /// For most use cases, prefer the [`property!`] or [`try_property!`] macros
    /// which provide a more ergonomic interface with automatic type conversion:
    ///
    /// ```ignore
    /// // Instead of:
    /// let health: i32 = entity.get_property("m_iHealth")?.try_into()?;
    ///
    /// // Use:
    /// let health: i32 = property!(entity, "m_iHealth");
    /// ```
    ///
    /// # Arguments
    ///
    /// * `name` - The property name in dot notation (e.g.,
    ///   "CBodyComponent.m_cellX")
    ///
    /// # Returns
    ///
    /// Returns `Ok(&FieldValue)` if the property exists, or an error if:
    /// - The property name is invalid or doesn't exist
    /// - The entity class doesn't have this property
    ///
    /// # Errors
    ///
    /// Returns [`EntityError::PropertyNameNotFound`] if the property doesn't
    /// exist on this entity or if the name is invalid.
    ///
    /// # Examples
    ///
    /// ## Basic usage with manual conversion
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(entity: &Entity) -> anyhow::Result<()> {
    /// // Get property and convert to i32
    /// let health: i32 = entity.get_property("m_iHealth")?.try_into()?;
    ///
    /// // Get nested property
    /// let cell_x: u8 = entity.get_property("CBodyComponent.m_cellX")?.try_into()?;
    ///
    /// // Get vector property
    /// let position: i32 = entity.get_property("m_iHealth")?.try_into()?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// ## Using in an observer
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// #[derive(Default)]
    /// struct HealthTracker;
    ///
    /// #[observer]
    /// #[uses_entities]
    /// impl HealthTracker {
    ///     fn on_entity(
    ///         &mut self,
    ///         ctx: &Context,
    ///         event: EntityEvents,
    ///         entity: &Entity,
    ///     ) -> ObserverResult {
    ///         // Manual conversion with get_property
    ///         let health: i32 = entity.get_property("m_iHealth")?.try_into()?;
    ///
    ///         // Recommended: using property! macro instead
    ///         let max_health: i32 = property!(entity, "m_iMaxHealth");
    ///
    ///         println!("Health: {}/{}", health, max_health);
    ///         Ok(())
    ///     }
    /// }
    /// ```
    ///
    /// ## Comparison with macros
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(entity: &Entity) -> anyhow::Result<()> {
    /// // Method 1: get_property (verbose)
    /// let health: i32 = entity.get_property("m_iHealth")?.try_into()?;
    ///
    /// // Method 2: property! macro (recommended)
    /// let health: i32 = property!(entity, "m_iHealth");
    ///
    /// // Method 3: try_property! macro (for optional properties)
    /// let health: Option<i32> = try_property!(entity, i32, "m_iHealth");
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # See Also
    ///
    /// - [`property!`] - Macro for concise property access with automatic
    ///   conversion
    /// - [`try_property!`] - Macro for optional property access (returns
    ///   `Option`)
    /// - [`FieldValue`] - The type returned by this method
    ///
    /// [`property!`]: crate::property
    /// [`try_property!`]: crate::try_property
    pub fn get_property(&self, name: &str) -> Result<&FieldValue, EntityError> {
        self.get_property_by_path(&self.class.serializer.get_path(name)?)
    }

    pub(crate) fn get_property_by_path(&self, fp: &FieldPath) -> Result<&FieldValue, EntityError> {
        self.state.get_value(fp).ok_or_else(|| {
            EntityError::PropertyNameNotFound(
                self.class.serializer.get_name(fp).to_string(),
                self.class.name().to_string(),
                format!("{}", fp),
            )
        })
    }

    /// Returns an iterator over the values inside a vector-like entity
    /// property.
    ///
    /// This is useful for properties that contain multiple field states, such
    /// as handle arrays like `"m_hItems"`. Each element is returned as an
    /// `Option<&FieldValue>` because some entries may not have a value.
    ///
    /// # Arguments
    ///
    /// * `name` - The property name in dot notation.
    ///
    /// # Returns
    ///
    /// Returns an iterator over the property's values if the property exists.
    ///
    /// # Errors
    ///
    /// Returns [`EntityError::PropertyNameNotFound`] if the property name is
    /// invalid or the entity does not contain this field.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(entity: &Entity) -> anyhow::Result<()> {
    /// for value in entity.get_iter("m_hItems")?.flatten() {
    ///     let handle: usize = value.try_into()?;
    ///     println!("Item handle: {}", handle);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_iter(
        &self,
        name: &str,
    ) -> Result<impl Iterator<Item = Option<&FieldValue>>, EntityError> {
        Ok(self
            .get_state(&self.class.serializer.get_path(name)?)?
            .children()
            .iter()
            .map(|fs| fs.value.as_ref()))
    }

    pub(crate) fn get_state(&self, fp: &FieldPath) -> Result<&FieldState, EntityError> {
        self.state.get_state(fp).ok_or_else(|| {
            EntityError::PropertyNameNotFound(
                self.class.serializer.get_name(fp).to_string(),
                self.class.name().to_string(),
                format!("{}", fp),
            )
        })
    }
}
