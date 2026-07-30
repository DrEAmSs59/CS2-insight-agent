use std::rc::Rc;

/// A row in a string table.
///
/// Each row contains an index, a key (string), and optional binary value data.
///
/// # Examples
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(table: &StringTable) {
/// for row in table.iter() {
///     println!("Key: {}", row.key());
///     if let Some(value) = row.value() {
///         println!("Value size: {} bytes", value.len());
///     }
/// }
/// # }
/// ```
#[derive(Clone, Default)]
pub struct StringTableRow {
    pub(crate) index: i32,
    pub(crate) key: String,
    pub(crate) value: Option<Rc<Vec<u8>>>,
}

impl StringTableRow {
    pub(crate) fn new(index: i32, key: String, value: Option<Rc<Vec<u8>>>) -> Self {
        StringTableRow { index, key, value }
    }

    /// Returns the row's index in the string table.
    pub fn index(&self) -> i32 {
        self.index
    }

    /// Returns the row's key (string identifier).
    pub fn key(&self) -> &str {
        self.key.as_str()
    }

    /// Returns the row's value as a byte slice, if present.
    ///
    /// String table values are stored as binary data. The interpretation
    /// depends on the specific string table and its purpose.
    pub fn value(&self) -> Option<&[u8]> {
        self.value.as_ref().map(|x| x.as_slice())
    }
}
