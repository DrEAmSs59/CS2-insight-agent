use crate::error::ParserError;
use crate::parser::demo::writer::packet::PacketDataRewrite;
use crate::parser::demo::writer::{DemoWriter, MessageRewrite, RawDemoMessage, RewriteInterests};
use crate::parser::demo::DemoCommands;
use crate::proto::{
    CDemoClassInfo, CDemoFullPacket, CDemoPacket, CDemoSendTables, CDemoStringTables,
    EDemoCommands, Message,
};
use crate::reader::{BitsReader, MessageReader};
use std::io::{Seek, Write};

pub(crate) enum DemoCommandWrite {
    Written,
    Dropped,
}

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    pub(crate) fn write_demo_command(
        &mut self,
        message: &RawDemoMessage,
        mut payload: Option<Vec<u8>>,
    ) -> Result<DemoCommandWrite, ParserError> {
        match message.msg_type {
            EDemoCommands::DemPacket | EDemoCommands::DemSignonPacket => {
                self.write_dem_packet(message, payload)?;
            }
            EDemoCommands::DemFullPacket => {
                self.write_dem_full_packet(message, payload)?;
            }
            EDemoCommands::DemSendTables if self.needs_class_metadata() => {
                self.write_dem_send_tables(message, &mut payload)?;
            }
            EDemoCommands::DemClassInfo if self.needs_class_metadata() => {
                self.write_dem_class_info(message, &mut payload)?;
            }
            EDemoCommands::DemStringTables => {
                if matches!(
                    self.write_dem_string_tables(message, payload)?,
                    DemoCommandWrite::Dropped
                ) {
                    return Ok(DemoCommandWrite::Dropped);
                }
            }
            _ => {
                self.write_message_or_raw(message, payload.as_deref())?;
            }
        }

        Ok(DemoCommandWrite::Written)
    }

    fn write_dem_packet(
        &mut self,
        message: &RawDemoMessage,
        mut payload: Option<Vec<u8>>,
    ) -> Result<(), ParserError> {
        if !self.needs_packet_scan() {
            self.write_message_or_raw(message, payload.as_deref())?;
            return Ok(());
        }

        let can_write_raw = payload.is_none();
        let payload = Self::materialize_payload(&mut payload, message)?;
        let mut packet = CDemoPacket::decode(payload.as_slice())?;
        let rewritten = self.rewrite_packet_data_if_changed(
            message.tick,
            packet.data(),
            self.needs_packet_state(),
        )?;
        match rewritten {
            PacketDataRewrite::Unchanged if can_write_raw => {
                self.write_raw_demo_message(
                    message.msg_type,
                    message.tick,
                    message.raw_payload.as_slice(),
                    message.compressed,
                )?;
                return Ok(());
            }
            PacketDataRewrite::Unchanged => {}
            PacketDataRewrite::Changed(rewritten) => packet.data = Some(rewritten),
        }

        let packet_bytes = packet.encode_to_vec();
        self.write_demo_message_with_compression(
            message.msg_type,
            message.tick,
            &packet_bytes,
            message.compressed,
        )
    }

    fn write_dem_full_packet(
        &mut self,
        message: &RawDemoMessage,
        mut payload: Option<Vec<u8>>,
    ) -> Result<(), ParserError> {
        if !self.needs_packet_scan() && !self.needs_demo_string_table_scan() {
            self.write_message_or_raw(message, payload.as_deref())?;
            return Ok(());
        }

        let can_write_raw = payload.is_none();
        let payload = Self::materialize_payload(&mut payload, message)?;
        let mut full = CDemoFullPacket::decode(payload.as_slice())?;
        let should_process =
            self.parser.context.last_full_packet_tick == u32::MAX || self.parser.skip_deltas;
        let mut changed = false;

        if let Some(table) = full.string_table.take() {
            if self.needs_demo_string_table_scan() {
                if let Some((rewritten, table_changed)) =
                    self.rewrite_string_tables(message.tick, table)?
                {
                    if should_process && self.needs_demo_string_table_state() {
                        self.parser.dem_string_tables(rewritten.clone())?;
                    }
                    full.string_table = Some(rewritten);
                    changed |= table_changed;
                } else {
                    changed = true;
                }
            } else {
                full.string_table = Some(table);
            }
        }

        if let Some(packet) = full.packet.as_mut() {
            if self.needs_packet_scan() {
                let rewritten = self.rewrite_packet_data_if_changed(
                    message.tick,
                    packet.data(),
                    should_process && self.needs_packet_state(),
                )?;
                if let PacketDataRewrite::Changed(rewritten) = rewritten {
                    packet.data = Some(rewritten);
                    changed = true;
                }
            }
        }

        self.parser.context.last_full_packet_tick = message.tick;
        if can_write_raw && !changed {
            self.write_raw_demo_message(
                message.msg_type,
                message.tick,
                message.raw_payload.as_slice(),
                message.compressed,
            )?;
            return Ok(());
        }

        let full_bytes = full.encode_to_vec();
        self.write_demo_message_with_compression(
            message.msg_type,
            message.tick,
            &full_bytes,
            message.compressed,
        )
    }

    fn write_dem_send_tables(
        &mut self,
        message: &RawDemoMessage,
        payload: &mut Option<Vec<u8>>,
    ) -> Result<(), ParserError> {
        let can_write_raw = payload.is_none();
        let payload = Self::materialize_payload(payload, message)?;
        let msg = CDemoSendTables::decode(payload.as_slice())?;
        self.parser.dem_send_tables(msg)?;
        if can_write_raw {
            return self.write_raw_demo_message(
                message.msg_type,
                message.tick,
                message.raw_payload.as_slice(),
                message.compressed,
            );
        }
        self.write_demo_message_with_compression(
            message.msg_type,
            message.tick,
            &payload,
            message.compressed,
        )
    }

    fn write_dem_class_info(
        &mut self,
        message: &RawDemoMessage,
        payload: &mut Option<Vec<u8>>,
    ) -> Result<(), ParserError> {
        let can_write_raw = payload.is_none();
        let payload = Self::materialize_payload(payload, message)?;
        let msg = CDemoClassInfo::decode(payload.as_slice())?;
        self.parser.dem_class_info(msg)?;
        if can_write_raw {
            return self.write_raw_demo_message(
                message.msg_type,
                message.tick,
                message.raw_payload.as_slice(),
                message.compressed,
            );
        }
        self.write_demo_message_with_compression(
            message.msg_type,
            message.tick,
            &payload,
            message.compressed,
        )
    }

    fn write_dem_string_tables(
        &mut self,
        message: &RawDemoMessage,
        mut payload: Option<Vec<u8>>,
    ) -> Result<DemoCommandWrite, ParserError> {
        if !self.needs_demo_string_table_scan() {
            self.write_message_or_raw(message, payload.as_deref())?;
            return Ok(DemoCommandWrite::Written);
        }

        let can_write_raw = payload.is_none();
        let payload = Self::materialize_payload(&mut payload, message)?;
        let mut msg = CDemoStringTables::decode(payload.as_slice())?;
        let mut changed = false;
        if self.rewrites_entity_fields() {
            changed |= self.rewrite_instance_baselines(&mut msg)?;
        }
        changed |= self.rewrite_demo_string_table_entries(message.tick, &mut msg)?;
        let mut out_payload: Option<Vec<u8>> = None;
        let ctx = &self.parser.context;
        for rewriter in self.rewriters.iter_mut().filter(|rewriter| {
            rewriter
                .interests()
                .contains(RewriteInterests::DEMO_STRING_TABLES)
        }) {
            match rewriter.rewrite_demo_string_tables(ctx, message.tick, &mut msg)? {
                MessageRewrite::Drop => return Ok(DemoCommandWrite::Dropped),
                MessageRewrite::Keep => {}
                MessageRewrite::Rewrite => {
                    changed = false;
                    out_payload = Some(msg.encode_to_vec());
                }
                MessageRewrite::Replace(bytes) => {
                    msg = CDemoStringTables::decode(bytes.as_slice())?;
                    changed = false;
                    out_payload = Some(bytes);
                }
            }
        }
        let output_payload = match out_payload {
            Some(payload) => Some(payload),
            None if changed => Some(msg.encode_to_vec()),
            None if can_write_raw => None,
            None => Some(payload),
        };
        if self.needs_demo_string_table_state() {
            self.parser.dem_string_tables(msg)?;
        }
        if let Some(payload) = output_payload {
            self.write_demo_message_with_compression(
                message.msg_type,
                message.tick,
                &payload,
                message.compressed,
            )?;
        } else {
            self.write_raw_demo_message(
                message.msg_type,
                message.tick,
                message.raw_payload.as_slice(),
                message.compressed,
            )?;
        }
        Ok(DemoCommandWrite::Written)
    }
}
