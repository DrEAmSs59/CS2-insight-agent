use crate::error::ParserError;
use crate::parser::demo::writer::{DemoWriter, INSTANCE_BASELINE_TABLE};
use crate::proto::{
    CSvcMsgCreateStringTable, CSvcMsgServerInfo, CSvcMsgUpdateStringTable, Message, SvcMessages,
};
use crate::reader::{BitsReader, MessageReader};
use crate::StringTable;
use std::io::{Seek, Write};

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    pub(crate) fn process_packet_message_state(
        &mut self,
        msg_type: i32,
        msg_buf: &[u8],
    ) -> Result<(), ParserError> {
        let Ok(msg) = SvcMessages::try_from(msg_type) else {
            return Ok(());
        };

        match msg {
            SvcMessages::SvcServerInfo if self.rewrites_entity_fields() => {
                self.process_server_info(CSvcMsgServerInfo::decode(msg_buf)?);
            }
            SvcMessages::SvcCreateStringTable if self.needs_string_table_context() => {
                let msg = CSvcMsgCreateStringTable::decode(msg_buf)?;
                self.process_create_string_table(&msg)?;
            }
            SvcMessages::SvcUpdateStringTable if self.needs_string_table_context() => {
                let msg = CSvcMsgUpdateStringTable::decode(msg_buf)?;
                if self.rewrites_string_table_entries()
                    || self.is_instance_baseline_table(msg.table_id() as usize)
                {
                    self.process_update_string_table(&msg)?;
                }
            }
            _ => {}
        }

        Ok(())
    }

    fn is_instance_baseline_table(&self, table_id: usize) -> bool {
        self.parser
            .context
            .string_tables
            .tables
            .get(table_id)
            .is_some_and(|table| table.name() == INSTANCE_BASELINE_TABLE)
    }

    fn process_server_info(&mut self, server_info: CSvcMsgServerInfo) {
        self.parser.context.classes.class_id_size =
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
                if let Ok(build) = game_dir[start..start + end].parse::<u32>() {
                    self.parser.context.game_build = build;
                }
            }
        }
    }

    pub(crate) fn process_create_string_table(
        &mut self,
        msg: &CSvcMsgCreateStringTable,
    ) -> Result<(), ParserError> {
        use std::cell::RefCell;

        let mut table = StringTable {
            index: self.parser.context.string_tables.tables.len() as i32,
            name: msg.name().into(),
            items: vec![],
            user_data_fixed_size: msg.user_data_fixed_size(),
            user_data_size: msg.user_data_size(),
            flags: msg.flags() as u32,
            var_int_bit_counts: msg.using_varint_bitcounts(),
            keys: RefCell::new(vec![String::default(); 32]),
        };

        let buf = if msg.data_compressed() {
            let mut decoder = snap::raw::Decoder::new();
            decoder.decompress_vec(msg.string_data())?
        } else {
            msg.string_data().into()
        };

        table.parse(
            &mut self.parser.context.baselines,
            buf.as_slice(),
            msg.num_entries(),
        )?;

        self.parser
            .context
            .string_tables
            .name_to_table
            .insert(table.name().into(), table.index as usize);
        self.parser.context.string_tables.tables.push(table);
        Ok(())
    }

    pub(crate) fn process_update_string_table(
        &mut self,
        msg: &CSvcMsgUpdateStringTable,
    ) -> Result<(), ParserError> {
        let Some(table) = self
            .parser
            .context
            .string_tables
            .tables
            .get_mut(msg.table_id() as usize)
        else {
            return Ok(());
        };

        table.parse(
            &mut self.parser.context.baselines,
            msg.string_data(),
            msg.num_changed_entries(),
        )?;
        Ok(())
    }
}
