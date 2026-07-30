//! String table system for managing game data.
//!
//! String tables are a key-value storage mechanism used by Source 2 games to
//! store various game data like hero names, item names, modifiers, and more.
//!
//! # Overview
//!
//! Each string table has:
//! - A name (e.g., "ActiveModifiers", "EntityNames")
//! - Rows containing key-value pairs
//! - Optional user data associated with each entry
//!
//! # Examples
//!
//! ## Accessing string tables
//!
//! ```no_run
//! use source2_demo::prelude::*;
//!
//! #[derive(Default)]
//! struct TableReader;
//!
//! impl Observer for TableReader {
//!     fn interests(&self) -> Interests {
//!         Interests::STRING_TABLE_STATE | Interests::STRING_TABLE_ENTRIES
//!     }
//!
//!     fn on_string_table(
//!         &mut self,
//!         ctx: &Context,
//!         st: &StringTable,
//!         modified: &[i32],
//!     ) -> ObserverResult {
//!         println!(
//!             "Table '{}' updated: {} rows modified",
//!             st.name(),
//!             modified.len()
//!         );
//!
//!         // Iterate all rows
//!         for row in st.iter() {
//!             println!("Key: {}", row.key());
//!         }
//!
//!         Ok(())
//!     }
//! }
//! ```
//!
//! ## Finding specific string tables
//!
//! ```no_run
//! use source2_demo::prelude::*;
//!
//! # fn example(ctx: &Context) -> anyhow::Result<()> {
//! // Get string table by name
//! let modifiers = ctx.string_tables().get_by_name("ActiveModifiers")?;
//! println!("Active modifiers: {}", modifiers.iter().count());
//!
//! // Get by index
//! let table = ctx.string_tables().get_by_id(0)?;
//! # Ok(())
//! # }
//! ```

mod container;
mod rewrite;
mod row;

pub use container::*;
pub use rewrite::StringTableEntryUpdate;
pub use row::*;

pub(crate) use rewrite::{
    rewrite_create_string_table, rewrite_demo_string_table_items, rewrite_update_string_table,
    PackedStringTableFormat, PackedStringTableState,
};

use crate::entity::BaselineContainer;
use crate::error::StringTableError;
use crate::reader::{BitsReader, SliceReader};
use std::cell::RefCell;
use std::rc::Rc;

