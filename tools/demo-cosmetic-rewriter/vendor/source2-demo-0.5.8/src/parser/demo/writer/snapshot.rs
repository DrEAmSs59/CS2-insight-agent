use crate::entity::field::{Encode, FieldPath};
use crate::error::ParserError;
use crate::parser::Context;
use crate::proto::CSvcMsgPacketEntities;
use crate::reader::FieldPathCodec;
use crate::stream::field_path::FieldOp;
use crate::writer::{BitsWriter, BitstreamWriter};

/// Replaces a decoded `svc_PacketEntities` payload with a complete snapshot of
/// every entity currently tracked by the parser context.
///
/// Each active entity is emitted as a Created entry with all decoded current
/// field values, so the resulting packet can serve as a non-delta frame
/// anchor for the immediately following snapshots.
pub fn materialize_full_packet_entities(
    ctx: &Context,
    message: &mut CSvcMsgPacketEntities,
) -> Result<usize, ParserError> {
    let mut data = Vec::new();
    let mut writer = BitstreamWriter::new(&mut data);
    let path_codec = FieldPathCodec::default();
    let mut previous_index = usize::MAX;
    let mut entity_count = 0_usize;

    for entity in ctx.entities.iter() {
        let entity_index = entity.index as usize;
        let index_delta = entity_index.wrapping_sub(previous_index).wrapping_sub(1);
        writer.write_ubit_var(index_delta as u32)?;
        writer.write_bits(2, 2)?;
        writer.write_bits(
            ctx.classes.class_id_size,
            entity.class.id as u64,
        )?;
        writer.write_bits(17, entity.serial as u64)?;
        writer.write_var_u32(0)?;

        let mut root = FieldPath::default();
        let paths = entity
            .class
            .serializer
            .get_paths(&mut root, &entity.state)
            .into_iter()
            .filter(|path| entity.state.get_value(path).is_some())
            .collect::<Vec<_>>();
        let mut previous_path = FieldPath::default();
        for path in &paths {
            path_codec.write_transition(&mut writer, &previous_path, path)?;
            previous_path = *path;
        }
        path_codec.write_op(&mut writer, FieldOp::FieldPathEncodeFinish)?;
        for path in &paths {
            let value = entity
                .state
                .get_value(path)
                .expect("filtered entity paths must have values");
            entity
                .class
                .serializer
                .get_decoder(path)
                .encode(&mut writer, value)?;
        }

        previous_index = entity_index;
        entity_count += 1;
    }

    writer.flush()?;
    drop(writer);

    message.updated_entries = Some(entity_count as i32);
    message.legacy_is_delta = Some(false);
    message.update_baseline = Some(false);
    message.delta_from = None;
    message.entity_data = Some(data);
    message.pending_full_frame = None;
    message.serialized_entities = None;
    message.alternate_baselines.clear();
    message.non_transmitted_entities = None;
    message.outofpvs_entity_updates = None;
    Ok(entity_count)
}
