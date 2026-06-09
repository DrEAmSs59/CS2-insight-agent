import { X } from "lucide-react";
import KillfeedIconStrip from "./killfeed/KillfeedIconStrip";
import { useT } from "../../../i18n/useT.js";
import { useLocaleStore } from "../../../i18n/localeStore.js";
import { weaponDisplayName } from "../../../i18n/weaponNames.js";

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

/** Keys for MOD_BADGES; labels resolved via t() in the component. */
const MOD_BADGE_KEYS = [
  { k: "trade_kill", labelKey: "analysis.modTradekill", titleKey: "analysis.modTradekillTitle" },
  { k: "first_kill", labelKey: "analysis.modFirstkill", titleKey: "analysis.modFirstkillTitle" },
  { k: "flash_assisted", labelKey: "analysis.modFlashAssist", titleKey: "analysis.modFlashAssistTitle" },
];

function modifierBadgeKeys(mods, flashAssistLine) {
  return MOD_BADGE_KEYS.filter((b) => {
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
 *   onRowRemove?: () => void,
 *   roundNumber?: number,
 *   variant?: "default" | "timeline",
 * }} props
 */
export default function KillfeedEventRow({
  event,
  focusedPlayer = "",
  queued = false,
  onRowClick,
  onRowRemove,
  roundNumber,
  variant = "default",
}) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const typ = String(event?.type || "");
  const isAssistOnly = typ === "assist_only";
  const isKill = typ === "kill" || event?.record_type === "kill";
  const isDeath = typ === "death" || event?.record_type === "death";
  const timeText = String(event?.time_text || "--:--");
  const atkRaw = String(event?.attacker_name || "").trim();
  const atk = (atkRaw && !["nan", "undefined", "null"].includes(atkRaw.toLowerCase())) ? atkRaw : "—";
  const vic = String(event?.victim_name || "").trim() || "—";
  const weapon = weaponDisplayName(String(event?.weapon_name || "").trim(), locale) || "—";
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
      ? "cursor-default border-cs2-border bg-cs2-bg-input/60 text-cs2-text-muted"
      : isKill
        ? atkHighlight
          ? "border-emerald-400/50 bg-gradient-to-r from-cs2-emerald-surface to-cs2-bg-card"
          : "border-emerald-500/28 bg-gradient-to-r from-cs2-emerald-surface to-cs2-bg-card"
        : isDeath
          ? vicHighlight
            ? "border-rose-400/55 bg-gradient-to-r from-cs2-rose-surface to-cs2-bg-card"
            : "border-rose-500/28 bg-gradient-to-r from-cs2-rose-surface to-cs2-bg-card"
          : "border-cs2-border bg-[rgb(8,8,8)]/88",
    clickable ? "cursor-pointer hover:brightness-110" : "",
    queued ? "ring-1 ring-cs2-accent/45" : "",
  ].join(" ");

  const badgeRow =
    variant === "timeline"
      ? []
      : modifierBadgeKeys(mods, flashAssistLine).map((b) => (
          <span
            key={b.k}
            title={t(b.titleKey)}
            className="rounded border border-cs2-border bg-cs2-bg-page/85 px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-cs2-text-primary"
          >
            {t(b.labelKey)}
          </span>
        ));

  if (isAssistOnly) {
    return (
      <div className={rowClass}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-snug">
        <span className="shrink-0 font-mono text-[12px] text-cs2-text-muted">[{timeText}]</span>
        {variant !== "timeline" && Number.isFinite(roundNumber) && roundNumber > 0 ? (
          <span className="shrink-0 rounded border border-cyan-500/25 bg-cs2-cyan-surface px-1 py-0 font-mono text-[10px] font-semibold text-cs2-cyan-on-surface">
            {t("analysis.roundLabel", { n: roundNumber })}
          </span>
        ) : null}
          <span className="text-cs2-text-muted">{String(event?.assist_note || t("analysis.assistFallback"))}</span>
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
        <span className="shrink-0 font-mono text-[12px] text-cs2-text-muted">[{timeText}]</span>
        {variant !== "timeline" && Number.isFinite(roundNumber) && roundNumber > 0 ? (
          <span className="shrink-0 rounded border border-cyan-500/30 bg-cs2-cyan-surface px-1 py-0 font-mono text-[10px] font-semibold text-cs2-cyan-on-surface">
            {t("analysis.roundLabel", { n: roundNumber })}
          </span>
        ) : null}
        <span
          className={[
            "shrink-0 font-bold tracking-tight",
            atkHighlight ? "text-cs2-accent" : "text-[#e8c56a]",
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
            vicHighlight ? "text-cs2-accent" : "text-[#b8d9f6]",
          ].join(" ")}
        >
          {vic}
        </span>
        {queued ? (
          onRowRemove ? (
            <button
              type="button"
              aria-label={t("analysis.ariaRemoveFromQueue")}
              onClick={(e) => { e.stopPropagation(); onRowRemove(); }}
              className="ml-auto shrink-0 flex items-center gap-0.5 rounded border border-cs2-accent/35 px-1.5 py-0.5 text-[10px] font-semibold text-cs2-accent transition-colors hover:border-rose-400/55 hover:text-rose-400"
            >
              {t("analysis.queued")}<X className="h-2.5 w-2.5" />
            </button>
          ) : (
            <span className="ml-auto shrink-0 rounded border border-cs2-accent/35 px-1.5 py-0.5 text-[10px] font-semibold text-cs2-accent">
              {t("analysis.queued")}
            </span>
          )
        ) : null}
      </div>
      {flashAssistLine ? (
        <p className="mt-1 pl-0.5 text-[12px] leading-snug text-cs2-text-secondary">
          <span className="text-cs2-text-muted">↳</span> {t("analysis.flashAssist")}
          <span className="font-semibold text-amber-400">{assistName}</span>
        </p>
      ) : normalAssistLine ? (
        <p className="mt-1 pl-0.5 text-[12px] leading-snug text-cs2-text-secondary">
          <span className="text-cs2-text-muted">↳</span> {t("analysis.assist")}
          <span className="font-semibold text-amber-400">{assistName}</span>
        </p>
      ) : null}
    </div>
  );
}
