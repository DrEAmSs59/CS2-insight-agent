"""Watch multiple directories and enqueue new .dem files."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import struct
import time
import zlib
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable, Iterable, Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

if TYPE_CHECKING:
    from .demo_db import DemoDB

from .file_hash import file_md5_hex

logger = logging.getLogger(__name__)

OnDemoDetected = Callable[[Path, Optional[str]], Awaitable[None]]

_LOCAL_ZIP_SIG = b"PK\x03\x04"


def normalize_scan_depth(value: object, *, default: int = 2) -> int:
    """Return a bounded directory depth for watch-path discovery."""
    try:
        depth = int(value)
    except (TypeError, ValueError):
        depth = default
    return max(0, min(32, depth))


def iter_candidate_files(
    root: Path,
    suffixes: Iterable[str] = (".dem", ".zip"),
    *,
    max_depth: int = 2,
    on_error: Callable[[OSError], None] | None = None,
) -> Iterable[Path]:
    """Yield candidate files under ``root`` up to a user-visible depth.

    Depth 0 means files directly inside the selected directory, depth 1 adds
    one nested directory, and so on. Symlinked directories are not followed.
    """
    wanted = {str(suffix).lower() for suffix in suffixes}
    bounded_depth = normalize_scan_depth(max_depth)
    try:
        resolved_root = root.expanduser().resolve()
    except OSError:
        return
    if not resolved_root.is_dir():
        return
    for current, dirnames, filenames in os.walk(
        resolved_root,
        followlinks=False,
        onerror=on_error,
    ):
        current_path = Path(current)
        try:
            current_depth = len(current_path.relative_to(resolved_root).parts)
        except ValueError:
            continue
        if current_depth >= bounded_depth:
            dirnames.clear()
        for filename in filenames:
            candidate = current_path / filename
            if candidate.suffix.lower() in wanted:
                yield candidate


def _sort_paths_by_mtime_newest_first(paths: Iterable[Path]) -> list[Path]:
    """按文件修改时间降序（最近改动的优先），stat 失败置末。"""
    scored: list[tuple[int, str, Path]] = []
    for path in paths:
        try:
            st = path.stat()
            ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000)))
        except OSError:
            ns = -1
        scored.append((ns, path.name.casefold(), path))
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return [t[2] for t in scored]


def _safe_zip_member_name(name: str) -> str | None:
    """Return basename of a .dem member, or None if unsafe."""
    if not name or name.endswith("/"):
        return None
    parts = name.replace("\\", "/").split("/")
    if not parts or any(p == ".." for p in parts):
        return None
    base = parts[-1]
    if not base.lower().endswith(".dem"):
        return None
    return base


def _iter_local_header_zip_dems(zip_path: Path) -> list[tuple[str, bytes]]:
    """Parse .dem payloads from ZIP local headers when EOCD is missing (e.g. some 5E replays)."""
    try:
        data = zip_path.read_bytes()
    except OSError:
        return []
    if not data.startswith(_LOCAL_ZIP_SIG):
        return []
    out: list[tuple[str, bytes]] = []
    offset = 0
    while offset + 30 <= len(data) and data[offset : offset + 4] == _LOCAL_ZIP_SIG:
        fn_len = struct.unpack_from("<H", data, offset + 26)[0]
        extra_len = struct.unpack_from("<H", data, offset + 28)[0]
        header_end = offset + 30 + fn_len + extra_len
        if header_end > len(data):
            break
        name = data[offset + 30 : offset + 30 + fn_len].decode("utf-8", "replace")
        method = struct.unpack_from("<H", data, offset + 8)[0]
        csize = struct.unpack_from("<I", data, offset + 18)[0]
        usize = struct.unpack_from("<I", data, offset + 22)[0]
        base = _safe_zip_member_name(name)
        payload_end = header_end + csize if csize else len(data)
        if payload_end > len(data):
            logger.warning("Truncated local-header zip payload in %s", zip_path)
            break
        payload = data[header_end:payload_end]
        if base:
            try:
                if method == 8:
                    raw = zlib.decompressobj(-zlib.MAX_WBITS).decompress(payload)
                elif method == 0:
                    raw = payload
                else:
                    logger.warning("Unsupported zip compression method %s in %s", method, zip_path)
                    break
            except Exception:
                logger.exception("Failed to decompress local-header zip member %s from %s", name, zip_path)
                break
            if usize and len(raw) != usize:
                logger.warning(
                    "Local-header zip size mismatch for %s: got %d expected %d",
                    zip_path,
                    len(raw),
                    usize,
                )
            out.append((base, raw))
        if payload_end >= len(data):
            break
        offset = payload_end
    return out


def _file_crc32(path: Path) -> int:
    checksum = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            checksum = zlib.crc32(chunk, checksum)
    return checksum & 0xFFFFFFFF


def _reuse_existing_dem_if_same_content(
    dest_dir: Path,
    base: str,
    size: int,
    crc32: int,
) -> Path | None:
    existing_target = dest_dir / base
    if not existing_target.is_file():
        return None
    try:
        if existing_target.stat().st_size == size and _file_crc32(existing_target) == crc32:
            logger.info("Demo already extracted with matching size and CRC, reuse: %s", existing_target)
            return existing_target.resolve()
    except OSError:
        pass
    return None


def _atomic_write_bytes(target: Path, body: bytes) -> None:
    temporary = target.with_name(f"{target.name}.{os.urandom(6).hex()}.part")
    try:
        temporary.write_bytes(body)
        os.replace(temporary, target)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _atomic_extract_member(zf: zipfile.ZipFile, member: str, target: Path) -> None:
    temporary = target.with_name(f"{target.name}.{os.urandom(6).hex()}.part")
    try:
        with zf.open(member, "r") as src, temporary.open("xb") as dst:
            while chunk := src.read(1024 * 1024):
                dst.write(chunk)
        os.replace(temporary, target)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _pick_extract_path(dest_dir: Path, member_base: str, zip_path: Path) -> Path:
    """Avoid overwriting an existing .dem in the watch folder."""
    stem = Path(member_base).stem
    first = dest_dir / member_base
    if not first.is_file():
        return first
    for i in range(1, 1000):
        cand = dest_dir / f"{stem}_fromzip_{zip_path.stem}_{i}.dem"
        if not cand.is_file():
            return cand
    return dest_dir / f"{stem}_fromzip_{zip_path.stem}_{int(time.time() * 1000)}.dem"


def _zip_extract_outputs_present(zip_path: Path) -> bool:
    """5E 等平台通常解压为与 zip 同 stem 的 .dem；用于判断 skip extract 是否安全。"""
    return zip_path.with_suffix(".dem").is_file()


def _extract_dems_from_zip_sync(zip_path: Path) -> list[Path]:
    """Extract all .dem from zip into the same directory as the zip. Returns written paths."""
    out: list[Path] = []
    dest_dir = zip_path.parent
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            members = [m for m in zf.namelist() if _safe_zip_member_name(m)]
            if not members:
                return out
            for m in members:
                base = _safe_zip_member_name(m)
                if not base:
                    continue
                info = zf.getinfo(m)
                reused = _reuse_existing_dem_if_same_content(dest_dir, base, info.file_size, info.CRC)
                if reused:
                    out.append(reused)
                    continue
                target = _pick_extract_path(dest_dir, base, zip_path)
                _atomic_extract_member(zf, m, target)
                out.append(target.resolve())
        return out
    except zipfile.BadZipFile:
        logger.info("Standard zip parse failed, trying local-header fallback: %s", zip_path)
    for base, raw in _iter_local_header_zip_dems(zip_path):
        reused = _reuse_existing_dem_if_same_content(
            dest_dir, base, len(raw), zlib.crc32(raw) & 0xFFFFFFFF
        )
        if reused:
            out.append(reused)
            continue
        target = _pick_extract_path(dest_dir, base, zip_path)
        _atomic_write_bytes(target, raw)
        out.append(target.resolve())
    return out


def _demo_ingest_md5_enabled() -> bool:
    v = (os.environ.get("CS2_INSIGHT_DISABLE_DEMO_MD5") or "").strip().lower()
    return v not in ("1", "true", "yes")


def _extract_zip_dems_dedupe_sync(zip_path: Path, existing_md5s: frozenset[str]) -> list[Path]:
    """解压 zip 内 .dem；若与库中已有 content_md5 相同则不落盘（避免重复内容与重复解析）。"""
    out: list[Path] = []
    seen: set[str] = set(existing_md5s)
    dest_dir = zip_path.parent

    def _write_deduped(base: str, raw: bytes, size_hint: int | None = None) -> None:
        reused = _reuse_existing_dem_if_same_content(
            dest_dir,
            base,
            size_hint if size_hint is not None else len(raw),
            zlib.crc32(raw) & 0xFFFFFFFF,
        )
        if reused:
            out.append(reused)
            return
        target = _pick_extract_path(dest_dir, base, zip_path)
        h = hashlib.md5()
        h.update(raw)
        md5_hex = h.hexdigest()
        if md5_hex in seen:
            return
        _atomic_write_bytes(target, raw)
        seen.add(md5_hex)
        out.append(target.resolve())

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            members = [m for m in zf.namelist() if _safe_zip_member_name(m)]
            if not members:
                return out
            for m in members:
                base = _safe_zip_member_name(m)
                if not base:
                    continue
                info = zf.getinfo(m)
                reused = _reuse_existing_dem_if_same_content(dest_dir, base, info.file_size, info.CRC)
                if reused:
                    out.append(reused)
                    continue
                target = _pick_extract_path(dest_dir, base, zip_path)
                temporary = target.with_name(f"{target.name}.{os.urandom(6).hex()}.part")
                h = hashlib.md5()
                try:
                    with zf.open(m, "r") as src, temporary.open("xb") as dst:
                        while True:
                            chunk = src.read(1024 * 1024)
                            if not chunk:
                                break
                            h.update(chunk)
                            dst.write(chunk)
                except Exception:
                    temporary.unlink(missing_ok=True)
                    raise
                md5_hex = h.hexdigest()
                if md5_hex in seen:
                    temporary.unlink(missing_ok=True)
                    continue
                try:
                    os.replace(temporary, target)
                except Exception:
                    temporary.unlink(missing_ok=True)
                    raise
                seen.add(md5_hex)
                out.append(target.resolve())
        return out
    except zipfile.BadZipFile:
        logger.info("Standard zip parse failed, trying local-header fallback: %s", zip_path)
    for base, raw in _iter_local_header_zip_dems(zip_path):
        _write_deduped(base, raw)
    return out


class _DemoEventHandler(FileSystemEventHandler):
    def __init__(self, loop: asyncio.AbstractEventLoop, watcher: "DemoWatcher") -> None:
        super().__init__()
        self._loop = loop
        self._watcher = watcher

    def _schedule(self, path: Path) -> None:
        if not self._watcher.path_in_scope(path):
            return
        suf = path.suffix.lower()
        if suf == ".dem":
            asyncio.run_coroutine_threadsafe(self._watcher._on_raw_dem_detected(path), self._loop)
        elif suf == ".zip":
            asyncio.run_coroutine_threadsafe(self._watcher._on_raw_zip_detected(path), self._loop)

    def on_created(self, event) -> None:  # type: ignore[override]
        if event.is_directory:
            return
        self._schedule(Path(event.src_path))

    def on_modified(self, event) -> None:  # type: ignore[override]
        if event.is_directory:
            return
        self._schedule(Path(event.src_path))

    def on_moved(self, event) -> None:  # type: ignore[override]
        if event.is_directory:
            return
        self._schedule(Path(event.dest_path))


class DemoWatcher:
    def __init__(
        self,
        paths: list[str],
        on_detected: OnDemoDetected,
        demo_db: Optional["DemoDB"] = None,
        max_depth: int = 2,
    ) -> None:
        self._paths = paths
        self._max_depth = normalize_scan_depth(max_depth)
        self._on_detected = on_detected
        self._demo_db = demo_db
        self._observer: Observer | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        # 同一 zip 被「目录扫描 + 文件监听」或并发协程同时处理时，会在解压竞态下重复生成 _fromzip_*_N.dem
        self._zip_extract_lock = asyncio.Lock()

    def configure(self, paths: list[str], max_depth: int | None = None) -> None:
        self._paths = list(paths)
        if max_depth is not None:
            self._max_depth = normalize_scan_depth(max_depth)

    def path_in_scope(self, path: Path) -> bool:
        try:
            resolved = path.resolve()
        except OSError:
            return False
        for root in self._normalized_paths():
            try:
                relative = resolved.relative_to(root.resolve())
            except (OSError, ValueError):
                continue
            return max(0, len(relative.parts) - 1) <= self._max_depth
        return False

    def _normalized_paths(self) -> list[Path]:
        out: list[Path] = []
        seen: set[str] = set()
        for p in self._paths:
            if not p:
                continue
            cand = Path(p).expanduser()
            if not cand.is_dir():
                continue
            key = str(cand.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(cand)
        return out

    def watch_root_for(self, path: Path) -> str | None:
        """Return the configured watch root owning *path*, if any."""
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            return None
        matches: list[Path] = []
        for root in self._normalized_paths():
            try:
                resolved.relative_to(root.resolve())
            except (OSError, ValueError):
                continue
            matches.append(root.resolve())
        if not matches:
            return None
        # Nested roots are legal; the most specific root owns the record.
        return str(max(matches, key=lambda item: len(item.parts)))

    async def _wait_until_stable(self, path: Path, timeout_sec: int = 30) -> bool:
        previous_signature: tuple[int, int] | None = None
        stable_count = 0
        checks = max(1, timeout_sec)
        for _ in range(checks):
            if not path.exists():
                await asyncio.sleep(1)
                continue
            try:
                stat = path.stat()
                signature = (int(stat.st_size), int(stat.st_mtime_ns))
            except OSError:
                await asyncio.sleep(1)
                continue
            if signature[0] > 0 and signature == previous_signature:
                stable_count += 1
                if stable_count >= 2:
                    return True
            else:
                stable_count = 0
            previous_signature = signature
            await asyncio.sleep(1)
        return False

    async def _on_raw_dem_detected(self, path: Path) -> None:
        if not await self._wait_until_stable(path):
            logger.warning("Demo file not stable, skip: %s", path)
            return
        await self._on_detected(path, None)

    async def _on_raw_zip_detected(
        self,
        path: Path,
        *,
        enqueue_extracted: bool = True,
        assume_stable: bool = False,
    ) -> None:
        # 目录批量扫描时文件早已落盘，跳过「每秒轮询等稳定」以免每个 zip 白等数秒
        if assume_stable:
            try:
                if path.stat().st_size <= 0:
                    logger.warning("Zip empty, skip: %s", path)
                    return
            except OSError as e:
                logger.warning("Cannot stat zip, skip: %s (%s)", path, e)
                return
        elif not await self._wait_until_stable(path):
            logger.warning("Zip file not stable, skip: %s", path)
            return
        zip_resolved = str(path.resolve())
        async with self._zip_extract_lock:
            try:
                st = path.stat()
            except OSError as e:
                logger.warning("Cannot stat zip, skip: %s (%s)", path, e)
                return
            mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000)))
            size_b = int(st.st_size)
            loop = asyncio.get_running_loop()
            col_md5 = self._demo_db is not None and getattr(self._demo_db, "ingest_md5_supported", False)
            dedupe_md5 = col_md5 and _demo_ingest_md5_enabled()
            if self._demo_db is not None:
                try:
                    if col_md5:
                        st_row = await self._demo_db.get_zip_extract_state(zip_resolved)
                        if st_row and dedupe_md5:
                            zip_md5_stored = (st_row.get("zip_md5") or "").strip()
                            if zip_md5_stored:
                                zm = await loop.run_in_executor(None, file_md5_hex, path)
                                if zm == zip_md5_stored:
                                    if _zip_extract_outputs_present(path):
                                        logger.info("Zip unchanged (md5), skip extract: %s", path)
                                        await self._demo_db.record_zip_extracted(
                                            zip_resolved,
                                            mtime_ns,
                                            size_b,
                                            zip_md5=zm,
                                        )
                                        return
                                    logger.info(
                                        "Zip unchanged (md5) but extracted .dem missing, re-extract: %s",
                                        path,
                                    )
                            if st_row and not zip_md5_stored:
                                if int(st_row["mtime_ns"]) == mtime_ns and int(st_row["size_bytes"]) == size_b:
                                    if _zip_extract_outputs_present(path):
                                        zm = await loop.run_in_executor(None, file_md5_hex, path)
                                        await self._demo_db.record_zip_extracted(
                                            zip_resolved,
                                            mtime_ns,
                                            size_b,
                                            zip_md5=zm,
                                        )
                                        logger.info(
                                            "Zip unchanged (mtime+size), skip extract; backfilled zip_md5: %s",
                                            path,
                                        )
                                        return
                                    logger.info(
                                        "Zip unchanged (mtime+size) but extracted .dem missing, re-extract: %s",
                                        path,
                                    )
                        if not dedupe_md5 and await self._demo_db.zip_unchanged_since_extract(
                            zip_resolved,
                            mtime_ns,
                            size_b,
                        ):
                            if _zip_extract_outputs_present(path):
                                zm = await loop.run_in_executor(None, file_md5_hex, path)
                                await self._demo_db.record_zip_extracted(
                                    zip_resolved,
                                    mtime_ns,
                                    size_b,
                                    zip_md5=zm,
                                )
                                logger.info(
                                    "Zip unchanged (mtime+size), skip extract; backfilled zip_md5: %s",
                                    path,
                                )
                                return
                            logger.info(
                                "Zip unchanged (mtime+size) but extracted .dem missing, re-extract: %s",
                                path,
                            )
                    else:
                        if await self._demo_db.zip_unchanged_since_extract(zip_resolved, mtime_ns, size_b):
                            if _zip_extract_outputs_present(path):
                                logger.info("Zip unchanged since last extract, skip re-import: %s", path)
                                return
                            logger.info(
                                "Zip unchanged since last extract but .dem missing, re-extract: %s",
                                path,
                            )
                except Exception:
                    logger.exception("zip_extract_state / md5 check failed for %s", path)

            try:
                if col_md5 and self._demo_db is not None:
                    existing = frozenset(await self._demo_db.all_content_md5_hexes())
                    extracted = await loop.run_in_executor(None, _extract_zip_dems_dedupe_sync, path, existing)
                else:
                    extracted = await loop.run_in_executor(None, _extract_dems_from_zip_sync, path)
            except Exception:
                logger.exception("Failed to extract zip: %s", path)
                return
            zip_md5_val: str | None = None
            if col_md5:
                try:
                    zip_md5_val = await loop.run_in_executor(None, file_md5_hex, path)
                except Exception:
                    logger.exception("zip md5 after extract failed: %s", path)
            if self._demo_db is not None:
                try:
                    await self._demo_db.record_zip_extracted(
                        zip_resolved,
                        mtime_ns,
                        size_b,
                        zip_md5=zip_md5_val,
                    )
                except Exception:
                    logger.exception("record_zip_extracted failed for %s", path)
            if not extracted:
                logger.info("Zip contains no new .dem files (or empty), skip: %s", path)
                return
            logger.info("Extracted %d .dem from zip %s", len(extracted), path)
            if enqueue_extracted:
                for dem in extracted:
                    await self._on_detected(dem, zip_resolved)

    async def start(self) -> None:
        if self._observer is not None:
            return
        self._loop = asyncio.get_running_loop()
        paths = self._normalized_paths()
        if not paths:
            logger.info("No demo watch paths configured, watcher idle")
            return
        handler = _DemoEventHandler(self._loop, self)
        observer = Observer()
        for p in paths:
            observer.schedule(handler, str(p), recursive=self._max_depth > 0)
            logger.info("Watching demo directory: %s (depth=%s)", p, self._max_depth)
        observer.start()
        self._observer = observer

    async def stop(self) -> None:
        if self._observer is None:
            return
        self._observer.stop()
        self._observer.join(timeout=5)
        self._observer = None

    async def restart(self, paths: list[str], max_depth: int | None = None) -> None:
        self.configure(paths, max_depth)
        await self.stop()
        await self.start()

    async def scan_existing(self) -> int:
        count = 0
        raw_conc = (os.environ.get("CS2_INSIGHT_SCAN_CONCURRENCY") or "").strip()
        try:
            max_conc = int(raw_conc) if raw_conc else 0
        except ValueError:
            max_conc = 0
        if max_conc < 1:
            max_conc = max(2, min(8, (os.cpu_count() or 4)))
        sem = asyncio.Semaphore(max_conc)

        # Reconcile one successfully enumerated watch root at a time.  Never use
        # a local path set to purge unrelated/manual records from the whole DB.
        for p in self._normalized_paths():
            existing_paths: set[str] = set()
            scan_errors: list[OSError] = []
            zip_paths = iter_candidate_files(
                p,
                (".zip",),
                max_depth=self._max_depth,
                on_error=scan_errors.append,
            )
            for archive in _sort_paths_by_mtime_newest_first(zip_paths):
                await self._on_raw_zip_detected(archive, enqueue_extracted=False, assume_stable=True)
                count += 1
            for dem in iter_candidate_files(
                p,
                (".dem",),
                max_depth=self._max_depth,
                on_error=scan_errors.append,
            ):
                try:
                    existing_paths.add(str(dem.resolve()))
                except OSError:
                    scan_errors.append(OSError(f"cannot resolve {dem}"))
            if scan_errors:
                logger.warning("Skip demo reconciliation for %s after scan errors: %s", p, scan_errors[-1])
                continue
            if self._demo_db is None:
                continue
            try:
                await self._demo_db.purge_deleted_demo_files(str(p.resolve()), existing_paths)
            except Exception:
                logger.exception("purge_deleted_demo_files failed during scan for root %s", p)

        async def _enqueue_dem(path: Path) -> None:
            async with sem:
                try:
                    await self._on_detected(path, None)
                except Exception:
                    logger.exception("scan_existing: enqueue failed for %s", path)

        for p in self._normalized_paths():
            # ZIP extraction already ran before reconciliation, so newly
            # materialized .dem files cannot be purged before they are indexed.
            dem_paths = _sort_paths_by_mtime_newest_first(
                iter_candidate_files(p, (".dem",), max_depth=self._max_depth)
            )
            if dem_paths:
                await asyncio.gather(*(_enqueue_dem(item) for item in dem_paths))
                count += len(dem_paths)
        return count
