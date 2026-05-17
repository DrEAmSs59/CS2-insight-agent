#!/usr/bin/env python3
"""与 debug_demoparser2.py 相同；便于按固定文件名运行调试脚本。"""

from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().with_name("debug_demoparser2.py")), run_name="__main__")
