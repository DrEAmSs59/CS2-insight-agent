use crate::entity::field::FieldValue;
use crate::entity::{Entity, EntityEvents};
use crate::error::ParserError;
use crate::parser::Context;
use crate::proto::{
    CDemoStringTables, CSvcMsgCreateStringTable, CSvcMsgPacketEntities,
    CSvcMsgUpdateStringTable, EDemoCommands, Message,
};
use crate::string_table::StringTableEntryUpdate;
use std::cell::RefCell;
use std::rc::Rc;

bitflags::bitflags! {
    /// Bitflags for declaring rewrite interests.
    ///
    /// Use these flags in [`DemoRewriter::interests`] to specify which rewrite
    /// callbacks your rewriter wants to receive. This lets
    /// [`DemoWriter`](crate::writer::DemoWriter) skip expensive decoding paths no
    /// registered rewriter needs.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub struct RewriteInterests: u32 {
        /// Interest in outer demo command payload rewrites.
        const DEMO_MESSAGE = 1 << 0;
        /// Interest in individual packet message payload rewrites.
        const PACKET_MESSAGE = 1 << 1;
        /// Interest in mutating the packet message list after per-message rewrites.
        const PACKET_MESSAGES = 1 << 2;
        /// Interest in outer `CDemoStringTables` rewrites.
        const DEMO_STRING_TABLES = 1 << 3;
        /// Interest in decoded string table entry updates.
        const STRING_TABLE_ENTRIES = 1 << 4;
        /// Interest in `svc_CreateStringTable` rewrites.
        const SVC_CREATE_STRING_TABLE = 1 << 5;
        /// Interest in `svc_UpdateStringTable` rewrites.
        const SVC_UPDATE_STRING_TABLE = 1 << 6;
        /// Interest in entity field replacement and entity rewrite filtering.
        const ENTITY_FIELDS = 1 << 7;
        /// Interest in mutating `svc_PacketEntities` after its entity delta
        /// has been applied to the writer's tracked state.
        const PACKET_ENTITIES_POST_STATE = 1 << 8;
    }
}

/// Outcome for a message rewrite operation.
pub enum MessageRewrite {
    /// Leave the message unchanged.
    Keep,
    /// Encode the mutated decoded message and replace the payload.
    ///
    /// Use this after changing a decoded protobuf message in place.
    Rewrite,
    /// Replace the message payload with the provided bytes.
    Replace(Vec<u8>),
    /// Drop the message entirely.
    Drop,
}

