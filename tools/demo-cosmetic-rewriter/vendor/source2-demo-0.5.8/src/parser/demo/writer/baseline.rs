use crate::entity::field::{Decode, Encode, FieldPath};
use crate::entity::{Entity, EntityEvents};
use crate::error::ParserError;
use crate::parser::demo::writer::{DemoWriter, INSTANCE_BASELINE_TABLE};
use crate::proto::{c_demo_string_tables::ItemsT, CDemoStringTables};
use crate::reader::{BitsReader, MessageReader, SliceReader};
use crate::stream::copy::{bit_position, copy_original_bits, copy_remaining_bits};
use crate::stream::field_path::FieldOp;
use crate::writer::{BitsWriter, BitstreamWriter};
use std::io::{Seek, Write};
use std::rc::Rc;

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    pub(crate) fn rewrite_instance_baselines(
        &mut self,
        msg: &mut CDemoStringTables,
    ) -> Result<bool, ParserError> {
        let mut changed = false;
        for table in msg.tables.iter_mut() {
            if table.table_name() != INSTANCE_BASELINE_TABLE {
                continue;
            }
            changed |= self.rewrite_instance_baseline_items(&mut table.items)?;
        }
        Ok(changed)
    }

    fn rewrite_instance_baseline_items(
        &mut self,
        items: &mut [ItemsT],
    ) -> Result<bool, ParserError> {
        let mut changed = false;
        for item in items.iter_mut() {
            let Some(class_id) = item
                .str
                .as_deref()
                .and_then(|value| value.parse::<i32>().ok())
            else {
                continue;
            };

            if class_id < 0 {
                continue;
            }

            let Some(data) = item.data.as_deref() else {
                continue;
            };

            if let Some(rewritten) = self.rewrite_instance_baseline_data(class_id, data)? {
                item.data = Some(rewritten);
                changed = true;
            }
        }

        Ok(changed)
    }

    pub(crate) fn rewrite_instance_baseline_data(
        &mut self,
        class_id: i32,
        data: &[u8],
    ) -> Result<Option<Vec<u8>>, ParserError> {
        let Some(class) = self
            .parser
            .context
            .classes
            .classes_vec
            .get(class_id as usize)
            .cloned()
        else {
            return Ok(None);
        };

        let mut entity = Entity::new(0, 0, class, Default::default());
        if !self.should_rewrite_entity(EntityEvents::Created, &entity) {
            return Ok(None);
        }

        let mut reader = SliceReader::new(data);
        let mut out = Vec::with_capacity(data.len());
        let mut writer = BitstreamWriter::new(&mut out);
        let path_reader = self.entity_rewrite.field_path_codec.clone();

        let paths_start = bit_position(&reader);
        let mut paths = Vec::new();
        let mut fp = FieldPath::default();
        loop {
            let op = path_reader.read_op(&mut reader);
            if op == FieldOp::FieldPathEncodeFinish {
                break;
            }
            op.execute(&mut reader, &mut fp);
            paths.push(fp);
        }
        let paths_end = bit_position(&reader);
        copy_original_bits(data, paths_start, paths_end - paths_start, &mut writer)?;

        struct DecodedField {
            fp: FieldPath,
            name: Rc<str>,
            value_start: usize,
            value_end: usize,
        }

        let mut decoded_fields = Vec::with_capacity(paths.len());
        for fp in paths {
            let name = entity.class.serializer.get_name(&fp);
            let decoder = entity.class.serializer.get_decoder(&fp);
            let value_start = bit_position(&reader);
            let value = decoder.decode(&mut reader);
            let value_end = bit_position(&reader);
            entity.state.set(&fp, value);
            decoded_fields.push(DecodedField {
                fp,
                name,
                value_start,
                value_end,
            });
        }

        let mut changed = false;
        for field in decoded_fields {
            let decoder = entity.class.serializer.get_decoder(&field.fp);
            let replacement = self.replace_entity_field(
                EntityEvents::Created,
                &entity,
                &field.name,
                entity
                    .state
                    .get_value(&field.fp)
                    .expect("decoded field value"),
            );

            if let Some(next_value) = replacement {
                decoder.encode(&mut writer, &next_value)?;
                entity.state.set(&field.fp, next_value);
                changed = true;
            } else {
                copy_original_bits(
                    reader.source_buffer,
                    field.value_start,
                    field.value_end - field.value_start,
                    &mut writer,
                )?;
            }
        }

        copy_remaining_bits(&mut reader, &mut writer)?;
        writer.flush()?;
        drop(writer);

        if changed {
            Ok(Some(out))
        } else {
            Ok(None)
        }
    }
}
