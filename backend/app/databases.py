"""Shared database handles for the backend process."""

from .demo_db import DemoDB
from .env_utils import resolve_config_path
from .lite_cut.db import LiteCutDB
from .montage_db import MontageDB

DB_PATH = resolve_config_path().parent / "cs2-insight.db"
demo_db = DemoDB(DB_PATH)
montage_db = MontageDB(DB_PATH)
lite_cut_db = LiteCutDB(DB_PATH)
