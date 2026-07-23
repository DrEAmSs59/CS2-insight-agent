"""Preserve renderer state while moving from Electron to Tauri/WebView2.

Electron and Tauri use different browser profiles and origins, so copying the
Chromium LevelDB directory does not make ``localStorage`` visible to WebView2.
During installation we briefly start the still-installed Electron executable
with a DevTools port, ask its own renderer to export the small set of durable
application keys, and then close it normally. The original LevelDB files are
also archived before the export as a recovery copy.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlsplit


UI_STATE_FILE_NAME = "desktop-ui-state-v1.json"
UI_STATE_BACKUP_DIR_NAME = "legacy-electron-browser-state-v1"
ELECTRON_EXECUTABLE_NAME = "CS2 Insight Agent.exe"
ELECTRON_UNINSTALLER_NAME = "uninstall cs2 insight agent.exe"
LEGACY_PROFILE_NAMES = (
    "cs2-insight-agent",
    "com.cs2insightagent.app",
    "CS2 Insight Agent",
)
EXACT_LOCAL_STORAGE_KEYS = {
    "cs2-insight-theme",
    "liteCut:panelLayout",
    "liteCut:lastProjectId",
}
LOCAL_STORAGE_KEY_PREFIXES = ("liteCut:recovery:v1:",)


class ElectronUiStateMigrationError(RuntimeError):
    """Raised when an installer-required renderer export cannot be proven."""


@dataclass(frozen=True)
class ElectronUiStateResult:
    mode: str  # "none", "existing", "exported" or "archived"
    state_file: Optional[str]
    source_profiles: tuple[str, ...]
    archived_profiles: tuple[str, ...]
    exported_keys: tuple[str, ...]


def _is_allowed_key(key: str) -> bool:
    return key in EXACT_LOCAL_STORAGE_KEYS or key.startswith(LOCAL_STORAGE_KEY_PREFIXES)


def _profile_has_browser_state(profile: Path) -> bool:
    leveldb = profile / "Local Storage" / "leveldb"
    if not leveldb.is_dir():
        return False
    return any(item.is_file() and item.stat().st_size > 0 for item in leveldb.iterdir())


def discover_legacy_profiles(appdata: Path) -> list[Path]:
    profiles: list[Path] = []
    for name in LEGACY_PROFILE_NAMES:
        profile = appdata / name
        if _profile_has_browser_state(profile):
            profiles.append(profile)
    return profiles


def _copy_profile_recovery_files(profile: Path, backup_root: Path) -> bool:
    destination = backup_root / profile.name
    copied = False
    for name in ("Local Storage", "Session Storage"):
        source = profile / name
        if source.is_dir():
            shutil.copytree(source, destination / name, dirs_exist_ok=True)
            copied = True
    for name in ("Preferences", "Local State"):
        source = profile / name
        if source.is_file():
            destination.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination / name)
            copied = True
    return copied


def archive_legacy_profiles(profiles: list[Path], canonical_data_root: Path) -> tuple[str, ...]:
    backup_root = canonical_data_root / UI_STATE_BACKUP_DIR_NAME
    archived: list[str] = []
    for profile in profiles:
        if _copy_profile_recovery_files(profile, backup_root):
            archived.append(str(profile))
    return tuple(archived)


def _executable_from_command(command: str) -> Optional[Path]:
    text = str(command or "").strip()
    if not text:
        return None
    quoted = re.match(r'^"([^"]+\.exe)"', text, flags=re.IGNORECASE)
    if quoted:
        return Path(quoted.group(1))
    match = re.match(r"^(.+?\.exe)(?:\s|$)", text, flags=re.IGNORECASE)
    return Path(match.group(1).strip()) if match else None


def _registry_install_candidates() -> list[Path]:
    if os.name != "nt":
        return []
    try:
        import winreg
    except ImportError:
        return []

    candidates: list[Path] = []
    roots = (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE)
    views = (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY)
    subkey = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
    for root in roots:
        for view in views:
            try:
                parent = winreg.OpenKey(root, subkey, 0, winreg.KEY_READ | view)
            except OSError:
                continue
            try:
                index = 0
                while True:
                    try:
                        name = winreg.EnumKey(parent, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        entry = winreg.OpenKey(parent, name)
                    except OSError:
                        continue
                    try:
                        try:
                            display_name = str(winreg.QueryValueEx(entry, "DisplayName")[0])
                        except OSError:
                            continue
                        if not display_name.lower().startswith("cs2 insight agent"):
                            continue
                        try:
                            uninstall = str(winreg.QueryValueEx(entry, "UninstallString")[0])
                        except OSError:
                            uninstall = ""
                        if ELECTRON_UNINSTALLER_NAME not in uninstall.lower():
                            continue
                        try:
                            install_location = str(winreg.QueryValueEx(entry, "InstallLocation")[0])
                        except OSError:
                            install_location = ""
                        if install_location:
                            candidates.append(Path(install_location) / ELECTRON_EXECUTABLE_NAME)
                        uninstaller = _executable_from_command(uninstall)
                        if uninstaller is not None:
                            candidates.append(uninstaller.parent / ELECTRON_EXECUTABLE_NAME)
                    finally:
                        winreg.CloseKey(entry)
            finally:
                winreg.CloseKey(parent)
    return candidates


def find_legacy_electron_executable() -> Optional[Path]:
    candidates: list[Path] = []
    override = os.environ.get("CS2_INSIGHT_ELECTRON_EXE", "").strip()
    if override:
        candidates.append(Path(override))
    candidates.extend(_registry_install_candidates())

    for variable, suffix in (
        ("ProgramFiles", Path("CS2 Insight Agent") / ELECTRON_EXECUTABLE_NAME),
        ("ProgramFiles(x86)", Path("CS2 Insight Agent") / ELECTRON_EXECUTABLE_NAME),
        ("LOCALAPPDATA", Path("Programs") / "CS2 Insight Agent" / ELECTRON_EXECUTABLE_NAME),
    ):
        root = os.environ.get(variable)
        if root:
            candidates.append(Path(root) / suffix)

    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.is_file() and candidate.name.lower() == ELECTRON_EXECUTABLE_NAME.lower():
            return candidate.resolve()
    return None


def _available_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _wait_for_port_closed(port: int, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.25)
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return
        time.sleep(0.2)
    raise ElectronUiStateMigrationError(
        f"legacy Electron closed, but its backend is still listening on 127.0.0.1:{port}"
    )


def _read_http_json(url: str, timeout: float = 1.0):
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _wait_for_renderer(port: int, process: subprocess.Popen, timeout: float) -> str:
    deadline = time.monotonic() + timeout
    last_error = "renderer did not publish a DevTools target"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ElectronUiStateMigrationError(
                f"legacy Electron exited before renderer export (exit code {process.returncode})"
            )
        try:
            targets = _read_http_json(f"http://127.0.0.1:{port}/json/list")
            pages = [item for item in targets if item.get("type") == "page"]
            preferred = next(
                (item for item in pages if str(item.get("url", "")).startswith("app://local")),
                None,
            )
            if preferred and preferred.get("webSocketDebuggerUrl"):
                return str(preferred["webSocketDebuggerUrl"])
        except (OSError, ValueError, urllib.error.URLError) as exc:
            last_error = str(exc)
        time.sleep(0.2)
    raise ElectronUiStateMigrationError(f"timed out waiting for legacy Electron renderer: {last_error}")


def _read_exact(connection: socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise ElectronUiStateMigrationError("DevTools WebSocket closed unexpectedly")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _send_websocket_text(connection: socket.socket, body: str) -> None:
    payload = body.encode("utf-8")
    mask = secrets.token_bytes(4)
    header = bytearray([0x81])
    length = len(payload)
    if length < 126:
        header.append(0x80 | length)
    elif length <= 0xFFFF:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", length))
    header.extend(mask)
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    connection.sendall(bytes(header) + masked)


def _receive_websocket_text(connection: socket.socket) -> str:
    fragments: list[bytes] = []
    while True:
        first, second = _read_exact(connection, 2)
        final = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", _read_exact(connection, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", _read_exact(connection, 8))[0]
        mask = _read_exact(connection, 4) if masked else b""
        payload = _read_exact(connection, length)
        if masked:
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        if opcode == 0x8:
            raise ElectronUiStateMigrationError("DevTools WebSocket closed during export")
        if opcode == 0x9:
            connection.sendall(bytes([0x8A, len(payload)]) + payload)
            continue
        if opcode in (0x1, 0x0):
            fragments.append(payload)
            if final:
                return b"".join(fragments).decode("utf-8")


def _websocket_connect(url: str, timeout: float = 10.0) -> socket.socket:
    parsed = urlsplit(url)
    if parsed.scheme != "ws" or not parsed.hostname or not parsed.port:
        raise ElectronUiStateMigrationError(f"unsupported DevTools WebSocket URL: {url}")
    connection = socket.create_connection((parsed.hostname, parsed.port), timeout=timeout)
    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {parsed.hostname}:{parsed.port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    connection.sendall(request.encode("ascii"))
    response = bytearray()
    while b"\r\n\r\n" not in response:
        response.extend(_read_exact(connection, 1))
        if len(response) > 32 * 1024:
            raise ElectronUiStateMigrationError("oversized DevTools WebSocket handshake")
    first_line = bytes(response).split(b"\r\n", 1)[0]
    if b" 101 " not in first_line:
        connection.close()
        raise ElectronUiStateMigrationError(
            f"DevTools WebSocket handshake failed: {first_line.decode('latin-1', errors='replace')}"
        )
    expected = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
    ).decode("ascii")
    if f"sec-websocket-accept: {expected}".lower().encode("ascii") not in bytes(response).lower():
        connection.close()
        raise ElectronUiStateMigrationError("invalid DevTools WebSocket handshake response")
    return connection


def _cdp_request(connection: socket.socket, request_id: int, method: str, params: dict) -> dict:
    _send_websocket_text(
        connection,
        json.dumps({"id": request_id, "method": method, "params": params}, separators=(",", ":")),
    )
    while True:
        response = json.loads(_receive_websocket_text(connection))
        if response.get("id") == request_id:
            if "error" in response:
                raise ElectronUiStateMigrationError(f"DevTools command failed: {response['error']}")
            return response


def _export_expression() -> str:
    exact = json.dumps(sorted(EXACT_LOCAL_STORAGE_KEYS), ensure_ascii=False)
    prefixes = json.dumps(list(LOCAL_STORAGE_KEY_PREFIXES), ensure_ascii=False)
    return f"""(() => {{
      const exact = new Set({exact});
      const prefixes = {prefixes};
      const out = {{}};
      for (let index = 0; index < localStorage.length; index += 1) {{
        const key = localStorage.key(index);
        if (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {{
          out[key] = localStorage.getItem(key);
        }}
      }}
      return JSON.stringify(out);
    }})()"""


def export_ui_state_via_electron(executable: Path, timeout: float = 35.0) -> dict[str, str]:
    port = _available_local_port()
    report_path = Path(tempfile.gettempdir()) / f"cs2-electron-ui-export-{os.getpid()}.json"
    environment = os.environ.copy()
    environment["CS2_INSIGHT_ELECTRON_SMOKE"] = "1"
    environment["CS2_INSIGHT_ELECTRON_SMOKE_REPORT"] = str(report_path)
    environment["ELECTRON_NO_ATTACH_CONSOLE"] = "1"
    creation_flags = 0x08000000 if os.name == "nt" else 0
    process = subprocess.Popen(
        [str(executable), f"--remote-debugging-port={port}", "--remote-allow-origins=*"],
        cwd=str(executable.parent),
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags,
    )
    connection: Optional[socket.socket] = None
    try:
        websocket_url = _wait_for_renderer(port, process, timeout)
        connection = _websocket_connect(websocket_url)
        response = _cdp_request(
            connection,
            1,
            "Runtime.evaluate",
            {"expression": _export_expression(), "returnByValue": True, "awaitPromise": True},
        )
        remote = response.get("result", {}).get("result", {})
        if remote.get("type") != "string" or not isinstance(remote.get("value"), str):
            raise ElectronUiStateMigrationError(f"legacy renderer returned no UI state: {remote}")
        parsed = json.loads(remote["value"])
        if not isinstance(parsed, dict):
            raise ElectronUiStateMigrationError("legacy renderer UI state was not a JSON object")
        exported = {
            str(key): str(value)
            for key, value in parsed.items()
            if isinstance(key, str) and isinstance(value, str) and _is_allowed_key(key)
        }
        try:
            _cdp_request(
                connection,
                2,
                "Runtime.evaluate",
                {"expression": "window.electron?.close?.(); true", "returnByValue": True},
            )
        except Exception:
            pass
        return exported
    finally:
        if connection is not None:
            connection.close()
        try:
            process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        report_path.unlink(missing_ok=True)
        _wait_for_port_closed(19871, timeout=12)


def _write_json_atomically(path: Path, body: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _read_existing_state(path: Path) -> Optional[dict[str, str]]:
    if not path.is_file():
        return None
    try:
        body = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    storage = body.get("local_storage") if isinstance(body, dict) else None
    if not isinstance(storage, dict):
        return None
    if not all(isinstance(key, str) and isinstance(value, str) for key, value in storage.items()):
        return None
    return {key: value for key, value in storage.items() if _is_allowed_key(key)}


def migrate_electron_ui_state(
    appdata: Path,
    canonical_data_root: Path,
    *,
    require_export: bool = False,
    electron_executable: Optional[Path] = None,
    exporter: Callable[[Path], dict[str, str]] = export_ui_state_via_electron,
) -> ElectronUiStateResult:
    appdata = appdata.expanduser().resolve()
    canonical_data_root = canonical_data_root.expanduser().resolve()
    state_file = canonical_data_root / UI_STATE_FILE_NAME
    existing = _read_existing_state(state_file)
    if existing is not None:
        return ElectronUiStateResult(
            mode="existing",
            state_file=str(state_file),
            source_profiles=(),
            archived_profiles=(),
            exported_keys=tuple(sorted(existing)),
        )

    profiles = discover_legacy_profiles(appdata)
    if not profiles:
        return ElectronUiStateResult("none", None, (), (), ())

    archived = archive_legacy_profiles(profiles, canonical_data_root)
    executable = electron_executable or find_legacy_electron_executable()
    if executable is None:
        # A previous Tauri build may already have removed Electron while its
        # profile remains. Keep a byte-for-byte recovery copy, but do not make
        # future Tauri upgrades impossible when there is no old executable to
        # retire. The installer-required failure path applies when an existing
        # Electron executable was found but could not export its live state.
        return ElectronUiStateResult(
            mode="archived",
            state_file=None,
            source_profiles=tuple(str(profile) for profile in profiles),
            archived_profiles=archived,
            exported_keys=(),
        )

    try:
        exported = exporter(executable)
    except Exception as exc:
        if require_export:
            raise ElectronUiStateMigrationError(f"could not export legacy Electron UI state: {exc}") from exc
        return ElectronUiStateResult(
            mode="archived",
            state_file=None,
            source_profiles=tuple(str(profile) for profile in profiles),
            archived_profiles=archived,
            exported_keys=(),
        )

    filtered = {
        key: value
        for key, value in exported.items()
        if isinstance(key, str) and isinstance(value, str) and _is_allowed_key(key)
    }
    _write_json_atomically(
        state_file,
        {
            "version": 1,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "source_profiles": [str(profile) for profile in profiles],
            "local_storage": filtered,
        },
    )
    return ElectronUiStateResult(
        mode="exported",
        state_file=str(state_file),
        source_profiles=tuple(str(profile) for profile in profiles),
        archived_profiles=archived,
        exported_keys=tuple(sorted(filtered)),
    )


def result_as_dict(result: ElectronUiStateResult) -> dict:
    return asdict(result)
