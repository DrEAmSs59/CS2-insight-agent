import { useCallback, useMemo, useState } from "react";
import { LockKeyhole, Search, X } from "lucide-react";
import { useT } from "../i18n/useT.js";

/** 程序内置、始终生效、不可删除的启动参数（仅展示，不写配置）。 */
const FIXED_LAUNCH_ARGS = [
  "-console",
  "-novid",
  "-insecure",
  "-worldwide",
  "-allow_third_party_software",
];

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
        className="min-w-0 w-full flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[12px] text-cs2-text-primary placeholder:text-cs2-text-muted focus:border-cs2-accent/50 focus:outline-none disabled:opacity-45"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAdd()}
        className="inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:border-cs2-accent/45 hover:text-cs2-text-primary disabled:opacity-45 @min-[24rem]/params:w-auto"
      >
        {addLabel}
      </button>
    </div>
  );
}

function CommandCollection({
  query,
  onQueryChange,
  countLabel,
  searchPlaceholder,
  emptyLabel,
  hasMatches,
  children,
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-input/55">
      <div className="flex flex-col gap-2 border-b border-cs2-border px-2 py-2 @min-[32rem]/params:flex-row @min-[32rem]/params:items-center">
        <span className="shrink-0 text-[10px] font-semibold text-cs2-text-muted">{countLabel}</span>
        <label className="relative min-w-0 flex-1 @min-[32rem]/params:ml-auto @min-[32rem]/params:max-w-64">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            spellCheck={false}
            className="h-8 w-full rounded-md border border-cs2-border bg-cs2-bg-card pl-8 pr-3 text-[11px] text-cs2-text-primary outline-none placeholder:text-cs2-text-muted focus:border-cs2-accent/50"
          />
        </label>
      </div>
      <div className="max-h-48 overflow-y-auto p-2 custom-scrollbar">
        {hasMatches ? (
          <div className="grid gap-1.5 @min-[42rem]/params:grid-cols-2">{children}</div>
        ) : (
          <p className="px-1 py-3 text-center text-[11px] text-cs2-text-muted">{emptyLabel}</p>
        )}
      </div>
    </div>
  );
}

