"""Windows-friendly uvicorn launcher for the portable package."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import uvicorn


def _backend_dir() -> str:
    return str(Path(__file__).resolve().parents[1])


def _install_windows_selector_loop() -> None:
    """
    Windows 下强制使用 SelectorEventLoop，规避 Proactor 的 IOCP accept 在
    遇到 ``WinError 64 (ERROR_NETNAME_DELETED)`` 时把 listening socket
    直接关掉退出 accept loop 的内核级问题（症状：进程仍活、老 ESTABLISHED
    连接仍可继续、但 8000 不再 listen，新请求 connection refused）。
    背景：录制流程会 ``subprocess.Popen`` 启动 CS2/Steam，子进程链路上
    handle 释放时 Windows TCP 栈会对 IOCP 队列里挂起的 accept 抛 WinError 64。

    必须在 ``uvicorn.run()`` 之前调用，且 **不能只靠 set_event_loop_policy**：
    uvicorn ≥ 0.30 起改用 ``loop_factory`` 直接拿 loop 类，完全绕开 policy。
    这里同时打两个补丁：
    1) 设置 ``WindowsSelectorEventLoopPolicy``（兜底覆盖任何走 policy 的代码路径）
    2) Monkey-patch ``uvicorn.loops.asyncio.asyncio_loop_factory``，让它返回
       ``SelectorEventLoop`` 而不是硬编码的 ``ProactorEventLoop``
    """
    if sys.platform != "win32":
        return
    policy_cls = getattr(asyncio, "WindowsSelectorEventLoopPolicy", None)
    if policy_cls is not None:
        asyncio.set_event_loop_policy(policy_cls())

    # uvicorn 0.30+ 用 loop_factory 直接选 loop 类，必须 patch 才能在 Windows
    # 上真正走 Selector。旧版 uvicorn 没这个属性，patch 失败也不影响主流程。
    try:
        from uvicorn.loops import asyncio as _uv_asyncio_loops

        def _selector_loop_factory(use_subprocess: bool = False):
            # SelectorEventLoop 在 Windows 上不支持 asyncio.create_subprocess_*；
            # 本工程子进程一律走同步 subprocess.Popen + asyncio.to_thread，无冲突。
            return asyncio.SelectorEventLoop

        if hasattr(_uv_asyncio_loops, "asyncio_loop_factory"):
            _uv_asyncio_loops.asyncio_loop_factory = _selector_loop_factory
        # 兼容旧版（< 0.30）：旧版有 asyncio_setup(use_subprocess) 函数，
        # use_subprocess=False 时它本身就 no-op，policy 路径足以；不需要额外 patch。
    except Exception:
        pass


def main() -> None:
    _install_windows_selector_loop()
    backend = _backend_dir()
    if backend not in sys.path:
        sys.path.insert(0, backend)
    host = os.environ.get("CS2_INSIGHT_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("CS2_INSIGHT_PORT", "8000"))
    except ValueError:
        port = 8000
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        loop="asyncio",
        log_level="info",
        access_log=True,
        app_dir=backend,
    )


if __name__ == "__main__":
    main()
