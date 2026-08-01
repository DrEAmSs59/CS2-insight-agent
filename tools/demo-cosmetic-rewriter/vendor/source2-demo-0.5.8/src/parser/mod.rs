mod context;
mod demo;
mod observer;

pub use context::*;
pub use demo::runner::*;
pub use demo::writer::*;
pub use observer::*;

use crate::error::*;
use crate::proto::*;
use crate::reader::*;
use std::cell::RefCell;
use std::rc::Rc;

use crate::parser::demo::DemoCommands;
use crate::try_observers;
#[cfg(feature = "dota")]
use std::collections::VecDeque;

/// Main parser for Source 2 demo files.
///
/// The parser maintains the replay state and processes demo commands
/// sequentially. It supports multiple observers that can react to different
/// types of events.
///
/// # Examples
///
/// ## Basic usage with chat messages
///
/// ```ignore
/// use source2_demo::prelude::*;
///
/// #[derive(Default)]
/// struct ChatLogger;
///
/// #[observer]
/// impl ChatLogger {
///     #[on_message]
///     fn on_chat(&mut self, ctx: &Context, msg: CDotaUserMsgChatMessage) -> ObserverResult {
///         println!("{}", msg.message_text());
///         Ok(())
///     }
/// }
///
/// fn main() -> anyhow::Result<()> {
///     let replay = std::fs::File::open("replay.dem")?;
///
///     let mut parser = Parser::from_reader(&replay)?;
///     parser.register_observer::<ChatLogger>();
///     parser.run_to_end()?;
///
///     Ok(())
/// }
/// ```
///
/// ## Processing entities
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// #[derive(Default)]
/// struct HeroTracker;
///
/// impl Observer for HeroTracker {
///     fn interests(&self) -> Interests {
///         Interests::ENTITY_STATE | Interests::ENTITY_EVENTS
///     }
///
///     fn on_entity(
///         &mut self,
///         ctx: &Context,
///         event: EntityEvents,
///         entity: &Entity,
///     ) -> ObserverResult {
///         if entity.class().name().starts_with("CDOTA_Unit_Hero_") {
///             let health: i32 = property!(entity, "m_iHealth");
///             println!("Hero {} health: {}", entity.class().name(), health);
///         }
///         Ok(())
///     }
/// }
/// # fn main() {}
/// ```
pub struct Parser<'a, R = SliceReader<'a>>
where
    R: BitsReader + MessageReader,
{
    pub(crate) reader: R,
    pub(crate) field_reader: FieldReader,

    pub(crate) observers: Vec<Box<dyn Observer + 'a>>,
    pub(crate) observer_masks: Vec<Interests>,
    pub(crate) global_mask: Interests,

    #[cfg(feature = "dota")]
    pub(crate) combat_log: VecDeque<CMsgDotaCombatLogEntry>,

    pub(crate) prologue_completed: bool,
    pub(crate) skip_deltas: bool,

    pub(crate) replay_info: CDemoFileInfo,
    pub(crate) last_tick: u32,
    pub(crate) context: Context,

    _phantom: std::marker::PhantomData<&'a ()>,
}

impl<'a> Parser<'a, SliceReader<'a>> {
    /// Creates a new parser instance from replay bytes.
    ///
    /// This method validates the replay file format and reads the file header.
    /// The replay data should remain valid for the lifetime of the parser.
    ///
    /// # Arguments
    ///
    /// * `replay` - Byte slice containing the demo file data (typically
    ///   memory-mapped)
    ///
    /// # Errors
    ///
    /// Returns [`ParserError::WrongMagic`] if the file is not a valid Source 2
    /// demo file. Returns [`ParserError::ReplayEncodingError`] if the file
    /// header is corrupted.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use source2_demo::prelude::*;
    /// use std::fs::File;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// // Using memory-mapped file (recommended for large files)
    /// let file = File::open("replay.dem")?;
    /// let replay = unsafe { memmap2::Mmap::map(&file)? };
    /// let parser = Parser::new(&replay)?;
    ///
    /// // Or read into memory (for small files)
    /// let replay = std::fs::read("replay.dem")?;
    /// let parser = Parser::new(&replay)?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn new(replay: &'a [u8]) -> Result<Self, ParserError> {
        let mut reader = SliceReader::new(replay);

        if replay.len() < 16 || reader.read_bytes(8) != b"PBDEMS2\0" {
            return Err(ParserError::WrongMagic);
        };

        reader.read_bytes(8);

        let replay_info = reader.read_replay_info()?;
        let last_tick = replay_info.playback_ticks() as u32;

        reader.seek(16);

        Ok(Parser {
            reader,
            field_reader: FieldReader::default(),

            observers: Vec::default(),
            observer_masks: Vec::default(),
            global_mask: Interests::empty(),

            #[cfg(feature = "dota")]
            combat_log: VecDeque::default(),

            prologue_completed: false,
            skip_deltas: false,

            context: Context::new(replay_info.clone()),

            replay_info,
            last_tick,
            _phantom: std::marker::PhantomData,
        })
    }

    /// Creates a new parser from replay bytes (same as `new`).
    ///
    /// This is an alias for [`Parser::new`] that makes it explicit if you're
    /// using a slice.
    ///
    /// # Arguments
    ///
    /// * `replay` - Byte slice containing the demo file data
    ///
    /// # Errors
    ///
    /// Returns [`ParserError::WrongMagic`] if the file is not a valid Source 2
    /// demo file.
    #[inline]
    pub fn from_slice(replay: &'a [u8]) -> Result<Self, ParserError> {
        Self::new(replay)
    }
}

