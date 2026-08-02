use crate::error::ParserError;
use crate::parser::demo::writer::{DemoWriter, MessageRewrite, PacketMessage, RewriteInterests};
use crate::proto::{CSvcMsgCreateStringTable, CSvcMsgUpdateStringTable, Message, SvcMessages};
use crate::reader::{BitsReader, MessageReader, SliceReader};
use crate::stream::copy::{bit_position, copy_original_bits};
use crate::writer::{BitsWriter, BitstreamWriter};
use std::io::{Seek, Write};

pub(crate) enum PacketDataRewrite {
    Unchanged,
    Changed(Vec<u8>),
}

enum PacketDataPart {
    Original { start_bit: usize, bit_len: usize },
    Changed(PacketMessage),
}

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    #[cfg(test)]
    pub(crate) fn rewrite_packet_data(
        &mut self,
        tick: u32,
        data: &[u8],
        process_state: bool,
    ) -> Result<Vec<u8>, ParserError> {
        match self.rewrite_packet_data_if_changed(tick, data, process_state)? {
            PacketDataRewrite::Unchanged => Ok(data.to_vec()),
            PacketDataRewrite::Changed(data) => Ok(data),
        }
    }

    pub(crate) fn rewrite_packet_data_if_changed(
        &mut self,
        tick: u32,
        data: &[u8],
        process_state: bool,
    ) -> Result<PacketDataRewrite, ParserError> {
        let mut reader = SliceReader::new(data);
        let retain_messages = self.has_rewriters(RewriteInterests::PACKET_MESSAGES);
        let mut messages = Vec::new();
        let mut parts = Vec::new();
        let mut scratch = Vec::new();
        let mut changed = false;

        'messages: while reader.remaining_bytes() != 0 {
            let message_start = bit_position(&reader);
            let msg_type = reader.read_ubit_var() as i32;
            let size = reader.read_var_u32();
            let msg_buf = if retain_messages {
                reader.read_bytes(size)
            } else {
                reader.read_bytes_into(size, &mut scratch);
                std::mem::take(&mut scratch)
            };
            let message_end = bit_position(&reader);

            let mut msg_payload = msg_buf;
            let mut payload_changed = false;
            let ctx = &self.parser.context;
            for rewriter in self.rewriters.iter_mut().filter(|rewriter| {
                rewriter
                    .interests()
                    .contains(RewriteInterests::PACKET_MESSAGE)
            }) {
                match rewriter.rewrite_packet_message(
                    ctx,
                    tick,
                    msg_type,
                    msg_payload.as_slice(),
                )? {
                    MessageRewrite::Drop => {
                        changed = true;
                        continue 'messages;
                    }
                    MessageRewrite::Replace(bytes) => {
                        changed = true;
                        payload_changed = true;
                        msg_payload = bytes;
                    }
                    MessageRewrite::Keep | MessageRewrite::Rewrite => {}
                }
            }

            let mut handled_entity = false;
            let mut processed_state = false;
            if self.needs_svc_packet_scan() {
                let needs_string_table_context = self.needs_string_table_context();
                let update_string_table_state = process_state && needs_string_table_context;

                if let Ok(svc_msg) = SvcMessages::try_from(msg_type) {
                    match svc_msg {
                        SvcMessages::SvcPacketEntities if self.tracks_entity_state() => {
                            if let Some(rewritten) =
                                self.rewrite_svc_packet_entities(tick, msg_payload.as_slice())?
                            {
                                msg_payload = rewritten;
                                changed = true;
                                payload_changed = true;
                            }
                            handled_entity = true;
                        }
                        SvcMessages::SvcCreateStringTable
                            if needs_string_table_context
                                || self
                                    .has_rewriters(RewriteInterests::SVC_CREATE_STRING_TABLE) =>
                        {
                            let mut msg = CSvcMsgCreateStringTable::decode(msg_payload.as_slice())?;
                            let mut table_changed =
                                self.rewrite_create_string_table_entries(tick, &mut msg)?;
                            for rewriter in self.rewriters.iter_mut().filter(|rewriter| {
                                rewriter
                                    .interests()
                                    .contains(RewriteInterests::SVC_CREATE_STRING_TABLE)
                            }) {
                                let ctx = &self.parser.context;
                                match rewriter
                                    .rewrite_svc_create_string_table(ctx, tick, &mut msg)?
                                {
                                    MessageRewrite::Drop => {
                                        changed = true;
                                        continue 'messages;
                                    }
                                    MessageRewrite::Keep => {}
                                    MessageRewrite::Rewrite => {
                                        changed = true;
                                        payload_changed = true;
                                        table_changed = false;
                                        msg_payload = msg.encode_to_vec();
                                    }
                                    MessageRewrite::Replace(bytes) => {
                                        changed = true;
                                        payload_changed = true;
                                        table_changed = false;
                                        if update_string_table_state {
                                            msg =
                                                CSvcMsgCreateStringTable::decode(bytes.as_slice())?;
                                        }
                                        msg_payload = bytes;
                                    }
                                }
                            }
                            if update_string_table_state {
                                self.process_create_string_table(&msg)?;
                                processed_state = true;
                            }
                            if table_changed {
                                msg_payload = msg.encode_to_vec();
                                changed = true;
                                payload_changed = true;
                            }
                        }
                        SvcMessages::SvcUpdateStringTable
                            if needs_string_table_context
                                || self
                                    .has_rewriters(RewriteInterests::SVC_UPDATE_STRING_TABLE) =>
                        {
                            let mut msg = CSvcMsgUpdateStringTable::decode(msg_payload.as_slice())?;
                            let mut table_changed =
                                self.rewrite_update_string_table_entries(tick, &mut msg)?;
                            for rewriter in self.rewriters.iter_mut().filter(|rewriter| {
                                rewriter
                                    .interests()
                                    .contains(RewriteInterests::SVC_UPDATE_STRING_TABLE)
                            }) {
                                let ctx = &self.parser.context;
                                match rewriter
                                    .rewrite_svc_update_string_table(ctx, tick, &mut msg)?
                                {
                                    MessageRewrite::Drop => {
                                        changed = true;
                                        continue 'messages;
                                    }
                                    MessageRewrite::Keep => {}
                                    MessageRewrite::Rewrite => {
                                        changed = true;
                                        payload_changed = true;
                                        table_changed = false;
                                        msg_payload = msg.encode_to_vec();
                                    }
                                    MessageRewrite::Replace(bytes) => {
                                        changed = true;
                                        payload_changed = true;
                                        table_changed = false;
                                        if update_string_table_state {
                                            msg =
                                                CSvcMsgUpdateStringTable::decode(bytes.as_slice())?;
                                        }
                                        msg_payload = bytes;
                                    }
                                }
                            }
                            if update_string_table_state {
                                self.process_update_string_table(&msg)?;
                                processed_state = true;
                            }
                            if table_changed {
                                msg_payload = msg.encode_to_vec();
                                changed = true;
                                payload_changed = true;
                            }
                        }
                        _ => {}
                    }
                }
            }

            if process_state && !handled_entity && !processed_state {
                self.process_packet_message_state(msg_type, msg_payload.as_slice())?;
            }

            if retain_messages {
                messages.push(PacketMessage::new(msg_type, msg_payload));
            } else if payload_changed {
                parts.push(PacketDataPart::Changed(PacketMessage::new(
                    msg_type,
                    msg_payload,
                )));
            } else {
                scratch = msg_payload;
                parts.push(PacketDataPart::Original {
                    start_bit: message_start,
                    bit_len: message_end - message_start,
                });
            }
        }

        for rewriter in self.rewriters.iter_mut().filter(|rewriter| {
            rewriter
                .interests()
                .contains(RewriteInterests::PACKET_MESSAGES)
        }) {
            let ctx = &self.parser.context;
            rewriter.rewrite_packet_messages(ctx, tick, &mut messages)?;
            changed = true;
        }

        if !changed {
            return Ok(PacketDataRewrite::Unchanged);
        }

        let mut out = Vec::with_capacity(data.len());
        let mut writer = BitstreamWriter::new(&mut out);
        if retain_messages {
            for message in messages {
                writer.write_ubit_var(message.msg_type as u32)?;
                writer.write_var_u32(message.payload.len() as u32)?;
                writer.write_bytes(message.payload.as_slice())?;
            }
        } else {
            for part in parts {
                match part {
                    PacketDataPart::Original { start_bit, bit_len } => {
                        copy_original_bits(data, start_bit, bit_len, &mut writer)?;
                    }
                    PacketDataPart::Changed(message) => {
                        writer.write_ubit_var(message.msg_type as u32)?;
                        writer.write_var_u32(message.payload.len() as u32)?;
                        writer.write_bytes(message.payload.as_slice())?;
                    }
                }
            }
        }
        writer.flush()?;
        drop(writer);
        Ok(PacketDataRewrite::Changed(out))
    }
}
