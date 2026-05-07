import { useEffect, useState } from "react";

export default function DemoWatchPathsModal({
  open,
  onClose,
  demoWatchPaths = [],
  onDemoWatchPathsChange,
  onSaveConfig,
}) {
  const [watchPathInput, setWatchPathInput] = useState("");

  useEffect(() => {
    if (open) setWatchPathInput("");
  }, [open]);

  if (!open) return null;

  const addPath = () => {
    const p = watchPathInput.trim();
    if (!p) return;
    const next = Array.from(new Set([...(demoWatchPaths || []), p]));
    onDemoWatchPathsChange?.(next);
    onSaveConfig?.({ demo_watch_paths: next });
    setWatchPathInput("");
  };

  const removePath = (p) => {
    const next = (demoWatchPaths || []).filter((x) => x !== p);
    onDemoWatchPathsChange?.(next);
    onSaveConfig?.({ demo_watch_paths: next });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-watch-paths-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-white/15 bg-cs2-bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 id="demo-watch-paths-title" className="mb-1 text-xs font-semibold text-zinc-300">
          Demo 监听路径
        </h4>
        <p className="mb-3 text-[10px] leading-relaxed text-cs2-text-secondary">
          添加 CS2 存放比赛录像的目录（通常包含 <span className="font-mono text-zinc-500">csgo</span> 或
          <span className="font-mono text-zinc-500"> game/csgo </span>
          等）。保存后后端会监听新文件；入库请点击「扫描本地 demo 库」。
        </p>
        <div className="mb-3 flex gap-2">
          <input
            type="text"
            value={watchPathInput}
            onChange={(e) => setWatchPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addPath();
              }
            }}
            placeholder="D:\\SteamLibrary\\...\\csgo"
            className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none"
          />
          <button
            type="button"
            className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 text-xs font-semibold hover:border-cs2-orange/50"
            onClick={addPath}
          >
            添加
          </button>
        </div>
        <div className="mb-4 max-h-48 space-y-1 overflow-y-auto">
          {(demoWatchPaths || []).length === 0 ? (
            <p className="py-2 text-center text-[10px] text-zinc-500">尚未添加监听目录</p>
          ) : (
            (demoWatchPaths || []).map((p) => (
              <div
                key={p}
                className="flex items-center justify-between gap-2 rounded border border-white/10 bg-cs2-bg-input/60 px-2 py-1"
              >
                <span className="min-w-0 truncate font-mono text-[10px] text-zinc-300">{p}</span>
                <button
                  type="button"
                  className="shrink-0 text-[10px] text-cs2-fail hover:opacity-80"
                  onClick={() => removePath(p)}
                >
                  删除
                </button>
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded border border-cs2-border px-3 py-1.5 text-[11px] text-zinc-300 hover:border-cs2-orange/35 hover:text-white"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
