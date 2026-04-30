"""Watch multiple directories and enqueue new .dem files."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable, Iterable, Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

if TYPE_CHECKING:
    from .demo_db import DemoDB

logger = logging.getLogger(__name__)

OnDemoDetected = Callable[[Path], Awaitable[None]]


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


def _extract_dems_from_zip_sync(zip_path: Path) -> list[Path]:
    """Extract all .dem from zip into the same directory as the zip. Returns written paths."""
    out: list[Path] = []
    dest_dir = zip_path.parent
    with zipfile.ZipFile(zip_path, "r") as zf:
        members = [m for m in zf.namelist() if _safe_zip_member_name(m)]
        if not members:
            return out
        for m in members:
            base = _safe_zip_member_name(m)
            if not base:
                continue
            target = _pick_extract_path(dest_dir, base, zip_path)
            with zf.open(m, "r") as src, target.open("wb") as dst:
                dst.write(src.read())
            out.append(target.resolve())
    return out


class _DemoEventHandler(FileSystemEventHandler):
    def __init__(self, loop: asyncio.AbstractEventLoop, watcher: "DemoWatcher") -> None:
        super().__init__()
        self._loop = loop
        self._watcher = watcher

    def on_created(self, event) -> None:  # type: ignore[override]
        if event.is_directory:
            return
        path = Path(event.src_path)
        suf = path.suffix.lower()
        if suf == ".dem":
            asyncio.run_coroutine_threadsafe(self._watcher._on_raw_dem_detected(path), self._loop)
        elif suf == ".zip":
            asyncio.run_coroutine_threadsafe(self._watcher._on_raw_zip_detected(path), self._loop)


class DemoWatcher:
    def __init__(
        self,
        paths: list[str],
        on_detected: OnDemoDetected,
        demo_db: Optional["DemoDB"] = None,
    ) -> None:
        self._paths = paths
        self._on_detected = on_detected
        self._demo_db = demo_db
        self._observer: Observer | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        # 同一 zip 被「目录扫描 + 文件监听」或并发协程同时处理时，会在解压竞态下重复生成 _fromzip_*_N.dem
        self._zip_extract_lock = asyncio.Lock()

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

    async def _wait_until_stable(self, path: Path, timeout_sec: int = 30) -> bool:
        prev_size = -1
        stable_count = 0
        checks = max(1, timeout_sec)
        for _ in range(checks):
            if not path.exists():
                await asyncio.sleep(1)
                continue
            try:
                size = path.stat().st_size
            except OSError:
                await asyncio.sleep(1)
                continue
            if size > 0 and size == prev_size:
                stable_count += 1
                if stable_count >= 2:
                    return True
            else:
                stable_count = 0
            prev_size = size
            await asyncio.sleep(1)
        return False

    async def _on_raw_dem_detected(self, path: Path) -> None:
        if not await self._wait_until_stable(path):
            logger.warning("Demo file not stable, skip: %s", path)
            return
        await self._on_detected(path)

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
            if self._demo_db is not None:
                try:
                    if await self._demo_db.zip_unchanged_since_extract(zip_resolved, mtime_ns, size_b):
                        logger.info("Zip unchanged since last extract, skip re-import: %s", path)
                        return
                except Exception:
                    logger.exception("zip_extract_state check failed for %s", path)

            loop = asyncio.get_running_loop()
            try:
                extracted = await loop.run_in_executor(None, _extract_dems_from_zip_sync, path)
            except zipfile.BadZipFile:
                logger.warning("Not a valid zip, skip: %s", path)
                return
            except Exception:
                logger.exception("Failed to extract zip: %s", path)
                return
            if self._demo_db is not None:
                try:
                    await self._demo_db.record_zip_extracted(zip_resolved, mtime_ns, size_b)
                except Exception:
                    logger.exception("record_zip_extracted failed for %s", path)
            if not extracted:
                logger.info("Zip contains no .dem files, skip: %s", path)
                return
            logger.info("Extracted %d .dem from zip %s", len(extracted), path)
            if enqueue_extracted:
                for dem in extracted:
                    await self._on_detected(dem)

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
            observer.schedule(handler, str(p), recursive=False)
            logger.info("Watching demo directory: %s", p)
        observer.start()
        self._observer = observer

    async def stop(self) -> None:
        if self._observer is None:
            return
        self._observer.stop()
        self._observer.join(timeout=5)
        self._observer = None

    async def restart(self, paths: list[str]) -> None:
        self._paths = paths
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

        async def _enqueue_dem(path: Path) -> None:
            async with sem:
                try:
                    await self._on_detected(path)
                except Exception:
                    logger.exception("scan_existing: enqueue failed for %s", path)

        for p in self._normalized_paths():
            # 先 zip 再 .dem：本轮解压出的文件可立即随后面的 glob 入库，避免「先扫 dem 再解压」需二次扫描才登记
            # 同类文件按 mtime 降序，优先处理最近写入的（用户刚下的 replay 等）
            for z in _sort_paths_by_mtime_newest_first(p.glob("*.zip")):
                await self._on_raw_zip_detected(z, enqueue_extracted=False, assume_stable=True)
                count += 1
            dem_paths = _sort_paths_by_mtime_newest_first(p.glob("*.dem"))
            if dem_paths:
                await asyncio.gather(*(_enqueue_dem(item) for item in dem_paths))
                count += len(dem_paths)
        return count
