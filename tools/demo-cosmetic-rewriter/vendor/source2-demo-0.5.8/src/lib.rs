#![doc = include_str!("../README.md")]
#![warn(missing_docs)]
#![allow(clippy::too_many_arguments)]

#[cfg(test)]
extern crate self as source2_demo;

mod display;
mod entity;
pub mod error;
mod event;
mod macros;
mod parser;
mod stream;
mod string_table;

#[cfg(test)]
mod tests;

/// Reader types used by advanced parser integrations.
///
/// Most applications should construct parsers with [`Parser::from_slice`] or
/// [`Parser::from_reader`]. These re-exports are primarily for wrappers that
/// need to store a concrete parser type.
pub mod reader {
    pub(crate) use crate::stream::reader::{
        BitsReader, FieldPathCodec, FieldReader, MessageReader, ReplayInfoReader,
    };
    pub use crate::stream::reader::{SeekableReader, SliceReader};
}

/// Demo rewriting APIs and lower-level bitstream writer utilities.
///
/// This module is the preferred import path for writing or rewriting demo
/// files. It includes [`DemoWriter`](crate::writer::DemoWriter),
/// [`DemoRewriter`](crate::writer::DemoRewriter), packet message helpers, and
/// the bitstream writer utilities used by advanced rewrites.
pub mod writer {
    pub use crate::error::ParserError;
    pub use crate::parser::{
        rewrite_protobuf_message, DemoRewriter, DemoWriter, MessageRewrite, PacketMessage,
        RewriteInterests,
    };
    pub use crate::stream::writer::{
        write_demo_message, write_demo_message_with_compression, write_var_u32_to_buf,
        write_var_u32_to_vec, write_var_u64_to_buf, write_var_u64_to_vec, BitsWriter,
        BitstreamWriter, MessageWriter,
    };
    pub use crate::string_table::StringTableEntryUpdate;
    pub use source2_demo_macros::{
        replace_entity_field, rewrite_demo_message, rewrite_demo_string_tables, rewrite_field,
        rewrite_packet_message, rewrite_packet_messages, rewrite_string_table_entry,
        rewrite_svc_create_string_table, rewrite_svc_update_string_table, rewriter,
        should_rewrite_entity, should_track_entity,
    };
}

/// Protocol buffer definitions for Source 2 games.
///
/// This module re-exports all protobuf message types used by the parser.
/// The available messages depend on which game feature is enabled.
///
/// # Examples
///
/// ```no_run
/// use source2_demo::proto::*;
///
/// // Decode a protobuf message
/// # let bytes: &[u8] = &[];
/// let msg = CDemoFileInfo::decode(bytes)?;
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
pub mod proto {
    pub use source2_demo_protobufs::prost::Message;
    pub use source2_demo_protobufs::*;
}

/// Prelude module for convenient reading/parsing imports.
///
/// Import this module to get access to all commonly used types and traits:
///
/// ```
/// use source2_demo::prelude::*;
/// ```
///
/// This includes:
/// - Core types: [`Parser`], [`Context`], [`Entity`], [`Observer`]
/// - Traits and macros: [`observer`], [`on_message`], [`property!`]
/// - Protobuf enums: Message type enumerations for each game
///
/// Demo writing APIs are intentionally not included. Import them from
/// [`crate::writer`] instead.
pub mod prelude {
    pub use crate::entity::field::FieldValue;
    pub use crate::entity::{Entity, EntityEvents, EntityField};
    pub use crate::error::ParserError;
    pub use crate::event::{EventValue, GameEvent, GameEventList};
    pub use crate::parser::{Context, DemoRunner, Interests, Observer, ObserverResult, Parser};
    pub use crate::string_table::{StringTable, StringTableRow, StringTables};
    pub use crate::{property, try_property};

    pub use source2_demo_macros::*;

    pub use source2_demo_protobufs::prost::Message;
    pub use source2_demo_protobufs::EBaseGameEvents;
    pub use source2_demo_protobufs::EBaseUserMessages;
    pub use source2_demo_protobufs::EDemoCommands;
    pub use source2_demo_protobufs::NetMessages;
    pub use source2_demo_protobufs::SvcMessages;

    #[cfg(feature = "dota")]
    pub use crate::event::CombatLogEntry;
    #[cfg(feature = "dota")]
    pub use crate::proto::EDotaUserMessages;

    #[cfg(feature = "deadlock")]
    pub use crate::proto::CitadelUserMessageIds;
    #[cfg(feature = "deadlock")]
    pub use crate::proto::ECitadelGameEvents;

    #[cfg(feature = "cs2")]
    pub use crate::proto::ECsgoGameEvents;
    #[cfg(feature = "cs2")]
    pub use crate::proto::ECstrike15UserMessages;
}

// Re-export commonly used types at the crate root
pub use crate::entity::field::{FieldRewriteResult, FieldValue, IntoFieldValue};
pub use crate::entity::*;
pub use crate::event::*;
pub use crate::parser::{Context, DemoRunner, Interests, Observer, ObserverResult, Parser};
pub use crate::string_table::{StringTable, StringTableRow, StringTables};
pub use source2_demo_macros::*;

/// Fast hash map using FxHash algorithm.
///
/// This type alias is used throughout the crate for better performance
/// compared to the standard library's `HashMap`.
pub type HashMap<K, V> = hashbrown::HashMap<K, V, rustc_hash::FxBuildHasher>;

/// Fast hash set using FxHash algorithm.
///
/// This type alias is used throughout the crate for better performance
/// compared to the standard library's `HashSet`.
pub type HashSet<T> = hashbrown::HashSet<T, rustc_hash::FxBuildHasher>;

#[cfg(feature = "dota")]
pub use crate::event::CombatLogEntry;

#[cfg(feature = "mimalloc")]
use mimalloc::MiMalloc;
#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;
