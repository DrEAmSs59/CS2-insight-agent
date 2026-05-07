import KillfeedIconStrip from "./killfeed/KillfeedIconStrip";

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
  const canRec = Boolean(event?.can_record) && !isAssistOnly;

  const atkHighlight = focusedPlayer && atk === focusedPlayer;
  const vicHighlight = focusedPlayer && vic === focusedPlayer;

  const rowClass = [
    "death-notice-row group relative inline-flex max-w-[760px] flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border px-2.5 py-1.5 text-[13px] leading-tight",
    isAssistOnly
      ? "border-white/[0.06] bg-black/40 text-zinc-500"
      : isKill
        ? "border-emerald-400/35 bg-gradient-to-r from-emerald-950/45 to-[rgb(10,10,10)]/90"
        : isDeath
          ? "border-rose-400/38 bg-gradient-to-r from-rose-950/40 to-[rgb(10,10,10)]/90"
          : "border-white/10 bg-[rgb(8,8,8)]/85",
  ].join(" ");

  if (isAssistOnly) {
    return (
      <div className={rowClass}>
        <span className="font-mono text-[11px] text-zinc-600">[{timeText}]</span>
        <span className="text-[12px]">{String(event?.assist_note || "助攻")}</span>
      </div>
    );
  }

  return (
    <div className={rowClass}>
      <span className="shrink-0 font-mono text-[11px] text-zinc-500">[{timeText}]</span>
      <span
        className={[
          "shrink-0 text-[13px] font-bold tracking-tight",
          atkHighlight ? "text-cs2-orange" : "text-[#e8c56a]",
        ].join(" ")}
      >
        {atk}
      </span>
      <KillfeedIconStrip event={event} weaponName={weapon} weaponKey={weaponKey} />
      <span
        className={["shrink-0 text-[13px] font-bold tracking-tight", vicHighlight ? "text-cs2-orange" : "text-[#b8d9f6]"].join(
          " ",
        )}
      >
        {vic}
      </span>
      {assistName ? (
        <span className="w-full basis-full pl-[3.25rem] text-[10px] text-zinc-500 sm:pl-0">
          助攻：{assistName}
        </span>
      ) : null}
      {canRec && onEnqueue ? (
        <button
          type="button"
          onClick={onEnqueue}
          disabled={queued}
          className="death-notice-action ml-auto shrink-0 rounded border border-cs2-orange/40 bg-cs2-orange/15 px-2 py-0.5 text-[11px] font-semibold text-cs2-orange opacity-100 transition-opacity duration-150 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
        >
          {queued ? "已入队" : "加入录制"}
        </button>
      ) : null}
    </div>
  );
}
