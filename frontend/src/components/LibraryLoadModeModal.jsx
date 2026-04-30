import { useState, useEffect } from "react";
import { X } from "lucide-react";

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   onConfirm: (payload: { mode: "none" | "expected" | "manual"; manualLines: string[] }) => void;
 *   expectedPreviewLines: string[];
 * }} props
 */
export default function LibraryLoadModeModal({ open, onClose, onConfirm, expectedPreviewLines = [] }) {
  const [mode, setMode] = useState("none");
  const [manualText, setManualText] = useState("");

  useEffect(() => {
    if (open) {
      setMode("none");
      setManualText("");
    }
  }, [open]);

  if (!open) return null;

  const manualLines = manualText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const submit = () => {
    onConfirm({
      mode,
      manualLines: mode === "manual" ? manualLines : [],
    });
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-3 py-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lib-load-mode-title"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-white/10 bg-cs2-bg-card p-4 shadow-2xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <h3 id="lib-load-mode-title" className="text-sm font-bold text-zinc-200">
            载入已选 Demo
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-white"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
          「仅载入」加载完即可进入玩家列表。选择关注名单或手动昵称时，将全屏加载直至<strong className="text-zinc-400">全部场次解析完成</strong>
          后再进入界面（多场并行解析时也会显示进度）。
        </p>

        <div className="mb-3 space-y-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-black/20 p-2.5">
            <input
              type="radio"
              name="libloadmode"
              className="mt-0.5"
              checked={mode === "none"}
              onChange={() => setMode("none")}
            />
            <span>
              <span className="block text-xs font-semibold text-zinc-200">仅载入</span>
              <span className="text-[10px] text-zinc-500">不选玩家、不解析，与「载入选中」相同效果。</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-black/20 p-2.5">
            <input
              type="radio"
              name="libloadmode"
              className="mt-0.5"
              checked={mode === "expected"}
              onChange={() => setMode("expected")}
            />
            <span>
              <span className="block text-xs font-semibold text-zinc-200">按侧栏「关注玩家」名单解析</span>
              <span className="text-[10px] text-zinc-500">
                每场 Demo 只在 roster 里匹配名单中的昵称；未配置名单时本项无效。
              </span>
              {expectedPreviewLines.length > 0 ? (
                <span className="mt-1 block font-mono text-[10px] text-cs2-orange/90">
                  {expectedPreviewLines.slice(0, 8).join(" · ")}
                  {expectedPreviewLines.length > 8 ? " …" : ""}
                </span>
              ) : (
                <span className="mt-1 block text-[10px] text-amber-500/90">当前侧栏名单为空。</span>
              )}
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-black/20 p-2.5">
            <input
              type="radio"
              name="libloadmode"
              className="mt-0.5"
              checked={mode === "manual"}
              onChange={() => setMode("manual")}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-zinc-200">手动输入昵称（每行一个）</span>
              <span className="text-[10px] text-zinc-500">应用于本场选中的每一份 Demo，按 roster 匹配。</span>
              <textarea
                rows={4}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder={"PlayerOne\nPlayerTwo"}
                className="mt-2 w-full resize-y rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-white placeholder:text-zinc-600"
                spellCheck={false}
              />
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-cs2-border px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:border-cs2-orange/40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md border border-cs2-orange/50 bg-cs2-orange/15 px-3 py-1.5 text-xs font-bold text-cs2-orange hover:bg-cs2-orange/25"
          >
            确认载入
          </button>
        </div>
      </div>
    </div>
  );
}
