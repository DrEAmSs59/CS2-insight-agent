"""Keep uint64 economy identities exact when results cross the JSON boundary."""

from typing import Any

JS_MAX_SAFE_INTEGER = (1 << 53) - 1


def json_safe_item_id(row: dict[str, Any]) -> dict[str, Any]:
    """JSON object hook, also usable on freshly parsed inventory entries."""
    value = row.get("item_id")
    if isinstance(value, int) and value > JS_MAX_SAFE_INTEGER:
        row["item_id"] = str(value)
    return row
