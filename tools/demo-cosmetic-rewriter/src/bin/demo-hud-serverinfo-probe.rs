use anyhow::{bail, Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use demo_cosmetic_rewriter::header::validate_demo_layout;
use demo_cosmetic_rewriter::WORKER_STACK_SIZE;
use sha2::{Digest, Sha256};
use source2_demo::prelude::*;
use source2_demo::proto::CSvcMsgServerInfo;
use source2_demo::writer::{DemoRewriter, DemoWriter, MessageRewrite, RewriteInterests};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

#[derive(Debug, ClapParser)]
#[command(name = "demo-hud-serverinfo-probe")]
#[command(about = "Rewrite CS2 ServerInfo player_slot, is_hltv, and optional max_clients")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    expected_input_sha256: String,
    #[arg(long)]
    player_slot: i32,
    #[arg(long, default_value_t = false)]
    is_hltv: bool,
    /// When set, also rewrite ServerInfo.max_clients (teammate-color gate needs <= 10).
    #[arg(long)]
    max_clients: Option<i32>,
}

#[derive(Clone, Debug, Default)]
struct ProbeReport {
    original_player_slots: BTreeSet<i32>,
    original_is_hltv: BTreeSet<bool>,
    original_max_clients: BTreeSet<i32>,
    ticks: BTreeSet<u32>,
    replacements: usize,
}

struct ServerInfoProbe {
    player_slot: i32,
    is_hltv: bool,
    max_clients: Option<i32>,
    report: ProbeReport,
}

impl DemoRewriter for ServerInfoProbe {
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::PACKET_MESSAGE
    }

    fn rewrite_packet_message(
        &mut self,
        _ctx: &Context,
        tick: u32,
        msg_type: i32,
        payload: &[u8],
    ) -> Result<MessageRewrite, source2_demo::error::ParserError> {
        if msg_type != SvcMessages::SvcServerInfo as i32 {
            return Ok(MessageRewrite::Keep);
        }
        let mut message = CSvcMsgServerInfo::decode(payload)?;
        self.report
            .original_player_slots
            .insert(message.player_slot());
        self.report.original_is_hltv.insert(message.is_hltv());
        self.report
            .original_max_clients
            .insert(message.max_clients());
        self.report.ticks.insert(tick);
        self.report.replacements += 1;
        message.player_slot = Some(self.player_slot);
        message.is_hltv = Some(self.is_hltv);
        if let Some(max_clients) = self.max_clients {
            message.max_clients = Some(max_clients);
        }
        Ok(MessageRewrite::Replace(message.encode_to_vec()))
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-hud-serverinfo-probe-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn ServerInfo probe worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("ServerInfo probe worker panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    if cli.player_slot < 0 {
        bail!("player_slot must be non-negative");
    }
    if cli.input == cli.output {
        bail!("input and output paths must differ");
    }
    if cli.output.exists() {
        bail!("output already exists: {}", cli.output.display());
    }
    let actual_input_sha256 = sha256_file(&cli.input)?;
    if !actual_input_sha256.eq_ignore_ascii_case(&cli.expected_input_sha256) {
        bail!(
            "input SHA-256 mismatch: expected {}, found {}",
            cli.expected_input_sha256,
            actual_input_sha256
        );
    }

    let parent = cli
        .output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create {}", parent.display()))?;
    let partial = partial_path(&cli.output);
    if partial.exists() {
        bail!("partial output already exists: {}", partial.display());
    }

    let input = BufReader::new(
        File::open(&cli.input)
            .with_context(|| format!("failed to open {}", cli.input.display()))?,
    );
    let output = File::create(&partial)
        .with_context(|| format!("failed to create {}", partial.display()))?;
    let mut writer = DemoWriter::from_reader(input, output)?;
    let state = writer.add_rewriter(ServerInfoProbe {
        player_slot: cli.player_slot,
        is_hltv: cli.is_hltv,
        max_clients: cli.max_clients,
        report: ProbeReport::default(),
    });
    writer.run()?;
    let (_, output) = writer.into_parts();
    output.sync_all()?;

    let report = state.borrow().report.clone();
    if report.replacements == 0 {
        bail!("no svc_ServerInfo message was found");
    }
    let layout = validate_demo_layout(&partial)?;
    let output_sha256 = sha256_file(&partial)?;
    fs::rename(&partial, &cli.output).with_context(|| {
        format!(
            "failed to promote {} to {}",
            partial.display(),
            cli.output.display()
        )
    })?;

    println!("probe=ServerInfo player slot plus HLTV mode");
    println!("input={}", cli.input.display());
    println!("input_sha256={actual_input_sha256}");
    println!("output={}", cli.output.display());
    println!("output_sha256={output_sha256}");
    println!("original_player_slots={:?}", report.original_player_slots);
    println!("original_is_hltv={:?}", report.original_is_hltv);
    println!("original_max_clients={:?}", report.original_max_clients);
    println!("player_slot={}", cli.player_slot);
    println!("is_hltv={}", cli.is_hltv);
    println!("max_clients={:?}", cli.max_clients);
    println!("replacements={} ticks={:?}", report.replacements, report.ticks);
    println!(
        "header_offsets=file_info:{} spawn_groups:{} eof:{}",
        layout.actual_file_info_offset, layout.actual_spawn_groups_offset, layout.file_len
    );
    Ok(())
}

fn partial_path(output: &Path) -> PathBuf {
    let extension = output
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("dem");
    output.with_extension(format!("{extension}.partial"))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("failed to hash {}", path.display()))?;
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
    fn partial_output_stays_next_to_final_output() {
        assert_eq!(
            partial_path(Path::new(r"C:\tmp\probe.dem")),
            PathBuf::from(r"C:\tmp\probe.dem.partial")
        );
    }
}

