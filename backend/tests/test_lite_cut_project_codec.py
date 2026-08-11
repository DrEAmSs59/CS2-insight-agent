import json

import pytest
from pydantic import ValidationError

from app.features.lite_cut.project_codec import (
    create_empty_project,
    diagnose_project_references,
    load_project_contract,
    project_contract_path,
    read_project_body,
    serialize_project_body,
    validate_project_body,
)
from app.features.lite_cut.preset_apply import parse_project_body


def test_project_codec_owns_create_read_validate_and_serialize_without_changing_schema_v2():
    empty = create_empty_project()
    assert empty.schema_version == 2
    assert [track.id for track in empty.tracks] == ["v1", "a1"]

    raw = {
        "schema_version": 2,
        "output": {"encoder": "h264_amf", "framemeld_enabled": True},
        "tracks": [
            {"id": "v1", "type": "video", "label": "V1", "clips": []},
            {"id": "a1", "type": "audio", "label": "A1", "clips": []},
        ],
    }
    parsed = read_project_body(raw)
    serialized = serialize_project_body(parsed)
    assert serialized["schema_version"] == 2
    assert serialized["output"]["encoder"] == "h264_amf"
    assert serialized["output"]["framemeld_enabled"] is True
    assert parse_project_body(raw) == parsed

    with pytest.raises(ValidationError):
        validate_project_body({"schema_version": 3})


def test_shared_contract_records_current_range_owners_instead_of_forcing_false_equivalence():
    contract = load_project_contract()
    assert contract["project_schema_version"] == 2
    assert contract["range_owners"]["frontend_editor_repair"]["width"]["integer_min"] == 1
    assert contract["range_owners"]["backend_schema_validation"]["width"]["min"] == 16
    assert contract["range_owners"]["backend_export_projection"]["width"]["min"] == 320


def test_reference_diagnostics_are_non_blocking_and_shared_with_the_frontend_fixture():
    contract = json.loads(project_contract_path().read_text(encoding="utf-8"))
    case = contract["diagnostic_cases"][0]
    diagnostics = diagnose_project_references(case["body"], available_asset_ids=case["available_asset_ids"])
    assert sorted(item.code for item in diagnostics) == case["expected_codes"]

    # Diagnostics must not become a new schema rejection path in this phase.
    assert case["body"]["schema_version"] == 2
