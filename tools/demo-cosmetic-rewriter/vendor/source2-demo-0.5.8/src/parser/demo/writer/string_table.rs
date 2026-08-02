use crate::error::ParserError;
use crate::parser::demo::writer::{
    DemoWriter, MessageRewrite, RewriteInterests, INSTANCE_BASELINE_TABLE,
};
use crate::proto::{
    CDemoStringTables, CSvcMsgCreateStringTable, CSvcMsgUpdateStringTable, Message,
};
use crate::reader::{BitsReader, MessageReader};
use crate::string_table::{
    rewrite_create_string_table, rewrite_demo_string_table_items, rewrite_update_string_table,
    PackedStringTableFormat, PackedStringTableState, StringTableEntryUpdate,
};
use std::io::{Seek, Write};

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    pub(crate) fn rewrite_string_tables(
        &mut self,
        tick: u32,
        mut msg: CDemoStringTables,
    ) -> Result<Option<(CDemoStringTables, bool)>, ParserError> {
        let mut changed = false;
        if self.rewrites_entity_fields() {
            changed |= self.rewrite_instance_baselines(&mut msg)?;
        }
        changed |= self.rewrite_demo_string_table_entries(tick, &mut msg)?;
        for rewriter in self.rewriters.iter_mut().filter(|rewriter| {
            rewriter
                .interests()
                .contains(RewriteInterests::DEMO_STRING_TABLES)
        }) {
            let ctx = &self.parser.context;
            match rewriter.rewrite_demo_string_tables(ctx, tick, &mut msg)? {
                MessageRewrite::Drop => return Ok(None),
                MessageRewrite::Keep => {}
                MessageRewrite::Rewrite => changed = true,
                MessageRewrite::Replace(bytes) => {
                    msg = CDemoStringTables::decode(bytes.as_slice())?;
                    changed = true;
                }
            }
        }
        Ok(Some((msg, changed)))
    }

    pub(crate) fn rewrite_create_string_table_entries(
        &mut self,
        tick: u32,
        msg: &mut CSvcMsgCreateStringTable,
    ) -> Result<bool, ParserError> {
        let table_name = msg.name().to_string();
        let rewrite_baselines =
            table_name == INSTANCE_BASELINE_TABLE && self.rewrites_entity_fields();
        if !self.rewrites_string_table_entries() && !rewrite_baselines {
            return Ok(false);
        }

        let table_id = self.string_table_rewrite.len();
        let mut state =
            PackedStringTableState::new(PackedStringTableFormat::from_create_message(msg));

        let changed = rewrite_create_string_table(msg, &mut state, |entry| {
            if rewrite_baselines {
                self.rewrite_instance_baseline_entry_update(entry, None)?;
            }
            self.rewrite_string_table_entry_with_rewriters(tick, &table_name, entry)?;
            Ok(())
        });

        let changed = changed?;

        self.ensure_string_table_rewrite_state(table_id);
        self.string_table_rewrite.set(table_id, state);
        Ok(changed)
    }

    pub(crate) fn rewrite_update_string_table_entries(
        &mut self,
        tick: u32,
        msg: &mut CSvcMsgUpdateStringTable,
    ) -> Result<bool, ParserError> {
        let table_id = msg.table_id() as usize;
        let Some(table) = self.parser.context.string_tables.tables.get(table_id) else {
            return Ok(false);
        };
        let table_name = table.name().to_string();
        let rewrite_baselines =
            table_name == INSTANCE_BASELINE_TABLE && self.rewrites_entity_fields();
        if !self.rewrites_string_table_entries() && !rewrite_baselines {
            return Ok(false);
        }
        let existing_keys = if rewrite_baselines {
            table
                .iter()
                .map(|row| row.key().to_string())
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let state_from_context = PackedStringTableState::from_table(table);

        self.ensure_string_table_rewrite_state(table_id);
        if self.string_table_rewrite.is_missing(table_id) {
            self.string_table_rewrite.set(table_id, state_from_context);
        }

        let Some(mut state) = self.string_table_rewrite.take(table_id) else {
            return Err(ParserError::MissingStringTableRewriteState { table_id });
        };

        let changed = rewrite_update_string_table(msg, &mut state, |entry| {
            if rewrite_baselines {
                let fallback_key = usize::try_from(entry.index())
                    .ok()
                    .and_then(|index| existing_keys.get(index))
                    .map(String::as_str);
                self.rewrite_instance_baseline_entry_update(entry, fallback_key)?;
            }
            self.rewrite_string_table_entry_with_rewriters(tick, &table_name, entry)?;
            Ok(())
        });

        self.string_table_rewrite.set(table_id, state);
        changed
    }

    pub(crate) fn rewrite_demo_string_table_entries(
        &mut self,
        tick: u32,
        msg: &mut CDemoStringTables,
    ) -> Result<bool, ParserError> {
        if !self.rewrites_string_table_entries() {
            return Ok(false);
        }

        let mut changed = false;
        for table in msg.tables.iter_mut() {
            let table_name = table.table_name().to_string();
            changed |= rewrite_demo_string_table_items(&mut table.items, |entry| {
                self.rewrite_string_table_entry_with_rewriters(tick, &table_name, entry)
            })?;
            changed |= rewrite_demo_string_table_items(&mut table.items_clientside, |entry| {
                self.rewrite_string_table_entry_with_rewriters(tick, &table_name, entry)
            })?;
        }
        Ok(changed)
    }

    fn ensure_string_table_rewrite_state(&mut self, table_id: usize) {
        self.string_table_rewrite.ensure(table_id);
    }

    fn rewrite_instance_baseline_entry_update(
        &mut self,
        entry: &mut StringTableEntryUpdate,
        fallback_key: Option<&str>,
    ) -> Result<(), ParserError> {
        let Some(class_id) = entry
            .key()
            .or(fallback_key)
            .and_then(|value| value.parse::<i32>().ok())
        else {
            return Ok(());
        };
        if class_id < 0 {
            return Ok(());
        }

        let Some(data) = entry.value() else {
            return Ok(());
        };
        if let Some(rewritten) = self.rewrite_instance_baseline_data(class_id, data)? {
            entry.set_value(rewritten);
        }
        Ok(())
    }

    fn rewrite_string_table_entry_with_rewriters(
        &mut self,
        tick: u32,
        table_name: &str,
        entry: &mut StringTableEntryUpdate,
    ) -> Result<(), ParserError> {
        for rewriter in self.rewriters.iter_mut().filter(|rewriter| {
            rewriter
                .interests()
                .contains(RewriteInterests::STRING_TABLE_ENTRIES)
        }) {
            let ctx = &self.parser.context;
            rewriter.rewrite_string_table_entry(ctx, tick, table_name, entry)?;
        }
        Ok(())
    }
}
