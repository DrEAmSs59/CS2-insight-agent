"""Windows-only: focus CS2 and inject lines into the developer console.

CS2 客户端播 demo 时 RCON 不可靠，故用前台窗口 + 模拟键盘输入执行命令；序列末尾会再执行 ``hideconsole``（可用环境变量改为 ``toggleconsole``）以关闭控制台。
另提供 ``send_cs2_space_taps``：不下拉控制台，仅向前台 CS2 发空格（Demo UI「下一玩家视角」等）。
非 Windows 平台提供空实现以便统一 import。

注入通道说明：
- ``~``（控制台开关）与 Space（demo UI）使用 ``SendInput``，需要 CS2 在前台。
- 控制台**文字字符与 Enter**使用 ``PostMessage(WM_CHAR)`` 直接投递到 CS2 消息队列，
  绕过 Windows UIPI 对 ``SendInput`` 的静默拦截（症状：SendInput 返回 0/2，
  文字输入到一半卡住）。所有 ``time.sleep`` 节奏保持原值不变。
"""

from __future__ import annotations

import logging
import sys
import time

logger = logging.getLogger(__name__)

__all__ = [
    "find_cs2_hwnd",
    "ensure_cs2_foreground",
    "inject_console_command",
    "inject_console_sequence",
    "send_cs2_space_taps",
]


if sys.platform != "win32":

    def find_cs2_hwnd() -> int:
        return 0

    def ensure_cs2_foreground(timeout: float = 3.0) -> bool:
        return False

    def inject_console_command(cmd: str, *, skip_console_toggle: bool = False) -> bool:
        return False

    def send_cs2_space_taps(count: int) -> bool:
        return False

    def inject_console_sequence(
        lines: list[str],
        *,
        skip_console_toggle: bool = False,
        close_console: bool = True,
    ) -> bool:
        return False

