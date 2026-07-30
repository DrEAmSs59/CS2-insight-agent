use crate::entity::field::*;
use crate::entity::*;
use crate::error::ParserError;
use crate::proto::*;
use crate::reader::*;
use crate::{try_observers, Parser, StringTable};
use std::cell::RefCell;

pub trait SvcMsg {
    fn server_info(&mut self, server_info: CSvcMsgServerInfo) -> Result<(), ParserError>;

    fn create_string_table(
        &mut self,
        string_table: CSvcMsgCreateStringTable,
    ) -> Result<(), ParserError>;

    fn update_string_table(
        &mut self,
        string_table: CSvcMsgUpdateStringTable,
    ) -> Result<(), ParserError>;

    fn packet_entities(
        &mut self,
        packet_entities: CSvcMsgPacketEntities,
    ) -> Result<(), ParserError>;

    fn entity_created(&mut self, reader: &mut SliceReader, index: usize)
        -> Result<(), ParserError>;

    fn entity_updated(&mut self, reader: &mut SliceReader, index: usize)
        -> Result<(), ParserError>;

    fn entity_deleted(&mut self, index: usize) -> Result<(), ParserError>;
}

impl<'a, R> SvcMsg for Parser<'a, R>
where
    R: BitsReader + MessageReader,
{
    fn server_info(&mut self, server_info: CSvcMsgServerInfo) -> Result<(), ParserError> {
        self.context.classes.class_id_size =
            (f64::log2(server_info.max_classes() as f64) + 1.0) as u32;

        let game_dir = server_info.game_dir();

        let game_prefix = if cfg!(feature = "dota") {
            "dota_v"
        } else if cfg!(feature = "deadlock") {
            "citadel_v"
        } else {
            "unknown"
        };

        if let Some(start) = game_dir.find(game_prefix) {
            let start = start + game_prefix.len();
            if let Some(end) = game_dir[start..].find('/') {
                let build_str = &game_dir[start..start + end];
                let build = build_str.parse::<u32>().unwrap();
                self.context.game_build = build;
            }
        }
        Ok(())
    }

    fn create_string_table(
        &mut self,
        string_table: CSvcMsgCreateStringTable,
    ) -> Result<(), ParserError> {
        let mut table = StringTable {
            index: self.context.string_tables.tables.len() as i32,
            name: string_table.name().into(),
            items: vec![],
            user_data_fixed_size: string_table.user_data_fixed_size(),
            user_data_size: string_table.user_data_size(),
            flags: string_table.flags() as u32,
            var_int_bit_counts: string_table.using_varint_bitcounts(),
            keys: RefCell::new(vec![String::default(); 32]),
        };

        let table_index = table.index as usize;

        let buf = if string_table.data_compressed() {
            let mut decoder = snap::raw::Decoder::new();
            decoder.decompress_vec(string_table.string_data())?
        } else {
            string_table.string_data().into()
        };

        let modified = table.parse(
            &mut self.context.baselines,
            buf.as_slice(),
            string_table.num_entries(),
        )?;

        self.context
            .string_tables
            .name_to_table
            .insert(table.name().into(), table.index as usize);
        self.context.string_tables.tables.push(table);

        try_observers!(
            self,
            STRING_TABLE_ENTRIES,
            on_string_table(
                &self.context,
                &self.context.string_tables.tables[table_index],
                modified.as_slice()
            )
        )?;

        Ok(())
    }

    fn update_string_table(
        &mut self,
        string_table: CSvcMsgUpdateStringTable,
    ) -> Result<(), ParserError> {
        let modified = {
            let table = &mut self.context.string_tables.tables[string_table.table_id() as usize];

            table.parse(
                &mut self.context.baselines,
                string_table.string_data(),
                string_table.num_changed_entries(),
            )?
        };

        try_observers!(
            self,
            STRING_TABLE_ENTRIES,
            on_string_table(
                &self.context,
                &self.context.string_tables.tables[string_table.table_id() as usize],
                modified.as_slice()
            )
        )?;

        Ok(())
    }

    fn packet_entities(
        &mut self,
        packet_entities: CSvcMsgPacketEntities,
    ) -> Result<(), ParserError> {
        let mut reader = SliceReader::new(packet_entities.entity_data());

        let mut index = usize::MAX;

        for _ in 0..packet_entities.updated_entries() {
            index = index.wrapping_add((reader.read_ubit_var() + 1) as usize);

            let cmd = reader.read_bits(2);

            if cmd == 1 {
                continue;
            }

            match EntityEvents::from_cmd(cmd) {
                EntityEvents::Created => self.entity_created(&mut reader, index)?,
                EntityEvents::Updated => self.entity_updated(&mut reader, index)?,
                EntityEvents::Deleted => self.entity_deleted(index)?,
            }
        }

        Ok(())
    }

    fn entity_created(
        &mut self,
        reader: &mut SliceReader,
        index: usize,
    ) -> Result<(), ParserError> {
        let class_id = reader.read_bits_unchecked(self.context.classes.class_id_size) as i32;
        let serial = reader.read_bits_unchecked(17);
        let _ = reader.read_var_u32();

        let class = self.context.classes.get_by_id_rc(class_id as usize).clone();

        let entity_baseline = self
            .context
            .baselines
            .states
            .entry(class_id)
            .or_insert_with(|| {
                let mut state = FieldState::default();
                if let Some(baseline) = self.context.baselines.baselines.get(&class_id) {
                    self.field_reader.read_fields(
                        &mut SliceReader::new(baseline.as_ref()),
                        &class.serializer,
                        &mut state,
                    );
                }
                state
            })
            .clone();

        debug_assert!(
            index < self.context.entities.entities_vec.len(),
            "Entity index out of bounds"
        );

        let entity = &mut self.context.entities.entities_vec[index];
        entity.index = index as u32;
        entity.serial = serial;
        entity.class = class.clone();
        entity.state = entity_baseline;

        self.field_reader
            .read_fields(reader, &entity.class.serializer, &mut entity.state);

        try_observers!(
            self,
            ENTITY_EVENTS,
            on_entity(
                &self.context,
                EntityEvents::Created,
                &self.context.entities.entities_vec[index]
            )
        )?;

        Ok(())
    }

    fn entity_updated(
        &mut self,
        reader: &mut SliceReader,
        index: usize,
    ) -> Result<(), ParserError> {
        let entity = &mut self.context.entities.entities_vec[index];

        self.field_reader
            .read_fields(reader, &entity.class.serializer, &mut entity.state);

        try_observers!(
            self,
            ENTITY_EVENTS,
            on_entity(
                &self.context,
                EntityEvents::Updated,
                &self.context.entities.entities_vec[index]
            )
        )?;

        Ok(())
    }

    fn entity_deleted(&mut self, index: usize) -> Result<(), ParserError> {
        try_observers!(
            self,
            ENTITY_EVENTS,
            on_entity(
                &self.context,
                EntityEvents::Deleted,
                &self.context.entities.entities_vec[index]
            )
        )?;

        self.context.entities.entities_vec[index].index = u32::MAX;

        Ok(())
    }
}
