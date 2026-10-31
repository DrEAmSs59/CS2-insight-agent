//! Read-only, serial-checked controller/pawn transitions for OBS bot takeovers.
use anyhow::{ensure, Result};
use clap::Parser as ClapParser;
use serde_json::{json, Value};
use source2_demo::prelude::*;
use std::{collections::BTreeMap, fs::File, io::BufReader, path::PathBuf};

#[derive(ClapParser)]
struct Cli {
    #[arg(long)] input: PathBuf,
    #[arg(long)] output: PathBuf,
    #[arg(long)] start: u32,
    #[arg(long)] end: u32,
}

fn field(entity: &Entity, name: &str) -> Option<Value> {
    let value = entity.get_property(name).ok().or_else(|| {
        entity.fields().into_iter().find(|f| f.name.rsplit('.').next() == Some(name)).and_then(|f| f.value)
    })?;
    Some(match value {
        FieldValue::Unsigned8(x) => json!(x), FieldValue::Unsigned16(x) => json!(x),
        FieldValue::Unsigned32(x) => json!(x), FieldValue::Unsigned64(x) => json!(x.to_string()),
        FieldValue::Signed32(x) => json!(x), FieldValue::Boolean(x) => json!(x),
        FieldValue::String(x) => json!(x), _ => return None,
    })
}

fn snapshot(ctx: &Context, controller: &Entity) -> Value {
    let takeover = field(controller, "m_bControllingBot") == Some(json!(true));
    let handle = field(controller, if takeover { "m_hPawn" } else { "m_hPlayerPawn" })
        .and_then(|v| v.as_u64());
    let pawn = handle.and_then(|h| ctx.entities().get_by_index((h & 0x3fff) as usize).ok()
        .filter(|p| p.handle() as u64 == h && p.class().name() == "CCSPlayerPawn"));
    let reverse = pawn.and_then(|p| field(p, "m_hController")).and_then(|v| v.as_u64());
    let alive = pawn.is_some_and(|p| field(p, "m_lifeState") == Some(json!(0))
        && field(p, "m_iHealth").and_then(|v| v.as_i64()).is_some_and(|v| v > 0));
    let body_known = pawn.is_some_and(|p| field(p, "m_lifeState").is_some()
        && field(p, "m_iHealth").is_some());
    json!({"slot":controller.index(), "controllerHandle":controller.handle(),
        "name":field(controller,"m_iszPlayerName"), "steamid":field(controller,"m_steamID"),
        "takeover":takeover, "pawnHandle":handle, "pawn":pawn.map(Entity::index),
        "reverseHandle":reverse, "alive":alive, "bodyKnown":body_known,
        "valid":alive && reverse == Some(controller.handle() as u64)})
}

#[derive(Default)]
struct Targets { start: u32, end: u32, first: Option<u32>, last: Option<u32>,
    previous: BTreeMap<u32, Value>, rows: Vec<Value> }

impl Observer for Targets {
    fn interests(&self) -> Interests { Interests::ENTITY_STATE | Interests::TICK_END }
    fn on_tick_end(&mut self, ctx: &Context) -> ObserverResult {
        let tick = ctx.tick();
        if tick < self.start || tick > self.end { return Ok(()); }
        self.first.get_or_insert(tick);
        self.last = Some(tick);
        let mut current = BTreeMap::new();
        for controller in ctx.entities().iter().filter(|e| e.class().name() == "CCSPlayerController"
            && (1..=64).contains(&e.index())) {
            current.insert(controller.index(), snapshot(ctx, controller));
        }
        for (slot, row) in &current {
            if self.previous.get(slot) != Some(row) {
                let mut row = row.clone(); row["tick"] = json!(tick); self.rows.push(row);
            }
        }
        for (slot, old) in &self.previous {
            if !current.contains_key(slot) {
                let mut row = old.clone(); row["tick"] = json!(tick);
                row["valid"] = json!(false); row["alive"] = json!(false);
                row["takeover"] = json!(false); row["pawn"] = Value::Null;
                self.rows.push(row);
            }
        }
        self.previous = current;
        Ok(())
    }
}

fn run(cli: Cli) -> Result<()> {
    ensure!(cli.start <= cli.end && !cli.output.exists(), "invalid range or output already exists");
    let mut parser = source2_demo::Parser::from_reader(BufReader::new(File::open(&cli.input)?))?;
    let observer = parser.register_observer::<Targets>();
    { let mut o = observer.borrow_mut(); o.start = cli.start; o.end = cli.end; }
    parser.run_to_end()?; // Never promote a partial parse.
    let o = observer.borrow();
    ensure!(o.first == Some(cli.start) && o.last == Some(cli.end), "requested ticks absent from demo");
    serde_json::to_writer(File::create(cli.output)?, &json!({"version":1,
        "start":cli.start,"end":cli.end,"rows":o.rows}))?;
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new().stack_size(demo_cosmetic_rewriter::WORKER_STACK_SIZE)
        .spawn(move || run(cli))?.join().map_err(|_| anyhow::anyhow!("target reader panicked"))?
}
