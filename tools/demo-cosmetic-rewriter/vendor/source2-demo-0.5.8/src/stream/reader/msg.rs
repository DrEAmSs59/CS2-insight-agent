use crate::error::ParserError;
#[cfg(feature = "deadlock")]
use crate::proto::{
    CCitadelUserMsgPostMatchDetails, CDemoPacket, CMsgMatchMetaDataContents, CitadelUserMessageIds,
};
use crate::proto::{CDemoFileInfo, EDemoCommands, Message};
use crate::stream::bits::BitsReader;
use crate::stream::msg::{MessageReader, OuterMessage, ReplayInfoReader};
use crate::stream::reader::{SeekableReader, SliceReader};
use std::io::{Read, Seek};

impl MessageReader for SliceReader<'_> {
    #[inline]
    fn read_next_message(&mut self) -> Result<Option<OuterMessage>, ParserError> {
        if self.remaining_bytes() == 0 {
            return Ok(None);
        }

        let cmd = self.read_var_u32() as i32;
        let tick = self.read_var_u32();
        let size = self.read_var_u32();

        let msg_type = EDemoCommands::try_from(cmd & !(EDemoCommands::DemIsCompressed as i32))?;
        let msg_compressed = cmd & EDemoCommands::DemIsCompressed as i32 != 0;

        let buf = if msg_compressed {
            let buf = self.read_bytes(size);
            let mut decoder = snap::raw::Decoder::new();
            decoder.decompress_vec(&buf)?
        } else {
            self.read_bytes(size)
        };

        Ok(Some(OuterMessage {
            msg_type,
            tick,
            buf,
            compressed: msg_compressed,
        }))
    }
}

impl<R: Read + Seek> ReplayInfoReader for SeekableReader<R> {
    fn read_replay_info(&mut self) -> Result<CDemoFileInfo, ParserError> {
        self.seek(8);
        let offset_bytes = self.read_bytes(4);
        let offset = u32::from_le_bytes([
            offset_bytes[0],
            offset_bytes[1],
            offset_bytes[2],
            offset_bytes[3],
        ]) as usize;

        self.seek(offset);

        if let Some(msg) = self.read_next_message()? {
            Ok(CDemoFileInfo::decode(msg.buf.as_slice())?)
        } else {
            Err(ParserError::ReplayEncodingError)
        }
    }

    #[cfg(feature = "deadlock")]
    fn read_deadlock_match_details(&mut self) -> Result<CMsgMatchMetaDataContents, ParserError> {
        self.seek(16);

        while let Some(message) = self.read_next_message()? {
            if message.msg_type != EDemoCommands::DemPacket {
                continue;
            }

            let packet = CDemoPacket::decode(message.buf.as_slice())?;
            let mut packet_reader = SliceReader::new(packet.data());

            while packet_reader.remaining_bytes() != 0 {
                let msg_type = packet_reader.read_ubit_var() as i32;
                let size = packet_reader.read_var_u32();
                let packet_buf = packet_reader.read_bytes(size);

                if msg_type == CitadelUserMessageIds::KEUserMsgPostMatchDetails as i32 {
                    return Ok(CMsgMatchMetaDataContents::decode(
                        CCitadelUserMsgPostMatchDetails::decode(packet_buf.as_slice())?
                            .match_details(),
                    )?);
                }
            }
        }

        Err(ParserError::MatchDetailsNotFound)
    }
}

impl<'a> ReplayInfoReader for SliceReader<'a> {
    fn read_replay_info(&mut self) -> Result<CDemoFileInfo, ParserError> {
        let source_data = self.source_buffer;
        let offset = u32::from_le_bytes(source_data[8..12].try_into().unwrap()) as usize;

        if source_data.len() < offset {
            return Err(ParserError::ReplayEncodingError);
        }

        let mut reader = SliceReader::new(&source_data[offset..]);
        Ok(CDemoFileInfo::decode(
            reader.read_next_message()?.unwrap().buf.as_slice(),
        )?)
    }

    #[cfg(feature = "deadlock")]
    fn read_deadlock_match_details(&mut self) -> Result<CMsgMatchMetaDataContents, ParserError> {
        let source_data = self.source_buffer;
        let mut temp_reader = SliceReader::new(source_data);
        temp_reader.seek(16);
        while let Some(message) = temp_reader.read_next_message()? {
            if message.msg_type != EDemoCommands::DemPacket {
                continue;
            }

            let packet = CDemoPacket::decode(message.buf.as_slice())?;
            let mut packet_reader = SliceReader::new(packet.data());
            while packet_reader.remaining_bytes() != 0 {
                let msg_type = packet_reader.read_ubit_var() as i32;
                let size = packet_reader.read_var_u32();
                let packet_buf = packet_reader.read_bytes(size);

                if msg_type == CitadelUserMessageIds::KEUserMsgPostMatchDetails as i32 {
                    return Ok(CMsgMatchMetaDataContents::decode(
                        CCitadelUserMsgPostMatchDetails::decode(packet_buf.as_slice())?
                            .match_details(),
                    )?);
                }
            }
        }

        Err(ParserError::ReplayEncodingError)
    }
}

impl<R: Read + Seek> MessageReader for SeekableReader<R> {
    #[inline]
    fn read_next_message(&mut self) -> Result<Option<OuterMessage>, ParserError> {
        self.refill();
        if self.remaining_bytes() == 0 {
            return Ok(None);
        }

        let cmd = self.read_var_u32() as i32;
        let tick = self.read_var_u32();
        let size = self.read_var_u32();

        let msg_type = EDemoCommands::try_from(cmd & !(EDemoCommands::DemIsCompressed as i32))?;
        let msg_compressed = cmd & EDemoCommands::DemIsCompressed as i32 != 0;

        let raw_bytes = self.read_bytes(size);

        let buf = if msg_compressed {
            let mut decoder = snap::raw::Decoder::new();
            decoder.decompress_vec(&raw_bytes)?
        } else {
            raw_bytes
        };

        Ok(Some(OuterMessage {
            msg_type,
            tick,
            buf,
            compressed: msg_compressed,
        }))
    }
}
