use anyhow::{Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use source2_demo::error::EntityError;
use source2_demo::prelude::*;
use source2_demo::proto::CSvcMsgServerInfo;
use source2_demo::writer::{DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

const WORKER_STACK_SIZE: usize = 64 * 1024 * 1024;

const REQUESTED_FIELDS: &[&str] = &[
    "m_bIsLocalPlayerController",
    "m_bIsHLTV",
    "m_iConnected",
    "m_hPawn",
    "m_hPlayerPawn",
    "m_hObserverPawn",
    "m_bPawnIsAlive",
    "m_iPawnHealth",
    "m_iTeamNum",
    "m_iCompTeammateColor",
    "m_hController",
    "m_hDefaultController",
    "m_hOriginalController",
    "m_iPlayerState",
    "m_iHideHUD",
    "m_iObserverMode",
    "m_hObserverTarget",
    "m_steamID",
    "m_iszPlayerName",
    "m_sSanitizedPlayerName",
];

const NAME_FIELDS: &[&str] = &["m_iszPlayerName", "m_sSanitizedPlayerName"];
const PAWN_HANDLE_FIELDS: &[&str] = &["m_hPawn", "m_hPlayerPawn", "m_hObserverPawn"];
const CONTROLLER_HANDLE_FIELDS: &[&str] =
    &["m_hController", "m_hDefaultController", "m_hOriginalController"];

#[derive(Debug, ClapParser)]
#[command(name = "demo-hud-audit")]
#[command(about = "Read-only Controller/Pawn serializer and delta audit for CS2 demos")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long, default_value = "donk")]
    target_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct FieldDatum {
    decoded_type: String,
    value: JsonValue,
}

impl FieldDatum {
    fn from_field(value: &FieldValue) -> Self {
        Self {
            decoded_type: value.type_name().to_owned(),
            value: field_value_json(value),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct ServerInfoSnapshot {
    tick: u32,
    player_slot: i32,
    is_hltv: bool,
    max_clients: i32,
    max_classes: i32,
}

#[derive(Clone, Debug, Serialize)]
struct FieldOccurrence {
    tick: u32,
    event: String,
    value: FieldDatum,
}

#[derive(Clone, Debug, Serialize)]
struct FieldTimeline {
    requested_field: String,
    actual_path: String,
    decoded_type: String,
    occurrence_count: usize,
    created_occurrence_count: usize,
    updated_occurrence_count: usize,
    first_tick: u32,
    last_tick: u32,
    first_created_value: Option<FieldOccurrence>,
    value_transitions: Vec<FieldOccurrence>,
    existing_only_rewrite_candidate: bool,
}

#[derive(Default)]
struct FieldTimelineBuilder {
    requested_field: String,
    actual_path: String,
    decoded_type: String,
    occurrence_count: usize,
    created_occurrence_count: usize,
    updated_occurrence_count: usize,
    first_tick: Option<u32>,
    last_tick: Option<u32>,
    first_created_value: Option<FieldOccurrence>,
    value_transitions: Vec<FieldOccurrence>,
    last_value: Option<FieldDatum>,
}

impl FieldTimelineBuilder {
    fn record(
        &mut self,
        requested_field: &str,
        actual_path: &str,
        tick: u32,
        event: EntityEvents,
        value: &FieldValue,
    ) {
        let datum = FieldDatum::from_field(value);
        let event_name = event_name(event).to_owned();
        self.requested_field = requested_field.to_owned();
        self.actual_path = actual_path.to_owned();
        self.decoded_type = value.type_name().to_owned();
        self.occurrence_count += 1;
        self.first_tick.get_or_insert(tick);
        self.last_tick = Some(tick);
        match event {
            EntityEvents::Created => {
                self.created_occurrence_count += 1;
                if self.first_created_value.is_none() {
                    self.first_created_value = Some(FieldOccurrence {
                        tick,
                        event: event_name.clone(),
                        value: datum.clone(),
                    });
                }
            }
            EntityEvents::Updated => self.updated_occurrence_count += 1,
            EntityEvents::Deleted => {}
        }
        if self.last_value.as_ref() != Some(&datum) {
            self.value_transitions.push(FieldOccurrence {
                tick,
                event: event_name,
                value: datum.clone(),
            });
        }
        self.last_value = Some(datum);
    }

    fn finish(&self) -> FieldTimeline {
        FieldTimeline {
            requested_field: self.requested_field.clone(),
            actual_path: self.actual_path.clone(),
            decoded_type: self.decoded_type.clone(),
            occurrence_count: self.occurrence_count,
            created_occurrence_count: self.created_occurrence_count,
            updated_occurrence_count: self.updated_occurrence_count,
            first_tick: self.first_tick.unwrap_or_default(),
            last_tick: self.last_tick.unwrap_or_default(),
            first_created_value: self.first_created_value.clone(),
            value_transitions: self.value_transitions.clone(),
            existing_only_rewrite_candidate: self.occurrence_count > 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct EntityStateSnapshot {
    tick: u32,
    event: String,
    fields: BTreeMap<String, FieldDatum>,
}

#[derive(Clone, Debug, Serialize)]
struct EntityAudit {
    class_name: String,
    entity_index: u32,
    serial: u32,
    handle: u32,
    derived_player_slot_zero_based: Option<u32>,
    first_seen_tick: u32,
    last_seen_tick: u32,
    names_seen: Vec<String>,
    steam_ids_seen: Vec<u64>,
    teams_seen: Vec<u64>,
    pawn_handles_seen: Vec<u32>,
    controller_handles_seen: Vec<u32>,
    latest_name: Option<String>,
    latest_steam_id: Option<u64>,
    latest_team: Option<u64>,
    latest_pawn_handle: Option<u32>,
    latest_controller_handle: Option<u32>,
    latest_is_local_player_controller: Option<bool>,
    latest_is_hltv: Option<bool>,
    state_transitions: Vec<EntityStateSnapshot>,
    delta_field_timelines: Vec<FieldTimeline>,
}

struct EntityAuditBuilder {
    class_name: String,
    entity_index: u32,
    serial: u32,
    handle: u32,
    first_seen_tick: Option<u32>,
    last_seen_tick: Option<u32>,
    names_seen: BTreeSet<String>,
    steam_ids_seen: BTreeSet<u64>,
    teams_seen: BTreeSet<u64>,
    pawn_handles_seen: BTreeSet<u32>,
    controller_handles_seen: BTreeSet<u32>,
    latest_name: Option<String>,
    latest_steam_id: Option<u64>,
    latest_team: Option<u64>,
    latest_pawn_handle: Option<u32>,
    latest_controller_handle: Option<u32>,
    latest_is_local_player_controller: Option<bool>,
    latest_is_hltv: Option<bool>,
    last_created_state: Option<BTreeMap<String, FieldDatum>>,
    state_transitions: Vec<EntityStateSnapshot>,
    timelines: BTreeMap<String, FieldTimelineBuilder>,
}

impl EntityAuditBuilder {
    fn new(entity: &Entity) -> Self {
        Self {
            class_name: entity.class().name().to_owned(),
            entity_index: entity.index(),
            serial: entity.serial(),
            handle: entity.handle(),
            first_seen_tick: None,
            last_seen_tick: None,
            names_seen: BTreeSet::new(),
            steam_ids_seen: BTreeSet::new(),
            teams_seen: BTreeSet::new(),
            pawn_handles_seen: BTreeSet::new(),
            controller_handles_seen: BTreeSet::new(),
            latest_name: None,
            latest_steam_id: None,
            latest_team: None,
            latest_pawn_handle: None,
            latest_controller_handle: None,
            latest_is_local_player_controller: None,
            latest_is_hltv: None,
            last_created_state: None,
            state_transitions: Vec::new(),
            timelines: BTreeMap::new(),
        }
    }

    fn record_delta(
        &mut self,
        requested_field: &str,
        actual_path: &str,
        tick: u32,
        event: EntityEvents,
        value: &FieldValue,
    ) {
        self.first_seen_tick.get_or_insert(tick);
        self.last_seen_tick = Some(tick);
        self.record_identity_value(requested_field, value);
        self.timelines
            .entry(actual_path.to_owned())
            .or_default()
            .record(requested_field, actual_path, tick, event, value);
    }

    fn record_created_state(&mut self, tick: u32, entity: &Entity) {
        self.first_seen_tick.get_or_insert(tick);
        self.last_seen_tick = Some(tick);

        let mut state = BTreeMap::new();
        for requested in REQUESTED_FIELDS {
            let Ok(value) = entity.get_property(requested) else {
                continue;
            };
            self.record_identity_value(requested, value);
            state.insert((*requested).to_owned(), FieldDatum::from_field(value));
        }
        if !state.is_empty() && self.last_created_state.as_ref() != Some(&state) {
            self.state_transitions.push(EntityStateSnapshot {
                tick,
                event: event_name(EntityEvents::Created).to_owned(),
                fields: state.clone(),
            });
            self.last_created_state = Some(state);
        }
    }

    fn record_seen_tick(&mut self, tick: u32) {
        self.first_seen_tick.get_or_insert(tick);
        self.last_seen_tick = Some(tick);
    }

    fn record_identity_value(&mut self, requested_field: &str, value: &FieldValue) {
        if NAME_FIELDS.contains(&requested_field) {
            if let Some(value) = as_string(value).filter(|value| !value.trim().is_empty()) {
                self.names_seen.insert(value.clone());
                self.latest_name = Some(value);
            }
            return;
        }
        if requested_field == "m_steamID" {
            if let Some(value) = as_u64(value) {
                self.steam_ids_seen.insert(value);
                self.latest_steam_id = Some(value);
            }
            return;
        }
        if requested_field == "m_iTeamNum" {
            if let Some(value) = as_u64(value) {
                self.teams_seen.insert(value);
                self.latest_team = Some(value);
            }
            return;
        }
        if PAWN_HANDLE_FIELDS.contains(&requested_field) {
            if let Some(value) = as_u64(value).and_then(valid_handle) {
                self.pawn_handles_seen.insert(value);
                self.latest_pawn_handle = Some(value);
            }
            return;
        }
        if CONTROLLER_HANDLE_FIELDS.contains(&requested_field) {
            if let Some(value) = as_u64(value).and_then(valid_handle) {
                self.controller_handles_seen.insert(value);
                self.latest_controller_handle = Some(value);
            }
            return;
        }
        if requested_field == "m_bIsLocalPlayerController" {
            self.latest_is_local_player_controller = as_bool(value);
        } else if requested_field == "m_bIsHLTV" {
            self.latest_is_hltv = as_bool(value);
        }
    }

    fn finish(&self) -> EntityAudit {
        EntityAudit {
            class_name: self.class_name.clone(),
            entity_index: self.entity_index,
            serial: self.serial,
            handle: self.handle,
            derived_player_slot_zero_based: derived_player_slot(self.entity_index),
            first_seen_tick: self.first_seen_tick.unwrap_or_default(),
            last_seen_tick: self.last_seen_tick.unwrap_or_default(),
            names_seen: self.names_seen.iter().cloned().collect(),
            steam_ids_seen: self.steam_ids_seen.iter().copied().collect(),
            teams_seen: self.teams_seen.iter().copied().collect(),
            pawn_handles_seen: self.pawn_handles_seen.iter().copied().collect(),
            controller_handles_seen: self.controller_handles_seen.iter().copied().collect(),
            latest_name: self.latest_name.clone(),
            latest_steam_id: self.latest_steam_id,
            latest_team: self.latest_team,
            latest_pawn_handle: self.latest_pawn_handle,
            latest_controller_handle: self.latest_controller_handle,
            latest_is_local_player_controller: self.latest_is_local_player_controller,
            latest_is_hltv: self.latest_is_hltv,
            state_transitions: self.state_transitions.clone(),
            delta_field_timelines: self.timelines.values().map(FieldTimelineBuilder::finish).collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct ResolvedSerializerPath {
    actual_path: String,
    field_type: String,
    decoded_type_seen: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct RequestedFieldAvailability {
    requested_field: String,
    exact_path_in_serializer: bool,
    serializer_available: bool,
    resolved_paths: Vec<ResolvedSerializerPath>,
}

#[derive(Clone, Debug, Serialize)]
struct ClassSchemaAudit {
    class_name: String,
    requested_fields: Vec<RequestedFieldAvailability>,
}

#[derive(Default)]
struct AvailabilityBuilder {
    exact_path_in_serializer: bool,
    resolved_paths: BTreeMap<String, ResolvedSerializerPath>,
}

#[derive(Clone, Debug, Serialize)]
struct IdentityComparison {
    field: String,
    source_tv_value: Option<FieldDatum>,
    target_value: Option<FieldDatum>,
    differs: Option<bool>,
}

#[derive(Serialize)]
struct SourceDemo {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Serialize)]
struct AuditReport {
    format_version: u32,
    probe: String,
    source_demo: SourceDemo,
    target_name: String,
    requested_fields: Vec<String>,
    server_info: Vec<ServerInfoSnapshot>,
    class_schemas: Vec<ClassSchemaAudit>,
    controllers: Vec<EntityAudit>,
    pawns: Vec<EntityAudit>,
    target_controller_handles: Vec<u32>,
    source_tv_controller_handles: Vec<u32>,
    source_tv_vs_target: Vec<IdentityComparison>,
    conclusions: Vec<String>,
}

#[derive(Default)]
struct HudAuditRewriter {
    server_info: Vec<ServerInfoSnapshot>,
    class_schemas: BTreeMap<String, BTreeMap<String, AvailabilityBuilder>>,
    fully_scanned_schema_classes: BTreeSet<String>,
    entities: BTreeMap<u32, EntityAuditBuilder>,
    started_at: Option<Instant>,
    last_progress_tick: Option<u32>,
}

impl HudAuditRewriter {
    fn entity_builder(&mut self, entity: &Entity) -> &mut EntityAuditBuilder {
        self.entities
            .entry(entity.handle())
            .or_insert_with(|| EntityAuditBuilder::new(entity))
    }

    fn scan_schema(&mut self, entity: &Entity, fields: &[EntityField<'_>]) {
        let class_name = entity.class().name().to_owned();
        let availability = self.class_schemas.entry(class_name).or_default();
        for requested in REQUESTED_FIELDS {
            let exact = match entity.get_property(requested) {
                Ok(_) | Err(EntityError::PropertyNameNotFound(_, _, _)) => true,
                Err(EntityError::FieldPathNotFound(_)) => false,
                Err(_) => false,
            };
            let entry = availability.entry((*requested).to_owned()).or_default();
            entry.exact_path_in_serializer |= exact;
        }
        for field in fields {
            let Some(requested) = requested_field_for_actual(&field.name) else {
                continue;
            };
            let resolved =
                availability
                .entry(requested.to_owned())
                .or_default()
                .resolved_paths
                .entry(field.name.clone())
                .or_insert_with(|| ResolvedSerializerPath {
                    actual_path: field.name.clone(),
                    field_type: field.field_type.clone(),
                    decoded_type_seen: field.value.map(|value| value.type_name().to_owned()),
                });
            resolved.field_type = field.field_type.clone();
            if resolved.decoded_type_seen.is_none() {
                resolved.decoded_type_seen =
                    field.value.map(|value| value.type_name().to_owned());
            }
        }
    }

    fn record_resolved_delta_path(
        &mut self,
        entity: &Entity,
        requested: &str,
        actual_path: &str,
        value: &FieldValue,
    ) {
        self.class_schemas
            .entry(entity.class().name().to_owned())
            .or_default()
            .entry(requested.to_owned())
            .or_default()
            .resolved_paths
            .entry(actual_path.to_owned())
            .or_insert_with(|| ResolvedSerializerPath {
                actual_path: actual_path.to_owned(),
                field_type: "not enumerated; observed in entity delta".to_owned(),
                decoded_type_seen: Some(value.type_name().to_owned()),
            });
    }

    fn report_progress(&mut self, tick: u32) {
        let started = self.started_at.get_or_insert_with(Instant::now);
        let should_report = match (tick, self.last_progress_tick) {
            (u32::MAX, Some(u32::MAX)) => false,
            (u32::MAX, _) => true,
            (_, Some(u32::MAX)) => true,
            (_, Some(previous)) => tick >= previous.saturating_add(5_000),
            (_, None) => true,
        };
        if should_report {
            eprintln!(
                "[demo-hud-audit] tick={tick} elapsed={:.1}s controllers_or_pawns={}",
                started.elapsed().as_secs_f64(),
                self.entities.len()
            );
            self.last_progress_tick = Some(tick);
        }
    }

    fn build_report(
        &self,
        input: &Path,
        bytes: u64,
        sha256: String,
        target_name: &str,
    ) -> AuditReport {
        let controllers = self
            .entities
            .values()
            .filter(|entity| entity.class_name == "CCSPlayerController")
            .map(EntityAuditBuilder::finish)
            .collect::<Vec<_>>();
        let pawns = self
            .entities
            .values()
            .filter(|entity| is_pawn_class(&entity.class_name))
            .map(EntityAuditBuilder::finish)
            .collect::<Vec<_>>();
        let target_handles = controllers
            .iter()
            .filter(|entity| {
                entity
                    .names_seen
                    .iter()
                    .any(|name| name.eq_ignore_ascii_case(target_name))
            })
            .map(|entity| entity.handle)
            .collect::<Vec<_>>();
        let source_tv_handles = controllers
            .iter()
            .filter(|entity| is_source_tv_candidate(entity))
            .map(|entity| entity.handle)
            .collect::<Vec<_>>();

        let source_tv = source_tv_handles
            .first()
            .and_then(|handle| controllers.iter().find(|entity| entity.handle == *handle));
        let target = target_handles
            .first()
            .and_then(|handle| controllers.iter().find(|entity| entity.handle == *handle));
        let comparison = match (source_tv, target) {
            (Some(source_tv), Some(target)) => compare_entities(source_tv, target),
            _ => Vec::new(),
        };

        let mut conclusions = Vec::new();
        if target_handles.is_empty() {
            conclusions.push(format!(
                "No CCSPlayerController matched target name {target_name:?}."
            ));
        } else {
            conclusions.push(format!(
                "Matched target {target_name:?} to controller handle(s) {:?}.",
                target_handles
            ));
        }
        if source_tv_handles.is_empty() {
            conclusions.push(
                "No SourceTV/HLTV CCSPlayerController candidate was found; the local HLTV identity may live outside player Controller entities."
                    .to_owned(),
            );
        } else {
            conclusions.push(format!(
                "SourceTV/HLTV controller candidate handle(s): {:?}.",
                source_tv_handles
            ));
        }
        conclusions.extend(field_candidate_conclusions(&controllers, &pawns));

        AuditReport {
            format_version: 1,
            probe: "Probe 4A - read-only serializer and Controller/Pawn delta audit".to_owned(),
            source_demo: SourceDemo {
                path: input.display().to_string(),
                bytes,
                sha256,
            },
            target_name: target_name.to_owned(),
            requested_fields: REQUESTED_FIELDS
                .iter()
                .map(|field| (*field).to_owned())
                .collect(),
            server_info: self.server_info.clone(),
            class_schemas: self
                .class_schemas
                .iter()
                .map(|(class_name, fields)| ClassSchemaAudit {
                    class_name: class_name.clone(),
                    requested_fields: fields
                        .iter()
                        .map(|(requested, availability)| RequestedFieldAvailability {
                            requested_field: requested.clone(),
                            exact_path_in_serializer: availability.exact_path_in_serializer,
                            serializer_available: availability.exact_path_in_serializer
                                || !availability.resolved_paths.is_empty(),
                            resolved_paths: availability
                                .resolved_paths
                                .values()
                                .cloned()
                                .collect(),
                        })
                        .collect(),
                })
                .collect(),
            controllers,
            pawns,
            target_controller_handles: target_handles,
            source_tv_controller_handles: source_tv_handles,
            source_tv_vs_target: comparison,
            conclusions,
        }
    }
}

impl DemoRewriter for HudAuditRewriter {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGE | RewriteInterests::ENTITY_FIELDS
    }

    fn rewrite_packet_message(
        &mut self,
        _ctx: &Context,
        tick: u32,
        msg_type: i32,
        payload: &[u8],
    ) -> Result<MessageRewrite, source2_demo::error::ParserError> {
        self.report_progress(tick);
        if msg_type == SvcMessages::SvcServerInfo as i32 {
            let message = CSvcMsgServerInfo::decode(payload)?;
            let snapshot = ServerInfoSnapshot {
                tick,
                player_slot: message.player_slot(),
                is_hltv: message.is_hltv(),
                max_clients: message.max_clients(),
                max_classes: message.max_classes(),
            };
            if self
                .server_info
                .last()
                .is_none_or(|previous| {
                    previous.player_slot != snapshot.player_slot
                        || previous.is_hltv != snapshot.is_hltv
                        || previous.max_clients != snapshot.max_clients
                        || previous.max_classes != snapshot.max_classes
                })
            {
                self.server_info.push(snapshot);
            }
        }
        Ok(MessageRewrite::Keep)
    }

    fn should_track_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        entity.index() != 0 && is_relevant_class(entity.class().name())
    }

    fn should_rewrite_entity(
        &mut self,
        _ctx: &Context,
        _event: EntityEvents,
        entity: &Entity,
    ) -> bool {
        // The writer also presents shared class baselines as a synthetic index-0
        // entity. Probe 4A is entity-delta-only, so exclude that synthetic row.
        entity.index() != 0 && is_relevant_class(entity.class().name())
    }

    fn replace_entity_field(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
        field_name: &str,
        value: &FieldValue,
    ) -> Option<FieldValue> {
        let requested = requested_field_for_actual(field_name)?;
        self.record_resolved_delta_path(entity, requested, field_name, value);
        self.entity_builder(entity)
            .record_delta(requested, field_name, ctx.tick(), event, value);
        None
    }

    fn append_entity_fields(
        &mut self,
        ctx: &Context,
        event: EntityEvents,
        entity: &Entity,
    ) -> Vec<(String, FieldValue)> {
        if entity.index() == 0 || !is_relevant_class(entity.class().name()) {
            return Vec::new();
        }
        let class_name = entity.class().name().to_owned();
        if self
            .fully_scanned_schema_classes
            .insert(class_name)
        {
            let fields = entity.fields();
            self.scan_schema(entity, &fields);
        }
        let builder = self.entity_builder(entity);
        builder.record_seen_tick(ctx.tick());
        if event == EntityEvents::Created {
            builder.record_created_state(ctx.tick(), entity);
        }
        Vec::new()
    }
}

#[derive(Default)]
struct NullSeekWriter {
    position: u64,
    length: u64,
}

impl Write for NullSeekWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.position = self.position.saturating_add(buf.len() as u64);
        self.length = self.length.max(self.position);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Seek for NullSeekWriter {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let next = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.length) + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
        };
        if next < 0 || next > i128::from(u64::MAX) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid null-writer seek",
            ));
        }
        self.position = next as u64;
        Ok(self.position)
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-hud-audit-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn 64MB audit worker thread")?
        .join()
        .map_err(|_| anyhow::anyhow!("demo HUD audit worker panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    let metadata = fs::metadata(&cli.input)
        .with_context(|| format!("failed to stat demo {}", cli.input.display()))?;
    let sha256 = sha256_file(&cli.input)?;
    let input = BufReader::new(
        File::open(&cli.input)
            .with_context(|| format!("failed to open demo {}", cli.input.display()))?,
    );
    let mut writer = DemoWriter::from_reader(input, NullSeekWriter::default())?;
    let state = writer.add_rewriter(HudAuditRewriter::default());
    writer.run()?;
    drop(writer);

    let report = state
        .borrow()
        .build_report(&cli.input, metadata.len(), sha256, &cli.target_name);
    if let Some(parent) = cli.output.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let output = File::create(&cli.output)
        .with_context(|| format!("failed to create report {}", cli.output.display()))?;
    serde_json::to_writer_pretty(output, &report)
        .with_context(|| format!("failed to write report {}", cli.output.display()))?;

    println!("report={}", cli.output.display());
    println!("sha256={}", report.source_demo.sha256);
    println!("server_info_snapshots={}", report.server_info.len());
    println!("controllers={}", report.controllers.len());
    println!("pawns={}", report.pawns.len());
    println!(
        "target_controller_handles={:?}",
        report.target_controller_handles
    );
    println!(
        "source_tv_controller_handles={:?}",
        report.source_tv_controller_handles
    );
    for conclusion in &report.conclusions {
        println!("conclusion={conclusion}");
    }
    Ok(())
}

fn is_relevant_class(class_name: &str) -> bool {
    class_name == "CCSPlayerController" || is_pawn_class(class_name)
}

fn is_pawn_class(class_name: &str) -> bool {
    class_name.contains("PlayerPawn") || class_name.contains("ObserverPawn")
}

fn requested_field_for_actual(actual: &str) -> Option<&'static str> {
    REQUESTED_FIELDS
        .iter()
        .copied()
        .find(|requested| actual == *requested || actual.ends_with(&format!(".{requested}")))
}

fn field_value_json(value: &FieldValue) -> JsonValue {
    match value {
        FieldValue::Boolean(value) => json!(value),
        FieldValue::String(value) => json!(value),
        FieldValue::Float(value) if value.is_finite() => json!(value),
        FieldValue::Float(value) => json!(format!("{value:?}")),
        FieldValue::Vector2D(value) => json!(value),
        FieldValue::Vector3D(value) => json!(value),
        FieldValue::Vector4D(value) => json!(value),
        FieldValue::Signed8(value) => json!(value),
        FieldValue::Signed16(value) => json!(value),
        FieldValue::Signed32(value) => json!(value),
        FieldValue::Signed64(value) => json!(value),
        FieldValue::Unsigned8(value) => json!(value),
        FieldValue::Unsigned16(value) => json!(value),
        FieldValue::Unsigned32(value) => json!(value),
        FieldValue::Unsigned64(value) => json!(value),
    }
}

fn as_string(value: &FieldValue) -> Option<String> {
    match value {
        FieldValue::String(value) => Some(value.clone()),
        _ => None,
    }
}

fn as_u64(value: &FieldValue) -> Option<u64> {
    match value {
        FieldValue::Unsigned8(value) => Some(u64::from(*value)),
        FieldValue::Unsigned16(value) => Some(u64::from(*value)),
        FieldValue::Unsigned32(value) => Some(u64::from(*value)),
        FieldValue::Unsigned64(value) => Some(*value),
        FieldValue::Signed8(value) if *value >= 0 => Some(*value as u64),
        FieldValue::Signed16(value) if *value >= 0 => Some(*value as u64),
        FieldValue::Signed32(value) if *value >= 0 => Some(*value as u64),
        FieldValue::Signed64(value) if *value >= 0 => Some(*value as u64),
        _ => None,
    }
}

fn as_bool(value: &FieldValue) -> Option<bool> {
    match value {
        FieldValue::Boolean(value) => Some(*value),
        _ => None,
    }
}

fn valid_handle(value: u64) -> Option<u32> {
    let value = u32::try_from(value).ok()?;
    (value != 0 && value != u32::MAX).then_some(value)
}

fn derived_player_slot(entity_index: u32) -> Option<u32> {
    (1..=64)
        .contains(&entity_index)
        .then_some(entity_index - 1)
}

fn event_name(event: EntityEvents) -> &'static str {
    match event {
        EntityEvents::Created => "Created",
        EntityEvents::Updated => "Updated",
        EntityEvents::Deleted => "Deleted",
    }
}

fn is_source_tv_candidate(entity: &EntityAudit) -> bool {
    entity.latest_is_hltv == Some(true)
        || entity.latest_name.as_ref().is_some_and(|name| {
            let lower = name.to_ascii_lowercase();
            lower.contains("sourcetv") || lower.contains("hltv") || lower.contains("gotv")
        })
        || (entity.latest_steam_id == Some(0)
            && entity
                .latest_name
                .as_ref()
                .is_some_and(|name| !name.trim().is_empty()))
}

fn latest_field(entity: &EntityAudit, requested: &str) -> Option<FieldDatum> {
    entity
        .delta_field_timelines
        .iter()
        .filter(|timeline| timeline.requested_field == requested)
        .filter_map(|timeline| timeline.value_transitions.last())
        .max_by_key(|occurrence| occurrence.tick)
        .map(|occurrence| occurrence.value.clone())
        .or_else(|| {
            entity
        .state_transitions
        .iter()
        .rev()
        .flat_map(|snapshot| snapshot.fields.iter())
        .find(|(actual, _)| requested_field_for_actual(actual) == Some(requested))
        .map(|(_, value)| value.clone())
        })
}

fn compare_entities(source_tv: &EntityAudit, target: &EntityAudit) -> Vec<IdentityComparison> {
    REQUESTED_FIELDS
        .iter()
        .map(|field| {
            let source_value = latest_field(source_tv, field);
            let target_value = latest_field(target, field);
            let differs = match (&source_value, &target_value) {
                (Some(source), Some(target)) => Some(source != target),
                _ => None,
            };
            IdentityComparison {
                field: (*field).to_owned(),
                source_tv_value: source_value,
                target_value,
                differs,
            }
        })
        .collect()
}

fn field_candidate_conclusions(controllers: &[EntityAudit], pawns: &[EntityAudit]) -> Vec<String> {
    let mut conclusions = Vec::new();
    for requested in [
        "m_bIsLocalPlayerController",
        "m_bIsHLTV",
        "m_hPawn",
        "m_hPlayerPawn",
        "m_hObserverPawn",
        "m_iPlayerState",
        "m_iObserverMode",
        "m_hObserverTarget",
    ] {
        let controller_count = controllers
            .iter()
            .filter(|entity| {
                entity
                    .delta_field_timelines
                    .iter()
                    .any(|timeline| timeline.requested_field == requested)
            })
            .count();
        let pawn_count = pawns
            .iter()
            .filter(|entity| {
                entity
                    .delta_field_timelines
                    .iter()
                    .any(|timeline| timeline.requested_field == requested)
            })
            .count();
        conclusions.push(format!(
            "{requested}: existing delta evidence on {controller_count} Controller entity/entities and {pawn_count} Pawn entity/entities."
        ));
    }
    conclusions
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("failed to hash demo {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_field_matches_exact_and_nested_paths() {
        assert_eq!(
            requested_field_for_actual("m_bIsLocalPlayerController"),
            Some("m_bIsLocalPlayerController")
        );
        assert_eq!(
            requested_field_for_actual("m_pObserverServices.m_iObserverMode"),
            Some("m_iObserverMode")
        );
        assert_eq!(requested_field_for_actual("m_iHealth"), None);
    }

    #[test]
    fn null_seek_writer_tracks_length_and_supports_header_patching() {
        let mut writer = NullSeekWriter::default();
        writer.write_all(&[1, 2, 3, 4]).unwrap();
        assert_eq!(writer.seek(SeekFrom::Start(1)).unwrap(), 1);
        writer.write_all(&[9, 9]).unwrap();
        assert_eq!(writer.length, 4);
        assert_eq!(writer.seek(SeekFrom::End(0)).unwrap(), 4);
    }
}
