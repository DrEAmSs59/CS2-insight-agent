use crate::error::ParserError;
use crate::reader::SliceReader;
use crate::writer::{BitsWriter, BitstreamWriter};
use bitter::BitReader;

pub(crate) fn bit_position(reader: &SliceReader<'_>) -> usize {
    let current_bits = (reader.source_buffer.len() - reader.source_offset) * 8;
    let remaining_bits = reader.bit_reader.bits_remaining().unwrap_or_default();
    reader.source_offset * 8 + current_bits.saturating_sub(remaining_bits)
}

pub(crate) fn copy_original_bits(
    source: &[u8],
    start_bit: usize,
    bit_len: usize,
    writer: &mut BitstreamWriter<'_>,
) -> Result<(), ParserError> {
    let end_bit = start_bit + bit_len;
    let aligned_start = ((start_bit + 7) & !7).min(end_bit);
    for bit_index in start_bit..aligned_start {
        let byte = source[bit_index / 8];
        let bit = ((byte >> (bit_index % 8)) & 1) != 0;
        writer.write_bit(bit)?;
    }

    let aligned_end = end_bit & !7;
    let byte_index = aligned_start / 8;
    let end_byte = aligned_end / 8;
    if byte_index < end_byte {
        writer.write_bytes(&source[byte_index..end_byte])?;
    }

    for bit_index in aligned_end.max(aligned_start)..end_bit {
        let byte = source[bit_index / 8];
        let bit = ((byte >> (bit_index % 8)) & 1) != 0;
        writer.write_bit(bit)?;
    }
    Ok(())
}

pub(crate) fn copy_remaining_bits(
    reader: &mut SliceReader<'_>,
    writer: &mut BitstreamWriter<'_>,
) -> Result<(), ParserError> {
    let Some(bits_left) = reader.bit_reader.bits_remaining() else {
        return Ok(());
    };

    for _ in 0..bits_left {
        let bit = reader
            .bit_reader
            .read_bit()
            .ok_or_else(|| ParserError::IoError("unexpected end of entity data".to_string()))?;
        writer.write_bit(bit)?;
    }
    Ok(())
}
