import { useCallback, useMemo, useState } from "react";

export function countInjectConsoleLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("#")).length;
}

/** 配置中的启动项：多行=多条录入；单行沿用旧版整段展示为一条 */
function launchChipsFromStored(s) {
  const t = String(s ?? "");
  if (!t.trim()) return [];
  if (/\r|\n/.test(t)) {
    return t
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [t.trim()];
}

function storedFromLaunchChips(chips) {
  return chips.map((x) => String(x).trim()).filter(Boolean).join("\n");
}

function consoleChipsFromStored(s) {
  return String(s ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function storedFromConsoleChips(chips) {
  return chips.map((x) => String(x).trim()).filter(Boolean).join("\n");
}

function TagListAddRow({ draft, onDraftChange, onAdd, placeholder, addLabel, disabled }) {
  return (
    <div className="flex shrink-0 flex-col gap-2 @min-[24rem]/params:flex-row @min-[24rem]/params:flex-wrap @min-[24rem]/params:items-center">
      <input
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAdd();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className="min-w-0 w-full flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[12px] text-white placeholder:text-zinc-600 focus:border-cs2-orange/50 focus:outline-none disabled:opacity-45"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAdd()}
        className="inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[11px] font-semibold text-zinc-200 transition-colors hover:border-cs2-orange/45 hover:text-white disabled:opacity-45 @min-[24rem]/params:w-auto"
      >
        {addLabel}
      </button>
    </div>
  );
}

/**
 * 额外启动参数 + 附加预热控制台（与常用参数页同一套交互）。
 */
export default function Cs2LaunchConsoleFields({
  cs2ExtraLaunchArgs = "",
  onCs2ExtraLaunchArgsChange,
  recordInjectConsoleLines = "",
  onRecordInjectConsoleLinesChange,
}) {
  const [launchArgDraft, setLaunchArgDraft] = useState("");
  const [consoleLineDraft, setConsoleLineDraft] = useState("");

  const injectExtraCount = useMemo(
    () => countInjectConsoleLines(recordInjectConsoleLines),
    [recordInjectConsoleLines],
  );

  const launchChips = useMemo(() => launchChipsFromStored(cs2ExtraLaunchArgs), [cs2ExtraLaunchArgs]);
  const consoleChips = useMemo(() => consoleChipsFromStored(recordInjectConsoleLines), [recordInjectConsoleLines]);

  const addLaunchChip = useCallback(() => {
    const t = launchArgDraft.trim();
    if (!t || !onCs2ExtraLaunchArgsChange) return;
    const cur = launchChipsFromStored(cs2ExtraLaunchArgs);
    if (cur.includes(t)) {
      setLaunchArgDraft("");
      return;
    }
    if (cur.length >= 32) return;
    onCs2ExtraLaunchArgsChange(storedFromLaunchChips([...cur, t]));
    setLaunchArgDraft("");
  }, [launchArgDraft, cs2ExtraLaunchArgs, onCs2ExtraLaunchArgsChange]);

  const removeLaunchChip = useCallback(
    (idx) => {
      if (!onCs2ExtraLaunchArgsChange) return;
      const cur = launchChipsFromStored(cs2ExtraLaunchArgs);
      onCs2ExtraLaunchArgsChange(storedFromLaunchChips(cur.filter((_, i) => i !== idx)));
    },
    [cs2ExtraLaunchArgs, onCs2ExtraLaunchArgsChange],
  );

  const addConsoleChip = useCallback(() => {
    const t = consoleLineDraft.trim();
    if (!t || !onRecordInjectConsoleLinesChange) return;
    const cur = consoleChipsFromStored(recordInjectConsoleLines);
    if (cur.length >= 60) return;
    onRecordInjectConsoleLinesChange(storedFromConsoleChips([...cur, t]));
    setConsoleLineDraft("");
  }, [consoleLineDraft, recordInjectConsoleLines, onRecordInjectConsoleLinesChange]);

  const removeConsoleChip = useCallback(
    (idx) => {
      if (!onRecordInjectConsoleLinesChange) return;
      const cur = consoleChipsFromStored(recordInjectConsoleLines);
      onRecordInjectConsoleLinesChange(storedFromConsoleChips(cur.filter((_, i) => i !== idx)));
    },
    [recordInjectConsoleLines, onRecordInjectConsoleLinesChange],
  );

  return (
    <div className="space-y-4">
      <div className="min-w-0 space-y-2">
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
          额外启动参数
        </label>
        <div className="flex min-h-[3rem] flex-wrap content-start gap-2 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/25 p-2">
          {launchChips.length === 0 ? (
            <span className="py-1 text-[11px] text-zinc-600">
              尚未添加；每条在 cs2.exe 上单独解析（可写 -threads 8 为一条）
            </span>
          ) : (
            launchChips.map((line, idx) => (
              <span
                key={`lc-${idx}`}
                className="group inline-flex max-w-full items-center gap-1 rounded-md border border-cs2-orange/30 bg-cs2-orange/10 pl-2 pr-1 py-1 text-[11px] font-semibold text-cs2-orange"
              >
                <span className="min-w-0 max-w-[min(100%,18rem)] truncate font-mono" title={line}>
                  {line}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-white"
                  aria-label={`移除启动项 ${line}`}
                  onClick={() => removeLaunchChip(idx)}
                >
                  ✕
                </button>
              </span>
            ))
          )}
        </div>
        <TagListAddRow
          draft={launchArgDraft}
          onDraftChange={setLaunchArgDraft}
          onAdd={addLaunchChip}
          placeholder="输入一条启动参数后回车或点添加"
          addLabel="＋ 添加启动项"
          disabled={launchChips.length >= 32}
        />
        <p className="text-[10px] leading-relaxed text-zinc-600">
          与程序内置启动项合并；含空格请用英文双引号包在一整条里。最多 32 条；重复条目会自动忽略。
        </p>
      </div>

      <div className="min-w-0 space-y-2 border-t border-white/[0.06] pt-4">
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
          附加预热控制台
        </label>
        <div className="flex min-h-[3rem] flex-wrap content-start gap-2 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/25 p-2">
          {consoleChips.length === 0 ? (
            <span className="py-1 text-[11px] text-zinc-600">尚未添加控制台行</span>
          ) : (
            consoleChips.map((line, idx) => (
              <span
                key={`cc-${idx}`}
                className="group inline-flex max-w-full items-center gap-1 rounded-md border border-cyan-500/35 bg-cyan-950/40 pl-2 pr-1 py-1 text-[11px] font-semibold text-cyan-100/95"
              >
                <span className="min-w-0 max-w-[min(100%,20rem)] truncate font-mono" title={line}>
                  {line}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-white"
                  aria-label={`移除指令 ${line}`}
                  onClick={() => removeConsoleChip(idx)}
                >
                  ✕
                </button>
              </span>
            ))
          )}
        </div>
        <TagListAddRow
          draft={consoleLineDraft}
          onDraftChange={setConsoleLineDraft}
          onAdd={addConsoleChip}
          placeholder="输入一条控制台指令后回车或点添加"
          addLabel="＋ 添加指令"
          disabled={consoleChips.length >= 60}
        />
        <p className="text-[10px] leading-relaxed text-zinc-600">
          以 # 或 // 开头的行会计入列表但不算入下方统计。条数已合入底部统计（+{injectExtraCount}）。
        </p>
      </div>
    </div>
  );
}