function CommandListItem({ line, index, builtIn = false, builtInLabel, tone = "accent", removeLabel, onRemove }) {
  const toneClass = builtIn
    ? "border-cs2-border bg-cs2-bg-elevated text-cs2-text-secondary"
    : tone === "console"
      ? "border-cs2-border bg-cs2-cyan-surface text-cs2-cyan-on-surface"
      : "border-cs2-accent/45 bg-cs2-accent-soft text-cs2-accent";

  return (
    <div className={`group flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 ${toneClass}`}>
      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-cs2-bg-card/70 px-1 font-mono text-[9px] text-cs2-text-muted">
        {builtIn ? <LockKeyhole aria-hidden className="h-3 w-3" /> : index}
      </span>
      <code className="min-w-0 flex-1 truncate text-[11px] font-semibold" title={line}>{line}</code>
      {builtIn ? (
        <span className="shrink-0 text-[9px] font-semibold text-cs2-text-muted">{builtInLabel}</span>
      ) : (
        <button
          type="button"
          className="shrink-0 rounded p-1 text-cs2-text-muted transition-colors hover:bg-cs2-bg-card hover:text-cs2-text-primary"
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <X aria-hidden className="h-3 w-3" />
        </button>
      )}
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
  omitConsoleHint = false,
}) {
  const t = useT();
  const [launchArgDraft, setLaunchArgDraft] = useState("");
  const [consoleLineDraft, setConsoleLineDraft] = useState("");
  const [launchQuery, setLaunchQuery] = useState("");
  const [consoleQuery, setConsoleQuery] = useState("");

  const injectExtraCount = useMemo(
    () => countInjectConsoleLines(recordInjectConsoleLines),
    [recordInjectConsoleLines],
  );

  const launchChips = useMemo(() => launchChipsFromStored(cs2ExtraLaunchArgs), [cs2ExtraLaunchArgs]);
  const editableLaunchChips = useMemo(
    () => launchChips.filter((c) => !FIXED_LAUNCH_ARGS.includes(c)),
    [launchChips],
  );
  const consoleChips = useMemo(() => consoleChipsFromStored(recordInjectConsoleLines), [recordInjectConsoleLines]);
  const normalizedLaunchQuery = launchQuery.trim().toLowerCase();
  const normalizedConsoleQuery = consoleQuery.trim().toLowerCase();
  const filteredFixedLaunchArgs = useMemo(
    () => FIXED_LAUNCH_ARGS.filter((line) => !normalizedLaunchQuery || line.toLowerCase().includes(normalizedLaunchQuery)),
    [normalizedLaunchQuery],
  );
  const filteredEditableLaunchChips = useMemo(
    () => editableLaunchChips
      .map((line, customIndex) => ({ line, index: launchChips.indexOf(line), customIndex }))
      .filter(({ line }) => !normalizedLaunchQuery || line.toLowerCase().includes(normalizedLaunchQuery)),
    [editableLaunchChips, launchChips, normalizedLaunchQuery],
  );
  const filteredConsoleChips = useMemo(
    () => consoleChips
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !normalizedConsoleQuery || line.toLowerCase().includes(normalizedConsoleQuery)),
    [consoleChips, normalizedConsoleQuery],
  );

  const addLaunchChip = useCallback(() => {
    const trimmed = launchArgDraft.trim();
    if (!trimmed || !onCs2ExtraLaunchArgsChange) return;
    const cur = launchChipsFromStored(cs2ExtraLaunchArgs);
    if (cur.includes(trimmed)) {
      setLaunchArgDraft("");
      return;
    }
    if (cur.length >= 32) return;
    onCs2ExtraLaunchArgsChange(storedFromLaunchChips([...cur, trimmed]));
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
    const trimmed = consoleLineDraft.trim();
    if (!trimmed || !onRecordInjectConsoleLinesChange) return;
    const cur = consoleChipsFromStored(recordInjectConsoleLines);
    if (cur.length >= 60) return;
    onRecordInjectConsoleLinesChange(storedFromConsoleChips([...cur, trimmed]));
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
          {t("record.launchSectionLabel")}
        </label>
        <CommandCollection
          query={launchQuery}
          onQueryChange={setLaunchQuery}
          countLabel={t("record.launchCount", { builtIn: FIXED_LAUNCH_ARGS.length, custom: editableLaunchChips.length })}
          searchPlaceholder={t("record.launchSearchPlaceholder")}
          emptyLabel={t("record.commandNoResults")}
          hasMatches={filteredFixedLaunchArgs.length + filteredEditableLaunchChips.length > 0}
        >
          {filteredFixedLaunchArgs.map((line) => (
            <CommandListItem
              key={`fixed-${line}`}
              line={line}
              builtIn
              builtInLabel={t("record.commandBuiltIn")}
            />
          ))}
          {filteredEditableLaunchChips.map(({ line, index, customIndex }) => (
            <CommandListItem
              key={`lc-${index}`}
              line={line}
              index={FIXED_LAUNCH_ARGS.length + customIndex + 1}
              removeLabel={t("record.launchRemoveAriaLabel", { arg: line })}
              onRemove={() => removeLaunchChip(index)}
            />
          ))}
        </CommandCollection>
        <TagListAddRow
          draft={launchArgDraft}
          onDraftChange={setLaunchArgDraft}
          onAdd={addLaunchChip}
          placeholder={t("record.launchInputPlaceholder")}
          addLabel={t("record.launchAddBtn")}
          disabled={launchChips.length >= 32}
        />
        <p className="text-[11px] leading-relaxed text-cs2-text-muted">
          {t("record.launchHint")}
        </p>
      </div>

      <div className="min-w-0 space-y-2 border-t border-cs2-border pt-4">
        <label className="block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
          {t("record.consoleSectionLabel")}
        </label>
        <CommandCollection
          query={consoleQuery}
          onQueryChange={setConsoleQuery}
          countLabel={t("record.consoleCount", { n: consoleChips.length })}
          searchPlaceholder={t("record.consoleSearchPlaceholder")}
          emptyLabel={consoleQuery.trim() ? t("record.commandNoResults") : t("record.consoleEmpty")}
          hasMatches={filteredConsoleChips.length > 0}
        >
          {filteredConsoleChips.map(({ line, index }) => (
            <CommandListItem
              key={`cc-${index}`}
              line={line}
              index={index + 1}
              tone="console"
              removeLabel={t("record.consoleRemoveAriaLabel", { arg: line })}
              onRemove={() => removeConsoleChip(index)}
            />
          ))}
        </CommandCollection>
        <TagListAddRow
          draft={consoleLineDraft}
          onDraftChange={setConsoleLineDraft}
          onAdd={addConsoleChip}
          placeholder={t("record.consoleInputPlaceholder")}
          addLabel={t("record.consoleAddBtn")}
          disabled={consoleChips.length >= 60}
        />
        {!omitConsoleHint ? (
          <p className="text-[11px] leading-relaxed text-cs2-text-muted">
            {t("record.consoleHint", { n: injectExtraCount })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
