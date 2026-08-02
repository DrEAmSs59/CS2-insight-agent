use crate::error::ParserError;
use crate::proto::{CSvcMsgCreateStringTable, CSvcMsgUpdateStringTable};
use crate::reader::{BitsReader, SliceReader};
use crate::writer::{BitsWriter, BitstreamWriter};

/// A mutable string table entry update passed to demo rewriters.
#[derive(Clone, Debug)]
pub struct StringTableEntryUpdate {
    index: i32,
    key: Option<String>,
    value: Option<Vec<u8>>,
    value_compressed: bool,
    changed: bool,
}

impl StringTableEntryUpdate {
    pub(crate) fn new(index: i32, key: Option<String>, value: Option<Vec<u8>>) -> Self {
        Self {
            index,
            key,
            value,
            value_compressed: false,
            changed: false,
        }
    }

    pub(crate) fn new_with_compression(
        index: i32,
        key: Option<String>,
        value: Option<Vec<u8>>,
        value_compressed: bool,
    ) -> Self {
        Self {
            index,
            key,
            value,
            value_compressed,
            changed: false,
        }
    }

    pub(crate) fn into_parts(self) -> (i32, Option<String>, Option<Vec<u8>>) {
        (self.index, self.key, self.value)
    }

    /// Returns the entry index in the table.
    pub fn index(&self) -> i32 {
        self.index
    }

    /// Returns the entry key, if this update includes one.
    pub fn key(&self) -> Option<&str> {
        self.key.as_deref()
    }

    /// Replaces the entry key.
    pub fn set_key(&mut self, key: impl Into<String>) {
        self.key = Some(key.into());
        self.changed = true;
    }

    /// Clears the entry key from this update.
    pub fn clear_key(&mut self) {
        self.key = None;
        self.changed = true;
    }

    /// Returns the entry value bytes, if present.
    pub fn value(&self) -> Option<&[u8]> {
        self.value.as_deref()
    }

    /// Returns mutable entry value bytes, if present.
    pub fn value_mut(&mut self) -> Option<&mut Vec<u8>> {
        if self.value.is_some() {
            self.changed = true;
        }
        self.value.as_mut()
    }

    /// Replaces the entry value bytes.
    pub fn set_value(&mut self, value: impl Into<Vec<u8>>) {
        self.value = Some(value.into());
        self.changed = true;
    }

    /// Clears the entry value from this update.
    pub fn clear_value(&mut self) {
        self.value = None;
        self.changed = true;
    }
}

#[derive(Clone, Copy)]
pub(crate) struct PackedStringTableFormat {
    user_data_fixed_size: bool,
    user_data_size: i32,
    flags: u32,
    var_int_bit_counts: bool,
}

impl PackedStringTableFormat {
    pub(crate) fn from_create_message(msg: &CSvcMsgCreateStringTable) -> Self {
        Self {
            user_data_fixed_size: msg.user_data_fixed_size(),
            user_data_size: msg.user_data_size(),
            flags: msg.flags() as u32,
            var_int_bit_counts: msg.using_varint_bitcounts(),
        }
    }

    pub(crate) fn from_table(table: &crate::StringTable) -> Self {
        Self {
            user_data_fixed_size: table.user_data_fixed_size,
            user_data_size: table.user_data_size,
            flags: table.flags,
            var_int_bit_counts: table.var_int_bit_counts,
        }
    }
}

#[derive(Clone)]
pub(crate) struct PackedStringTableState {
    format: PackedStringTableFormat,
    keys: Vec<String>,
}

impl PackedStringTableState {
    pub(crate) fn new(format: PackedStringTableFormat) -> Self {
        Self {
            format,
            keys: vec![String::new(); 32],
        }
    }

    pub(crate) fn from_table(table: &crate::StringTable) -> Self {
        Self {
            format: PackedStringTableFormat::from_table(table),
            keys: table.keys.borrow().clone(),
        }
    }

    pub(crate) fn rewrite<F>(
        &mut self,
        data: &[u8],
        num_entries: i32,
        mut rewrite: F,
    ) -> Result<Option<Vec<u8>>, ParserError>
    where
        F: FnMut(&mut StringTableEntryUpdate) -> Result<(), ParserError>,
    {
        let entries = self.decode_entries(data, num_entries)?;
        let mut changed = false;
        let mut rewritten = Vec::with_capacity(entries.len());

        for mut entry in entries {
            rewrite(&mut entry)?;
            changed |= entry.changed;
            rewritten.push(entry);
        }

        if changed {
            Ok(Some(encode_entries(&rewritten, self.format)?))
        } else {
            Ok(None)
        }
    }

