import json

import pytest
from app.features.lite_cut.project_codec import (
    LiteCutProjectCompatibilityError,
    create_empty_project,
    diagnose_project_references,
    load_project_contract,
    project_contract_path,
    read_project_body,
    serialize_project_body,
    validate_project_body,
)
from app.features.lite_cut.preset_apply import parse_project_body


def test_project_codec_owns_create_read_validate_and_serialize_for_schema_v3():
    empty = create_empty_project()
    assert empty.schema_version == 3
    assert [track.id for track in empty.tracks] == ["v1", "a1"]

    raw = {
        "schema_version": 3,
        "output": {"encoder": "h264_amf", "framemeld_enabled": True},
        "tracks": [
            {"id": "v1", "type": "video", "label": "V1", "clips": []},
            {"id": "a1", "type": "audio", "label": "A1", "clips": []},
        ],
    }
    parsed = read_project_body(raw)
    serialized = serialize_project_body(parsed)
    assert serialized["schema_version"] == 3
    assert serialized["output"]["encoder"] == "h264_amf"
    assert serialized["output"]["framemeld_enabled"] is True
    assert parse_project_body(raw) == parsed

    with pytest.raises(LiteCutProjectCompatibilityError, match="schema 3 is required") as exc_info:
        validate_project_body({"schema_version": 2})
    assert exc_info.value.code == "LITECUT_PROJECT_VERSION_UNSUPPORTED"

    with pytest.raises(LiteCutProjectCompatibilityError) as exc_info:
        validate_project_body({"schema_version": 3, "output": {"delivery_fps": 60}})
    assert exc_info.value.code == "LITECUT_LEGACY_PROJECT_FIELDS_UNSUPPORTED"


def test_shared_contract_records_the_unified_output_boundaries():
    contract = load_project_contract()
    assert contract["project_schema_version"] == 3
    assert contract["compatibility"]["legacy_project_migration"] is False
    assert contract["output"]["limits"]["width"] == {"integer_min": 320, "integer_max": 7680}
    assert contract["range_owners"]["frontend_editor_repair"]["width"]["integer_min"] == 320
    assert contract["range_owners"]["backend_schema_validation"]["width"]["min"] == 320
    assert contract["range_owners"]["backend_export_projection"]["width"]["min"] == 320


def test_project_codec_canonicalizes_video_rows_before_audio_rows():
    parsed = read_project_body({
        "schema_version": 3,
        "tracks": [
            {"id": "v1", "type": "video", "label": "old-v1", "clips": []},
            {"id": "a1", "type": "audio", "label": "old-a1", "clips": []},
            {"id": "v2", "type": "video", "label": "old-v2", "clips": []},
            {"id": "a2", "type": "audio", "label": "old-a2", "clips": []},
        ],
    })

    assert [track.id for track in parsed.tracks] == ["v1", "v2", "a1", "a2"]
    assert [track.label for track in parsed.tracks] == ["V1", "V2", "A1", "A2"]


def test_reference_diagnostics_are_non_blocking_and_shared_with_the_frontend_fixture():
    contract = json.loads(project_contract_path().read_text(encoding="utf-8"))
    case = contract["diagnostic_cases"][0]
    diagnostics = diagnose_project_references(case["body"], available_asset_ids=case["available_asset_ids"])
    assert sorted(item.code for item in diagnostics) == case["expected_codes"]

    # Diagnostics must not become a new schema rejection path in this phase.
    assert case["body"]["schema_version"] == 3
