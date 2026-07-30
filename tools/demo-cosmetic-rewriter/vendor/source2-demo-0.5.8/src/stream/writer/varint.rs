/// Appends an unsigned 64-bit varint to a byte buffer.
pub fn write_var_u64_to_buf(buf: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }

        buf.push(byte);

        if value == 0 {
            return;
        }
    }
}

/// Encodes an unsigned 64-bit varint into a new byte vector.
pub fn write_var_u64_to_vec(value: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(10);
    write_var_u64_to_buf(&mut out, value);
    out
}

/// Appends an unsigned varint used for 32-bit demo fields to a byte buffer.
pub fn write_var_u32_to_buf(buf: &mut Vec<u8>, value: u64) {
    write_var_u64_to_buf(buf, value);
}

/// Encodes an unsigned varint used for 32-bit demo fields into a new byte
/// vector.
pub fn write_var_u32_to_vec(value: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(10);
    write_var_u32_to_buf(&mut out, value);
    out
}
