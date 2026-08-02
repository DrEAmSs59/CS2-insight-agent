use crate::error::StringTableError;
use crate::string_table::*;
use crate::HashMap;

/// Container managing all string tables in a replay.
///
/// String tables store game data in key-value pairs organized by table name.
///
/// # Examples
///
/// ## Iterating all tables
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) {
/// for table in ctx.string_tables().iter() {
///     println!("Table: {} ({} rows)", table.name(), table.iter().count());
/// }
/// # }
/// ```
///
/// ## Accessing a specific table
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ctx: &Context) -> anyhow::Result<()> {
/// // Get by table name
/// let modifiers = ctx.string_tables().get_by_name("ActiveModifiers")?;
/// println!("Active modifiers: {}", modifiers.iter().count());
///
/// // Get by table ID
/// let table = ctx.string_tables().get_by_id(0)?;
/// println!("Table at index 0: {}", table.name());
/// # Ok(())
/// # }
/// ```
///
/// ## Extracting player data from userinfo
///
/// ```no_run
/// use source2_demo::prelude::*;
/// use source2_demo::proto::CMsgPlayerInfo;
///
/// # fn example(ctx: &Context) -> anyhow::Result<()> {
/// let userinfo = ctx.string_tables().get_by_name("userinfo")?;
///
/// // Read player info for slot 0
/// let player_row = userinfo.get_row(0)?;
/// if let Some(data) = player_row.value() {
///     let player_info = CMsgPlayerInfo::decode(data)?;
///     println!("Player: {}", player_info.name());
/// }
/// # Ok(())
/// # }
/// ```
#[derive(Default, Clone)]
pub struct StringTables {
    pub(crate) tables: Vec<StringTable>,
    pub(crate) name_to_table: HashMap<String, usize>,
}

impl StringTables {
    /// Returns an iterator over all string tables.
    ///
    /// Useful for discovering available tables or performing operations
    /// on all tables regardless of their names.
    pub fn iter(&self) -> impl Iterator<Item = &StringTable> {
        self.tables.iter()
    }

    /// Gets a string table by its numeric ID/index.
    ///
    /// # Arguments
    ///
    /// * `id` - The numeric index of the table
    ///
    /// # Errors
    ///
    /// Returns [`StringTableError::TableNotFoundById`] if no table exists at
    /// the given ID.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// let table = ctx.string_tables().get_by_id(5)?;
    /// println!("Table: {}", table.name());
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_by_id(&self, id: usize) -> Result<&StringTable, StringTableError> {
        self.tables
            .get(id)
            .ok_or(StringTableError::TableNotFoundById(id as i32))
    }

    /// Gets a string table by its name.
    ///
    /// This is the most common way to access string tables since you typically
    /// know which table (e.g., "userinfo", "ActiveModifiers") you need.
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the table (case-sensitive)
    ///
    /// # Errors
    ///
    /// Returns [`StringTableError::TableNotFoundByName`] if no table with the
    /// given name exists.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// // Get the userinfo table (contains player info)
    /// let userinfo = ctx.string_tables().get_by_name("userinfo")?;
    ///
    /// // Get the active modifiers table
    /// let modifiers = ctx.string_tables().get_by_name("ActiveModifiers")?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_by_name(&self, name: &str) -> Result<&StringTable, StringTableError> {
        self.name_to_table
            .get(name)
            .ok_or_else(|| StringTableError::TableNotFoundByName(name.to_string()))
            .map(|&idx| &self.tables[idx])
    }

    pub(crate) fn get_by_name_mut(
        &mut self,
        name: &str,
    ) -> Result<&mut StringTable, StringTableError> {
        self.name_to_table
            .get(name)
            .ok_or_else(|| StringTableError::TableNotFoundByName(name.to_string()))
            .map(|&idx| self.tables.get_mut(idx).unwrap())
    }
}