    fn decode_entries(
        &mut self,
        data: &[u8],
        num_entries: i32,
    ) -> Result<Vec<StringTableEntryUpdate>, ParserError> {
        let mut reader = SliceReader::new(data);
        let mut index = -1;
        let mut delta_pos = 0;
        let mut entries = Vec::with_capacity(num_entries.max(0) as usize);

        for _ in 0..num_entries {
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

                    if delta_pos < pos || self.keys[pos].len() < size {
                        reader.read_cstring()
                    } else {
                        self.keys[pos][..size].to_string() + &reader.read_cstring()
                    }
                } else {
                    reader.read_cstring()
                };
                self.keys[delta_pos & 31].clone_from(&key);
                delta_pos += 1;
                key
            });

            let mut value_compressed = false;
            let value = reader.read_bool().then(|| {
                let bit_size = if self.format.user_data_fixed_size {
                    self.format.user_data_size as u32
                } else {
                    if (self.format.flags & 0x1) != 0 {
                        value_compressed = reader.read_bool();
                    }
                    if self.format.var_int_bit_counts {
                        reader.read_ubit_var() * 8
                    } else {
                        reader.read_bits(17) * 8
                    }
                };

                let bytes = reader.read_bits_as_bytes(bit_size);
                if value_compressed {
                    snap::raw::Decoder::new()
                        .decompress_vec(&bytes)
                        .unwrap_or(bytes)
                } else {
                    bytes
                }
            });

            entries.push(StringTableEntryUpdate::new_with_compression(
                index,
                key,
                value,
                value_compressed,
            ));
        }

        Ok(entries)
    }
}

pub(crate) fn rewrite_create_string_table<F>(
    msg: &mut CSvcMsgCreateStringTable,
    state: &mut PackedStringTableState,
    rewrite: F,
) -> Result<bool, ParserError>
where
    F: FnMut(&mut StringTableEntryUpdate) -> Result<(), ParserError>,
{
    let data = if msg.data_compressed() {
        snap::raw::Decoder::new().decompress_vec(msg.string_data())?
    } else {
        msg.string_data().to_vec()
    };

    let Some(rewritten) = state.rewrite(&data, msg.num_entries(), rewrite)? else {
        return Ok(false);
    };

    msg.uncompressed_size = Some(rewritten.len() as i32);
    if msg.data_compressed() {
        msg.string_data = Some(snap::raw::Encoder::new().compress_vec(&rewritten)?);
        msg.data_compressed = Some(true);
    } else {
        msg.string_data = Some(rewritten);
    }
    Ok(true)
}

pub(crate) fn rewrite_update_string_table<F>(
    msg: &mut CSvcMsgUpdateStringTable,
    state: &mut PackedStringTableState,
    rewrite: F,
) -> Result<bool, ParserError>
where
    F: FnMut(&mut StringTableEntryUpdate) -> Result<(), ParserError>,
{
    let Some(rewritten) = state.rewrite(msg.string_data(), msg.num_changed_entries(), rewrite)?
    else {
        return Ok(false);
    };

    msg.string_data = Some(rewritten);
    Ok(true)
}

pub(crate) fn rewrite_demo_string_table_items<F>(
    items: &mut [crate::proto::c_demo_string_tables::ItemsT],
    mut rewrite: F,
) -> Result<bool, ParserError>
where
    F: FnMut(&mut StringTableEntryUpdate) -> Result<(), ParserError>,
{
    let mut changed = false;

    for (index, item) in items.iter_mut().enumerate() {
        let mut entry =
            StringTableEntryUpdate::new(index as i32, item.str.clone(), item.data.clone());
        rewrite(&mut entry)?;

        if entry.changed {
            let (_, key, value) = entry.into_parts();
            item.str = key;
            item.data = value;
            changed = true;
        }
    }

    Ok(changed)
}

fn encode_entries(
    entries: &[StringTableEntryUpdate],
    format: PackedStringTableFormat,
) -> Result<Vec<u8>, ParserError> {
    let mut out = Vec::new();
    let mut writer = BitstreamWriter::new(&mut out);
    let mut previous_index = -1;

    for entry in entries {
        if entry.index == previous_index + 1 {
            writer.write_bit(true)?;
        } else {
            writer.write_bit(false)?;
            writer.write_var_u32((entry.index - previous_index - 2) as u32)?;
        }
        previous_index = entry.index;

        if let Some(key) = entry.key.as_deref() {
            writer.write_bit(true)?;
            writer.write_bit(false)?;
            writer.write_cstring(key)?;
        } else {
            writer.write_bit(false)?;
        }

        if let Some(value) = entry.value.as_deref() {
            writer.write_bit(true)?;

            if format.user_data_fixed_size {
                let expected_bytes = (format.user_data_size as usize).div_ceil(8);
                if value.len() != expected_bytes {
                    return Err(ParserError::IoError(format!(
                        "fixed-size string table entry expected {expected_bytes} bytes, got {}",
                        value.len()
                    )));
                }
                writer.write_bits_as_bytes(value, format.user_data_size as u32)?;
            } else {
                let compressed;
                let (value, is_compressed) = if (format.flags & 0x1) != 0 {
                    compressed = snap::raw::Encoder::new().compress_vec(value)?;
                    if compressed.len() < value.len() || entry.value_compressed {
                        (compressed.as_slice(), true)
                    } else {
                        (value, false)
                    }
                } else {
                    (value, false)
                };

                if (format.flags & 0x1) != 0 {
                    writer.write_bit(is_compressed)?;
                }
                if format.var_int_bit_counts {
                    writer.write_ubit_var(value.len() as u32)?;
                } else {
                    writer.write_bits(17, value.len() as u64)?;
                }
                writer.write_bits_as_bytes(value, (value.len() * 8) as u32)?;
            }
        } else {
            writer.write_bit(false)?;
        }
    }

    writer.flush()?;
    drop(writer);
    Ok(out)
}