/// Trait for handling demo rewrites.
///
/// Implement this trait directly for custom behavior, or use the `#[rewriter]`
/// attribute macro to generate it from annotated methods.
#[allow(unused_variables)]
pub trait DemoRewriter {
    /// Declares which rewrite callbacks this rewriter is interested in.
    ///
    /// Return an empty [`RewriteInterests`] to leave the demo unchanged.
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::empty()
    }

    /// Rewrites an outer demo command payload.
    ///
    /// Requires [`RewriteInterests::DEMO_MESSAGE`] to be set. The payload is
    /// passed as bytes; return [`MessageRewrite::Replace`] to emit new bytes.
    fn rewrite_demo_message(
        &mut self,
        ctx: &Context,
        tick: u32,
        msg_type: EDemoCommands,
        payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        Ok(MessageRewrite::Keep)
    }

    /// Rewrites one packet message payload.
    ///
    /// Requires [`RewriteInterests::PACKET_MESSAGE`] to be set. The payload is
    /// passed as bytes; return [`MessageRewrite::Replace`] to emit new bytes.
    fn rewrite_packet_message(
        &mut self,
        ctx: &Context,
        tick: u32,
        msg_type: i32,
        payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        Ok(MessageRewrite::Keep)
    }

    /// Mutates the packet message list after per-message rewrites.
    ///
    /// Requires [`RewriteInterests::PACKET_MESSAGES`] to be set. Messages
    /// inserted here are output-only; they are not processed for writer
    /// metadata state.
    fn rewrite_packet_messages(
        &mut self,
        ctx: &Context,
        tick: u32,
        messages: &mut Vec<PacketMessage>,
    ) -> Result<(), ParserError> {
        Ok(())
    }

    /// Rewrites an outer demo string table message after it has been decoded.
    ///
    /// Requires [`RewriteInterests::DEMO_STRING_TABLES`] to be set.
    fn rewrite_demo_string_tables(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CDemoStringTables,
    ) -> Result<MessageRewrite, ParserError> {
        Ok(MessageRewrite::Keep)
    }

    /// Rewrites one decoded string table entry update.
    ///
    /// Requires [`RewriteInterests::STRING_TABLE_ENTRIES`] to be set.
    fn rewrite_string_table_entry(
        &mut self,
        ctx: &Context,
        tick: u32,
        table_name: &str,
        entry: &mut StringTableEntryUpdate,
    ) -> Result<(), ParserError> {
        Ok(())
    }

    /// Rewrites a decoded `svc_CreateStringTable` message.
    ///
    /// Requires [`RewriteInterests::SVC_CREATE_STRING_TABLE`] to be set.
    fn rewrite_svc_create_string_table(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CSvcMsgCreateStringTable,
    ) -> Result<MessageRewrite, ParserError> {
        Ok(MessageRewrite::Keep)
    }

    /// Rewrites a decoded `svc_UpdateStringTable` message.
    ///
    /// Requires [`RewriteInterests::SVC_UPDATE_STRING_TABLE`] to be set.
    fn rewrite_svc_update_string_table(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CSvcMsgUpdateStringTable,
    ) -> Result<MessageRewrite, ParserError> {
        Ok(MessageRewrite::Keep)
    }

    /// Rewrites a decoded `svc_PacketEntities` message after its entity delta
    /// has been applied to the writer's tracked entity state.
    ///
    /// This callback is intended for diagnostics that must materialize a
    /// complete snapshot from the post-delta state. Returning
    /// [`MessageRewrite::Rewrite`] emits the mutated protobuf message.
    fn rewrite_packet_entities_post_state(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CSvcMsgPacketEntities,
    ) -> Result<MessageRewrite, ParserError> {
        Ok(MessageRewrite::Keep)
    }

    /// Returns a replacement value for a decoded entity field.
    ///
    /// Requires [`RewriteInterests::ENTITY_FIELDS`] to be set. The first
    /// registered rewriter that returns `Some` wins.
    fn replace_entity_field(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
        field_name: &str,
        value: &FieldValue,
    ) -> Option<FieldValue> {
        None
    }

    /// Appends fields that are absent from the current entity delta.
    ///
    /// This hook is intentionally limited to fields already known by the
    /// entity serializer. Appended values are emitted after the original
    /// delta values and become part of the tracked entity state.
    fn append_entity_fields(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> Vec<(String, FieldValue)> {
        Vec::new()
    }

    /// Decides whether an entity should enter the decoded field rewrite path.
    ///
    /// Requires [`RewriteInterests::ENTITY_FIELDS`] to be set. If any
    /// registered rewriter returns `false`, the entity is not field-rewritten.
    fn should_rewrite_entity(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        true
    }

    /// Decides whether decoded state should be retained for an entity.
    ///
    /// Requires [`RewriteInterests::ENTITY_FIELDS`] to be set. Returning
    /// `false` allows the writer to skip decoding fields when the entity also
    /// does not enter the rewrite path.
    fn should_track_entity(&mut self, ctx: &Context, event: EntityEvents, entity: &Entity) -> bool {
        true
    }
}