impl<S> Parser<'static, SeekableReader<S>>
where
    S: std::io::Read + std::io::Seek,
{
    /// Creates a new parser from a reader.
    ///
    /// Uses SeekableReader for reading data from the reader, but internally
    /// uses SliceReader for parsing message buffers for maximum
    /// performance.
    ///
    /// # Arguments
    ///
    /// * `reader` - Any type implementing Read + Seek (e.g., File, Cursor,
    ///   BufReader)
    ///
    /// # Errors
    ///
    /// Returns an error if reading from the reader fails or data is invalid.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use source2_demo::prelude::*;
    /// use std::fs::File;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// let file = File::open("replay.dem")?;
    /// let mut parser = Parser::from_reader(file)?;
    /// parser.run_to_end()?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn from_reader(reader: S) -> Result<Self, ParserError> {
        let mut reader =
            SeekableReader::new(reader).map_err(|e| ParserError::IoError(e.to_string()))?;

        let magic = reader.read_bytes(8);
        if magic != b"PBDEMS2\0" {
            return Err(ParserError::WrongMagic);
        }

        reader.read_bytes(8);

        let replay_info = Self::read_file_info_from_reader(&mut reader)?;
        let last_tick = replay_info.playback_ticks() as u32;

        reader.seek(16);

        Ok(Parser {
            reader,
            field_reader: FieldReader::default(),
            observers: Vec::default(),
            observer_masks: Vec::default(),
            global_mask: Interests::empty(),

            #[cfg(feature = "dota")]
            combat_log: VecDeque::default(),

            prologue_completed: false,
            skip_deltas: false,

            context: Context::new(replay_info.clone()),

            replay_info,
            last_tick,
            _phantom: std::marker::PhantomData,
        })
    }

    fn read_file_info_from_reader(
        reader: &mut SeekableReader<S>,
    ) -> Result<CDemoFileInfo, ParserError> {
        reader.seek(8);
        let offset_bytes = reader.read_bytes(4);
        let offset = u32::from_le_bytes([
            offset_bytes[0],
            offset_bytes[1],
            offset_bytes[2],
            offset_bytes[3],
        ]) as usize;

        reader.seek(offset);

        if let Some(msg) = reader.read_next_message()? {
            Ok(CDemoFileInfo::decode(msg.buf.as_slice())?)
        } else {
            Err(ParserError::ReplayEncodingError)
        }
    }
}

