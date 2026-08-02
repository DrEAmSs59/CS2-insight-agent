//! Error types for the parser.
//!
//! This module defines all error types that can occur during replay parsing.
//! All errors implement the standard [`std::error::Error`] trait using
//! [`thiserror`].
//!
//! # Error Types
//!
//! - [`ParserError`] - Main error type for parsing operations
//! - [`EntityError`] - Errors related to entity operations
//! - [`ClassError`] - Errors related to entity class lookups
//! - [`StringTableError`] - Errors related to string table operations
//! - [`GameEventError`] - Errors related to game event operations
//! - [`FieldValueError`] - Errors related to field value conversions
//!
//! # Examples
//!
//! ## Handling errors
//!
//! ```no_run
//! use source2_demo::error::*;
//! use source2_demo::prelude::*;
//!
//! # fn example(ctx: &Context) {
//! match ctx.entities().get_by_index(0) {
//!     Ok(entity) => println!("Entity: {}", entity.class().name()),
//!     Err(EntityError::IndexNotFound(idx)) => {
//!         println!("No entity at index {}", idx);
//!     }
//!     Err(e) => println!("Other error: {}", e),
//! }
//! # }
//! ```

/// Main error type for parser operations.
///
/// This error type covers all parsing-related errors including protobuf
/// decoding, decompression, and various domain-specific errors.
#[derive(thiserror::Error, Debug)]
pub enum ParserError {
    /// Protobuf decoding error
    #[error(transparent)]
    ProtobufDecode(#[from] crate::proto::prost::DecodeError),

    /// Unknown enum value in protobuf
    #[error(transparent)]
    UnknownEnumValue(#[from] crate::proto::prost::UnknownEnumValue),

    /// Snappy decompression error
    #[error(transparent)]
    SnapDecompress(#[from] snap::Error),

    /// String table related error
    #[error(transparent)]
    StringTable(#[from] StringTableError),

    /// Class lookup error
    #[error(transparent)]
    Class(#[from] ClassError),

    /// Entity related error
    #[error(transparent)]
    Entity(#[from] EntityError),

    /// Field value conversion error
    #[error(transparent)]
    FieldValue(#[from] FieldValueError),

    /// Game event error
    #[error(transparent)]
    GameEvent(#[from] GameEventError),

    /// Observer callback error
    #[error(transparent)]
    ObserverError(#[from] anyhow::Error),

    /// Invalid CDemoFileInfo offset
    #[error("Wrong CDemoFileInfo offset")]
    ReplayEncodingError,

    /// Missing rewrite state for a string table
    #[error("Missing rewrite state for string table {table_id}")]
    MissingStringTableRewriteState {
        /// String table id that lacked rewrite state.
        table_id: usize,
    },

    /// File is not a valid Source 2 demo
    #[error("Supports only Source 2 replays")]
    WrongMagic,

    /// I/O error occurred during file operations
    #[error("IO error: {0}")]
    IoError(String),

    #[cfg(feature = "dota")]
    /// Combat log parsing error (Dota 2)
    #[error(transparent)]
    CombatLog(#[from] CombatLogError),

    #[cfg(feature = "deadlock")]
    /// Match details not found in Deadlock replay
    #[error("CCitadelUserMsgPostMatchDetails not found")]
    MatchDetailsNotFound,
}

/// Errors related to entity class operations.
#[derive(thiserror::Error, Debug)]
pub enum ClassError {
    /// Class not found for the given ID
    #[error("Class not found for the given id {0}")]
    ClassNotFoundById(i32),

    /// Class not found for the given name
    #[error("Class not found for the given name {0}")]
    ClassNotFoundByName(String),
}

/// Errors related to entity operations.
#[derive(thiserror::Error, Debug)]
pub enum EntityError {
    /// No entity exists at the specified index
    #[error("No entities found at index {0}")]
    IndexNotFound(usize),

    /// No entity exists with the specified handle
    #[error("No entities found for handle {0}")]
    HandleNotFound(usize),

    /// No entity exists with the specified class ID
    #[error("No entities found for class with id {0}")]
    ClassIdNotFound(i32),

    /// No entity exists with the specified class name
    #[error("No entities found for class with name {0}")]
    ClassNameNotFound(String),

    /// Property not found on the entity
    #[error("No property found for name {0} (Class: {1}, FieldPath: {2})")]
    PropertyNameNotFound(String, String, String),

    /// Field path not found in serializer
    #[error(transparent)]
    FieldPathNotFound(#[from] SerializerError),
}

/// Errors related to field value conversions.
#[derive(thiserror::Error, Debug)]
pub enum FieldValueError {
    /// Failed to convert field value to target type
    #[error("Cannot convert {0} into {1}")]
    ConversionError(String, String),
}

/// Errors related to game event operations.
#[derive(thiserror::Error, Debug)]
pub enum GameEventError {
    /// Unknown key in game event
    #[error("Unknown key: {0}")]
    UnknownKey(String),
    /// Failed to convert event value to target type
    #[error("Conversion error: {0} -> {1}")]
    ConversionError(String, String),
}

/// Errors related to serializer operations.
#[derive(thiserror::Error, Debug)]
pub enum SerializerError {
    /// No field path found for property name
    #[error("No field path for given name {0}")]
    NoFieldPath(String),
}

/// Errors related to string table operations.
#[derive(thiserror::Error, Debug)]
pub enum StringTableError {
    /// String table not found with the given ID
    #[error("String table not found for the given id {0}")]
    TableNotFoundById(i32),

    /// String table not found with the given name
    #[error("String table not found for the given name {0}")]
    TableNotFoundByName(String),

    /// String table row not found at the given index
    #[error("String table entry not found for the given index {0} ({1})")]
    RowNotFoundByIndex(i32, String),
}

/// Errors related to combat log operations (Dota 2 only).
#[derive(thiserror::Error, Debug)]
pub enum CombatLogError {
    /// Missing property in combat log entry
    #[error("No {0} for {1}")]
    EmptyProperty(String, String),
    /// Missing name in combat log entry
    #[error("No {0} for {1}")]
    EmptyName(String, String),
}

impl From<std::io::Error> for ParserError {
    fn from(value: std::io::Error) -> Self {
        ParserError::IoError(value.to_string())
    }
}
