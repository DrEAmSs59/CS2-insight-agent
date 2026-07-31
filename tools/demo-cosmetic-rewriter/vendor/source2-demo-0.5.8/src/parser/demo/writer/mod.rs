mod baseline;
mod commands;
mod entity;
mod input;
mod output;
mod packet;
mod packet_state;
mod rewriter;
mod runner;
mod snapshot;
mod string_table;

use crate::entity::field::{FieldPath, FieldValue, Serializer};
use crate::entity::{Entity, EntityEvents};
use crate::error::ParserError;
use crate::parser::Parser;
use crate::reader::{BitsReader, FieldPathCodec, MessageReader, SeekableReader, SliceReader};
use crate::string_table::PackedStringTableState;
use std::cell::RefCell;
use std::io::{Seek, Write};
use std::rc::Rc;

pub(crate) use input::RawDemoMessage;
pub use rewriter::{
    rewrite_protobuf_message, DemoRewriter, MessageRewrite, PacketMessage, RewriteInterests,
};
pub use snapshot::materialize_full_packet_entities;

const INSTANCE_BASELINE_TABLE: &str = "instancebaseline";
const ENTITY_REWRITE_BUFFER_CAPACITY: usize = 8192;

struct FieldReplacement {
    serializer: Rc<Serializer>,
    fp: FieldPath,
    value: FieldValue,
    value_start: usize,
    value_end: usize,
}

struct DecodedEntityField {
    fp: FieldPath,
    name: Rc<str>,
    value_start: usize,
    value_end: usize,
}

struct EntityFieldInjection {
    serializer: Rc<Serializer>,
    from_fp: FieldPath,
    original_fields: Vec<OriginalEntityField>,
    fields: Vec<(FieldPath, FieldValue)>,
    finish_start: usize,
    values_end: usize,
}

struct OriginalEntityField {
    fp: FieldPath,
    value_start: usize,
    value_end: usize,
    replacement: Option<FieldValue>,
}

struct EntityRewriteState {
    field_path_codec: FieldPathCodec,
    rewrite_paths: Vec<FieldPath>,
    decoded_fields: Vec<DecodedEntityField>,
    replacements: Vec<FieldReplacement>,
    injections: Vec<EntityFieldInjection>,
}

impl EntityRewriteState {
    fn new() -> Self {
        Self {
            field_path_codec: FieldPathCodec::default(),
            rewrite_paths: Vec::with_capacity(ENTITY_REWRITE_BUFFER_CAPACITY),
            decoded_fields: Vec::with_capacity(ENTITY_REWRITE_BUFFER_CAPACITY),
            replacements: Vec::with_capacity(ENTITY_REWRITE_BUFFER_CAPACITY),
            injections: Vec::new(),
        }
    }
}

#[derive(Default)]
struct StringTableRewriteState {
    tables: Vec<Option<PackedStringTableState>>,
}

impl StringTableRewriteState {
    fn len(&self) -> usize {
        self.tables.len()
    }

    fn ensure(&mut self, table_id: usize) {
        if self.tables.len() <= table_id {
            self.tables.resize_with(table_id + 1, || None);
        }
    }

    fn set(&mut self, table_id: usize, state: PackedStringTableState) {
        self.tables[table_id] = Some(state);
    }

    fn is_missing(&self, table_id: usize) -> bool {
        self.tables[table_id].is_none()
    }

    fn take(&mut self, table_id: usize) -> Option<PackedStringTableState> {
        self.tables[table_id].take()
    }
}

