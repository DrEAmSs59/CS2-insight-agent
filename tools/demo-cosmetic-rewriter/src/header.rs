use anyhow::{bail, Context, Result};
use source2_demo::proto::{CDemoFileHeader, Message};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

const DEMO_HEADER_LEN: u64 = 16;
const COMPRESSED_COMMAND_FLAG: u32 = 64;
const DEM_FILE_HEADER: u32 = 1;
const DEM_FILE_INFO: u32 = 2;
const DEM_SPAWN_GROUPS: u32 = 15;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DemoFileMetadata {
    pub patch_version: Option<i32>,
    pub build_num: Option<i32>,
    pub map_name: Option<String>,
    pub server_name: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DemoLayout {
    pub file_len: u64,
    pub header_file_info_offset: u32,
    pub header_spawn_groups_offset: u32,
    pub actual_file_info_offset: u32,
    pub actual_spawn_groups_offset: u32,
    pub metadata: DemoFileMetadata,
}

impl DemoLayout {
    pub fn header_offsets_are_valid(&self) -> bool {
        self.header_file_info_offset == self.actual_file_info_offset
            && self.header_spawn_groups_offset == self.actual_spawn_groups_offset
    }
}

pub fn scan_demo(path: &Path) -> Result<DemoLayout> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open demo {}", path.display()))?;
    let file_len = file.metadata()?.len();
    if file_len < DEMO_HEADER_LEN {
        bail!("demo {} is shorter than its 16-byte header", path.display());
    }

    let mut magic = [0_u8; 8];
    file.read_exact(&mut magic)?;
    if &magic != b"PBDEMS2\0" {
        bail!("demo {} has an invalid PBDEMS2 header", path.display());
    }
    let mut encoded_offsets = [0_u8; 8];
    file.read_exact(&mut encoded_offsets)?;
    let header_file_info_offset = u32::from_le_bytes(encoded_offsets[..4].try_into()?);
    let header_spawn_groups_offset = u32::from_le_bytes(encoded_offsets[4..].try_into()?);

    let mut file_info = None;
    let mut spawn_groups = None;
    let mut metadata = None;
    while file.stream_position()? < file_len {
        let frame_start = file.stream_position()?;
        let raw_command = read_varint(&mut file)?;
        let command = raw_command & !COMPRESSED_COMMAND_FLAG;
        let _tick = read_varint(&mut file)?;
        let size = u64::from(read_varint(&mut file)?);
        let payload_start = file.stream_position()?;
        let payload_end = payload_start
            .checked_add(size)
            .ok_or_else(|| anyhow::anyhow!("demo frame at {frame_start} overflows u64"))?;
        if payload_end > file_len {
            bail!("demo frame at {frame_start} ends at {payload_end}, past EOF {file_len}");
        }

        if command == DEM_FILE_HEADER && metadata.is_none() {
            let mut payload = vec![0_u8; usize::try_from(size)?];
            file.read_exact(&mut payload)?;
            if raw_command & COMPRESSED_COMMAND_FLAG != 0 {
                payload = snap::raw::Decoder::new()
                    .decompress_vec(&payload)
                    .context("failed to decompress DEM_FileHeader")?;
            }
            let header = CDemoFileHeader::decode(payload.as_slice())
                .context("failed to decode DEM_FileHeader")?;
            metadata = Some(DemoFileMetadata {
                patch_version: header.patch_version,
                build_num: header.build_num,
                map_name: header.map_name,
                server_name: header.server_name,
            });
        } else {
            file.seek(SeekFrom::Start(payload_end))?;
        }

        if command == DEM_FILE_INFO && file_info.is_none() {
            file_info =
                Some(u32::try_from(frame_start).context("DEM_FileInfo offset exceeds u32")?);
        }
        if command == DEM_SPAWN_GROUPS && spawn_groups.is_none() {
            spawn_groups =
                Some(u32::try_from(frame_start).context("DEM_SpawnGroups offset exceeds u32")?);
        }
        file.seek(SeekFrom::Start(payload_end))?;
    }
    if file.stream_position()? != file_len {
        bail!("demo frame scan did not finish exactly at EOF");
    }

    Ok(DemoLayout {
        file_len,
        header_file_info_offset,
        header_spawn_groups_offset,
        actual_file_info_offset: file_info
            .ok_or_else(|| anyhow::anyhow!("DEM_FileInfo frame was not found"))?,
        actual_spawn_groups_offset: spawn_groups
            .ok_or_else(|| anyhow::anyhow!("DEM_SpawnGroups frame was not found"))?,
        metadata: metadata.ok_or_else(|| anyhow::anyhow!("DEM_FileHeader frame was not found"))?,
    })
}

