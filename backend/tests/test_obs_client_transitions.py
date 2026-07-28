from types import SimpleNamespace
from unittest.mock import MagicMock

from app.env_utils import OBSConfig
from app.recording.executor.obs_client import OBSClient


def _connected_client(response_data: dict) -> OBSClient:
    client = OBSClient(OBSConfig(host="localhost", port=4455, password=""))
    client._ws = MagicMock()
    client._ws.call.return_value = SimpleNamespace(datain=response_data)
    return client


def test_resolve_scene_transition_name_matches_exact_name():
    client = _connected_client(
        {
            "transitions": [
                {
                    "transitionName": "Fade",
                    "transitionKind": "fade_transition",
                }
            ]
        }
    )

    assert client.resolve_scene_transition_name("fade") == "Fade"


def test_resolve_scene_transition_name_uses_kind_for_localized_obs():
    client = _connected_client(
        {
            "transitions": [
                {
                    "transitionName": "淡入淡出",
                    "transitionKind": "fade_transition",
                },
                {
                    "transitionName": "剪切",
                    "transitionKind": "cut_transition",
                },
            ]
        }
    )

    assert client.resolve_scene_transition_name("Fade") == "淡入淡出"
    assert client.resolve_scene_transition_name("Cut") == "剪切"


def test_resolve_scene_transition_name_rejects_unknown_transition():
    client = _connected_client(
        {
            "transitions": [
                {
                    "transitionName": "淡入淡出",
                    "transitionKind": "fade_transition",
                }
            ]
        }
    )

    assert client.resolve_scene_transition_name("Stinger") is None


def test_set_current_scene_transition_uses_separate_duration_request():
    client = _connected_client({})

    client.set_current_scene_transition("淡入淡出", 180)

    requests = [item.args[0] for item in client._ws.call.call_args_list]
    assert [type(item).__name__ for item in requests] == [
        "SetCurrentSceneTransition",
        "SetCurrentSceneTransitionDuration",
    ]
    assert requests[0].data() == {"transitionName": "淡入淡出"}
    assert requests[1].data() == {"transitionDuration": 180}
