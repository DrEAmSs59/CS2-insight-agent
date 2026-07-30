use crate::entity::field::Serializer;
use crate::error::ClassError;
use crate::HashMap;
use std::rc::Rc;

/// Container for all entity classes in a replay.
///
/// Classes define the types of entities that exist in the game. Each entity
/// belongs to a class which specifies:
/// - What properties it has
/// - How those properties are encoded
/// - The class name (e.g., "CDOTA_Unit_Hero_Axe")
///
/// # Examples
///
/// ## Iterating all classes
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) {
/// for class in ctx.classes().iter() {
///     println!("Class ID {}: {}", class.id(), class.name());
/// }
/// # }
/// ```
///
/// ## Finding a specific class
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) -> anyhow::Result<()> {
/// // Get by class name
/// let hero_class = ctx.classes().get_by_name("CDOTA_Unit_Hero_Axe")?;
/// println!("Found class: {}", hero_class.name());
///
/// // Get by ID
/// let class = ctx.classes().get_by_id(42)?;
/// # Ok(())
/// # }
/// ```
#[derive(Default)]
pub struct Classes {
    pub(crate) classes_vec: Vec<Rc<Class>>,
    pub(crate) classes_by_name: HashMap<Box<str>, Rc<Class>>,
    pub(crate) class_id_size: u32,
}

impl Classes {
    pub(crate) fn get_by_id_rc(&self, id: usize) -> &Rc<Class> {
        &self.classes_vec[id]
    }

    /// Returns an iterator over all classes.
    ///
    /// This allows you to discover all entity types in the replay.
    pub fn iter(&self) -> impl Iterator<Item = &Class> {
        self.classes_vec.iter().map(|class| class.as_ref())
    }

    /// Gets a class by its numeric ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The numeric class ID
    ///
    /// # Errors
    ///
    /// Returns [`ClassError::ClassNotFoundById`] if no class with the given ID
    /// exists.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::Context;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// let class = ctx.classes().get_by_id(42)?;
    /// println!("Class name: {}", class.name());
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_by_id(&self, id: usize) -> Result<&Class, ClassError> {
        self.classes_vec
            .get(id)
            .ok_or(ClassError::ClassNotFoundById(id as i32))
            .map(|class| class.as_ref())
    }

    /// Gets a class by its name.
    ///
    /// This is the most common way to find entity classes since you typically
    /// know the class name you're looking for (e.g., "CDOTA_Unit_Hero_Axe").
    ///
    /// # Arguments
    ///
    /// * `name` - The class name (case-sensitive, e.g., "CDOTA_PlayerResource")
    ///
    /// # Errors
    ///
    /// Returns [`ClassError::ClassNotFoundByName`] if no class with the given
    /// name exists.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::Context;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// // Find hero class
    /// let hero_class = ctx.classes().get_by_name("CDOTA_Unit_Hero_Axe")?;
    ///
    /// // Find player resource class
    /// let resource = ctx.classes().get_by_name("CDOTA_PlayerResource")?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_by_name(&self, name: &str) -> Result<&Class, ClassError> {
        self.classes_by_name
            .get(name)
            .ok_or_else(|| ClassError::ClassNotFoundByName(name.to_string()))
            .map(|class| class.as_ref())
    }
}

/// Entity class definition.
///
/// Represents the type and structure of an entity. Classes define:
/// - Class ID: Numeric identifier
/// - Class name: Human-readable type name (e.g., "CDOTA_Unit_Hero_Axe")
/// - Serializer: Defines which properties exist and how they're encoded
///
/// # Class Name Patterns
///
/// Entity class names follow patterns that help identify their type:
/// - `CDOTA_Unit_Hero_*` - Dota 2 heroes
/// - `CDOTA_Unit_*` - Dota 2 NPCs and units
/// - `CDOTA_Item_*` - Dota 2 item holders
/// - `CDOTA_*` - Other Dota 2 entities
/// - `CCitadelPlayerPawn` - Deadlock players
/// - `CPlayer_*` - CS2 players
///
/// # Examples
///
/// ## Using class information
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(entity: &Entity) {
/// let class = entity.class();
/// println!("Entity ID: {}", class.id());
/// println!("Entity name: {}", class.name());
///
/// // Check entity type
/// if class.name().starts_with("CDOTA_Unit_Hero_") {
///     println!("This is a hero!");
/// }
/// # }
/// ```
///
/// ## Finding all entities of a class type
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) -> anyhow::Result<()> {
/// // Find all heroes
/// let heroes: Vec<&Entity> = ctx
///     .entities()
///     .iter()
///     .filter(|e| e.class().name().starts_with("CDOTA_Unit_Hero_"))
///     .collect();
/// # Ok(())
/// # }
/// ```
#[derive(Clone, Default)]
pub struct Class {
    pub(crate) id: i32,
    pub(crate) name: Box<str>,
    pub(crate) serializer: Rc<Serializer>,
}

impl Class {
    pub(crate) fn new(id: i32, name: Box<str>, serializer: Rc<Serializer>) -> Self {
        Class {
            id,
            name,
            serializer,
        }
    }

    /// Returns the human-readable name of this class.
    ///
    /// Examples: "CDOTA_Unit_Hero_Axe", "CDOTA_PlayerResource"
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::Class;
    ///
    /// # fn example(class: &Class) {
    /// match class.name() {
    ///     "CDOTA_PlayerResource" => println!("Found player resource"),
    ///     name if name.starts_with("CDOTA_Unit_Hero_") => println!("Found hero"),
    ///     _ => println!("Other entity type"),
    /// }
    /// # }
    /// ```
    pub fn name(&self) -> &str {
        self.name.as_ref()
    }

    /// Returns the numeric ID of this class.
    ///
    /// Each class has a unique numeric ID assigned when the replay is parsed.
    /// This ID is used internally for efficient entity classification.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::Class;
    ///
    /// # fn example(class: &Class) {
    /// println!("Class ID: {}", class.id());
    /// # }
    /// ```
    pub fn id(&self) -> i32 {
        self.id
    }
}
