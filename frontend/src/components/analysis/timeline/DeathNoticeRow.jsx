import KillfeedIconStrip from "./killfeed/KillfeedIconStrip";
import { useT } from "../../../i18n/useT.js";
import { useLocaleStore } from "../../../i18n/localeStore.js";
import { weaponDisplayName } from "../../../i18n/weaponNames.js";

/** 过滤 demo 里可能出现的 NaN / 占位字符串，避免显示「助攻: nan」。 */
function assisterDisplayName(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number" && !Number.isFinite(raw)) return "";
  const s = String(raw).trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low === "nan" || low === "undefined" || low === "null") return "";
  return s;
}

/**
 * CS2 击杀条风格：左攻击者（偏金）→ 图标带 → 右受害者（偏蓝）。
 * 武器与修饰图标来自 hud.hlae.site 生成器所用 SVG（One Studio），已复制到 `public/hud-death-notice/`
 * 并以稳定文件名引用；部署站点的 content-hash 变更不会影响本应用。
 */
export default function DeathNoticeRow({ event, focusedPlayer = "", queued = false, onEnqueue }) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const typ = String(event?.type || "");
  const isAssistOnly = typ === "assist_only";
  const isKill = typ === "kill" || event?.record_type === "kill";
  const isDeath = typ === "death" || event?.record_type === "death";
  const timeText = String(event?.time_text || "--:--");
  const atk = String(event?.attacker_name || "").trim() || "—";
  const vic = String(event?.victim_name || "").trim() || "—";
  const weapon = weaponDisplayName(String(event?.weapon_name || "").trim(), locale) || "—";
  const weaponKey = String(event?.weapon_key || "").trim();
  const assistName = assisterDisplayName(event?.assister_name);
  const canRec = Boolean(event?.can_record) && !isAssistOnly;

  const atkHighlight = focusedPlayer && atk === focusedPlayer;
  const vicHighlight = focusedPlayer && vic === focusedPlayer;

  const rowClass = [
    "death-notice-row group relative inline-flex max-w-[760px] flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border px-2.5 py-1.5 text-[13px] leading-tight",
    isAssistOnly
      ? "border-cs2-border bg-cs2-bg-input/70 text-cs2-text-muted"
      : isKill
        ? "border-emerald-400/35 bg-gradient-to-r from-cs2-emerald-surface to-cs2-bg-card"
        : isDeath
          ? "border-rose-400/38 bg-gradient-to-r from-cs2-rose-surface to-cs2-bg-card"
          : "border-cs2-border bg-[rgb(8,8,8)]/85",
  ].join(" ");

  if (isAssistOnly) {
    return (
      <div className={rowClass}>
        <span className="font-mono text-[12px] text-cs2-text-muted">[{timeText}]</span>
        <span className="text-[12px]">{String(event?.assist_note || t("analysis.assistFallback"))}</span>
      </div>
    );
  }

  return (
    <div className={rowClass}>
      <span className="shrink-0 font-mono text-[12px] text-cs2-text-muted">[{timeText}]</span>
      <span
        className={[
          "shrink-0 text-[13px] font-bold tracking-tight",
          atkHighlight ? "text-cs2-accent" : "text-[#e8c56a]",
        ].join(" ")}
      >
        {atk}
      </span>
      <KillfeedIconStrip event={event} weaponName={weapon} weaponKey={weaponKey} />
      <span
        className={["shrink-0 text-[13px] font-bold tracking-tight", vicHighlight ? "text-cs2-accent" : "text-[#b8d9f6]"].join(
          " ",
        )}
      >
        {vic}
      </span>
      {assistName ? (
        <span className="w-full basis-full pl-[3.25rem] text-[11px] text-cs2-text-muted sm:pl-0">
          {t("analysis.assistLabel")}{assistName}
        </span>
      ) : null}
      {canRec && onEnqueue ? (
        <button
          type="button"
          onClick={onEnqueue}
          disabled={queued}
          className="death-notice-action ml-auto shrink-0 rounded border border-cs2-accent/40 bg-cs2-accent/15 px-2 py-0.5 text-[12px] font-semibold text-cs2-accent opacity-100 transition-opacity duration-150 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
        >
          {queued ? t("analysis.queued") : t("analysis.btnEnqueue")}
        </button>
      ) : null}
    </div>
  );
}