pub fn validate_demo_layout(path: &Path) -> Result<DemoLayout> {
    let layout = scan_demo(path)?;
    if !layout.header_offsets_are_valid() {
        bail!(
            "demo header offsets are stale: header=({}, {}), actual=({}, {})",
            layout.header_file_info_offset,
            layout.header_spawn_groups_offset,
            layout.actual_file_info_offset,
            layout.actual_spawn_groups_offset
        );
    }
    Ok(layout)
}

/// Validates the outer header and both indexed frame targets without scanning
/// every demo frame. The full writer/parser pass remains responsible for the
/// complete stream structure.
pub fn validate_demo_header(path: &Path) -> Result<DemoLayout> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open demo {}", path.display()))?;
    let file_len = file.metadata()?.len();
    if file_len < DEMO_HEADER_LEN {
        bail!("demo {} is shorter than its 16-byte header", path.display());
    }

    let mut magic = [0_u8; 8];
    file.read_exact(&mut magic)?;
    if &magic != b"PBDEMS2\0" {
        bail!("demo {} has an invalid PBDEMS2 header", path.display());
    }
    let mut encoded_offsets = [0_u8; 8];
    file.read_exact(&mut encoded_offsets)?;
    let file_info_offset = u32::from_le_bytes(encoded_offsets[..4].try_into()?);
    let spawn_groups_offset = u32::from_le_bytes(encoded_offsets[4..].try_into()?);

    let metadata = read_file_header_metadata(&mut file, file_len)?;
    validate_indexed_frame(
        &mut file,
        file_len,
        u64::from(file_info_offset),
        DEM_FILE_INFO,
        "DEM_FileInfo",
    )?;
    validate_indexed_frame(
        &mut file,
        file_len,
        u64::from(spawn_groups_offset),
        DEM_SPAWN_GROUPS,
        "DEM_SpawnGroups",
    )?;

    Ok(DemoLayout {
        file_len,
        header_file_info_offset: file_info_offset,
        header_spawn_groups_offset: spawn_groups_offset,
        actual_file_info_offset: file_info_offset,
        actual_spawn_groups_offset: spawn_groups_offset,
        metadata,
    })
}

fn read_file_header_metadata(file: &mut File, file_len: u64) -> Result<DemoFileMetadata> {
    file.seek(SeekFrom::Start(DEMO_HEADER_LEN))?;
    let raw_command = read_varint(file)?;
    if raw_command & !COMPRESSED_COMMAND_FLAG != DEM_FILE_HEADER {
        bail!("first demo frame is not DEM_FileHeader");
    }
    let _tick = read_varint(file)?;
    let size = u64::from(read_varint(file)?);
    let payload_start = file.stream_position()?;
    let payload_end = payload_start
        .checked_add(size)
        .ok_or_else(|| anyhow::anyhow!("DEM_FileHeader payload overflows u64"))?;
    if payload_end > file_len {
        bail!("DEM_FileHeader payload ends past EOF");
    }
    let mut payload = vec![0_u8; usize::try_from(size)?];
    file.read_exact(&mut payload)?;
    if raw_command & COMPRESSED_COMMAND_FLAG != 0 {
        payload = snap::raw::Decoder::new()
            .decompress_vec(&payload)
            .context("failed to decompress DEM_FileHeader")?;
    }
    let header =
        CDemoFileHeader::decode(payload.as_slice()).context("failed to decode DEM_FileHeader")?;
    Ok(DemoFileMetadata {
        patch_version: header.patch_version,
        build_num: header.build_num,
        map_name: header.map_name,
        server_name: header.server_name,
    })
}

