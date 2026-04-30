import { useEffect, useRef } from "react";
import { Skull } from "lucide-react";
import { AiScoreBadge } from "./ClipCard";

/**
 * 研发集锦合集大卡：一键勾选本局全部 meme_death 片段
 * @param {number} totalDeathsInMatch - 本局目标玩家总死亡次数（来自解析 match_meta）
 * @param {string[]|undefined} memeSeriesBadges - o/i/z/211 梗标签（与 PlayerSelect 一致）
 * @param {number|string|null|undefined} aiMemeMontageScore - 整局特殊战绩 AI 分
 * @param {string|undefined} aiMemeMontageCommentary - 整局特殊战绩 AI 锐评
 */
export default function MemeDeathMontageCard({
  totalDeathsInMatch,
  memeSeriesBadges = [],
  aiMemeMontageScore,
  aiMemeMontageCommentary,
  allSelected,
  someSelected,
  onBundleToggle,
  bundleDisabled = false,
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [someSelected, allSelected]);

  const badges = Array.isArray(memeSeriesBadges) ? memeSeriesBadges.filter(Boolean) : [];
  const montageComment = String(aiMemeMontageCommentary ?? "").trim();

  return (
    <div
      className={[
        "relative overflow-hidden rounded-2xl border-2 p-5 md:p-6",
        "border-red-500/70 shadow-[0_0_24px_rgba(239,68,68,0.45),0_0_48px_rgba(190,24,93,0.2),inset_0_1px_0_rgba(255,255,255,0.06)]",
        "bg-gradient-to-br from-rose-950/50 via-red-950/40 to-fuchsia-950/35",
      ].join(" ")}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 20% 0%, rgba(244,63,94,0.25), transparent 50%), radial-gradient(ellipse 60% 40% at 100% 100%, rgba(127,29,29,0.35), transparent 55%)",
        }}
      />

      <div className="relative flex flex-row items-start justify-between gap-3 md:gap-5">
        <div className="min-w-0 flex-1 pr-2">
          <div className="mb-2 flex items-center gap-2 text-red-300/90">
            <Skull className="h-5 w-5 shrink-0" />
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-red-200/70">
              打包录制
            </span>
          </div>
          <h3 className="text-xl font-black leading-tight tracking-tight text-white drop-shadow-[0_0_12px_rgba(0,0,0,0.5)] md:text-2xl lg:text-3xl">
            👨‍🔬 节目效果专属：研发全过程{" "}
            <span className="whitespace-nowrap text-red-200">
              (本局共 {totalDeathsInMatch} 次死亡)
            </span>
          </h3>
          {badges.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {badges.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-fuchsia-400/35 bg-fuchsia-950/40 px-2 py-0.5 text-[10px] font-bold tracking-wide text-fuchsia-100/95"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {montageComment ? (
            <div className="relative mt-4 min-w-0 overflow-hidden rounded-lg bg-black/35 pl-3.5 pr-3 py-2.5 ring-1 ring-white/[0.08]">
              <div
                className="pointer-events-none absolute bottom-1 left-0 top-1 w-[3px] rounded-full bg-gradient-to-b from-red-400 via-fuchsia-500/80 to-amber-500/50 opacity-90"
                aria-hidden
              />
              <p className="min-w-0 break-words pl-2 text-[13px] leading-relaxed text-zinc-100">
                <span className="mr-1.5 inline-block select-none not-italic" aria-hidden>
                  🎙️
                </span>
                <span className="font-semibold not-italic text-zinc-500">AI 锐评（整局梗战绩）：</span>
                <span className="italic text-zinc-100/95">{montageComment}</span>
              </p>
            </div>
          ) : null}
        </div>

        {aiMemeMontageScore != null && aiMemeMontageScore !== "" && (
          <div className="pointer-events-none shrink-0 select-none pt-1">
            <AiScoreBadge score={aiMemeMontageScore} />
          </div>
        )}

        <label
          className={`relative flex shrink-0 select-none flex-col items-center gap-2 rounded-xl border border-red-400/40 bg-black/25 px-3 py-3 backdrop-blur-sm sm:px-4 ${
            bundleDisabled
              ? "cursor-not-allowed opacity-45"
              : "cursor-pointer transition-colors hover:border-red-400/70 hover:bg-black/35"
          }`}
        >
          <span className="max-w-[4.5rem] text-center text-[10px] font-bold uppercase leading-tight tracking-wider text-red-200/90">
            {bundleDisabled ? "已在队列" : "全选本合集"}
          </span>
          <input
            ref={inputRef}
            type="checkbox"
            checked={allSelected}
            disabled={bundleDisabled}
            onChange={(e) => onBundleToggle(e.target.checked)}
            className="h-6 w-6 cursor-pointer rounded border-2 border-red-400/60 bg-zinc-900 text-red-500 accent-red-500 focus:ring-2 focus:ring-red-400 focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
      </div>
    </div>
  );
}
