use crate::error::EntityError;
use crate::Entity;

/// Container for all entities in the replay.
///
/// Entities represent all game objects (heroes, NPCs, items, wards, etc.).
/// This container provides multiple ways to access them:
/// - By index (direct position in entity array)
/// - By handle (combined serial + index)
/// - By class ID (entity type)
/// - By class name (e.g., "CDOTA_Unit_Hero_Axe")
///
/// # Entity Access Patterns
///
/// Different scenarios require different lookup methods:
/// - **Known class name**: Use
///   [`get_by_class_name`](Entities::get_by_class_name)
/// - **Iterating all**: Use [`iter`](Entities::iter)
/// - **Known index**: Use [`get_by_index`](Entities::get_by_index)
/// - **Finding by type**: Use iterator with filter
///
/// # Examples
///
/// ## Get the player resource
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) -> anyhow::Result<()> {
/// let player_resource = ctx.entities().get_by_class_name("CDOTA_PlayerResource")?;
/// # Ok(())
/// # }
/// ```
///
/// ## Find all heroes on a specific team
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) -> anyhow::Result<()> {
/// let radiant_heroes: Vec<&Entity> = ctx
///     .entities()
///     .iter()
///     .filter(|e| {
///         e.class().name().starts_with("CDOTA_Unit_Hero_")
///             && try_property!(e, u32, "m_iTeamNum") == Some(2) // 2 = Radiant
///     })
///     .collect();
/// # Ok(())
/// # }
/// ```
///
/// ## Get entity by index
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) -> anyhow::Result<()> {
/// let entity = ctx.entities().get_by_index(256)?;
/// println!("Entity type: {}", entity.class().name());
/// # Ok(())
/// # }
/// ```
pub struct Entities {
    pub(crate) entities_vec: Vec<Entity>,
}

impl Default for Entities {
    fn default() -> Self {
        Entities {
            entities_vec: vec![Entity::default(); 8192],
        }
    }
}

impl Entities {
    /// Returns an iterator over all active entities.
    ///
    /// Iterates only entities that are currently alive/active in the replay.
    /// Deleted entities are automatically skipped.
    ///
    /// # Examples
    ///
    /// ```
    /// use source2_demo::prelude::*;
    /// use source2_demo::proto::*;
    ///
    /// #[derive(Default)]
    /// struct MyObs;
    ///
    /// impl Observer for MyObs {
    ///     fn on_tick_start(&mut self, ctx: &Context) -> ObserverResult {
    ///         let dire_heroes = ctx
    ///             .entities()
    ///             .iter()
    ///             .filter(|&e| {
    ///                 e.class().name().starts_with("CDOTA_Hero_Unit")
    ///                     && try_property!(e, u32, "m_iTeamNum") == Some(3)
    ///                     && try_property!(e, u32, "m_hReplicatingOtherHeroModel") == Some(u32::MAX)
    ///             })
    ///             .collect::<Vec<_>>();
    ///         Ok(())
    ///     }
    /// }
    /// ```
    pub fn iter(&self) -> impl Iterator<Item = &Entity> {
        self.entities_vec.iter().filter(|e| e.index != u32::MAX)
    }

    /// Gets an entity by its index in the entity array.
    ///
    /// Entity indices are in the range 0-8191. This is the fastest way to
    /// access an entity if you already know its index.
    ///
    /// # Arguments
    ///
    /// * `index` - The entity index (0-8191)
    ///
    /// # Errors
    ///
    /// Returns [`EntityError::IndexNotFound`] if no entity exists at the given
    /// index or if the entity at that index has been deleted.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// let entity = ctx.entities().get_by_index(0)?;
    /// println!("First entity type: {}", entity.class().name());
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_by_index(&self, index: usize) -> Result<&Entity, EntityError> {
        if let Some(e) = self.entities_vec.get(index) {
            if e.index != u32::MAX {
                return Ok(e);
            }
        }
        Err(EntityError::IndexNotFound(index))
    }

    /// Gets an entity by its handle.
    ///
    /// A handle combines the serial number and index into a single identifier.
    /// This is useful when you have a handle reference from entity properties.
    ///
    /// # Arguments
    ///
    /// * `handle` - The entity handle (serial << 14 | index)
    ///
    /// # Errors
    ///
    /// Returns [`EntityError::HandleNotFound`] if no valid entity exists
    /// for the given handle.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// let handle = 123; // Example handle from entity property
    /// let entity = ctx.entities().get_by_handle(handle as usize)?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_by_handle(&self, handle: usize) -> Result<&Entity, EntityError> {
        self.get_by_index(handle & 0x3fff)
            .map_err(|_| EntityError::HandleNotFound(handle))
    }

    /// Gets the first entity with the specified class ID.
    ///
    /// Typically only useful if you know there's only one entity of that class,
    /// or if you only need the first one. For finding multiple entities of a
    /// type, use [`iter`](Entities::iter) with a filter.
    ///
    /// # Arguments
    ///
    /// * `id` - The class ID to search for
    ///
    /// # Errors
    ///
    /// Returns [`EntityError::ClassIdNotFound`] if no entity with the given
    /// class ID exists.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// // Find entity by class ID
    /// let entity = ctx.entities().get_by_class_id(42)?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_by_class_id(&self, id: i32) -> Result<&Entity, EntityError> {
        self.iter()
            .find(|&entity| entity.class().id() == id)
            .ok_or(EntityError::ClassIdNotFound(id))
    }

    /// Gets the first entity with the specified class name.
    ///
    /// This is useful for finding unique entities like "CDOTA_PlayerResource"
    /// or specific entity types. For finding multiple entities of a class type,
    /// use [`iter`](Entities::iter) with a filter.
    ///
    /// # Arguments
    ///
    /// * `name` - The class name to search for (e.g., "CDOTA_PlayerResource")
    ///
    /// # Errors
    ///
    /// Returns [`EntityError::ClassNameNotFound`] if no entity with the given
    /// class name exists.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// // Find the player resource entity
    /// let player_resource = ctx.entities().get_by_class_name("CDOTA_PlayerResource")?;
    ///
    /// // Now you can get player info from this entity
    /// let player_name: String =
    ///     property!(player_resource, "m_vecPlayerData.{:04}.m_iszPlayerName", 0);
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_by_class_name(&self, name: &str) -> Result<&Entity, EntityError> {
        self.iter()
            .find(|&entity| entity.class().name() == name)
            .ok_or(EntityError::ClassNameNotFound(name.to_string()))
    }
}