impl<'a, R> Parser<'a, R>
where
    R: BitsReader + MessageReader,
{
    /// Returns a reference to the current parser context.
    ///
    /// The context contains the current state of the replay, including
    /// - Entities and their properties
    /// - String tables
    /// - Game events
    /// - Current tick and game build
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use source2_demo::prelude::*;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// # let replay = std::fs::File::open("replay.dem")?;
    /// let parser = Parser::from_reader(&replay)?;
    /// let ctx = parser.context();
    /// println!("Current tick: {}", ctx.tick());
    /// println!("Game build: {}", ctx.game_build());
    /// # Ok(())
    /// # }
    /// ```
    pub fn context(&self) -> &Context {
        &self.context
    }

    /// Returns replay file information.
    /// Contains metadata about the replay including:
    /// - Playback duration
    /// - Server information
    /// - Game-specific details
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use source2_demo::prelude::*;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// # let replay = std::fs::File::open("replay.dem")?;
    /// let parser = Parser::from_reader(&replay)?;
    /// let info = parser.replay_info();
    /// println!("Playback ticks: {}", info.playback_ticks());
    /// # Ok(())
    /// # }
    /// ```
    pub fn replay_info(&self) -> &CDemoFileInfo {
        &self.replay_info
    }

    /// Registers an observer and returns a reference-counted handle to it.
    ///
    /// Observers must implement the [`Observer`] trait and [`Default`].
    /// Use the `#[observer]` attribute macro to automatically implement the
    /// trait.
    ///
    /// The returned `Rc<RefCell<T>>` allows you to access the observer's state
    /// after parsing completes.
    ///
    /// # Type Parameters
    ///
    /// * `T` - Observer type that implements [`Observer`] and [`Default`]
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use source2_demo::prelude::*;
    /// use std::cell::RefCell;
    /// use std::rc::Rc;
    ///
    /// #[derive(Default)]
    /// struct Stats {
    ///     message_count: usize,
    /// }
    ///
    /// #[observer]
    /// impl Stats {
    ///     #[on_message]
    ///     fn on_chat(&mut self, ctx: &Context, msg: CDotaUserMsgChatMessage) -> ObserverResult {
    ///         self.message_count += 1;
    ///         Ok(())
    ///     }
    /// }
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// # let replay = std::fs::File::open("replay.dem")?;
    /// let mut parser = Parser::from_reader(&replay)?;
    /// let stats = parser.register_observer::<Stats>();
    /// parser.run_to_end()?;
    ///
    /// println!("Total messages: {}", stats.borrow().message_count);
    /// # Ok(())
    /// # }
    /// ```
    pub fn register_observer<T>(&mut self) -> Rc<RefCell<T>>
    where
        T: Observer + Default + 'a,
    {
        self.add_observer(T::default())
    }

    /// Adds an already constructed observer and returns a handle to its state.
    ///
    /// Use this when the observer needs custom constructor state. Observers run
    /// in registration order.
    pub fn add_observer<T>(&mut self, observer: T) -> Rc<RefCell<T>>
    where
        T: Observer + 'a,
    {
        let rc = Rc::new(RefCell::new(observer));
        let mask = rc.borrow().interests();
        self.global_mask |= mask;
        self.observer_masks.push(mask);
        self.observers.push(Box::new(rc.clone()));
        rc
    }

    #[inline]
    fn anyone_interested(&self, flag: Interests) -> bool {
        self.global_mask.intersects(flag)
    }

    pub(crate) fn prologue(&mut self) -> Result<(), ParserError> {
        if self.prologue_completed && self.context.tick != u32::MAX {
            return Ok(());
        }

        while let Some(message) = self.reader.read_next_message()? {
            if self.prologue_completed
                && (message.msg_type == EDemoCommands::DemSendTables
                    || message.msg_type == EDemoCommands::DemClassInfo)
            {
                continue;
            }

            self.on_demo_command(message.msg_type, message.buf.as_slice())?;

            if message.msg_type == EDemoCommands::DemSyncTick {
                self.prologue_completed = true;
                break;
            }
        }

        Ok(())
    }

    pub(crate) fn on_demo_command(
        &mut self,
        msg_type: EDemoCommands,
        msg: &[u8],
    ) -> Result<(), ParserError> {
        match msg_type {
            EDemoCommands::DemSendTables => {
                self.dem_send_tables(CDemoSendTables::decode(msg)?)?;
            }
            EDemoCommands::DemClassInfo => {
                self.dem_class_info(CDemoClassInfo::decode(msg)?)?;
            }
            EDemoCommands::DemPacket | EDemoCommands::DemSignonPacket => {
                self.dem_packet(CDemoPacket::decode(msg)?)?;
            }
            EDemoCommands::DemFullPacket => self.dem_full_packet(CDemoFullPacket::decode(msg)?)?,
            EDemoCommands::DemStringTables => {
                self.dem_string_tables(CDemoStringTables::decode(msg)?)?
            }
            EDemoCommands::DemStop => {
                self.dem_stop()?;
            }
            _ => {}
        };

        try_observers!(
            self,
            DEMO_MESSAGE,
            on_demo_command(&self.context, msg_type, msg)
        )?;
        Ok(())
    }
}

impl<S> Parser<'static, SeekableReader<S>>
where
    S: std::io::Read + std::io::Seek,
{
    /// Extracts match details from a Deadlock replay.
    ///
    /// This method scans through the replay to find and extract post-match
    /// details specific to Deadlock games. It searches for the
    /// `KEUserMsgPostMatchDetails` message and returns the decoded match
    /// metadata.
    ///
    /// # Errors
    ///
    /// Returns `ParserError::MatchDetailsNotFound` if the match details message
    /// cannot be found in the replay.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// let replay = std::fs::File::open("deadlock_replay.dem")?;
    /// let mut parser = Parser::from_reader(&replay)?;
    /// let match_details = parser.deadlock_match_details()?;
    /// println!("Match info available: {}", match_details.match_info.is_some());
    ///
    /// Ok(())
    /// }
    /// ```
    #[cfg(feature = "deadlock")]
    pub fn deadlock_match_details(&mut self) -> Result<CMsgMatchMetaDataContents, ParserError> {
        self.reader.read_deadlock_match_details()
    }
}

impl<'a> Parser<'a, SliceReader<'a>> {
    /// Extracts match details from a Deadlock replay.
    ///
    /// This method scans through the replay to find and extract post-match
    /// details specific to Deadlock games. It searches for the
    /// `KEUserMsgPostMatchDetails` message and returns the decoded match
    /// metadata.
    ///
    /// # Errors
    ///
    /// Returns `ParserError::MatchDetailsNotFound` if the match details message
    /// cannot be found in the replay.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn main() -> anyhow::Result<()> {
    /// let replay = std::fs::read("deadlock_replay.dem")?;
    /// let mut parser = Parser::new(&replay)?;
    /// let match_details = parser.deadlock_match_details()?;
    /// println!("Match info available: {}", match_details.match_info.is_some());
    ///
    /// Ok(())
    /// }
    /// ```
    #[cfg(feature = "deadlock")]
    pub fn deadlock_match_details(&mut self) -> Result<CMsgMatchMetaDataContents, ParserError> {
        self.reader.read_deadlock_match_details()
    }
}