fn validate_indexed_frame(
    file: &mut File,
    file_len: u64,
    offset: u64,
    expected_command: u32,
    label: &str,
) -> Result<()> {
    if !(DEMO_HEADER_LEN..file_len).contains(&offset) {
        bail!("{label} header offset {offset} is outside the demo");
    }
    file.seek(SeekFrom::Start(offset))?;
    let command = read_varint(file)? & !COMPRESSED_COMMAND_FLAG;
    if command != expected_command {
        bail!("{label} header offset {offset} points to command {command}");
    }
    let _tick = read_varint(file)?;
    let size = u64::from(read_varint(file)?);
    let payload_end = file
        .stream_position()?
        .checked_add(size)
        .ok_or_else(|| anyhow::anyhow!("{label} payload overflows u64"))?;
    if payload_end > file_len {
        bail!("{label} payload ends past EOF");
    }
    Ok(())
}

pub fn patch_and_validate_demo_layout(path: &Path) -> Result<DemoLayout> {
    let mut scanned = scan_demo(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("failed to reopen output demo {}", path.display()))?;
    file.seek(SeekFrom::Start(8))?;
    file.write_all(&scanned.actual_file_info_offset.to_le_bytes())?;
    file.write_all(&scanned.actual_spawn_groups_offset.to_le_bytes())?;
    file.flush()?;
    file.sync_data()?;
    drop(file);
    scanned.header_file_info_offset = scanned.actual_file_info_offset;
    scanned.header_spawn_groups_offset = scanned.actual_spawn_groups_offset;
    Ok(scanned)
}

fn read_varint<R: Read>(reader: &mut R) -> Result<u32> {
    let mut value = 0_u32;
    for shift in (0..35).step_by(7) {
        let mut byte = [0_u8; 1];
        reader.read_exact(&mut byte)?;
        if shift == 28 && byte[0] & 0xf0 != 0 {
            bail!("demo varint exceeds u32");
        }
        value |= u32::from(byte[0] & 0x7f) << shift;
        if byte[0] & 0x80 == 0 {
            return Ok(value);
        }
    }
    bail!("unterminated demo varint")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_varint(mut value: u32, out: &mut Vec<u8>) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    fn frame(command: u32, payload: &[u8], out: &mut Vec<u8>) {
        write_varint(command, out);
        write_varint(0, out);
        write_varint(payload.len() as u32, out);
        out.extend_from_slice(payload);
    }

    fn unique_path(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "demo-cosmetic-rewriter-{label}-{}-{nonce}.dem",
            std::process::id()
        ))
    }

    #[test]
    fn patches_offsets_and_rejects_trailing_frame_overrun() -> Result<()> {
        let path = unique_path("header");
        let header = CDemoFileHeader {
            demo_file_stamp: "PBDEMS2\0".to_owned(),
            patch_version: Some(14172),
            map_name: Some("de_dust2".to_owned()),
            ..Default::default()
        };
        let mut bytes = b"PBDEMS2\0".to_vec();
        bytes.extend_from_slice(&[0_u8; 8]);
        frame(DEM_FILE_HEADER, &header.encode_to_vec(), &mut bytes);
        frame(DEM_FILE_INFO, &[1, 2, 3], &mut bytes);
        frame(DEM_SPAWN_GROUPS, &[4, 5], &mut bytes);
        fs_err_write(&path, &bytes)?;

        let before = scan_demo(&path)?;
        assert!(!before.header_offsets_are_valid());
        assert!(validate_demo_header(&path).is_err());
        let after = patch_and_validate_demo_layout(&path)?;
        assert!(after.header_offsets_are_valid());
        assert_eq!(after.metadata.patch_version, Some(14172));
        assert_eq!(validate_demo_header(&path)?, after);

        let mut broken = std::fs::read(&path)?;
        frame(7, &[9, 9, 9], &mut broken);
        broken.pop();
        fs_err_write(&path, &broken)?;
        assert!(scan_demo(&path).is_err());
        std::fs::remove_file(path)?;
        Ok(())
    }

    fn fs_err_write(path: &Path, bytes: &[u8]) -> Result<()> {
        std::fs::write(path, bytes)
            .with_context(|| format!("failed to write test demo {}", path.display()))
    }
}
