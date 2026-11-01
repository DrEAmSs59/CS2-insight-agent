//! Offline suppression of the rules-state EndOfMatch trigger. No native offsets.
use crate::header::validate_demo_layout;
use crate::verify::sha256_file as sha256;
use crate::workflow::{ensure_same_demo_metadata, resolve_new_output, TempArtifact};
use anyhow::{bail, Result};
use serde::Serialize;
use source2_demo::prelude::*;
use source2_demo::writer::{DemoRewriter, DemoWriter, RewriteInterests};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Seek, SeekFrom, Write},
    path::Path,
};

const LIVE_PHASE: i32 = 3;
const ENDED_PHASE: i32 = 5;

#[derive(Clone, Default, Debug, Serialize)]
pub struct PhaseAudit {
    pub fields_seen: usize,
    pub values: BTreeMap<i32, usize>,
    pub first_live_tick: Option<u32>,
    pub first_terminal_tick: Option<u32>,
    pub last_terminal_tick: Option<u32>,
    pub terminal_fields: usize,
    pub invalid_fields: usize,
}

impl PhaseAudit {
    fn observe(&mut self, tick: u32, value: &FieldValue) {
        self.fields_seen += 1;
        let Some(phase) = phase_number(value) else {
            self.invalid_fields += 1;
            return;
        };
        *self.values.entry(phase).or_default() += 1;
        let tick = if tick == u32::MAX { 0 } else { tick };
        if phase == LIVE_PHASE {
            self.first_live_tick = Some(self.first_live_tick.map_or(tick, |old| old.min(tick)));
        }
        if phase == ENDED_PHASE {
            self.terminal_fields += 1;
            self.first_terminal_tick =
                Some(self.first_terminal_tick.map_or(tick, |old| old.min(tick)));
            self.last_terminal_tick =
                Some(self.last_terminal_tick.map_or(tick, |old| old.max(tick)));
        }
    }
    fn validate(&self) -> Result<()> {
        if self.invalid_fields != 0 {
            bail!("unsupported m_gamePhase field encoding");
        }
        if let Some(ended) = self.first_terminal_tick {
            if !self.first_live_tick.is_some_and(|live| live < ended) {
                bail!("terminal phase has no earlier observed live phase; refusing to invent match state");
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct TerminalPhaseReport {
    pub schema_version: u32,
    pub changed: bool,
    pub input_sha256: String,
    pub output_sha256: Option<String>,
    pub replacement_phase: i32,
    pub input: PhaseAudit,
    pub output: PhaseAudit,
    pub rewritten_fields: usize,
}

fn phase_number(value: &FieldValue) -> Option<i32> {
    match value {
        FieldValue::Signed8(v) => Some(*v as i32),
        FieldValue::Signed16(v) => Some(*v as i32),
        FieldValue::Signed32(v) => Some(*v),
        FieldValue::Signed64(v) => i32::try_from(*v).ok(),
        FieldValue::Unsigned8(v) => Some(*v as i32),
        FieldValue::Unsigned16(v) => Some(*v as i32),
        FieldValue::Unsigned32(v) => i32::try_from(*v).ok(),
        FieldValue::Unsigned64(v) => i32::try_from(*v).ok(),
        _ => None,
    }
}

fn live_value(value: &FieldValue) -> Option<FieldValue> {
    Some(match value {
        FieldValue::Signed8(_) => FieldValue::Signed8(LIVE_PHASE as i8),
        FieldValue::Signed16(_) => FieldValue::Signed16(LIVE_PHASE as i16),
        FieldValue::Signed32(_) => FieldValue::Signed32(LIVE_PHASE),
        FieldValue::Signed64(_) => FieldValue::Signed64(LIVE_PHASE as i64),
        FieldValue::Unsigned8(_) => FieldValue::Unsigned8(LIVE_PHASE as u8),
        FieldValue::Unsigned16(_) => FieldValue::Unsigned16(LIVE_PHASE as u16),
        FieldValue::Unsigned32(_) => FieldValue::Unsigned32(LIVE_PHASE as u32),
        FieldValue::Unsigned64(_) => FieldValue::Unsigned64(LIVE_PHASE as u64),
        _ => return None,
    })
}

#[derive(Default)]
struct PhaseRewriter {
    rewrite: bool,
    audit: PhaseAudit,
    rewritten: usize,
}
impl DemoRewriter for PhaseRewriter {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::ENTITY_FIELDS
    }
    fn should_track_entity(&mut self, _: &Context, _: EntityEvents, entity: &Entity) -> bool {
        entity.class().name().ends_with("CSGameRulesProxy")
    }
    fn should_rewrite_entity(&mut self, _: &Context, _: EntityEvents, entity: &Entity) -> bool {
        entity.class().name().ends_with("CSGameRulesProxy")
    }
    fn replace_entity_field(
        &mut self,
        ctx: &Context,
        _: EntityEvents,
        _: &Entity,
        field: &str,
        value: &FieldValue,
    ) -> Option<FieldValue> {
        if field.rsplit('.').next() != Some("m_gamePhase") {
            return None;
        }
        self.audit.observe(ctx.tick(), value);
        if self.rewrite && phase_number(value) == Some(ENDED_PHASE) {
            let result = live_value(value);
            if result.is_some() {
                self.rewritten += 1;
            }
            result
        } else {
            None
        }
    }
}

// Audit through the writer's raw field callbacks: unlike sequential Observer
// state, this also visits non-anchor DEM_FullPacket snapshots and baselines.
#[derive(Default)]
struct CountingSink {
    position: u64,
    length: u64,
}
impl Write for CountingSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.position += bytes.len() as u64;
        self.length = self.length.max(self.position);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Seek for CountingSink {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let next = match from {
            SeekFrom::Start(value) => value as i128,
            SeekFrom::Current(value) => self.position as i128 + value as i128,
            SeekFrom::End(value) => self.length as i128 + value as i128,
        };
        self.position = u64::try_from(next)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid audit seek"))?;
        Ok(self.position)
    }
}

fn audit(path: &Path) -> Result<PhaseAudit> {
    let mut writer = DemoWriter::from_reader(File::open(path)?, CountingSink::default())?;
    let state = writer.add_rewriter(PhaseRewriter::default());
    writer.run()?;
    let result = state.borrow().audit.clone();
    Ok(result)
}

// Keep every outer command and tick, including terminal metadata and seek anchors.
fn timeline(path: &Path) -> Result<Vec<(u32, u32)>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(16))?;
    let mut frames = Vec::new();
    while file.stream_position()? < length {
        let command = crate::header::read_varint(&mut file)? & !64;
        let tick = crate::header::read_varint(&mut file)?;
        let size = crate::header::read_varint(&mut file)?;
        let end = file
            .stream_position()?
            .checked_add(u64::from(size))
            .filter(|end| *end <= length)
            .ok_or_else(|| anyhow::anyhow!("demo frame exceeds EOF"))?;
        frames.push((command, tick));
        file.seek(SeekFrom::Start(end))?;
    }
    Ok(frames)
}

