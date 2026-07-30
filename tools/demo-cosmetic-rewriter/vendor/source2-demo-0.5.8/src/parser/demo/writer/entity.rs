use crate::entity::field::{Decode, Encode, FieldPath, FieldState, Serializer, Skip};
use crate::entity::{Entity, EntityEvents};
use crate::error::ParserError;
use crate::parser::demo::writer::{
    DecodedEntityField, DemoWriter, FieldReplacement, OriginalEntityField,
};
use crate::proto::{CSvcMsgPacketEntities, Message};
use crate::reader::{BitsReader, FieldPathCodec, MessageReader, SliceReader};
use crate::stream::copy::{bit_position, copy_original_bits};
use crate::stream::field_path::FieldOp;
use crate::writer::{BitsWriter, BitstreamWriter};
use std::io::{Seek, Write};

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    pub(crate) fn rewrite_svc_packet_entities(
        &mut self,
        msg: &[u8],
    ) -> Result<Option<Vec<u8>>, ParserError> {
        let mut packet_entities = CSvcMsgPacketEntities::decode(msg)?;
        let Some(entity_data) = packet_entities.entity_data.as_deref() else {
            return Ok(None);
        };

        let (rewritten, changed) =
            self.rewrite_entity_data(entity_data, packet_entities.updated_entries())?;
        if changed {
            packet_entities.entity_data = Some(rewritten);
            packet_entities.serialized_entities = None;
            Ok(Some(packet_entities.encode_to_vec()))
        } else {
            Ok(None)
        }
    }

    fn rewrite_entity_data(
        &mut self,
        entity_data: &[u8],
        updated_entries: i32,
    ) -> Result<(Vec<u8>, bool), ParserError> {
        let mut reader = SliceReader::new(entity_data);
        self.entity_rewrite.replacements.clear();
        self.entity_rewrite.injections.clear();
        let mut index = usize::MAX;
        let path_reader = self.entity_rewrite.field_path_codec.clone();

        for _ in 0..updated_entries {
            let delta = reader.read_ubit_var();
            index = index.wrapping_add((delta + 1) as usize);

            let cmd = reader.read_bits(2);

            if cmd == 1 {
                continue;
            }

            match EntityEvents::from_cmd(cmd) {
                EntityEvents::Created => {
                    self.rewrite_entity_created(&mut reader, &path_reader, index)?;
                }
                EntityEvents::Updated => {
                    self.rewrite_entity_updated(&mut reader, &path_reader, index)?;
                }
                EntityEvents::Deleted => {
                    self.parser.context.entities.entities_vec[index].index = u32::MAX;
                }
            }
        }

        if self.entity_rewrite.replacements.is_empty() && self.entity_rewrite.injections.is_empty()
        {
            return Ok((Vec::new(), false));
        }

        let mut out = Vec::with_capacity(entity_data.len());
        let mut writer = BitstreamWriter::new(&mut out);
        let mut copy_start = 0;
        enum EntityBitEdit {
            Replacement(FieldReplacement),
            Injection(crate::parser::demo::writer::EntityFieldInjection),
        }

        let mut edits = std::mem::take(&mut self.entity_rewrite.replacements)
            .into_iter()
            .map(EntityBitEdit::Replacement)
            .chain(
                std::mem::take(&mut self.entity_rewrite.injections)
                    .into_iter()
                    .map(EntityBitEdit::Injection),
            )
            .collect::<Vec<_>>();
        edits.sort_by_key(|edit| match edit {
            EntityBitEdit::Replacement(replacement) => replacement.value_start,
            EntityBitEdit::Injection(injection) => injection.finish_start,
        });

        for edit in edits {
            let edit_start = match &edit {
                EntityBitEdit::Replacement(replacement) => replacement.value_start,
                EntityBitEdit::Injection(injection) => injection.finish_start,
            };
            if edit_start < copy_start {
                return Err(ParserError::IoError(
                    "overlapping entity field rewrites".to_owned(),
                ));
            }
            copy_original_bits(
                entity_data,
                copy_start,
                edit_start - copy_start,
                &mut writer,
            )?;

            match edit {
                EntityBitEdit::Replacement(replacement) => {
                    replacement
                        .serializer
                        .get_decoder(&replacement.fp)
                        .encode(&mut writer, &replacement.value)?;
                    copy_start = replacement.value_end;
                }
                EntityBitEdit::Injection(injection) => {
                    let mut current = injection.from_fp;
                    for (fp, _) in &injection.fields {
                        path_reader.write_transition(&mut writer, &current, fp)?;
                        current = *fp;
                    }
                    path_reader.write_op(&mut writer, FieldOp::FieldPathEncodeFinish)?;
                    for field in &injection.original_fields {
                        if let Some(value) = &field.replacement {
                            injection
                                .serializer
                                .get_decoder(&field.fp)
                                .encode(&mut writer, value)?;
                        } else {
                            copy_original_bits(
                                entity_data,
                                field.value_start,
                                field.value_end - field.value_start,
                                &mut writer,
                            )?;
                        }
                    }
                    for (fp, value) in &injection.fields {
                        injection
                            .serializer
                            .get_decoder(fp)
                            .encode(&mut writer, value)?;
                    }
                    copy_start = injection.values_end;
                }
            }
        }
        copy_original_bits(
            entity_data,
            copy_start,
            entity_data.len() * 8 - copy_start,
            &mut writer,
        )?;
        writer.flush()?;
        drop(writer);
        Ok((out, true))
    }

    fn rewrite_entity_created(
        &mut self,
        reader: &mut SliceReader<'_>,
        path_reader: &FieldPathCodec,
        index: usize,
    ) -> Result<(), ParserError> {
        let class_id = reader.read_bits(self.parser.context.classes.class_id_size) as i32;

        let serial = reader.read_bits(17);

        let _ = reader.read_var_u32();

        let class = self
            .parser
            .context
            .classes
            .get_by_id_rc(class_id as usize)
            .clone();

        let state = self.entity_baseline_state(class_id, &class.serializer);
        let mut entity = Entity::new(index as u32, serial, class, state);

        let track = self.should_track_entity(EntityEvents::Created, &entity);
        let rewrite = self.should_rewrite_entity(EntityEvents::Created, &entity);
        if track || rewrite {
            self.rewrite_fields(
                reader,
                path_reader,
                EntityEvents::Created,
                &mut entity,
                track,
                rewrite,
            )?;
        } else {
            self.skip_original_fields(reader, path_reader, &entity);
        }
        if !track {
            entity.state = FieldState::default();
        }
        self.parser.context.entities.entities_vec[index] = entity;

        Ok(())
    }

    fn rewrite_entity_updated(
        &mut self,
        reader: &mut SliceReader<'_>,
        path_reader: &FieldPathCodec,
        index: usize,
    ) -> Result<(), ParserError> {
        let class = self.parser.context.entities.entities_vec[index]
            .class
            .clone();
        let placeholder = Entity {
            index: u32::MAX,
            serial: 0,
            class,
            state: FieldState::default(),
        };
        let mut entity = std::mem::replace(
            &mut self.parser.context.entities.entities_vec[index],
            placeholder,
        );
        let track = self.should_track_entity(EntityEvents::Updated, &entity);
        let rewrite = self.should_rewrite_entity(EntityEvents::Updated, &entity);
        if track || rewrite {
            self.rewrite_fields(
                reader,
                path_reader,
                EntityEvents::Updated,
                &mut entity,
                track,
                rewrite,
            )?;
        } else {
            self.skip_original_fields(reader, path_reader, &entity);
        }
        if !track {
            entity.state = FieldState::default();
        }
        self.parser.context.entities.entities_vec[index] = entity;

        Ok(())
    }

    fn skip_original_fields(
        &mut self,
        reader: &mut SliceReader<'_>,
        path_reader: &FieldPathCodec,
        entity: &Entity,
    ) {
        self.entity_rewrite.rewrite_paths.clear();
        let mut fp = FieldPath::default();

        loop {
            reader.refill();
            let op = path_reader.read_op(reader);
            if let FieldOp::FieldPathEncodeFinish = op {
                break;
            }
            op.execute(reader, &mut fp);
            self.entity_rewrite.rewrite_paths.push(fp);
        }

        for fp in &self.entity_rewrite.rewrite_paths {
            entity.class.serializer.get_decoder(fp).skip(reader);
        }
    }

    fn rewrite_fields(
        &mut self,
        reader: &mut SliceReader<'_>,
        path_reader: &FieldPathCodec,
        event: EntityEvents,
        entity: &mut Entity,
        track: bool,
        rewrite: bool,
    ) -> Result<(), ParserError> {
        self.entity_rewrite.rewrite_paths.clear();
        let mut fp = FieldPath::default();
        let finish_start;

        loop {
            let op_start = bit_position(reader);
            reader.refill();
            let op = path_reader.read_op(reader);
            if op == FieldOp::FieldPathEncodeFinish {
                finish_start = op_start;
                break;
            }
            op.execute(reader, &mut fp);
            self.entity_rewrite.rewrite_paths.push(fp);
        }

        if !rewrite {
            for fp in self.entity_rewrite.rewrite_paths.iter() {
                let decoder = entity.class.serializer.get_decoder(fp);
                let value = decoder.decode(reader);
                entity.state.set(fp, value);
            }
            return Ok(());
        }

        if !track {
            let mut paths = std::mem::take(&mut self.entity_rewrite.rewrite_paths);
            for fp in paths.iter().copied() {
                let name = entity.class.serializer.get_name(&fp);
                let decoder = entity.class.serializer.get_decoder(&fp);
                let value_start = bit_position(reader);
                let value = decoder.decode(reader);
                let value_end = bit_position(reader);

                if let Some(next_value) = self.replace_entity_field(event, entity, &name, &value) {
                    entity.state.set(&fp, next_value.clone());
                    self.entity_rewrite.replacements.push(FieldReplacement {
                        serializer: entity.class.serializer.clone(),
                        fp,
                        value: next_value,
                        value_start,
                        value_end,
                    });
                }
            }
            paths.clear();
            self.entity_rewrite.rewrite_paths = paths;
            return Ok(());
        }

        self.entity_rewrite.decoded_fields.clear();
        let mut paths = std::mem::take(&mut self.entity_rewrite.rewrite_paths);
        let original_paths = paths.clone();
        for fp in paths.iter().copied() {
            let name = entity.class.serializer.get_name(&fp);
            let decoder = entity.class.serializer.get_decoder(&fp);
            let value_start = bit_position(reader);
            let value = decoder.decode(reader);
            let value_end = bit_position(reader);
            entity.state.set(&fp, value);
            self.entity_rewrite.decoded_fields.push(DecodedEntityField {
                fp,
                name,
                value_start,
                value_end,
            });
        }
        paths.clear();
        self.entity_rewrite.rewrite_paths = paths;
        let values_end = bit_position(reader);
        let original_field_ranges = self
            .entity_rewrite
            .decoded_fields
            .iter()
            .map(|field| (field.fp, field.value_start, field.value_end))
            .collect::<Vec<_>>();

        let entity_replacement_start = self.entity_rewrite.replacements.len();
        let mut decoded_fields = std::mem::take(&mut self.entity_rewrite.decoded_fields);
        for field in decoded_fields.drain(..) {
            let Some(value) = entity.state.get_value(&field.fp) else {
                continue;
            };
            let replacement = self.replace_entity_field(event, entity, &field.name, value);

            if let Some(next_value) = replacement {
                entity.state.set(&field.fp, next_value.clone());
                self.entity_rewrite.replacements.push(FieldReplacement {
                    serializer: entity.class.serializer.clone(),
                    fp: field.fp,
                    value: next_value,
                    value_start: field.value_start,
                    value_end: field.value_end,
                });
            }
        }
        self.entity_rewrite.decoded_fields = decoded_fields;

        let requested_fields = self.append_entity_fields(event, entity);
        if !requested_fields.is_empty() {
            let mut root = FieldPath::default();
            let available_paths = entity.class.serializer.get_paths(&mut root, &entity.state);
            let mut original_fields = Vec::with_capacity(original_paths.len());
            let mut replacements = self
                .entity_rewrite
                .replacements
                .drain(entity_replacement_start..)
                .map(|replacement| (replacement.fp, replacement.value))
                .collect::<Vec<_>>();
            for (fp, value_start, value_end) in &original_field_ranges {
                let replacement = replacements
                    .iter()
                    .position(|(candidate, _)| candidate == fp)
                    .map(|index| replacements.swap_remove(index).1);
                original_fields.push(OriginalEntityField {
                    fp: *fp,
                    value_start: *value_start,
                    value_end: *value_end,
                    replacement,
                });
            }
            debug_assert!(replacements.is_empty());
            let mut fields = Vec::with_capacity(requested_fields.len());
            for (name, value) in requested_fields {
                let path = available_paths
                    .iter()
                    .copied()
                    .find(|path| entity.class.serializer.get_name(path).as_ref() == name)
                    .or_else(|| entity.class.serializer.get_path(&name).ok())
                    .ok_or_else(|| {
                        ParserError::IoError(format!(
                            "cannot inject unknown entity field {name} into {}",
                            entity.class().name()
                        ))
                    })?;
                if original_paths.contains(&path) {
                    return Err(ParserError::IoError(format!(
                        "cannot inject entity field already present in delta: {name}"
                    )));
                }
                entity.state.set(&path, value.clone());
                fields.push((path, value));
            }
            fields.sort_by(|left, right| {
                let left = left.0;
                let right = right.0;
                left.path[..=left.last].cmp(&right.path[..=right.last])
            });
            self.entity_rewrite.injections.push(
                crate::parser::demo::writer::EntityFieldInjection {
                    serializer: entity.class.serializer.clone(),
                    from_fp: original_paths.last().copied().unwrap_or_default(),
                    original_fields,
                    fields,
                    finish_start,
                    values_end,
                },
            );
        }

        Ok(())
    }

    fn entity_baseline_state(&mut self, class_id: i32, serializer: &Serializer) -> FieldState {
        self.parser
            .context
            .baselines
            .states
            .entry(class_id)
            .or_insert_with(|| {
                let mut state = FieldState::default();
                if let Some(baseline) = self.parser.context.baselines.baselines.get(&class_id) {
                    self.parser.field_reader.read_fields(
                        &mut SliceReader::new(baseline.as_ref()),
                        serializer,
                        &mut state,
                    );
                }
                state
            })
            .clone()
    }
}
