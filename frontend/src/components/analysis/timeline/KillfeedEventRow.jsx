import KillfeedIconStrip from "./killfeed/KillfeedIconStrip";

function assisterDisplayName(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number" && !Number.isFinite(raw)) return "";
  const s = String(raw).trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low === "nan" || low === "undefined" || low === "null") return "";
  return s;
}

function getModifiers(ev) {
  const m = ev?.modifiers;
  if (m && typeof m === "object") return m;
  return {
    headshot: Boolean(ev?.is_headshot),
    through_smoke: Boolean(ev?.is_through_smoke),
    attacker_blind: Boolean(ev?.is_blind),
    no_scope: Boolean(ev?.is_noscope),
    through_wall: Boolean(ev?.is_wallbang),
    airborne: Boolean(ev?.is_jump_kill),
    flash_assisted: Boolean(ev?.is_flash_assist),
    trade_kill: Boolean(ev?.trade_kill),
    first_kill: Boolean(ev?.first_kill),
  };
}

/** 仅保留无 HUD 图标修饰的徽章（爆头/穿烟/跳杀等由 KillfeedIconStrip 展示）。 */
const MOD_BADGES = [
  { k: "trade_kill", label: "补枪", title: "补枪 / 换人" },
  { k: "first_kill", label: "首杀", title: "本回合首杀" },
  { k: "flash_assisted", label: "闪协", title: "闪光助攻参与" },
];

function modifierBadges(mods, flashAssistLine) {
  return MOD_BADGES.filter((b) => {
    if (!mods[b.k]) return false;
    if (b.k === "flash_assisted" && flashAssistLine) return false;
    return true;
  });
}

/**
 * 紧凑 Killfeed 行（时间线中间栏）。
 * @param {{
 *   event: Record<string, unknown>,
 *   focusedPlayer?: string,
 *   queued?: boolean,
 *   onRowClick?: () => void,
 *   roundNumber?: number,
 *   variant?: "default" | "timeline",
 * }} props
 */
export default function KillfeedEventRow({
  event,
  focusedPlayer = "",
  queued = false,
  onRowClick,
  roundNumber,
  variant = "default",
}) {
  const typ = String(event?.type || "");
  const isAssistOnly = typ === "assist_only";
  const isKill = typ === "kill" || event?.record_type === "kill";
  const isDeath = typ === "death" || event?.record_type === "death";
  const timeText = String(event?.time_text || "--:--");
  const atk = String(event?.attacker_name || "").trim() || "—";
  const vic = String(event?.victim_name || "").trim() || "—";
  const weapon = String(event?.weapon_name || "").trim() || "—";
  const weaponKey = String(event?.weapon_key || "").trim();
  const assistName = assisterDisplayName(event?.assister_name);
  const mods = getModifiers(event);
  const flashAssistLine = Boolean(mods.flash_assisted) && assistName;
  const normalAssistLine = assistName && !flashAssistLine;
  const canRec = Boolean(event?.can_record) && !isAssistOnly;
  const clickable = canRec && typeof onRowClick === "function";

  const atkHighlight = focusedPlayer && atk === focusedPlayer;
  const vicHighlight = focusedPlayer && vic === focusedPlayer;

  const rowClass = [
    "killfeed-event-row flex min-h-9 w-full max-w-full cursor-default flex-col justify-center rounded-md border px-2.5 py-1.5 text-left transition-colors duration-150",
    normalAssistLine || flashAssistLine ? "min-h-[52px]" : "",
    isAssistOnly
      ? "cursor-default border-white/[0.06] bg-black/35 text-zinc-500"
      : isKill
        ? atkHighlight
          ? "border-emerald-400/50 bg-gradient-to-r from-emerald-950/55 to-[rgb(12,18,14)]/95"
          : "border-emerald-500/28 bg-gradient-to-r from-emerald-950/40 to-[rgb(10,10,10)]/92"
        : isDeath
          ? vicHighlight
            ? "border-rose-400/55 bg-gradient-to-r from-rose-950/55 to-[rgb(18,12,12)]/95"
            : "border-rose-500/28 bg-gradient-to-r from-rose-950/38 to-[rgb(10,10,10)]/92"
          : "border-white/10 bg-[rgb(8,8,8)]/88",
    clickable ? "cursor-pointer hover:brightness-110" : "",
    queued ? "ring-1 ring-cs2-orange/45" : "",
  ].join(" ");

  const badgeRow =
    variant === "timeline"
      ? []
      : modifierBadges(mods, flashAssistLine).map((b) => (
          <span
            key={b.k}
            title={b.title}
            className="rounded border border-white/14 bg-black/55 px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-zinc-200"
          >
            {b.label}
          </span>
        ));

  if (isAssistOnly) {
    return (
      <div className={rowClass}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-snug">
        <span className="shrink-0 font-mono text-[11px] text-zinc-600">[{timeText}]</span>
        {variant !== "timeline" && Number.isFinite(roundNumber) && roundNumber > 0 ? (
          <span className="shrink-0 rounded border border-cyan-500/25 bg-cyan-950/35 px-1 py-0 font-mono text-[10px] font-semibold text-cyan-200/90">
            第 {roundNumber} 回合
          </span>
        ) : null}
          <span className="text-zinc-500">{String(event?.assist_note || "助攻")}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onRowClick : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRowClick?.();
              }
            }
          : undefined
      }
      className={rowClass}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] leading-tight">
        <span className="shrink-0 font-mono text-[11px] text-zinc-500">[{timeText}]</span>
        {variant !== "timeline" && Number.isFinite(roundNumber) && roundNumber > 0 ? (
          <span className="shrink-0 rounded border border-cyan-500/30 bg-cyan-950/40 px-1 py-0 font-mono text-[10px] font-semibold text-cyan-200/95">
            第 {roundNumber} 回合
          </span>
        ) : null}
        <span
          className={[
            "shrink-0 font-bold tracking-tight",
            atkHighlight ? "text-cs2-orange" : "text-[#e8c56a]",
          ].join(" ")}
        >
          {atk}
        </span>
        <KillfeedIconStrip event={event} weaponName={weapon} weaponKey={weaponKey} />
        {badgeRow.length ? (
          <span className="inline-flex flex-wrap items-center gap-0.5">{badgeRow}</span>
        ) : null}
        <span
          className={[
            "min-w-0 shrink-0 font-bold tracking-tight",
            vicHighlight ? "text-cs2-orange" : "text-[#b8d9f6]",
          ].join(" ")}
        >
          {vic}
        </span>
        {queued ? (
          <span className="ml-auto shrink-0 rounded border border-cs2-orange/35 px-1.5 py-0.5 text-[10px] font-semibold text-cs2-orange">
            已入队
          </span>
        ) : null}
      </div>
      {flashAssistLine ? (
        <p className="mt-1 pl-0.5 text-[12px] leading-snug text-zinc-400">
          <span className="text-zinc-600">↳</span> 闪光助攻：
          <span className="font-semibold text-amber-400">{assistName}</span>
        </p>
      ) : normalAssistLine ? (
        <p className="mt-1 pl-0.5 text-[12px] leading-snug text-zinc-400">
          <span className="text-zinc-600">↳</span> 助攻：
          <span className="font-semibold text-amber-400">{assistName}</span>
        </p>
      ) : null}
    </div>
  );
}
