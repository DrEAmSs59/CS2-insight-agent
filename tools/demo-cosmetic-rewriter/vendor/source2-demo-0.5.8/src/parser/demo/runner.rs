//! Demo runner implementations for parser execution.
//!
//! This module provides the [`DemoRunner`] trait which defines methods for
//! controlling replay parsing execution.

use crate::error::ParserError;
use crate::parser::demo::DemoMessages;
use crate::parser::Parser;
use crate::proto::*;
use crate::reader::*;
use crate::Entity;
use std::cmp::min;
use std::mem;

/// Trait for controlling replay parsing execution.
///
/// Provides methods to run the parser to completion, to a specific tick,
/// or to jump to a tick without full processing.
pub trait DemoRunner {
    /// Processes the entire replay from start to finish.
    ///
    /// This method processes all demo commands sequentially, calling registered
    /// observers for each event. The final packet is [`CDemoFileInfo`].
    ///
    /// # Errors
    ///
    /// Returns [`ParserError`] if parsing fails.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// let replay = std::fs::read("replay.dem")?;
    /// let mut parser = Parser::new(&replay)?;
    /// parser.register_observer::<MyObserver>();
    /// parser.run_to_end()?;
    /// # Ok(())
    /// # }
    /// # #[derive(Default)]
    /// # struct MyObserver;
    /// # impl Observer for MyObserver {}
    /// ```
    fn run_to_end(&mut self) -> Result<(), ParserError>;

    /// Processes the replay up to a specific tick.
    ///
    /// Stops parsing when the specified tick is reached. All observers are
    /// called for events up to and including the target tick.
    ///
    /// # Arguments
    ///
    /// * `target_tick` - The tick to parse up to (inclusive)
    ///
    /// # Errors
    ///
    /// Returns [`ParserError`] if parsing fails.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// let replay = std::fs::File::open("replay.dem")?;
    /// let mut parser = Parser::from_reader(&replay)?;
    ///
    /// // Process first 5 minutes (30 ticks per second * 60 seconds * 5 minutes)
    /// parser.run_to_tick(9000)?;
    /// # Ok(())
    /// # }
    /// ```
    fn run_to_tick(&mut self, target_tick: u32) -> Result<(), ParserError>;

    /// Jumps to a specific tick without full processing.
    ///
    /// This is an optimized method that seeks to the target tick without
    /// calling observers for intermediate events. Useful for jumping to
    /// a specific point in a replay quickly.
    ///
    /// After jumping, you can continue parsing normally with observers active.
    ///
    /// # Arguments
    ///
    /// * `target_tick` - The tick to jump to
    ///
    /// # Errors
    ///
    /// Returns [`ParserError`] if seeking fails.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// let replay = std::fs::File::open("replay.dem")?;
    /// let mut parser = Parser::from_reader(&replay)?;
    ///
    /// // Jump to 10 minutes in
    /// parser.jump_to_tick(18000)?;
    ///
    /// // Now register observers and continue
    /// parser.register_observer::<MyObserver>();
    /// parser.run_to_tick(20000)?;
    /// # Ok(())
    /// # }
    /// # #[derive(Default)]
    /// # struct MyObserver;
    /// # impl Observer for MyObserver {}
    /// ```
    fn jump_to_tick(&mut self, target_tick: u32) -> Result<(), ParserError>;
}

impl<'a, R> DemoRunner for Parser<'a, R>
where
    R: BitsReader + MessageReader,
{
    fn run_to_end(&mut self) -> Result<(), ParserError> {
        self.prologue()?;

        while let Some(message) = self.reader.read_next_message()? {
            self.on_tick_start(message.tick)?;
            self.on_demo_command(message.msg_type, message.buf.as_slice())?;
        }
        self.on_tick_end()?;

        Ok(())
    }

    fn run_to_tick(&mut self, target_tick: u32) -> Result<(), ParserError> {
        assert!(target_tick > self.context.tick || self.context.tick == u32::MAX);

        self.prologue()?;

        let target_tick = min(target_tick, self.last_tick);

        while let Some(message) = self.reader.read_next_message()? {
            self.on_tick_start(message.tick)?;
            self.on_demo_command(message.msg_type, message.buf.as_slice())?;
            if self.context.tick >= target_tick {
                self.on_tick_end()?;
                break;
            }
        }

        Ok(())
    }

    fn jump_to_tick(&mut self, target_tick: u32) -> Result<(), ParserError> {
        let fp_delta = if cfg!(feature = "deadlock") {
            3600
        } else {
            1800
        };

        let target_tick = min(target_tick, self.last_tick);

        if target_tick < self.context.tick {
            self.context.last_full_packet_tick = u32::MAX;
            self.context.tick = u32::MAX;
            self.context.net_tick = u32::MAX;
            self.reader.seek(16);

            self.context.entities.entities_vec = vec![Entity::default(); 8192];

            self.context.string_tables.tables.clear();
            self.context.string_tables.name_to_table.clear();
            self.context.game_events.list.clear();
        }

        self.prologue()?;

        self.skip_deltas = true;
        let observers = mem::take(&mut self.observers);

        let mut first_fp_checked = self.context.last_full_packet_tick != u32::MAX;
        let mut last_fp_checked = first_fp_checked
            && self.context.last_full_packet_tick < target_tick
            && (target_tick - self.context.last_full_packet_tick) <= fp_delta;

        while let Some(mut message) = self.reader.read_next_message()? {
            self.context.previous_tick = self.context.tick;
            self.context.tick = message.tick;

            if message.msg_type == EDemoCommands::DemFullPacket {
                self.context.last_full_packet_tick = self.context.tick;
            }

            let next_fp = self.context.last_full_packet_tick == u32::MAX
                || self.context.last_full_packet_tick < target_tick
                    && (target_tick - self.context.last_full_packet_tick) > fp_delta;

            if message.msg_type == EDemoCommands::DemFullPacket {
                if next_fp && first_fp_checked {
                    message.msg_type = EDemoCommands::DemStringTables;
                    message.buf = CDemoFullPacket::decode(message.buf.as_slice())?
                        .string_table
                        .unwrap()
                        .encode_to_vec();
                }

                self.on_demo_command(message.msg_type, message.buf.as_slice())?;
            }

            if last_fp_checked {
                self.on_demo_command(message.msg_type, message.buf.as_slice())?;
            }

            if message.msg_type == EDemoCommands::DemFullPacket && !first_fp_checked {
                first_fp_checked = true;
            }

            if message.msg_type == EDemoCommands::DemFullPacket && !next_fp {
                last_fp_checked = true;
                self.skip_deltas = false;
            }

            if self.context.tick >= target_tick && first_fp_checked {
                break;
            }
        }

        self.skip_deltas = false;
        self.observers = observers;

        Ok(())
    }
}
