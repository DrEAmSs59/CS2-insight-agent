import { Flame, Skull, Check, Clapperboard, Film } from "lucide-react";
import { describeTag } from "../utils/tagDescriptions";

const CATEGORY_CONFIG = {
  highlight: {
    icon: Flame,
    color: "text-cs2-highlight",
    bgColor: "bg-cs2-highlight/10",
    borderColor: "border-cs2-highlight/30",
    label: "高光",
  },
  fail: {
    icon: Skull,
    color: "text-cs2-fail",
    bgColor: "bg-cs2-fail/10",
    borderColor: "border-cs2-fail/30",
    label: "下饭",
  },
  meme_death: {
    icon: Clapperboard,
    color: "text-fuchsia-400",
    bgColor: "bg-fuchsia-500/10",
    borderColor: "border-fuchsia-500/35",
    label: "坐牢集锦",
  },
  compilation: {
    icon: Film,
    color: "text-cs2-compilation",
    bgColor: "bg-cs2-compilation/10",
    borderColor: "border-cs2-compilation/35",
    label: "合集",
  },
};

function normalizeAiScore(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 右上角抢眼的 AI 分数：>85 金橙发光；40–85 绿/灰；<40 紫红小丑 */
export function AiScoreBadge({ score }) {
  const n = normalizeAiScore(score);
  if (n == null) return null;

  const rounded = Math.round(n);

  if (n > 85) {
    return (
      <div
        className="pointer-events-none select-none rounded-md border border-amber-400/50 bg-gradient-to-br from-amber-500/25 via-orange-500/15 to-amber-600/10 px-2 py-1 shadow-[0_0_18px_rgba(251,191,36,0.35),0_0_36px_rgba(249,115,22,0.12)]"
        aria-label={`AI 评分 ${rounded} 分`}
      >
        <span className="whitespace-nowrap text-[11px] font-black tracking-tight text-amber-100 drop-shadow-[0_0_8px_rgba(251,191,36,0.9)]">
          🏆 {rounded} 分
        </span>
      </div>
    );
  }

  if (n >= 40) {
    return (
      <div
        className="pointer-events-none select-none rounded-md border border-emerald-500/25 bg-emerald-950/30 px-2 py-1"
        aria-label={`AI 评分 ${rounded} 分`}
      >
        <span className="whitespace-nowrap font-mono text-[11px] font-bold tabular-nums text-emerald-300/95">
          {rounded} 分
        </span>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none select-none rounded-md border border-rose-500/45 bg-gradient-to-br from-rose-950/70 via-fuchsia-950/50 to-red-950/40 px-2 py-1 shadow-[0_0_14px_rgba(244,63,94,0.25)]"
      aria-label={`AI 评分 ${rounded} 分`}
    >
      <span className="whitespace-nowrap text-[11px] font-black tracking-tight text-rose-200 drop-shadow-[0_0_6px_rgba(244,63,94,0.5)]">
        🤡 {rounded} 分
      </span>
    </div>
  );
}

function namesDiffer(a, b) {
  const s = (v) => String(v ?? "").trim();
  return s(a) !== "" && s(a) !== s(b);
}

export default function ClipCard({
  clip,
  targetPlayer = "",
  selected,
  onToggle,
  aiMode: _aiMode,
  inQueue = false,
}) {
  const cat = CATEGORY_CONFIG[clip.category] || CATEGORY_CONFIG.highlight;
  const Icon = cat.icon;

  const showKillerBadge =
    clip.category === "fail" && namesDiffer(clip.killer_name, targetPlayer);

  const victimsList = Array.isArray(clip.victims) ? clip.victims.filter(Boolean) : [];
  const showVictimsBadge =
    clip.category === "highlight" &&
    clip.kill_count !== 5 &&
    victimsList.length > 0;

  const hasAiScore = normalizeAiScore(clip.ai_score) != null;
  const aiCommentary = String(clip.ai_commentary ?? "").trim();

  const hasScore = clip.score_own != null && clip.score_opp != null;

  // 若 context_tags 已包含对应中文杀数词，则不再单独显示数字徽章（避免「双杀」+「2 杀」重复）
  const KILL_COUNT_TAGS = new Set(["双杀", "三杀", "四杀", "五杀 (ACE)"]);
  const killCountInTags = clip.context_tags?.some((t) => KILL_COUNT_TAGS.has(t)) ?? false;

  return (
    <div
      role="button"
      aria-disabled={inQueue}
      tabIndex={inQueue ? -1 : 0}
      onClick={() => !inQueue && clip.client_clip_uid && onToggle(clip.client_clip_uid)}
      onKeyDown={(e) => {
        if (inQueue || !clip.client_clip_uid) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(clip.client_clip_uid);
        }
      }}
      className={`group relative rounded-xl border transition-all duration-200 bg-cs2-bg-card ${
        inQueue
          ? "cursor-not-allowed border-white/[0.06] opacity-[0.72]"
          : `cursor-pointer hover:shadow-lg ${
              selected
                ? "border-cs2-orange shadow-lg shadow-cs2-orange/10"
                : "border-cs2-border hover:border-cs2-border"
            }`
      }`}
    >
      {hasAiScore && (
        <div className="absolute right-11 top-3 z-10 max-w-[calc(100%-5.5rem)] sm:right-12">
          <AiScoreBadge score={clip.ai_score} />
        </div>
      )}

      {/* Selection / 队列状态 */}
      <div
        className={`absolute right-3 top-3 z-10 flex min-h-[1.25rem] min-w-[1.25rem] items-center justify-center rounded-md px-1 text-[9px] font-bold uppercase tracking-wide transition-colors ${
          inQueue
            ? "border border-zinc-600/80 bg-zinc-800/90 text-zinc-400"
            : selected
              ? "bg-cs2-orange"
              : "border border-cs2-border bg-cs2-bg-input group-hover:border-cs2-orange/40"
        }`}
      >
        {inQueue ? "队列" : selected ? <Check className="h-3 w-3 text-black" /> : null}
      </div>

      <div className="p-5 pt-4">
        <div className="flex items-start gap-4">
          {/* Category badge */}
          <div className={`flex flex-col items-center gap-1 rounded-lg px-3 py-2 ${cat.bgColor}`}>
            <Icon className={`h-5 w-5 ${cat.color}`} />
            <span className={`text-[9px] font-bold tracking-widest ${cat.color}`}>{cat.label}</span>
          </div>

          {/* Details */}
          <div className="min-w-0 flex-1 pr-6 sm:pr-8">
            {clip.category !== "compilation" && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-bold text-cs2-orange">第 {clip.round} 回合</span>
                {clip.round_won != null && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
                      clip.round_won
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-rose-500/20 text-rose-400"
                    }`}
                    title={clip.round_won ? "本回合：本方赢" : "本回合：本方输"}
                  >
                    {clip.round_won ? "胜" : "败"}
                  </span>
                )}
                {hasScore && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums"
                    title="本回合开局时比分（本方 : 对方）"
                  >
                    <span className="text-emerald-400">{clip.score_own}</span>
                    <span className="text-cs2-text-secondary">:</span>
                    <span className="text-rose-400">{clip.score_opp}</span>
                  </span>
                )}
                {clip.kill_count > 0 && !killCountInTags && (
                  <span className="rounded bg-cs2-bg-input px-2 py-0.5 text-[10px] font-bold text-white">
                    {clip.kill_count} 杀
                  </span>
                )}
              </div>
            )}
            {clip.category === "compilation" && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {Array.isArray(clip.source_ticks) && clip.source_ticks.length > 0 && (
                  <span
                    className="rounded bg-cs2-bg-input px-2 py-0.5 font-mono text-[10px] font-bold text-white"
                    title="合集包含的子片段数（每段对应一次击杀或死亡）"
                  >
                    {clip.source_ticks.length} 段
                  </span>
                )}
                {clip.kill_count > 0 && (
                  <span className="rounded bg-cs2-bg-input px-2 py-0.5 text-[10px] font-bold text-white">
                    {clip.kill_count} 杀
                  </span>
                )}
              </div>
            )}

            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {clip.context_tags?.map((tag) => {
                const desc = describeTag(tag);
                return (
                  <span
                    key={tag}
                    title={desc || undefined}
                    className={`rounded border px-2 py-0.5 text-[10px] font-bold tracking-wide ${cat.bgColor} ${cat.borderColor} ${cat.color} ${desc ? "cursor-help" : ""}`}
                  >
                    {tag}
                  </span>
                );
              })}
              {clip.weapon_used
                ?.split(" / ")
                .map((w) => w.trim())
                .filter(Boolean)
                .map((w) => (
                  <span
                    key={w}
                    className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-0.5 font-mono text-[10px] text-cs2-text-secondary"
                  >
                    {w}
                  </span>
                ))}
              {showKillerBadge && (
                <span className="rounded border border-rose-500/25 bg-rose-950/40 px-2 py-0.5 text-[10px] font-bold tracking-wide text-rose-300/85">
                  💀 击杀者: {clip.killer_name}
                </span>
              )}
              {showVictimsBadge && (
                <span className="rounded border border-emerald-500/20 bg-emerald-950/35 px-2 py-0.5 text-[10px] font-bold tracking-wide text-emerald-400/90">
                  🎯 击杀: {victimsList.join(", ")}
                </span>
              )}
            </div>

            <div className="font-mono text-[10px] text-cs2-text-secondary">
              帧 {clip.start_tick.toLocaleString()} → {clip.end_tick.toLocaleString()}
            </div>
          </div>
        </div>

        {aiCommentary ? (
          <div className="relative mt-4 min-w-0 overflow-hidden rounded-lg bg-zinc-950/75 pl-3.5 pr-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ring-1 ring-white/[0.06]">
            <div
              className="pointer-events-none absolute bottom-1 left-0 top-1 w-[3px] rounded-full bg-gradient-to-b from-cs2-orange via-fuchsia-500/80 to-cyan-500/40 opacity-90"
              aria-hidden
            />
            <p className="min-w-0 break-words pl-2 text-[13px] leading-relaxed text-zinc-200">
              <span className="mr-1.5 inline-block select-none not-italic" aria-hidden>
                🎙️
              </span>
              <span className="font-semibold not-italic text-zinc-500">AI 锐评：</span>
              <span className="italic text-zinc-100/95">{aiCommentary}</span>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
