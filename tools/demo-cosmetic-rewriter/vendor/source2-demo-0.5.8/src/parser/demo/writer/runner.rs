use crate::error::ParserError;
use crate::parser::demo::writer::commands::DemoCommandWrite;
use crate::parser::demo::writer::{DemoWriter, MessageRewrite, RawDemoMessage, RewriteInterests};
use crate::reader::{BitsReader, MessageReader};
use std::io::{Seek, Write};

pub(crate) enum DemoMessageRewrite {
    Keep(Option<Vec<u8>>),
    Drop,
}

impl<'a, R, W> DemoWriter<'a, R, W>
where
    R: BitsReader + MessageReader,
    W: Write + Seek,
{
    /// Parses the demo while writing the rewritten stream.
    pub fn run(&mut self) -> Result<(), ParserError> {
        self.parser.reader.seek(0);
        let header = self.parser.reader.read_bytes(16);
        self.writer.write_all(&header)?;
        self.bytes_written = header.len() as u64;

        while let Some(message) = self.read_next_raw_message()? {
            self.update_context_tick(message.tick);

            let payload = match self.rewrite_demo_message(&message)? {
                DemoMessageRewrite::Keep(payload) => payload,
                DemoMessageRewrite::Drop => continue,
            };

            if matches!(
                self.write_demo_command(&message, payload)?,
                DemoCommandWrite::Dropped
            ) {
                continue;
            }
        }

        self.finalize_header_offsets()?;
        Ok(())
    }

    fn rewrite_demo_message(
        &mut self,
        message: &RawDemoMessage,
    ) -> Result<DemoMessageRewrite, ParserError> {
        let mut payload = None;
        if self.has_rewriters(RewriteInterests::DEMO_MESSAGE) {
            let mut decoded = Self::decode_raw_payload(message)?;
            let ctx = &self.parser.context;
            for rewriter in self.rewriters.iter_mut().filter(|rewriter| {
                rewriter
                    .interests()
                    .contains(RewriteInterests::DEMO_MESSAGE)
            }) {
                match rewriter.rewrite_demo_message(
                    ctx,
                    message.tick,
                    message.msg_type,
                    decoded.as_slice(),
                )? {
                    MessageRewrite::Drop => return Ok(DemoMessageRewrite::Drop),
                    MessageRewrite::Replace(bytes) => decoded = bytes,
                    MessageRewrite::Keep | MessageRewrite::Rewrite => {}
                }
            }
            payload = Some(decoded);
        }

        Ok(DemoMessageRewrite::Keep(payload))
    }

    fn update_context_tick(&mut self, tick: u32) {
        self.parser.context.previous_tick = self.parser.context.tick;
        self.parser.context.tick = tick;
    }
}