impl<T> DemoRewriter for Rc<RefCell<T>>
where
    T: DemoRewriter,
{
    fn interests(&self) -> RewriteInterests {
        self.borrow().interests()
    }

    fn rewrite_demo_message(
        &mut self,
        ctx: &Context,
        tick: u32,
        msg_type: EDemoCommands,
        payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        self.borrow_mut()
            .rewrite_demo_message(ctx, tick, msg_type, payload)
    }

    fn rewrite_packet_message(
        &mut self,
        ctx: &Context,
        tick: u32,
        msg_type: i32,
        payload: &[u8],
    ) -> Result<MessageRewrite, ParserError> {
        self.borrow_mut()
            .rewrite_packet_message(ctx, tick, msg_type, payload)
    }

    fn rewrite_packet_messages(
        &mut self,
        ctx: &Context,
        tick: u32,
        messages: &mut Vec<PacketMessage>,
    ) -> Result<(), ParserError> {
        self.borrow_mut()
            .rewrite_packet_messages(ctx, tick, messages)
    }

    fn rewrite_demo_string_tables(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CDemoStringTables,
    ) -> Result<MessageRewrite, ParserError> {
        self.borrow_mut()
            .rewrite_demo_string_tables(ctx, tick, message)
    }

    fn rewrite_string_table_entry(
        &mut self,
        ctx: &Context,
        tick: u32,
        table_name: &str,
        entry: &mut StringTableEntryUpdate,
    ) -> Result<(), ParserError> {
        self.borrow_mut()
            .rewrite_string_table_entry(ctx, tick, table_name, entry)
    }

    fn rewrite_svc_create_string_table(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CSvcMsgCreateStringTable,
    ) -> Result<MessageRewrite, ParserError> {
        self.borrow_mut()
            .rewrite_svc_create_string_table(ctx, tick, message)
    }

    fn rewrite_svc_update_string_table(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CSvcMsgUpdateStringTable,
    ) -> Result<MessageRewrite, ParserError> {
        self.borrow_mut()
            .rewrite_svc_update_string_table(ctx, tick, message)
    }

    fn rewrite_packet_entities_post_state(
        &mut self,
        ctx: &Context,
        tick: u32,
        message: &mut CSvcMsgPacketEntities,
    ) -> Result<MessageRewrite, ParserError> {
        self.borrow_mut()
            .rewrite_packet_entities_post_state(ctx, tick, message)
    }

    fn replace_entity_field(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
        field_name: &str,
        value: &FieldValue,
    ) -> Option<FieldValue> {
        self.borrow_mut()
            .replace_entity_field(ctx, event, entity, field_name, value)
    }

    fn append_entity_fields(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> Vec<(String, FieldValue)> {
        self.borrow_mut().append_entity_fields(ctx, event, entity)
    }

    fn should_rewrite_entity(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        self.borrow_mut().should_rewrite_entity(ctx, event, entity)
    }

    fn should_track_entity(&mut self, ctx: &Context, event: EntityEvents, entity: &Entity) -> bool {
        self.borrow_mut().should_track_entity(ctx, event, entity)
    }
}

/// Rewrites a prost message by decoding, mutating, and re-encoding it.
pub fn rewrite_protobuf_message<M, F>(
    msg: &[u8],
    mut rewrite: F,
) -> Result<MessageRewrite, ParserError>
where
    M: Message + Default,
    F: FnMut(&mut M) -> Result<MessageRewrite, ParserError>,
{
    let mut decoded = M::decode(msg)?;
    match rewrite(&mut decoded)? {
        MessageRewrite::Keep => Ok(MessageRewrite::Keep),
        MessageRewrite::Drop => Ok(MessageRewrite::Drop),
        MessageRewrite::Replace(bytes) => Ok(MessageRewrite::Replace(bytes)),
        MessageRewrite::Rewrite => Ok(MessageRewrite::Replace(decoded.encode_to_vec())),
    }
}

/// Packet message passed to packet-list rewriters.
#[derive(Clone, Debug)]
pub struct PacketMessage {
    /// Inner packet message type.
    pub msg_type: i32,
    /// Encoded inner packet message payload.
    pub payload: Vec<u8>,
}

impl PacketMessage {
    /// Creates a packet message from a message type and encoded payload.
    pub fn new(msg_type: i32, payload: impl Into<Vec<u8>>) -> Self {
        Self {
            msg_type,
            payload: payload.into(),
        }
    }

    /// Creates a packet message by encoding a protobuf payload.
    pub fn encoded<M>(msg_type: i32, message: &M) -> Self
    where
        M: Message,
    {
        Self::new(msg_type, message.encode_to_vec())
    }

    /// Decodes the packet message payload as a protobuf message.
    pub fn decode<M>(&self) -> Result<M, ParserError>
    where
        M: Message + Default,
    {
        Ok(M::decode(self.payload.as_slice())?)
    }

    /// Replaces the packet message payload with an encoded protobuf message.
    pub fn replace_with<M>(&mut self, message: &M)
    where
        M: Message,
    {
        self.payload = message.encode_to_vec();
    }
}