pub fn repair_terminal_phase(input: &Path, output: &Path) -> Result<TerminalPhaseReport> {
    let input = std::fs::canonicalize(input)?;
    let output = resolve_new_output(output)?;
    if input == output {
        bail!("source demo must not be overwritten");
    }
    let before = sha256(&input)?;
    let layout = validate_demo_layout(&input)?;
    let original_timeline = timeline(&input)?;
    let scan = audit(&input)?;
    scan.validate()?;
    if scan.terminal_fields == 0 {
        return Ok(TerminalPhaseReport {
            schema_version: 1,
            changed: false,
            input_sha256: before,
            output_sha256: None,
            replacement_phase: LIVE_PHASE,
            input: scan.clone(),
            output: scan,
            rewritten_fields: 0,
        });
    }
    let (mut temp, file) = TempArtifact::create(&output, "terminal-phase")?;
    let mut writer = DemoWriter::from_reader(File::open(&input)?, file)?;
    let state = writer.add_rewriter(PhaseRewriter {
        rewrite: true,
        ..Default::default()
    });
    writer.run()?;
    drop(writer);
    let count = state.borrow().rewritten;
    if count != scan.terminal_fields {
        bail!("terminal phase rewrite count differs from input audit");
    }
    let after = audit(temp.path())?;
    if after.terminal_fields != 0
        || after.invalid_fields != 0
        || after.fields_seen != scan.fields_seen
    {
        bail!("terminal phase verification failed");
    }
    let mut expected = scan.values.clone();
    expected.remove(&ENDED_PHASE);
    *expected.entry(LIVE_PHASE).or_default() += count;
    if after.values != expected || timeline(temp.path())? != original_timeline {
        bail!("rewrite changed other phase values or the outer demo timeline");
    }
    let next_layout = validate_demo_layout(temp.path())?;
    ensure_same_demo_metadata(&layout, &next_layout)?;
    if sha256(&input)? != before {
        bail!("source demo changed during terminal phase rewrite");
    }
    let output_hash = sha256(temp.path())?;
    temp.commit_to(&output)?;
    Ok(TerminalPhaseReport {
        schema_version: 1,
        changed: true,
        input_sha256: before,
        output_sha256: Some(output_hash),
        replacement_phase: LIVE_PHASE,
        input: scan,
        output: after,
        rewritten_fields: count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn post_match_only_or_out_of_order_state_is_rejected() {
        for live in [None, Some(100), Some(101)] {
            let scan = PhaseAudit {
                first_live_tick: live,
                first_terminal_tick: Some(100),
                terminal_fields: 1,
                ..Default::default()
            };
            assert!(scan.validate().is_err());
        }
        assert!(PhaseAudit {
            first_live_tick: Some(99),
            first_terminal_tick: Some(100),
            terminal_fields: 1,
            ..Default::default()
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn replacement_preserves_signedness_and_integer_width() {
        for value in [
            FieldValue::Signed8(5),
            FieldValue::Signed16(5),
            FieldValue::Signed32(5),
            FieldValue::Signed64(5),
            FieldValue::Unsigned8(5),
            FieldValue::Unsigned16(5),
            FieldValue::Unsigned32(5),
            FieldValue::Unsigned64(5),
        ] {
            let replacement = live_value(&value).unwrap();
            assert_eq!(phase_number(&replacement), Some(3));
            assert_eq!(
                std::mem::discriminant(&value),
                std::mem::discriminant(&replacement)
            );
        }
    }
    #[test]
    fn unknown_field_encoding_is_not_accepted_as_clean() {
        let mut scan = PhaseAudit::default();
        scan.observe(100, &FieldValue::String("5".into()));
        assert!(scan.validate().is_err());
    }
}
