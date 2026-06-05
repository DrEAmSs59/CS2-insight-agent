"""spec 切人后补注入：过滤纯函数 + 执行器参数存储。"""

from app.obs_director import _filter_post_spec_console_lines


def test_filter_picks_cl_demo_predict():
    lines = ["fps_max 0", "cl_demo_predict 1", "cl_trueview_show_status 2"]
    assert _filter_post_spec_console_lines(lines) == ["cl_demo_predict 1"]


def test_filter_empty_when_no_match():
    assert _filter_post_spec_console_lines(["fps_max 0", "cl_trueview_show_status 2"]) == []


def test_filter_case_and_whitespace_insensitive():
    assert _filter_post_spec_console_lines(["  CL_DEMO_PREDICT 1  "]) == ["CL_DEMO_PREDICT 1"]


def test_filter_skips_blank_lines():
    assert _filter_post_spec_console_lines(["", "   ", "cl_demo_predict 1"]) == ["cl_demo_predict 1"]