/// A string table containing key-value pairs.
///
/// String tables store game data in a table format where each row has a key
/// (string) and optional value (binary data). They're used for various purposes
/// like tracking active modifiers, entity names, particle systems, etc.
///
/// # Usage Patterns
///
/// ## Accessing player data
///
/// ```no_run
/// use source2_demo::prelude::*;
/// use source2_demo::proto::CMsgPlayerInfo;
///
/// # fn example(ctx: &Context) -> anyhow::Result<()> {
/// let userinfo = ctx.string_tables().get_by_name("userinfo")?;
/// let row = userinfo.get_row(0)?;
///
/// if let Some(data) = row.value() {
///     let player_info = CMsgPlayerInfo::decode(data)?;
///     println!("Player: {}", player_info.name());
/// }
/// # Ok(())
/// # }
/// ```
///
/// ## Listing all entries
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(table: &StringTable) {
/// for row in table.iter() {
///     println!("Key: {}", row.key());
///     if let Some(value) = row.value() {
///         println!("  Value size: {} bytes", value.len());
///     }
/// }
/// # }
/// ```
#[derive(Clone, Default)]
pub struct StringTable {
    pub(crate) index: i32,
    pub(crate) name: String,
    pub(crate) items: Vec<StringTableRow>,
    pub(crate) user_data_fixed_size: bool,
    pub(crate) user_data_size: i32,
    pub(crate) flags: u32,
    pub(crate) var_int_bit_counts: bool,
    pub(crate) keys: RefCell<Vec<String>>,
}

impl StringTable {
    /// Returns the table's numeric index.
    pub fn index(&self) -> i32 {
        self.index
    }

    /// Returns the table's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns an iterator over all rows in the string table.
    ///
    /// This allows you to inspect all key-value pairs stored in the table.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// let table = ctx.string_tables().get_by_name("ActiveModifiers")?;
    ///
    /// for row in table.iter() {
    ///     println!("Key: {}", row.key());
    ///     if let Some(value) = row.value() {
    ///         println!("  Value size: {} bytes", value.len());
    ///     }
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub fn iter(&self) -> impl Iterator<Item = &StringTableRow> {
        self.items.iter()
    }

    /// See [`get_row`](StringTable::get_row) - this method is deprecated in
    /// favor of the more clearly named `get_row`.
    #[deprecated]
    pub fn get_row_by_index(&self, idx: usize) -> Result<&StringTableRow, StringTableError> {
        self.get_row(idx)
    }

    /// Gets a specific row by its index in the string table.
    ///
    /// Each string table is essentially a list of key-value pairs.
    /// This retrieves the row at the specified position.
    ///
    /// # Arguments
    ///
    /// * `idx` - The row index (0-based)
    ///
    /// # Errors
    ///
    /// Returns [`StringTableError::RowNotFoundByIndex`] if the index is out of
    /// bounds.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ctx: &Context) -> anyhow::Result<()> {
    /// let userinfo = ctx.string_tables().get_by_name("userinfo")?;
    ///
    /// // Get player info at slot 0
    /// let row = userinfo.get_row(0)?;
    /// println!("Slot 0 key: {}", row.key());
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_row(&self, idx: usize) -> Result<&StringTableRow, StringTableError> {
        self.items
            .get(idx)
            .ok_or(StringTableError::RowNotFoundByIndex(
                idx as i32,
                self.name.clone(),
            ))
    }

    pub(crate) fn parse(
        &mut self,
        baselines: &mut BaselineContainer,
        buf: &[u8],
        num_updates: i32,
    ) -> Result<Vec<i32>, StringTableError> {
        let items = &mut self.items;
        let mut reader = SliceReader::new(buf);
        let mut index = -1;
        let mut delta_pos = 0;
        let mut keys = self.keys.borrow_mut();

        let mut modified = vec![];

        if self.name == "decalprecache" {
            return Ok(modified);
        }

        for _ in 0..num_updates {
            reader.refill();

            index += 1;
            if !reader.read_bool() {
                index += reader.read_var_u32() as i32 + 1;
            }

            let key = reader.read_bool().then(|| {
                let delta_zero = if delta_pos > 32 { delta_pos & 31 } else { 0 };
                let key = if reader.read_bool() {
                    let pos = (delta_zero + reader.read_bits_unchecked(5) as usize) & 31;
                    let size = reader.read_bits_unchecked(5) as usize;

                    if delta_pos < pos || keys[pos].len() < size {
                        reader.read_cstring()
                    } else {
                        let x = String::new();
                        x + &keys[pos][..size] + &reader.read_cstring()
                    }
                } else {
                    reader.read_cstring()
                };
                keys[delta_pos & 31].clone_from(&key);
                delta_pos += 1;
                key
            });

            let value = reader.read_bool().then(|| {
                let mut is_compressed = false;
                let bit_size = if self.user_data_fixed_size {
                    self.user_data_size as u32
                } else {
                    if (self.flags & 0x1) != 0 {
                        is_compressed = reader.read_bool();
                    }
                    if self.var_int_bit_counts {
                        reader.read_ubit_var() * 8
                    } else {
                        reader.read_bits(17) * 8
                    }
                };

                let value = Rc::new(if is_compressed {
                    let mut decoder = snap::raw::Decoder::new();
                    decoder
                        .decompress_vec(&reader.read_bits_as_bytes(bit_size))
                        .unwrap()
                } else {
                    reader.read_bits_as_bytes(bit_size)
                });

                if self.name == "instancebaseline" {
                    let baseline_key = key
                        .as_deref()
                        .or_else(|| items.get(index as usize).map(|item| item.key.as_str()));
                    if let Some(baseline_key) = baseline_key {
                        baselines.add_baseline(baseline_key.parse().unwrap_or(-1), value.clone());
                    }
                }

                value
            });

            if let Some(x) = items.get_mut(index as usize) {
                if let Some(k) = key {
                    x.key = k;
                }
                x.value = value;
            } else {
                items.push(StringTableRow::new(index, key.unwrap_or_default(), value));
            }

            modified.push(index);
        }

        Ok(modified)
    }
}
