use super::write_var_u32_to_buf;
use crate::proto::EDemoCommands;
use crate::stream::msg::MessageWriter;
use std::io::{self, Write};

/// Writes a demo command message and returns the number of bytes emitted.
pub fn write_demo_message<W: Write + ?Sized>(
    writer: &mut W,
    msg_type: EDemoCommands,
    tick: u32,
    payload: &[u8],
) -> io::Result<usize> {
    writer.write_message(msg_type, tick, payload)
}

/// Writes a demo command message, optionally Snappy-compressing the payload.
pub fn write_demo_message_with_compression<W: Write + ?Sized>(
    writer: &mut W,
    msg_type: EDemoCommands,
    tick: u32,
    payload: &[u8],
    compressed: bool,
) -> io::Result<usize> {
    writer.write_message_with_compression(msg_type, tick, payload, compressed)
}

impl<W: Write + ?Sized> MessageWriter for W {
    fn write_message(
        &mut self,
        msg_type: EDemoCommands,
        tick: u32,
        payload: &[u8],
    ) -> io::Result<usize> {
        self.write_message_with_compression(msg_type, tick, payload, false)
    }

    fn write_message_with_compression(
        &mut self,
        msg_type: EDemoCommands,
        tick: u32,
        payload: &[u8],
        compressed: bool,
    ) -> io::Result<usize> {
        let compressed_payload;
        let payload = if compressed {
            compressed_payload = snap::raw::Encoder::new()
                .compress_vec(payload)
                .map_err(io::Error::other)?;
            compressed_payload.as_slice()
        } else {
            payload
        };
        let cmd = if compressed {
            msg_type as i32 | EDemoCommands::DemIsCompressed as i32
        } else {
            msg_type as i32
        };
        let mut header = Vec::with_capacity(20);
        write_var_u32_to_buf(&mut header, cmd as u64);
        write_var_u32_to_buf(&mut header, tick as u64);
        write_var_u32_to_buf(&mut header, payload.len() as u64);
        self.write_all(&header)?;
        self.write_all(payload)?;
        Ok(header.len() + payload.len())
    }
}