/// Demo writer that reads demo messages and writes a rewritten stream.
///
/// The writer maintains the parser metadata needed for the registered
/// rewrites, such as serializers, classes, string tables, baselines, and
/// entity state. Output targets must be seekable so the demo header can be
/// patched after writing.
pub struct DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    parser: Parser<'a, R>,
    writer: W,
    string_table_rewrite: StringTableRewriteState,
    rewriters: Vec<Box<dyn DemoRewriter + 'a>>,
    rewriter_interests: RewriteInterests,
    entity_rewrite: EntityRewriteState,
    bytes_written: u64,
    file_info_offset: Option<u64>,
    spawn_groups_offset: Option<u64>,
}

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    /// Creates a new demo writer from an existing parser and output target.
    pub fn new(parser: Parser<'a, R>, writer: W) -> Self {
        Self {
            parser,
            writer,
            string_table_rewrite: StringTableRewriteState::default(),
            rewriters: Vec::new(),
            rewriter_interests: RewriteInterests::empty(),
            entity_rewrite: EntityRewriteState::new(),
            bytes_written: 0,
            file_info_offset: None,
            spawn_groups_offset: None,
        }
    }

    /// Adds an already constructed demo rewriter and returns a handle to it.
    ///
    /// Use this when the rewriter needs custom constructor state. Rewriters run
    /// in registration order; message callbacks see the output of earlier
    /// rewriters.
    pub fn add_rewriter<T>(&mut self, rewriter: T) -> Rc<RefCell<T>>
    where
        T: DemoRewriter + 'a,
    {
        let rewriter = Rc::new(RefCell::new(rewriter));
        self.rewriter_interests |= rewriter.borrow().interests();
        self.rewriters.push(Box::new(rewriter.clone()));
        rewriter
    }

    /// Registers a default demo rewriter and returns a handle to it.
    ///
    /// This mirrors
    /// [`Parser::register_observer`](crate::Parser::register_observer): the
    /// writer constructs `T::default()`, registers it, and returns an
    /// `Rc<RefCell<T>>` so callers can inspect accumulated state after
    /// writing.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// # use source2_demo::prelude::*;
    /// # use source2_demo::proto::CDotaUserMsgChatMessage;
    /// # use source2_demo::writer::*;
    /// # use std::fs::File;
    /// #[derive(Default)]
    /// struct RemoveChat;
    ///
    /// #[rewriter]
    /// impl RemoveChat {
    ///     #[rewrite_packet_message]
    ///     fn remove_chat(
    ///         &mut self,
    ///         _message: CDotaUserMsgChatMessage,
    ///     ) -> Result<MessageRewrite, ParserError> {
    ///         Ok(MessageRewrite::Drop)
    ///     }
    /// }
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// # let input = File::open("input.dem")?;
    /// # let output = File::create("output.dem")?;
    /// let mut writer = DemoWriter::from_reader(input, output)?;
    /// writer.register_rewriter::<RemoveChat>();
    /// writer.run()?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn register_rewriter<T>(&mut self) -> Rc<RefCell<T>>
    where
        T: DemoRewriter + Default + 'a,
    {
        self.add_rewriter(T::default())
    }

    fn should_rewrite_entity(&mut self, event: EntityEvents, entity: &Entity) -> bool {
        if !self.rewrites_entity_fields() {
            return false;
        }
        let ctx = &self.parser.context;
        self.rewriters
            .iter_mut()
            .filter(|rewriter| {
                rewriter
                    .interests()
                    .contains(RewriteInterests::ENTITY_FIELDS)
            })
            .all(|rewriter| rewriter.should_rewrite_entity(ctx, event, entity))
    }

    fn should_track_entity(&mut self, event: EntityEvents, entity: &Entity) -> bool {
        let ctx = &self.parser.context;
        self.rewriters
            .iter_mut()
            .filter(|rewriter| {
                rewriter
                    .interests()
                    .contains(RewriteInterests::ENTITY_FIELDS)
            })
            .all(|rewriter| rewriter.should_track_entity(ctx, event, entity))
    }

    fn replace_entity_field(
        &mut self,
        event: EntityEvents,
        entity: &Entity,
        field_name: &str,
        value: &FieldValue,
    ) -> Option<FieldValue> {
        let ctx = &self.parser.context;
        self.rewriters
            .iter_mut()
            .filter(|rewriter| {
                rewriter
                    .interests()
                    .contains(RewriteInterests::ENTITY_FIELDS)
            })
            .find_map(|rewriter| {
                rewriter.replace_entity_field(ctx, event, entity, field_name, value)
            })
    }

    fn append_entity_fields(
        &mut self,
        event: EntityEvents,
        entity: &Entity,
    ) -> Vec<(String, FieldValue)> {
        let ctx = &self.parser.context;
        self.rewriters
            .iter_mut()
            .filter(|rewriter| {
                rewriter
                    .interests()
                    .contains(RewriteInterests::ENTITY_FIELDS)
            })
            .flat_map(|rewriter| rewriter.append_entity_fields(ctx, event, entity))
            .collect()
    }

    fn has_rewriters(&self, interests: RewriteInterests) -> bool {
        self.rewriter_interests.intersects(interests)
    }

    fn rewrites_entity_fields(&self) -> bool {
        self.has_rewriters(RewriteInterests::ENTITY_FIELDS)
    }

    fn tracks_entity_state(&self) -> bool {
        self.rewrites_entity_fields()
            || self.has_rewriters(RewriteInterests::PACKET_ENTITIES_POST_STATE)
    }

    fn rewrites_string_table_entries(&self) -> bool {
        self.has_rewriters(RewriteInterests::STRING_TABLE_ENTRIES)
    }

    fn needs_string_table_context(&self) -> bool {
        self.tracks_entity_state() || self.rewrites_string_table_entries()
    }

    fn needs_packet_scan(&self) -> bool {
        self.has_rewriters(RewriteInterests::PACKET_MESSAGE | RewriteInterests::PACKET_MESSAGES)
            || self.rewrites_entity_fields()
            || self.rewrites_string_table_entries()
            || self.has_rewriters(
                RewriteInterests::SVC_CREATE_STRING_TABLE
                    | RewriteInterests::SVC_UPDATE_STRING_TABLE,
            )
    }

    fn needs_svc_packet_scan(&self) -> bool {
        self.needs_string_table_context()
            || self.has_rewriters(
                RewriteInterests::SVC_CREATE_STRING_TABLE
                    | RewriteInterests::SVC_UPDATE_STRING_TABLE,
            )
    }

    fn needs_packet_state(&self) -> bool {
        self.needs_string_table_context()
    }

    fn needs_class_metadata(&self) -> bool {
        self.tracks_entity_state()
    }

    fn needs_demo_string_table_scan(&self) -> bool {
        self.needs_string_table_context()
            || self.has_rewriters(RewriteInterests::DEMO_STRING_TABLES)
    }

    fn needs_demo_string_table_state(&self) -> bool {
        self.rewrites_string_table_entries()
    }

    /// Returns the wrapped parser and output target.
    pub fn into_parts(self) -> (Parser<'a, R>, W) {
        (self.parser, self.writer)
    }
}

impl<'a, W> DemoWriter<'a, SliceReader<'a>, W>
where
    W: Write + Seek,
{
    /// Creates a demo writer from replay bytes and an output target.
    ///
    /// This is a convenience wrapper around [`Parser::from_slice`] and
    /// [`DemoWriter::new`].
    pub fn from_slice(replay: &'a [u8], writer: W) -> Result<Self, ParserError> {
        Ok(Self::new(Parser::from_slice(replay)?, writer))
    }
}

impl<S, W> DemoWriter<'static, SeekableReader<S>, W>
where
    S: std::io::Read + std::io::Seek,
    W: Write + Seek,
{
    /// Creates a demo writer from a seekable reader and an output target.
    ///
    /// This is a convenience wrapper around [`Parser::from_reader`] and
    /// [`DemoWriter::new`].
    pub fn from_reader(reader: S, writer: W) -> Result<Self, ParserError> {
        Ok(Self::new(Parser::from_reader(reader)?, writer))
    }
}
