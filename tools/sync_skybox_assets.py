"""Validate and copy compiled Source 2 skybox pairs into the bundled catalog."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.skybox_resources import validate_skybox_files  # noqa: E402
from app.skybox_vpk import SKYBOX_ASSETS  # noqa: E402


def sync(source_dir: Path, output_dir: Path) -> None:
    copied = 0
    total_bytes = 0
    for skybox_id, (material_path, texture_path) in SKYBOX_ASSETS.items():
        material_source = source_dir / Path(material_path).name
        texture_source = source_dir / Path(texture_path).name
        if not material_source.is_file() or not texture_source.is_file():
            raise FileNotFoundError(
                f"missing compiled pair for {skybox_id}: "
                f"{material_source.name} + {texture_source.name}"
            )

        material_bytes = material_source.read_bytes()
        texture_bytes = texture_source.read_bytes()
        referenced_texture = validate_skybox_files(
            material_filename=material_source.name,
            material_bytes=material_bytes,
            texture_filename=texture_source.name,
            texture_bytes=texture_bytes,
        )
        if referenced_texture != texture_path:
            raise ValueError(
                f"{skybox_id} compiles to {referenced_texture}, expected {texture_path}"
            )

        target_dir = output_dir / skybox_id
        target_dir.mkdir(parents=True, exist_ok=True)
        for source in (material_source, texture_source):
            target = target_dir / source.name
            shutil.copy2(source, target)
            copied += 1
            total_bytes += target.stat().st_size

    print(
        f"synced {len(SKYBOX_ASSETS)} skyboxes, {copied} files, "
        f"{total_bytes} bytes into {output_dir}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROJECT_ROOT / "pov" / "skyboxes",
    )
    args = parser.parse_args()
    sync(args.source_dir.resolve(), args.output_dir.resolve())


if __name__ == "__main__":
    main()
