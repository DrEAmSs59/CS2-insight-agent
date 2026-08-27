"""Export bundled Source 2 cubemaps as browser-friendly skybox previews.

The compiled texture export is performed by ValveResourceFormat / Source 2
Viewer (https://github.com/ValveResourceFormat/ValveResourceFormat). The
resulting HDR panorama is tone-mapped and resized here before it is committed
to ``frontend/public/skyboxes``.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.skybox_vpk import SKYBOX_ASSETS  # noqa: E402


def _load_image_dependencies(openexr_path: Path | None):
    if openexr_path is not None:
        sys.path.insert(0, str(openexr_path))
    try:
        import numpy as np
        import OpenEXR
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - developer tool guidance
        raise RuntimeError(
            "preview generation requires OpenEXR, numpy, and Pillow; "
            "install them into the selected Python environment first"
        ) from exc
    return np, OpenEXR, Image


def _tone_map(pixels, np):
    rgb = np.nan_to_num(pixels[..., :3], nan=0.0, posinf=16.0, neginf=0.0)
    rgb = np.maximum(rgb, 0.0)
    # ACES fitted curve followed by the standard sRGB transfer function. It
    # keeps bright suns/clouds readable without crushing darker sky detail.
    mapped = np.clip(
        (rgb * (2.51 * rgb + 0.03)) / (rgb * (2.43 * rgb + 0.59) + 0.14),
        0.0,
        1.0,
    )
    mapped = np.where(
        mapped <= 0.0031308,
        mapped * 12.92,
        1.055 * np.power(mapped, 1.0 / 2.4) - 0.055,
    )
    return np.round(mapped * 255.0).astype(np.uint8)


def build(
    source_dir: Path,
    cli_path: Path,
    output_dir: Path,
    *,
    width: int,
    openexr_path: Path | None,
) -> None:
    np, OpenEXR, Image = _load_image_dependencies(openexr_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    height = width // 2

    with tempfile.TemporaryDirectory(prefix="cs2-insight-skybox-") as temp_name:
        temp_dir = Path(temp_name)
        for skybox_id, (_, texture_path) in SKYBOX_ASSETS.items():
            texture_source = source_dir / Path(texture_path).name
            if not texture_source.is_file():
                raise FileNotFoundError(f"missing compiled texture: {texture_source}")

            requested_output = temp_dir / f"{skybox_id}.exr"
            subprocess.run(
                [str(cli_path), "-i", str(texture_source), "-o", str(requested_output)],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            # VRF preserves the source stem when choosing the exported name.
            exported = temp_dir / f"{texture_source.name.removesuffix('.vtex_c')}.exr"
            if not exported.is_file():
                raise FileNotFoundError(f"VRF did not create the expected export: {exported}")

            channels = OpenEXR.File(str(exported)).channels()
            channel = channels.get("RGBA") or channels.get("RGB")
            if channel is None:
                raise ValueError(f"exported texture has no RGB channels: {exported}")
            preview = Image.fromarray(_tone_map(channel.pixels, np))
            preview.thumbnail((width, height), Image.Resampling.LANCZOS)
            if preview.size != (width, height):
                preview = preview.resize((width, height), Image.Resampling.LANCZOS)
            target = output_dir / f"{skybox_id}.webp"
            preview.save(target, "WEBP", quality=84, method=6)
            print(f"built {target.name} ({target.stat().st_size} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROJECT_ROOT / "frontend" / "public" / "skyboxes",
    )
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument(
        "--openexr-path",
        type=Path,
        help="optional directory containing a locally installed OpenEXR package",
    )
    args = parser.parse_args()
    if args.width < 320 or args.width % 2:
        parser.error("--width must be an even number of at least 320")
    build(
        args.source_dir.resolve(),
        args.cli.resolve(),
        args.output_dir.resolve(),
        width=args.width,
        openexr_path=args.openexr_path.resolve() if args.openexr_path else None,
    )


if __name__ == "__main__":
    main()
