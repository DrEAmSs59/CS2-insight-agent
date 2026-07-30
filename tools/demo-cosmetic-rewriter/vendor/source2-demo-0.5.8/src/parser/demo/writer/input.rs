use crate::error::ParserError;
use crate::parser::demo::writer::DemoWriter;
use crate::proto::EDemoCommands;
use crate::reader::{BitsReader, MessageReader};
use std::io::{Seek, Write};

pub(crate) struct RawDemoMessage {
    pub(crate) msg_type: EDemoCommands,
    pub(crate) tick: u32,
    pub(crate) raw_payload: Vec<u8>,
    pub(crate) compressed: bool,
}

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    pub(crate) fn read_next_raw_message(&mut self) -> Result<Option<RawDemoMessage>, ParserError> {
        self.parser.reader.refill();
        if self.parser.reader.remaining_bytes() == 0 {
            return Ok(None);
        }

        let cmd = self.parser.reader.read_var_u32() as i32;
        let tick = self.parser.reader.read_var_u32();
        let size = self.parser.reader.read_var_u32();
        let compressed = cmd & EDemoCommands::DemIsCompressed as i32 != 0;
        let msg_type = EDemoCommands::try_from(cmd & !(EDemoCommands::DemIsCompressed as i32))?;
        let raw_payload = self.parser.reader.read_bytes(size);

        Ok(Some(RawDemoMessage {
            msg_type,
            tick,
            raw_payload,
            compressed,
        }))
    }

    pub(crate) fn decode_raw_payload(message: &RawDemoMessage) -> Result<Vec<u8>, ParserError> {
        if message.compressed {
            let mut decoder = snap::raw::Decoder::new();
            Ok(decoder.decompress_vec(message.raw_payload.as_slice())?)
        } else {
            Ok(message.raw_payload.clone())
        }
    }

    pub(crate) fn materialize_payload(
        payload: &mut Option<Vec<u8>>,
        message: &RawDemoMessage,
    ) -> Result<Vec<u8>, ParserError> {
        payload
            .take()
            .map(Ok)
            .unwrap_or_else(|| Self::decode_raw_payload(message))
    }
}
