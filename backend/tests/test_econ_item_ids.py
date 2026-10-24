import asyncio
import json

from app.demo_db import DemoDB
from app.econ_item_ids import json_safe_item_id


def test_item_id_json_hook_preserves_other_numbers():
    decoded = json.loads('{"item_id":14204636884736196609,"other":14204636884736196609}', object_hook=json_safe_item_id)
    assert decoded == {"item_id": "14204636884736196609", "other": 14204636884736196609}
    assert json_safe_item_id({"item_id": 123}) == {"item_id": 123}


def test_cached_results_and_plans_expose_uint64_ids_as_strings(tmp_path):
    async def run():
        db = DemoDB(tmp_path / "demo.db")
        await db.init_db()
        path = str(tmp_path / "test.dem")
        await db.add_demo(path, file_size=1)
        item = {"item_id": 14204636884736196609}
        await db.save_result(path, {"analysis_workspace": {"cosmetics": {"players": {"owner": [item]}}}})
        result = await db.get_result(path)
        assert result["analysis_workspace"]["cosmetics"]["players"]["owner"][0]["item_id"] == str(item["item_id"])
        await db.upsert_custom_skin_plan(path, "owner", {"items": [{"original": item}]})
        plan = await db.get_custom_skin_plan(path, "owner")
        assert plan["plan_json"]["items"][0]["original"]["item_id"] == str(item["item_id"])
        plans = await db.list_custom_skin_plans_for_demo(path)
        assert plans[0]["plan_json"] == plan["plan_json"]
    asyncio.run(run())