else:
    import os

    import ctypes
    from ctypes import wintypes

    INPUT_KEYBOARD = 1
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_UNICODE = 0x0004
    VK_RETURN = 0x0D
    VK_MENU = 0x12
    VK_F10 = 0x79
    VK_OEM_3 = 0xC0  # US `~  控制台默认开关
    WM_CHAR    = 0x0102
    WM_KEYDOWN = 0x0100
    WM_KEYUP   = 0x0101
    SCAN_ENTER = 0x1C
    SCAN_F10 = 0x44
    SCAN_OEM_3 = 0x29   # scan code for `~
    SCAN_SPACE = 0x39   # scan code for Space

    ULONG_PTR = ctypes.c_size_t

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = (
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        )

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = (
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        )

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = (("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD))

    class INPUT_UNION(ctypes.Union):
        _fields_ = (("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT))

    class INPUT(ctypes.Structure):
        _fields_ = (("type", wintypes.DWORD), ("u", INPUT_UNION))

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    def _query_process_exe_basename(pid: int) -> str | None:
        """Lowercase basename of the process image, or None if the query fails."""
        h = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return None
        try:
            buf = ctypes.create_unicode_buffer(2048)
            size = wintypes.DWORD(len(buf))
            if not kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return None
            path = buf.value or ""
            if not path:
                return None
            return os.path.basename(path).lower()
        finally:
            kernel32.CloseHandle(h)

    def _window_process_exe_basename(hwnd: int) -> str | None:
        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return None
        return _query_process_exe_basename(int(pid.value))

    _CONSOLE_TOGGLE_KEYS: dict[str, tuple[int, int]] = {
        "`": (VK_OEM_3, SCAN_OEM_3),
        "~": (VK_OEM_3, SCAN_OEM_3),
        "OEM_3": (VK_OEM_3, SCAN_OEM_3),
        "F10": (VK_F10, SCAN_F10),
    }

    for _i in range(1, 13):
        _vk = 0x6F + _i  # F1 = 0x70
        _scan = int(user32.MapVirtualKeyW(_vk, 0)) or 0
        _CONSOLE_TOGGLE_KEYS[f"F{_i}"] = (_vk, _scan)

    def _console_toggle_vk_scan() -> tuple[int, int]:
        raw = (os.environ.get("CS2_INSIGHT_CONSOLE_TOGGLE_KEY") or "F10").strip().upper()
        return _CONSOLE_TOGGLE_KEYS.get(raw, _CONSOLE_TOGGLE_KEYS["F10"])

    def _send_input(*inputs: INPUT) -> bool:
        """发送 SendInput 事件；返回是否全部成功投递。"""
        arr = (INPUT * len(inputs))(*inputs)
        sent = user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(INPUT))
        if sent != len(inputs):
            logger.warning("SendInput incomplete: %s / %s", sent, len(inputs))
            return False
        return True

    def _post_key_tap(hwnd: int, vk: int, scan: int) -> None:
        """PostMessage 通道按下并释放一个虚拟键（绕过 UIPI 对 SendInput 的拦截）。"""
        lp_down = (scan << 16) | 1
        lp_up   = (1 << 31) | (1 << 30) | (scan << 16) | 1
        user32.PostMessageW(hwnd, WM_KEYDOWN, vk, lp_down)
        user32.PostMessageW(hwnd, WM_KEYUP,   vk, lp_up)

    def _vk_tap_with_fallback(hwnd: int, vk: int, scan: int) -> None:
        """按下并释放一个虚拟键：先走 SendInput（前台游戏常规通道），
        若被 UIPI 拦截（sent<2）则降级到 PostMessage，保证只触发一次。
        """
        ok = False
        if user32.GetForegroundWindow() == hwnd:
            ok = _send_input(_key_vk(vk, False), _key_vk(vk, True))
        if not ok:
            _post_key_tap(hwnd, vk, scan)

    def _key_unicode(code: int, keyup: bool = False) -> INPUT:
        flags = KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if keyup else 0)
        ki = KEYBDINPUT(0, code & 0xFFFF, flags, 0, 0)
        return INPUT(type=INPUT_KEYBOARD, u=INPUT_UNION(ki=ki))

    def _key_vk(vk: int, keyup: bool = False) -> INPUT:
        flags = KEYEVENTF_KEYUP if keyup else 0
        ki = KEYBDINPUT(vk, 0, flags, 0, 0)
        return INPUT(type=INPUT_KEYBOARD, u=INPUT_UNION(ki=ki))

    def _post_char(hwnd: int, code: int) -> None:
        """PostMessage(WM_CHAR) 投递单字符到 CS2 消息队列（绕过 UIPI 对 SendInput 的拦截）。"""
        user32.PostMessageW(hwnd, WM_CHAR, code, 1)

    def _post_enter(hwnd: int) -> None:
        """提交控制台当前行。

        Dear ImGui 的 ``InputText`` 通过按键事件（``ImGuiKey_Enter``）识别提交，
        单靠 ``WM_CHAR('\\r')`` 不会触发，因此必须发 WM_KEYDOWN/WM_KEYUP(VK_RETURN)。
        """
        lp_down = (SCAN_ENTER << 16) | 1                       # scan, repeat=1
        lp_up   = (1 << 31) | (1 << 30) | (SCAN_ENTER << 16) | 1  # released, prev was down
        user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, lp_down)
        user32.PostMessageW(hwnd, WM_KEYUP,   VK_RETURN, lp_up)

    def _unlock_foreground() -> None:
        """Send a short Alt tap, the least invasive way to release Windows' foreground lock."""
        _send_input(_key_vk(VK_MENU, False), _key_vk(VK_MENU, True))
        time.sleep(0.03)

    def _topmost_pulse(hwnd: int) -> None:
        """Briefly raise the window without leaving it topmost."""
        HWND_TOPMOST = -1
        HWND_NOTOPMOST = -2
        SWP_NOSIZE = 0x0001
        SWP_NOMOVE = 0x0002
        SWP_NOACTIVATE = 0x0010
        SWP_SHOWWINDOW = 0x0040
        flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags)
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags)

    def find_cs2_hwnd() -> int:
        """Locate a top-level CS2 window by title prefix, but require ``cs2.exe`` as the owner process.

        Title-only matching falsely triggers on browsers / other apps whose window title
        contains ``Counter-Strike`` (e.g. Steam store, wiki, streams).
        """
        found: int = 0

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def _enum(hwnd: int, _lparam: int) -> bool:
            nonlocal found
            if found:
                return False
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd) + 1
            buf = ctypes.create_unicode_buffer(length)
            user32.GetWindowTextW(hwnd, buf, length)
            title = buf.value or ""
            if "Counter-Strike" not in title:
                return True
            low = title.lower()
            if any(x in low for x in ("obs ", "obs studio", "streamlabs")):
                return True
            if _window_process_exe_basename(hwnd) != "cs2.exe":
                return True
            found = hwnd
            return False

        user32.EnumWindows(_enum, 0)
        return found

    def _focus_hwnd(hwnd: int) -> int:
        """强制把 CS2 窗口置为前台，返回最终实际的前台 hwnd。

        Windows 前台锁定的正确绕法：用 ``AttachThreadInput`` 挂接**当前前台
        窗口所属线程**（而不是目标线程）。合并输入队列后，当前线程即视同持有
        前台许可，``SetForegroundWindow(cs2)`` 才能真正生效。同时为稳妥也
        挂接目标（CS2）线程。完成后撤销挂接，再短暂轮询 ``GetForegroundWindow``
        等待前台切换真正到位。
        """
        SW_RESTORE = 9
        SW_SHOW = 5
        user32.ShowWindowAsync(hwnd, SW_SHOW)
        user32.ShowWindow(hwnd, SW_RESTORE)
        _topmost_pulse(hwnd)
        _unlock_foreground()

        get_wtp = user32.GetWindowThreadProcessId
        get_wtp.restype = wintypes.DWORD

        current_tid = ctypes.windll.kernel32.GetCurrentThreadId()
        fg_hwnd = user32.GetForegroundWindow()
        fg_tid = get_wtp(fg_hwnd, None) if fg_hwnd else 0
        target_tid = get_wtp(hwnd, None)

        attached_fg = False
        attached_target = False
        if fg_tid and fg_tid != current_tid:
            attached_fg = bool(user32.AttachThreadInput(current_tid, fg_tid, True))
        if target_tid and target_tid != current_tid and target_tid != fg_tid:
            attached_target = bool(user32.AttachThreadInput(current_tid, target_tid, True))

        try:
            user32.AllowSetForegroundWindow(0xFFFFFFFF)  # ASFW_ANY
            try:
                user32.SwitchToThisWindow(hwnd, True)
            except Exception:
                pass
            user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
            user32.SetFocus(hwnd)
        finally:
            if attached_target:
                user32.AttachThreadInput(current_tid, target_tid, False)
            if attached_fg:
                user32.AttachThreadInput(current_tid, fg_tid, False)

        deadline = time.monotonic() + 0.6
        last_fg = 0
        while time.monotonic() < deadline:
            last_fg = user32.GetForegroundWindow()
            if last_fg == hwnd:
                return last_fg
            time.sleep(0.02)
        logger.warning(
            "_focus_hwnd: CS2(hwnd=%s) 未成为前台，当前前台=%s（UIPI/FLP 限制）",
            hwnd, last_fg,
        )
        return last_fg

    def ensure_cs2_foreground(timeout: float = 3.0) -> bool:
        """Bring CS2 to the foreground and wait until Windows actually reports it focused."""
        hwnd = find_cs2_hwnd()
        if not hwnd:
            logger.error("未找到 Counter-Strike 窗口，无法切到前台")
            return False
        deadline = time.monotonic() + max(0.1, float(timeout))
        last_fg = 0
        while time.monotonic() < deadline:
            hwnd = find_cs2_hwnd() or hwnd
            last_fg = _focus_hwnd(hwnd)
            if last_fg == hwnd or user32.GetForegroundWindow() == hwnd:
                return True
            time.sleep(0.15)
        logger.warning("CS2 前台确认超时: hwnd=%s current_fg=%s timeout=%.2fs", hwnd, last_fg, timeout)
        return False

    VK_SPACE = 0x20

    def send_cs2_space_taps(count: int) -> bool:
        """
        向前台 CS2 窗口发送空格键（不下拉控制台），用于 Demo 右下角「下一个玩家视角」等 UI。
        ``count`` 为连按次数，每次之间短暂 sleep。
        """
        n = max(0, int(count))
        if n <= 0:
            return True
        hwnd = find_cs2_hwnd()
        if not hwnd:
            logger.error("未找到 Counter-Strike 窗口，无法发送空格 (demo UI)")
            return False
        try:
            focus_timeout = max(0.2, float((os.environ.get("CS2_INSIGHT_FOREGROUND_TIMEOUT_SEC") or "4.0").strip()))
        except ValueError:
            focus_timeout = 4.0
        if not ensure_cs2_foreground(focus_timeout):
            return False
        time.sleep(0.15)
        try:
            between = max(0.02, float((os.environ.get("CS2_INSIGHT_SPEC_PRIME_SPACE_GAP") or "0.09").strip()))
        except ValueError:
            between = 0.09
        for _ in range(n):
            _vk_tap_with_fallback(hwnd, VK_SPACE, SCAN_SPACE)
            time.sleep(between)
        return True

    def inject_console_sequence(
        lines: list[str],
        *,
        skip_console_toggle: bool = False,
        close_console: bool = True,
    ) -> bool:
        cmds = [ln.strip() for ln in lines if ln and str(ln).strip()]
        if not cmds:
            return True
        hwnd = find_cs2_hwnd()
        if not hwnd:
            logger.error("未找到 Counter-Strike 窗口，无法注入控制台命令")
            return False
        try:
            focus_timeout = max(0.2, float((os.environ.get("CS2_INSIGHT_FOREGROUND_TIMEOUT_SEC") or "4.0").strip()))
        except ValueError:
            focus_timeout = 4.0
        if not ensure_cs2_foreground(focus_timeout):
            return False
        time.sleep(0.12)
        if not skip_console_toggle:
            if user32.GetForegroundWindow() != hwnd:
                ensure_cs2_foreground(0.8)
            vk_toggle, scan_toggle = _console_toggle_vk_scan()
            _vk_tap_with_fallback(hwnd, vk_toggle, scan_toggle)
            time.sleep(0.18)
        for cmd in cmds:
            for ch in cmd:
                _post_char(hwnd, ord(ch))
                time.sleep(0.002)
            time.sleep(0.02)
            _post_enter(hwnd)
            time.sleep(0.1)
        # 用控制台命令关闭，避免键盘布局下 VK_OEM_3 与游戏绑定不一致导致关不掉
        if close_console and not os.environ.get("CS2_INSIGHT_SKIP_CONSOLE_CLOSE", "").strip().lower() in (
            "1",
            "true",
            "yes",
        ):
            time.sleep(0.06)
            close_cmd = (os.environ.get("CS2_INSIGHT_CONSOLE_CLOSE_CMD") or "hideconsole").strip() or "hideconsole"
            for ch in close_cmd:
                _post_char(hwnd, ord(ch))
                time.sleep(0.002)
            time.sleep(0.02)
            _post_enter(hwnd)
            time.sleep(0.08)
        return True

    def inject_console_command(cmd: str, *, skip_console_toggle: bool = False) -> bool:
        return inject_console_sequence([cmd], skip_console_toggle=skip_console_toggle)
