"""Build packaging/windows/app-icon.ico from frontend/public/cs2-insight-logo.png."""
from __future__ import annotations

from pathlib import Path

from PIL import Image


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    png = root / "frontend" / "public" / "cs2-insight-logo.png"
    out = Path(__file__).resolve().parent / "app-icon.ico"
    if not png.is_file():
        raise SystemExit(f"missing logo: {png}")
    img = Image.open(png).convert("RGBA")
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(out, format="ICO", sizes=sizes)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
