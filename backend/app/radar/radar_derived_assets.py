"""Radar-derived utility masks and content_rect estimates from luminance."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from .radar_map_assets import bundled_radar_maps_dir


def _luminance(r: int, g: int, b: int) -> float:
    return (r + g + b) / 3.0


def _content_pixels(img: Image.Image, *, luminance_threshold: int) -> list[tuple[int, int]]:
    rgba = img.convert("RGBA")
    w, h = rgba.size
    pixels = rgba.load()
    hits: list[tuple[int, int]] = []
    for y in range(h):
        for x in range(w):
            r, g, b, _a = pixels[x, y]
            if _luminance(r, g, b) > luminance_threshold:
                hits.append((x, y))
    return hits


def estimate_content_rect(
    radar_png: Path,
    *,
    luminance_threshold: int = 18,
    pad: int = 8,
) -> dict:
    """Bounding box of bright radar content, optionally padded."""
    img = Image.open(radar_png)
    w, h = img.size
    hits = _content_pixels(img, luminance_threshold=luminance_threshold)
    if not hits:
        return {
            "content_x": 0,
            "content_y": 0,
            "content_width": w,
            "content_height": h,
        }
    xs = [p[0] for p in hits]
    ys = [p[1] for p in hits]
    x0 = max(0, min(xs) - pad)
    y0 = max(0, min(ys) - pad)
    x1 = min(w - 1, max(xs) + pad)
    y1 = min(h - 1, max(ys) + pad)
    return {
        "content_x": int(x0),
        "content_y": int(y0),
        "content_width": int(x1 - x0 + 1),
        "content_height": int(y1 - y0 + 1),
    }


def generate_utility_mask(
    radar_png: Path,
    out_png: Path,
    *,
    luminance_threshold: int = 18,
) -> None:
    """Write an L-mode mask: white where bright, black elsewhere; 1px border forced black."""
    img = Image.open(radar_png).convert("RGBA")
    w, h = img.size
    src = img.load()
    mask = Image.new("L", (w, h), 0)
    dst = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b, _a = src[x, y]
            if _luminance(r, g, b) > luminance_threshold:
                dst[x, y] = 255
    # Force outermost 1px ring black.
    for x in range(w):
        dst[x, 0] = 0
        dst[x, h - 1] = 0
    for y in range(h):
        dst[0, y] = 0
        dst[w - 1, y] = 0
    out_png.parent.mkdir(parents=True, exist_ok=True)
    mask.save(out_png)


def resolve_utility_mask_path(map_key: str, *, layer: str = "upper") -> Path | None:
    """Resolve a vendored ``*_utility_mask.png`` if present."""
    root = bundled_radar_maps_dir()
    mk = map_key.strip()
    normalized_layer = str(layer or "upper").strip().lower()
    if normalized_layer not in {"upper", "lower"}:
        raise ValueError(f"Unsupported radar layer: {layer!r}")
    suffix = "_lower" if normalized_layer == "lower" else ""
    candidates = [
        root / f"{mk}{suffix}_utility_mask.png",
        root / f"{mk.lower()}{suffix}_utility_mask.png",
    ]
    seen: set[Path] = set()
    for c in candidates:
        if c in seen:
            continue
        seen.add(c)
        if c.is_file():
            return c
    return None
