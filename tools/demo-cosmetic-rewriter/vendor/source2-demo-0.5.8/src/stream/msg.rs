use crate::error::ParserError;
#[cfg(feature = "deadlock")]
use crate::proto::CMsgMatchMetaDataContents;
use crate::proto::{CDemoFileInfo, EDemoCommands};
use std::io;

#[doc(hidden)]
pub struct OuterMessage {
    pub msg_type: EDemoCommands,
    pub tick: u32,
    pub buf: Vec<u8>,
    pub compressed: bool,
}

#[doc(hidden)]
pub trait MessageReader {
    fn read_next_message(&mut self) -> Result<Option<OuterMessage>, ParserError>;
}

#[doc(hidden)]
pub trait ReplayInfoReader: MessageReader {
    fn read_replay_info(&mut self) -> Result<CDemoFileInfo, ParserError>;
    #[cfg(feature = "deadlock")]
    fn read_deadlock_match_details(&mut self) -> Result<CMsgMatchMetaDataContents, ParserError>;
}

#[doc(hidden)]
pub trait MessageWriter {
    fn write_message(
        &mut self,
        msg_type: EDemoCommands,
        tick: u32,
        payload: &[u8],
    ) -> io::Result<usize>;

    fn write_message_with_compression(
        &mut self,
        msg_type: EDemoCommands,
        tick: u32,
        payload: &[u8],
        compressed: bool,
    ) -> io::Result<usize>;
}
