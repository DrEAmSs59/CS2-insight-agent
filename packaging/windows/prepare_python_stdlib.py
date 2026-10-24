"""Keep the isolated, hashed python312.zip layout used by the Pro loader."""

from pathlib import Path
import shutil
import subprocess
import sys
from zipfile import ZIP_STORED, ZipFile, ZipInfo


def prepare(runtime: Path):
    runtime = runtime.resolve(strict=True)
    if runtime != Path(sys.executable).resolve().parent:
        raise ValueError("Run this script with the staged runtime's python.exe")
    lib = runtime / "Lib"
    archive = runtime / "python312.zip"
    # An already isolated portable runtime need not be converted again.
    if not (lib / "encodings").is_dir():
        if not archive.is_file():
            raise ValueError("Python standard library is missing")
        return

    sources = sorted(path for path in lib.iterdir() if path.name != "site-packages")
    files = sorted(
        file for path in sources for file in ([path] if path.is_file() else path.rglob("*"))
        if file.is_file() and "__pycache__" not in file.parts and file.suffix != ".pyc"
    )
    for path in [*sources, *files]:
        # Do not traverse or remove external trees from a custom Python source.
        if path.is_symlink() or path.is_junction() or not path.resolve().is_relative_to(lib):
            raise ValueError(f"Unexpected standard library path: {path}")
    with ZipFile(archive, "w", compression=ZIP_STORED) as bundle:
        for file in files:
            entry = ZipInfo(file.relative_to(lib).as_posix(), date_time=(2026, 10, 23, 0, 0, 0))
            entry.external_attr = 0o644 << 16
            bundle.writestr(entry, file.read_bytes())
    pth = runtime / "python312._pth"
    previous = pth.read_bytes() if pth.exists() else None
    pth.write_text("python312.zip\n.\nDLLs\nLib/site-packages\nimport site\n", encoding="utf-8")
    try:
        subprocess.run([str(runtime / "python.exe"), "-I", "-B", "-c",
                        "import encodings,ssl,sqlite3,lzma,ctypes,multiprocessing,sysconfig,zipfile; "
                        "import cryptography,demoparser2,fastapi,openai,PIL,uvicorn"], check=True)
    except Exception:
        if previous is None:
            pth.unlink()
        else:
            pth.write_bytes(previous)
        raise
    # Only delete checked stdlib paths after the isolated child boots successfully.
    for path in sources:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    print(f"[desktop] Prepared isolated standard library: {len(files)} files")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]))
