"""Persistent custom skybox resources and Source 2 upload validation."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import struct
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from .env_utils import get_data_dir


CUSTOM_SKYBOX_PREFIX = "custom:"
CUSTOM_SKYBOX_ID_RE = re.compile(r"^custom:[0-9a-f]{32}$")
MAX_SKYBOX_NAME_LENGTH = 64
MAX_VMAT_BYTES = 2 * 1024 * 1024
MAX_VTEX_BYTES = 256 * 1024 * 1024
MANIFEST_FILENAME = "manifest.json"
MATERIAL_FILENAME = "material.vmat_c"
TEXTURE_FILENAME = "texture.vtex_c"

BUILTIN_SKYBOX_NAMES = {
    "chroma_green": "纯绿幕（AE / PR 抠像）",
    "chroma_blue": "纯蓝幕（AE / PR 抠像）",
    "xuejing": "雪景",
    "yinhezhanjian": "银河战舰",
    "huoshaoyun": "火烧云",
    "xiyang": "夕阳",
    "chengchetiankong": "乘车天空",
}


def builtin_skybox_display_name(skybox_id: str) -> str:
    if skybox_id in BUILTIN_SKYBOX_NAMES:
        return BUILTIN_SKYBOX_NAMES[skybox_id]
    cartoon = re.fullmatch(r"cartoon(\d*)", skybox_id)
    if cartoon:
        return f"Cartoon {cartoon.group(1)}".rstrip()
    egg = re.fullmatch(r"egg(\d+)", skybox_id)
    if egg:
        return f"Egg {egg.group(1)}"
    return skybox_id


class SkyboxResourceError(ValueError):
    pass


class SkyboxResourceConflict(SkyboxResourceError):
    pass


@dataclass(frozen=True)
class ResolvedSkyboxResource:
    material_path: str
    texture_path: str
    material_bytes: bytes
    texture_bytes: bytes


def get_custom_skybox_root() -> Path:
    return get_data_dir() / "game_resources" / "skyboxes"


def is_custom_skybox_id(value: object) -> bool:
    return bool(CUSTOM_SKYBOX_ID_RE.fullmatch(str(value or "").strip().lower()))


def _normalize_display_name(value: object) -> str:
    name = str(value or "").strip()
    if not name:
        raise SkyboxResourceError("天空盒名称不能为空。")
    if len(name) > MAX_SKYBOX_NAME_LENGTH:
        raise SkyboxResourceError(f"天空盒名称不能超过 {MAX_SKYBOX_NAME_LENGTH} 个字符。")
    if any(ord(char) < 32 for char in name):
        raise SkyboxResourceError("天空盒名称包含不支持的控制字符。")
    return name


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _resource_blocks(data: bytes) -> tuple[dict[str, tuple[int, int]], int]:
    if len(data) < 16:
        raise SkyboxResourceError("文件不是有效的 Source 2 编译资源：文件头不完整。")
    declared_size, header_version, _resource_version, block_offset, block_count = struct.unpack_from(
        "<IHHII", data, 0
    )
    if header_version != 12:
        raise SkyboxResourceError(
            f"不支持的 Source 2 资源头版本：{header_version}（需要 12）。"
        )
    if declared_size < 16 or declared_size > len(data):
        raise SkyboxResourceError("Source 2 资源声明的文件长度无效。")
    if block_count < 1 or block_count > 128:
        raise SkyboxResourceError("Source 2 资源块数量无效。")

    # BlockOffset is relative to the position of its own uint32 field (0x08).
    table_start = 8 + block_offset
    table_end = table_start + block_count * 12
    if table_start < 16 or table_end > declared_size:
        raise SkyboxResourceError("Source 2 资源块索引越界。")

    blocks: dict[str, tuple[int, int]] = {}
    for index in range(block_count):
        entry_start = table_start + index * 12
        raw_type = data[entry_start : entry_start + 4]
        try:
            block_type = raw_type.decode("ascii")
        except UnicodeDecodeError as exc:
            raise SkyboxResourceError("Source 2 资源块类型无效。") from exc
        relative_offset, block_size = struct.unpack_from("<II", data, entry_start + 4)
        block_start = entry_start + 4 + relative_offset
        block_end = block_start + block_size
        if block_start < table_end or block_end > declared_size:
            raise SkyboxResourceError(f"Source 2 资源块 {block_type} 越界。")
        blocks[block_type] = (block_start, block_size)
    return blocks, declared_size


def _read_cstring(data: bytes, start: int, end: int) -> str:
    terminator = data.find(b"\0", start, end)
    if terminator < 0:
        raise SkyboxResourceError("Source 2 外部资源引用缺少字符串终止符。")
    try:
        return data[start:terminator].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SkyboxResourceError("Source 2 外部资源引用不是有效 UTF-8。") from exc


def _external_references(data: bytes, blocks: dict[str, tuple[int, int]]) -> list[str]:
    location = blocks.get("RERL")
    if location is None:
        return []
    block_start, block_size = location
    block_end = block_start + block_size
    if block_size < 8:
        raise SkyboxResourceError("Source 2 RERL 资源引用块不完整。")
    table_offset, count = struct.unpack_from("<II", data, block_start)
    table_start = block_start + table_offset
    table_end = table_start + count * 12
    if count > 256 or table_start < block_start or table_end > block_end:
        raise SkyboxResourceError("Source 2 RERL 资源引用表越界。")

    references: list[str] = []
    for index in range(count):
        entry_start = table_start + index * 12
        name_offset_field = entry_start + 8
        name_offset = struct.unpack_from("<I", data, name_offset_field)[0]
        name_start = name_offset_field + name_offset
        if name_start < table_end or name_start >= block_end:
            raise SkyboxResourceError("Source 2 外部资源引用路径越界。")
        references.append(_read_cstring(data, name_start, block_end))
    return references


def _normalize_texture_reference(value: str) -> str:
    normalized = value.strip().replace("\\", "/").lower()
    if normalized.endswith(".vtex_c"):
        compiled = normalized
    elif normalized.endswith(".vtex"):
        compiled = f"{normalized}_c"
    else:
        raise SkyboxResourceError("vmat_c 引用的资源不是 vtex 纹理。")
    path = PurePosixPath(compiled)
    if path.is_absolute() or ".." in path.parts or not compiled.startswith("materials/"):
        raise SkyboxResourceError("vmat_c 中的纹理引用必须位于 materials/ 下。")
    return path.as_posix()


def validate_skybox_files(
    *,
    material_filename: str,
    material_bytes: bytes,
    texture_filename: str,
    texture_bytes: bytes,
) -> str:
    if not str(material_filename or "").lower().endswith(".vmat_c"):
        raise SkyboxResourceError("材质文件必须使用 .vmat_c 扩展名。")
    if not str(texture_filename or "").lower().endswith(".vtex_c"):
        raise SkyboxResourceError("纹理文件必须使用 .vtex_c 扩展名。")
    if not material_bytes or len(material_bytes) > MAX_VMAT_BYTES:
        raise SkyboxResourceError("vmat_c 文件为空或超过 2 MB。")
    if not texture_bytes or len(texture_bytes) > MAX_VTEX_BYTES:
        raise SkyboxResourceError("vtex_c 文件为空或超过 256 MB。")

    material_blocks, _ = _resource_blocks(material_bytes)
    texture_blocks, _ = _resource_blocks(texture_bytes)
    if "DATA" not in material_blocks or "DATA" not in texture_blocks:
        raise SkyboxResourceError("上传文件缺少 Source 2 DATA 资源块。")
    if b"sky.vfx" not in material_bytes:
        raise SkyboxResourceError("该 vmat_c 不是 sky.vfx 天空材质。")

    texture_refs = [
        ref for ref in _external_references(material_bytes, material_blocks)
        if ref.lower().endswith((".vtex", ".vtex_c"))
    ]
    if len(texture_refs) != 1:
        raise SkyboxResourceError(
            "vmat_c 必须且只能引用一个 vtex 纹理，才能作为单纹理天空盒上传。"
        )
    texture_path = _normalize_texture_reference(texture_refs[0])
    expected_name = PurePosixPath(texture_path).name
    actual_name = Path(str(texture_filename)).name.lower()
    if actual_name != expected_name.lower():
        raise SkyboxResourceError(
            f"vmat_c 需要纹理 {expected_name}，但上传的是 {Path(str(texture_filename)).name}。"
        )
    return texture_path


def _manifest_path(resource_id: str) -> Path:
    normalized = str(resource_id or "").strip().lower()
    if not is_custom_skybox_id(normalized):
        raise SkyboxResourceError("无效的自定义天空盒 ID。")
    return get_custom_skybox_root() / normalized.removeprefix(CUSTOM_SKYBOX_PREFIX) / MANIFEST_FILENAME


def _atomic_write_manifest(path: Path, payload: dict[str, Any]) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise SkyboxResourceError(f"天空盒清单损坏：{path.parent.name}") from exc
    if not isinstance(value, dict):
        raise SkyboxResourceError(f"天空盒清单格式无效：{path.parent.name}")
    return value


def _custom_manifest_snapshot(path: Path) -> dict[str, Any]:
    manifest = _read_manifest(path)
    resource_id = str(manifest.get("id") or "").strip().lower()
    if not is_custom_skybox_id(resource_id) or path.parent.name != resource_id.split(":", 1)[1]:
        raise SkyboxResourceError(f"天空盒清单 ID 无效：{path.parent.name}")
    material_path = path.parent / MATERIAL_FILENAME
    texture_path = path.parent / TEXTURE_FILENAME
    available = material_path.is_file() and texture_path.is_file()
    return {
        "id": resource_id,
        "display_name": str(manifest.get("display_name") or resource_id),
        "source": "custom",
        "readonly": False,
        "available": available,
        "status": "ready" if available else "broken",
        "material_original_name": str(manifest.get("material_original_name") or ""),
        "texture_original_name": str(manifest.get("texture_original_name") or ""),
        "size_bytes": int(manifest.get("size_bytes") or 0),
        "created_at": str(manifest.get("created_at") or ""),
        "preview_url": None,
    }


def list_skybox_resources() -> list[dict[str, Any]]:
    from .skybox_vpk import SKYBOX_ASSETS

    items = [
        {
            "id": skybox_id,
            "display_name": builtin_skybox_display_name(skybox_id),
            "source": "builtin",
            "readonly": True,
            "available": True,
            "status": "ready",
            "material_original_name": PurePosixPath(paths[0]).name,
            "texture_original_name": PurePosixPath(paths[1]).name,
            "size_bytes": 0,
            "created_at": "",
            "preview_url": f"/skyboxes/{skybox_id}.webp",
        }
        for skybox_id, paths in SKYBOX_ASSETS.items()
    ]
    root = get_custom_skybox_root()
    if not root.is_dir():
        return items
    for path in sorted(root.glob(f"*/{MANIFEST_FILENAME}")):
        candidate_id = f"custom:{path.parent.name}"
        if not is_custom_skybox_id(candidate_id):
            continue
        try:
            items.append(_custom_manifest_snapshot(path))
        except SkyboxResourceError:
            items.append(
                {
                    "id": candidate_id,
                    "display_name": path.parent.name,
                    "source": "custom",
                    "readonly": False,
                    "available": False,
                    "status": "broken",
                    "material_original_name": "",
                    "texture_original_name": "",
                    "size_bytes": 0,
                    "created_at": "",
                    "preview_url": None,
                }
            )
    return items


def skybox_resource_exists(resource_id: object) -> bool:
    normalized = str(resource_id or "").strip().lower()
    if normalized == "default":
        return True
    from .skybox_vpk import SKYBOX_ASSETS

    if normalized in SKYBOX_ASSETS:
        return True
    if not is_custom_skybox_id(normalized):
        return False
    try:
        return bool(_custom_manifest_snapshot(_manifest_path(normalized))["available"])
    except SkyboxResourceError:
        return False


def create_custom_skybox(
    *,
    display_name: object,
    material_filename: str,
    material_bytes: bytes,
    texture_filename: str,
    texture_bytes: bytes,
) -> dict[str, Any]:
    name = _normalize_display_name(display_name)
    texture_internal_path = validate_skybox_files(
        material_filename=material_filename,
        material_bytes=material_bytes,
        texture_filename=texture_filename,
        texture_bytes=texture_bytes,
    )
    material_sha = _sha256(material_bytes)
    texture_sha = _sha256(texture_bytes)
    for item in list_skybox_resources():
        if item["source"] == "custom" and item["display_name"].casefold() == name.casefold():
            raise SkyboxResourceConflict(f"已存在名为“{name}”的天空盒。")
        if item["source"] != "custom" or not item.get("available"):
            continue
        try:
            existing = _read_manifest(_manifest_path(item["id"]))
        except SkyboxResourceError:
            continue
        hashes = existing.get("sha256") if isinstance(existing.get("sha256"), dict) else {}
        if hashes.get("material") == material_sha and hashes.get("texture") == texture_sha:
            raise SkyboxResourceConflict(
                f"这组文件已作为“{item['display_name']}”导入。"
            )

    suffix = uuid.uuid4().hex
    resource_id = f"{CUSTOM_SKYBOX_PREFIX}{suffix}"
    root = get_custom_skybox_root()
    root.mkdir(parents=True, exist_ok=True)
    target_dir = root / suffix
    temp_dir = root / f".{suffix}.tmp"
    manifest = {
        "schema_version": 1,
        "id": resource_id,
        "display_name": name,
        "material_original_name": Path(str(material_filename)).name,
        "texture_original_name": Path(str(texture_filename)).name,
        "material_internal_path": f"materials/cs2_insight/skyboxes/{suffix}.vmat_c",
        "texture_internal_path": texture_internal_path,
        "sha256": {"material": material_sha, "texture": texture_sha},
        "size_bytes": len(material_bytes) + len(texture_bytes),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        temp_dir.mkdir()
        (temp_dir / MATERIAL_FILENAME).write_bytes(material_bytes)
        (temp_dir / TEXTURE_FILENAME).write_bytes(texture_bytes)
        _atomic_write_manifest(temp_dir / MANIFEST_FILENAME, manifest)
        temp_dir.replace(target_dir)
    except OSError as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise SkyboxResourceError(f"保存天空盒资源失败：{exc}") from exc
    return _custom_manifest_snapshot(target_dir / MANIFEST_FILENAME)


def rename_custom_skybox(resource_id: object, display_name: object) -> dict[str, Any]:
    normalized = str(resource_id or "").strip().lower()
    name = _normalize_display_name(display_name)
    path = _manifest_path(normalized)
    if not path.is_file():
        raise SkyboxResourceError("未找到自定义天空盒。")
    for item in list_skybox_resources():
        if item["id"] != normalized and item["source"] == "custom" and item["display_name"].casefold() == name.casefold():
            raise SkyboxResourceConflict(f"已存在名为“{name}”的天空盒。")
    manifest = _read_manifest(path)
    manifest["display_name"] = name
    try:
        _atomic_write_manifest(path, manifest)
    except OSError as exc:
        raise SkyboxResourceError(f"更新天空盒名称失败：{exc}") from exc
    return _custom_manifest_snapshot(path)


def delete_custom_skybox(resource_id: object) -> bool:
    normalized = str(resource_id or "").strip().lower()
    manifest_path = _manifest_path(normalized)
    target = manifest_path.parent.resolve()
    root = get_custom_skybox_root().resolve()
    if target.parent != root:
        raise SkyboxResourceError("拒绝删除天空盒资源目录之外的路径。")
    if not target.is_dir():
        raise SkyboxResourceError("未找到自定义天空盒。")
    try:
        shutil.rmtree(target)
    except OSError as exc:
        raise SkyboxResourceError(f"删除天空盒失败：{exc}") from exc
    return True


def load_custom_skybox(resource_id: object) -> ResolvedSkyboxResource:
    normalized = str(resource_id or "").strip().lower()
    manifest_path = _manifest_path(normalized)
    manifest = _read_manifest(manifest_path)
    if str(manifest.get("id") or "").strip().lower() != normalized:
        raise SkyboxResourceError("自定义天空盒清单 ID 不匹配。")
    material_path = manifest_path.parent / MATERIAL_FILENAME
    texture_path = manifest_path.parent / TEXTURE_FILENAME
    try:
        material_bytes = material_path.read_bytes()
        texture_bytes = texture_path.read_bytes()
    except OSError as exc:
        raise SkyboxResourceError("自定义天空盒文件缺失或无法读取。") from exc
    hashes = manifest.get("sha256") if isinstance(manifest.get("sha256"), dict) else {}
    if hashes.get("material") != _sha256(material_bytes) or hashes.get("texture") != _sha256(texture_bytes):
        raise SkyboxResourceError("自定义天空盒文件完整性校验失败，请重新导入。")
    return ResolvedSkyboxResource(
        material_path=str(manifest.get("material_internal_path") or ""),
        texture_path=str(manifest.get("texture_internal_path") or ""),
        material_bytes=material_bytes,
        texture_bytes=texture_bytes,
    )
