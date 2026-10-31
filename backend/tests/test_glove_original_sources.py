import asyncio
from copy import deepcopy
from pathlib import Path

from app.api import cosmetics_skin
from app.cosmetics_glove_sources import canonical_glove_batch
from test_cosmetics_skin_api import api_env, STEAM_ID


SOURCE = {"type":"glove", "item_id":54353673408, "def_index":5034, "paint_index":10068,
          "paint_seed":162,"paint_wear":0.308407,"observed_teams":["ct","t"],
          "owner_steamid64":STEAM_ID,"ownership_evidence":"demo_skin_table"}


def _glove(identity, definition, paint, team):
    return {"type":"glove","item_id":str(identity),"def_index":definition,"paint_index":paint,
            "paint_seed":0,"paint_wear":0.07,"observed_teams":[team],"name_en":"Applied glove"}


def test_reanalysis_alias_ids_save_reload_and_replay_from_owned_original(api_env,monkeypatch):
    inventory=[_glove(14204656308197212219,5031,1399,"ct"),_glove(14204656304548975581,5030,10073,"t"),
               {**SOURCE,"observed_teams":[]}]
    def save_inventory(rows):
        asyncio.run(api_env["db"].save_result(str(api_env["original"]),{"analysis_workspace":{"cosmetics":{"players":{STEAM_ID:rows}}}}))
    save_inventory(inventory)
    monkeypatch.setattr(cosmetics_skin,"read_original_glove_inventory",lambda path:{STEAM_ID:[SOURCE]})
    calls=[]
    def rewrite(**kwargs):
        calls.append(deepcopy(kwargs))
        Path(kwargs["output_dem"]).write_bytes(b"REWRITTEN")
        return {"ok":True,"player_loadout_applied":True,"succeeded":[
            {"item_id64":row["item_id64"],"definition_index":row["definition_index"],"team":row.get("team")}
            for row in kwargs["items"]],"failed":[]}
    monkeypatch.setattr(cosmetics_skin,"run_rewrite_owned_batch",rewrite)
    route=f'/api/demos/{api_env["demo_id"]}/cosmetics/custom-plan'
    replacements={"ct:id:14204656308197212219":_glove(0,5030,10073,"ct"),
                  "t:id:14204656304548975581":_glove(0,5031,1399,"t")}
    response=api_env["client"].post(route,json={"steamid":STEAM_ID,"replacements":replacements,
        "originals":{key:{**SOURCE,"item_id":"999999","def_index":5034} for key in replacements}})
    assert response.status_code==200,response.text
    assert response.json()["ok"] and len(response.json()["succeeded"])==2
    assert [(row["item_id64"],row["definition_index"],row["team"]) for row in calls[-1]["items"]]==[
        ("54353673408",5034,"CT"),("54353673408",5034,"T")]
    plan=response.json()["plan"]
    assert [row["slot_key"] for row in plan["items"]]==list(replacements)
    assert all(row["original"]["item_id"]==54353673408 for row in plan["items"])
    # Further analysis changes the alias IDs again and the original has no observed side in the cache.
    save_inventory([_glove(14204656300000000001,5030,10073,"ct"),_glove(14204656300000000002,5031,1399,"t")])
    response=api_env["client"].post(route,json={"steamid":STEAM_ID,"player_loadout":{"music_kit_ct":4,"music_kit_t":5}})
    assert response.status_code==200,response.text
    assert response.json()["ok"] and len(response.json()["plan"]["items"])==2
    assert all(row["item_id64"]=="54353673408" for row in calls[-1]["items"])
    assert api_env["original"].read_bytes()==b"ORIGINAL-DEMO"


def test_canonicalization_does_not_mutate_inputs_or_guess_ambiguous_originals():
    import pytest
    from app.cosmetics_skin_plan import CosmeticsSkinPlanError
    batch=[{"item_id64":"14204656308197212219","definition_index":5031,"team":"CT"}]
    plan={"items":[{"slot_key":"ct:id:14204656308197212219","original":_glove(14204656308197212219,5034,10068,"ct")} ]}
    before=deepcopy((batch,plan))
    canonical_glove_batch(batch,plan,[SOURCE])
    assert (batch,plan)==before
    with pytest.raises(CosmeticsSkinPlanError,match="ambiguous"):
        canonical_glove_batch(batch,plan,[SOURCE,{**SOURCE,"item_id":1234}])
