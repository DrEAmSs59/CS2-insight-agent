import { useMemo, useState } from "react";
import {
  Package,
  X,
  Trash2,
  ChevronRight,
  Rocket,
  Settings,
  RotateCcw,
  Eye,
  EyeOff,
  OctagonX,
} from "lucide-react";
import { useRecordingQueue, BACKEND_DEFAULT_PACING } from "../stores/recordingQueueStore";

// 与后端 build_smart_jump_segments 保持一致
const DEFAULT_PACING = BACKEND_DEFAULT_PACING;

function groupByDemo(queue) {
  const map = new Map();
  for (const item of queue) {
    const key = item.demoFilename || item.demoPath || "unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return Array.from(map.entries());
}

function PacingMicroPanel({ item, expanded, onToggleExpand, updateItemPacing }) {
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const gp = globalPacing || {};
  const po = item.pacing_override || {};
  const gNum = (key) => {
    const v = gp[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const pre = po.pre_first_sec ?? gNum("pre_first_sec") ?? DEFAULT_PACING.pre_first_sec;
  const post = po.post_last_sec ?? gNum("post_last_sec") ?? DEFAULT_PACING.post_last_sec;
  const gap = po.max_gap_sec ?? gNum("max_gap_sec") ?? DEFAULT_PACING.max_gap_sec;
  const postMid = po.post_mid_sec ?? gNum("post_mid_sec") ?? DEFAULT_PACING.post_mid_sec;
  const preCont = po.pre_cont_sec ?? gNum("pre_cont_sec") ?? DEFAULT_PACING.pre_cont_sec;

  const commit = (partial) => {
    const next = { ...partial };
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (typeof v !== "number" || !Number.isFinite(v)) delete next[k];
    }
    if (Object.keys(next).length) updateItemPacing(item.id, next);
  };

  return (
    <div className="mt-2 border-t border-white/[0.06] pt-2">
      <button
        type="button"
        onClick={() => onToggleExpand(item.id)}
        className="flex w-full items-center justify-between rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[10px] font-semibold text-zinc-400 hover:border-cs2-orange/30 hover:text-cs2-orange"
      >
        <span className="flex items-center gap-1.5">
          <Settings className="h-3 w-3" />
          【⚙️ 微调】剪辑节奏
        </span>
        <span className="text-zinc-600">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded ? (
        <div className="mt-2 space-y-3 rounded border border-white/[0.06] bg-black/30 p-2">
          <div className="border-b border-white/[0.06] pb-2">
            <p className="mb-2 text-[9px] font-bold uppercase tracking-wider text-zinc-500">基础参数</p>
            <div className="space-y-3">
              <label className="block text-[10px] text-zinc-500">
                开场预留 (秒)
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={20}
                    step={0.1}
                    value={pre}
                    onChange={(e) => commit({ pre_first_sec: parseFloat(e.target.value) })}
                    className="min-w-0 flex-1 accent-cs2-orange"
                  />
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={pre}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) commit({ pre_first_sec: n });
                    }}
                    className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
                  />
                </div>
              </label>
              <label className="block text-[10px] text-zinc-500">
                结尾留白 (秒)
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.1}
                    value={post}
                    onChange={(e) => commit({ post_last_sec: parseFloat(e.target.value) })}
                    className="min-w-0 flex-1 accent-cs2-orange"
                  />
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={post}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) commit({ post_last_sec: n });
                    }}
                    className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
                  />
                </div>
              </label>
              <label className="block text-[10px] text-zinc-500">
                防跳剪阈值 (秒)
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={2}
                    max={70}
                    step={0.5}
                    value={gap}
                    onChange={(e) => commit({ max_gap_sec: parseFloat(e.target.value) })}
                    className="min-w-0 flex-1 accent-cs2-orange"
                  />
                  <input
                    type="number"
                    step={0.5}
                    min={0.5}
                    value={gap}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) commit({ max_gap_sec: n });
                    }}
                    className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
                  />
                </div>
              </label>
            </div>
          </div>

          <details className="group rounded border border-white/[0.08] bg-black/20 [&_summary::-webkit-details-marker]:hidden">
            <summary className="cursor-pointer list-none px-2 py-1.5 text-[10px] font-semibold text-zinc-400 transition-colors hover:text-cs2-orange">
              <span className="select-none">🔽 展开专业跳剪参数 (Pro)</span>
            </summary>
            <div className="space-y-3 border-t border-white/[0.06] px-2 pb-2 pt-2">
              <label
                className="block text-[10px] text-zinc-500"
                title="触发闪切前的保留时间(适合保留切刀)"
              >
                中间击杀后停顿 (秒)
                <p className="mt-0.5 text-[9px] font-normal leading-snug text-zinc-600">
                  触发闪切前的保留时间(适合保留切刀)
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.1}
                    value={postMid}
                    onChange={(e) => commit({ post_mid_sec: parseFloat(e.target.value) })}
                    className="min-w-0 flex-1 accent-cs2-orange"
                  />
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={postMid}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) commit({ post_mid_sec: n });
                    }}
                    className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
                  />
                </div>
              </label>
              <label
                className="block text-[10px] text-zinc-500"
                title="闪切后距离下次开枪的时间"
              >
                跳跃后切入缓冲 (秒)
                <p className="mt-0.5 text-[9px] font-normal leading-snug text-zinc-600">
                  闪切后距离下次开枪的时间
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.1}
                    value={preCont}
                    onChange={(e) => commit({ pre_cont_sec: parseFloat(e.target.value) })}
                    className="min-w-0 flex-1 accent-cs2-orange"
                  />
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={preCont}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) commit({ pre_cont_sec: n });
                    }}
                    className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
                  />
                </div>
              </label>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 追加 POV 段落开关面板，嵌入每个队列条目。
 * 高光片段 → 受害者视角；失误片段 → 击杀者视角。
 * 开关与独立时序参数均存入 item.pacing_override。
 */
function PovSection({ item, updateItemPacing }) {
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const gp = globalPacing || {};
  const po = item.pacing_override || {};
  const clipCategory = item.clipData?.category;
  const victimsList = item.clipData?.victims || [];
  const killersList = item.clipData?.killers || [];
  const killerName = item.clipData?.killer_name;

  const isHighlight = clipCategory === "highlight" && victimsList.length > 0;
  const isFail = clipCategory === "fail" && Boolean(killerName);
  const isCompilation = clipCategory === "compilation";
  const compilationKind = item.clipData?.compilation_kind;
  const isKillCompilation = isCompilation && ["rival_kills", "all_kills"].includes(compilationKind);
  const isDeathCompilation = isCompilation && ["nemesis_deaths", "all_deaths"].includes(compilationKind);
  const canVictimPov = (isHighlight || isKillCompilation) && victimsList.some((v) => String(v ?? "").trim());
  const canKillerPov = isFail || (isDeathCompilation && killersList.some((v) => String(v ?? "").trim()));

  if (!canVictimPov && !canKillerPov) return null;

  const gNum = (key) => {
    const v = gp[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };

  const povEnabled = Boolean(po.victim_pov);
  const killerPovEnabled = Boolean(po.killer_pov);
  const vicPre =
    po.victim_pov_pre_sec ?? gNum("victim_pov_pre_sec") ?? (isFail ? 3.0 : 1.5);
  const vicPost =
    po.victim_pov_post_sec ?? gNum("victim_pov_post_sec") ?? (isFail ? 1.5 : 1.0);
  const killPre = po.killer_pov_pre_sec ?? gNum("killer_pov_pre_sec") ?? vicPre;
  const killPost = po.killer_pov_post_sec ?? gNum("killer_pov_post_sec") ?? vicPost;

  const commit = (partial) => updateItemPacing(item.id, partial);

  return (
    <div className="mt-2 border-t border-white/[0.06] pt-2">
      <div className="grid gap-1.5">
        {canVictimPov && (
          <button
            type="button"
            onClick={() => commit({ victim_pov: !povEnabled })}
            className={`flex w-full items-center gap-1.5 rounded border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
              povEnabled
                ? "border-cyan-500/40 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-950/60"
                : "border-white/10 bg-white/[0.04] text-zinc-400 hover:border-cyan-500/30 hover:text-cyan-400"
            }`}
          >
            {povEnabled ? <Eye className="h-3 w-3 shrink-0" /> : <EyeOff className="h-3 w-3 shrink-0" />}
            <span>追加受害者视角</span>
            {povEnabled && (
              <span className="ml-auto font-mono text-[9px] text-cyan-400/70">
                -{vicPre.toFixed(1)}s / +{vicPost.toFixed(1)}s
              </span>
            )}
          </button>
        )}
        {canKillerPov && (
          <button
            type="button"
            onClick={() => commit({ killer_pov: !killerPovEnabled })}
            className={`flex w-full items-center gap-1.5 rounded border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
              killerPovEnabled
                ? "border-amber-500/40 bg-amber-950/35 text-amber-300 hover:bg-amber-950/55"
                : "border-white/10 bg-white/[0.04] text-zinc-400 hover:border-amber-500/30 hover:text-amber-300"
            }`}
          >
            {killerPovEnabled ? <Eye className="h-3 w-3 shrink-0" /> : <EyeOff className="h-3 w-3 shrink-0" />}
            <span>追加击杀者视角</span>
            {killerPovEnabled && (
              <span className="ml-auto font-mono text-[9px] text-amber-400/70">
                -{killPre.toFixed(1)}s / +{killPost.toFixed(1)}s
              </span>
            )}
          </button>
        )}
      </div>

      {povEnabled && canVictimPov && (
        <div className="mt-1.5 space-y-2 rounded border border-cyan-500/10 bg-cyan-950/10 p-2">
          <label className="block text-[10px] text-zinc-500">
            击杀前预留 (秒) · 受害者视角
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range"
                min={0.5}
                max={5}
                step={0.5}
                value={vicPre}
                onChange={(e) => commit({ victim_pov_pre_sec: parseFloat(e.target.value) })}
                className="min-w-0 flex-1 accent-cyan-500"
              />
              <input
                type="number"
                step={0.5}
                min={0.5}
                value={vicPre}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (Number.isFinite(n)) commit({ victim_pov_pre_sec: n });
                }}
                className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
              />
            </div>
          </label>
          <label className="block text-[10px] text-zinc-500">
            死亡后停留 (秒) · 受害者视角
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={5}
                step={0.5}
                value={vicPost}
                onChange={(e) => commit({ victim_pov_post_sec: parseFloat(e.target.value) })}
                className="min-w-0 flex-1 accent-cyan-500"
              />
              <input
                type="number"
                step={0.5}
                min={0}
                value={vicPost}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (Number.isFinite(n)) commit({ victim_pov_post_sec: n });
                }}
                className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
              />
            </div>
          </label>
        </div>
      )}

      {killerPovEnabled && canKillerPov && (
        <div className="mt-1.5 space-y-2 rounded border border-amber-500/15 bg-amber-950/10 p-2">
          <label className="block text-[10px] text-zinc-500">
            击杀前预留 (秒) · 击杀者视角
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range"
                min={0.5}
                max={5}
                step={0.5}
                value={killPre}
                onChange={(e) => commit({ killer_pov_pre_sec: parseFloat(e.target.value) })}
                className="min-w-0 flex-1 accent-amber-500"
              />
              <input
                type="number"
                step={0.5}
                min={0.5}
                value={killPre}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (Number.isFinite(n)) commit({ killer_pov_pre_sec: n });
                }}
                className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
              />
            </div>
          </label>
          <label className="block text-[10px] text-zinc-500">
            死亡后停留 (秒) · 击杀者视角
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={5}
                step={0.5}
                value={killPost}
                onChange={(e) => commit({ killer_pov_post_sec: parseFloat(e.target.value) })}
                className="min-w-0 flex-1 accent-amber-500"
              />
              <input
                type="number"
                step={0.5}
                min={0}
                value={killPost}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (Number.isFinite(n)) commit({ killer_pov_post_sec: n });
                }}
                className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
              />
            </div>
          </label>
        </div>
      )}
    </div>
  );
}

function countVictimPovEligibleHighlights(queue) {
  return queue.filter((q) => {
    const victims = Array.isArray(q.clipData?.victims) ? q.clipData.victims : [];
    const kind = q.clipData?.compilation_kind;
    return (
      (q.clipData?.category === "highlight" ||
        (q.clipData?.category === "compilation" && ["rival_kills", "all_kills"].includes(kind))) &&
      victims.some((v) => String(v ?? "").trim().length > 0)
    );
  }).length;
}

function countKillerPovEligible(queue) {
  return queue.filter((q) => {
    const killers = Array.isArray(q.clipData?.killers) ? q.clipData.killers : [];
    const kind = q.clipData?.compilation_kind;
    return (
      (q.clipData?.category === "compilation" &&
        ["nemesis_deaths", "all_deaths"].includes(kind) &&
        killers.some((v) => String(v ?? "").trim().length > 0)) ||
      (q.clipData?.category === "fail" && String(q.clipData?.killer_name ?? "").trim().length > 0)
    );
  }).length;
}

/** 符合条件的高光是否已全部打开「受害者视角」 */
function allEligibleVictimPovEnabled(queue) {
  const eligible = queue.filter((q) => {
    const victims = Array.isArray(q.clipData?.victims) ? q.clipData.victims : [];
    const kind = q.clipData?.compilation_kind;
    return (
      (q.clipData?.category === "highlight" ||
        (q.clipData?.category === "compilation" && ["rival_kills", "all_kills"].includes(kind))) &&
      victims.some((v) => String(v ?? "").trim().length > 0)
    );
  });
  if (eligible.length === 0) return false;
  return eligible.every((q) => Boolean(q.pacing_override?.victim_pov));
}

function allEligibleKillerPovEnabled(queue) {
  const eligible = queue.filter((q) => {
    const killers = Array.isArray(q.clipData?.killers) ? q.clipData.killers : [];
    const kind = q.clipData?.compilation_kind;
    return (
      (q.clipData?.category === "compilation" &&
        ["nemesis_deaths", "all_deaths"].includes(kind) &&
        killers.some((v) => String(v ?? "").trim().length > 0)) ||
      (q.clipData?.category === "fail" && String(q.clipData?.killer_name ?? "").trim().length > 0)
    );
  });
  if (eligible.length === 0) return false;
  return eligible.every((q) => Boolean(q.pacing_override?.killer_pov));
}

/** 全局节奏设置面板（折叠式） */
function GlobalPacingPanel({ globalPacing, setGlobalPacing, resetGlobalPacing, queue, onToggleAllVictimPov, onToggleAllKillerPov }) {
  const [open, setOpen] = useState(false);
  const post = globalPacing.post_last_sec ?? DEFAULT_PACING.post_last_sec;
  const pre  = globalPacing.pre_first_sec ?? DEFAULT_PACING.pre_first_sec;
  const gap  = globalPacing.max_gap_sec   ?? DEFAULT_PACING.max_gap_sec;
  const victimPovEligible = useMemo(() => countVictimPovEligibleHighlights(queue), [queue]);
  const allVictimPovOn = useMemo(() => allEligibleVictimPovEnabled(queue), [queue]);
  const killerPovEligible = useMemo(() => countKillerPovEligible(queue), [queue]);
  const allKillerPovOn = useMemo(() => allEligibleKillerPovEnabled(queue), [queue]);

  const commit = (partial) => {
    const next = Object.fromEntries(
      Object.entries(partial).filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    );
    if (Object.keys(next).length) setGlobalPacing(next);
  };

  return (
    <div className="border-b border-white/[0.06] bg-black/20 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-[10px] font-semibold text-zinc-400 hover:text-cs2-orange"
      >
        <span className="flex items-center gap-1.5">
          <Settings className="h-3 w-3" />
          全局节奏设置
          <span className="text-zinc-600">（对所有片段生效，单独设置优先）</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-cs2-orange">结尾 {post.toFixed(1)}s</span>
          <span className="text-zinc-600">{open ? "▲" : "▼"}</span>
        </span>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={victimPovEligible === 0}
          title={
            victimPovEligible === 0
              ? "队列中暂无带受害者名单的高光片段"
              : allVictimPovOn
                ? `关闭 ${victimPovEligible} 条高光片段的「追加受害者视角」`
                : `为 ${victimPovEligible} 条高光片段打开「追加受害者视角」`
          }
          onClick={onToggleAllVictimPov}
          className={
            allVictimPovOn
              ? "inline-flex items-center gap-1.5 rounded border border-zinc-500/40 bg-zinc-900/40 px-2.5 py-1.5 text-[10px] font-semibold text-zinc-200 transition-colors hover:border-zinc-400/55 hover:bg-zinc-900/60 disabled:cursor-not-allowed disabled:opacity-40"
              : "inline-flex items-center gap-1.5 rounded border border-cyan-500/35 bg-cyan-950/30 px-2.5 py-1.5 text-[10px] font-semibold text-cyan-200 transition-colors hover:border-cyan-400/60 hover:bg-cyan-950/50 disabled:cursor-not-allowed disabled:opacity-40"
          }
        >
          {allVictimPovOn ? (
            <EyeOff className="h-3 w-3 shrink-0" />
          ) : (
            <Eye className="h-3 w-3 shrink-0" />
          )}
          {allVictimPovOn ? "一键取消受害者视角" : "一键开启受害者视角"}
          {victimPovEligible > 0 ? (
            <span
              className={
                allVictimPovOn
                  ? "font-mono text-[9px] text-zinc-400/90"
                  : "font-mono text-[9px] text-cyan-400/80"
              }
            >
              ({victimPovEligible})
            </span>
          ) : null}
        </button>
        <button
          type="button"
          disabled={killerPovEligible === 0}
          title={
            killerPovEligible === 0
              ? "队列中暂无可追加击杀者视角的片段"
              : allKillerPovOn
                ? `关闭 ${killerPovEligible} 条片段的「追加击杀者视角」`
                : `为 ${killerPovEligible} 条片段打开「追加击杀者视角」`
          }
          onClick={onToggleAllKillerPov}
          className={
            allKillerPovOn
              ? "inline-flex items-center gap-1.5 rounded border border-zinc-500/40 bg-zinc-900/40 px-2.5 py-1.5 text-[10px] font-semibold text-zinc-200 transition-colors hover:border-zinc-400/55 hover:bg-zinc-900/60 disabled:cursor-not-allowed disabled:opacity-40"
              : "inline-flex items-center gap-1.5 rounded border border-amber-500/35 bg-amber-950/25 px-2.5 py-1.5 text-[10px] font-semibold text-amber-200 transition-colors hover:border-amber-400/60 hover:bg-amber-950/45 disabled:cursor-not-allowed disabled:opacity-40"
          }
        >
          {allKillerPovOn ? (
            <EyeOff className="h-3 w-3 shrink-0" />
          ) : (
            <Eye className="h-3 w-3 shrink-0" />
          )}
          {allKillerPovOn ? "一键取消击杀者视角" : "一键开启击杀者视角"}
          {killerPovEligible > 0 ? (
            <span
              className={
                allKillerPovOn
                  ? "font-mono text-[9px] text-zinc-400/90"
                  : "font-mono text-[9px] text-amber-300/80"
              }
            >
              ({killerPovEligible})
            </span>
          ) : null}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2 rounded border border-white/[0.06] bg-black/30 p-2">
          {/* 结尾留白 */}
          <label className="block text-[10px] text-zinc-500">
            结尾留白 (秒)
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range" min={0} max={10} step={0.1} value={post}
                onChange={(e) => commit({ post_last_sec: parseFloat(e.target.value) })}
                className="min-w-0 flex-1 accent-cs2-orange"
              />
              <input
                type="number" step={0.1} min={0} value={post}
                onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) commit({ post_last_sec: n }); }}
                className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
              />
            </div>
          </label>
          {/* 开场预留 */}
          <label className="block text-[10px] text-zinc-500">
            开场预留 (秒)
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range" min={0} max={20} step={0.1} value={pre}
                onChange={(e) => commit({ pre_first_sec: parseFloat(e.target.value) })}
                className="min-w-0 flex-1 accent-cs2-orange"
              />
              <input
                type="number" step={0.1} min={0} value={pre}
                onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) commit({ pre_first_sec: n }); }}
                className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
              />
            </div>
          </label>
          {/* 防跳剪阈值 */}
          <label className="block text-[10px] text-zinc-500">
            防跳剪阈值 (秒)
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range" min={2} max={30} step={0.5} value={gap}
                onChange={(e) => commit({ max_gap_sec: parseFloat(e.target.value) })}
                className="min-w-0 flex-1 accent-cs2-orange"
              />
              <input
                type="number" step={0.5} min={0.5} value={gap}
                onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) commit({ max_gap_sec: n }); }}
                className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
              />
            </div>
          </label>
          <button
            type="button"
            onClick={resetGlobalPacing}
            className="flex items-center gap-1 text-[9px] text-zinc-600 hover:text-zinc-400"
          >
            <RotateCcw className="h-2.5 w-2.5" /> 恢复后端默认值
          </button>
        </div>
      )}
    </div>
  );
}

export default function RecordingQueueDrawer({
  open,
  onClose,
  queue,
  onRemove,
  onClear,
  onStartBatch,
  batchRecording,
  onAbortBatch,
}) {
  const grouped = useMemo(() => groupByDemo(queue), [queue]);
  const [pacingExpandedId, setPacingExpandedId] = useState(null);
  const updateItemPacing  = useRecordingQueue((s) => s.updateItemPacing);
  const globalPacing      = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing   = useRecordingQueue((s) => s.setGlobalPacing);
  const resetGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);
  const toggleVictimPovForAllHighlightsInQueue = useRecordingQueue((s) => s.toggleVictimPovForAllHighlightsInQueue);
  const toggleKillerPovForAllEligibleInQueue = useRecordingQueue((s) => s.toggleKillerPovForAllEligibleInQueue);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-black/50 backdrop-blur-[2px]" role="presentation">
      <button
        type="button"
        className="h-full min-w-0 flex-1 cursor-default"
        aria-label="关闭抽屉背景"
        onClick={onClose}
      />
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-cs2-bg-sidebar shadow-2xl"
        role="dialog"
        aria-labelledby="queue-drawer-title"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 id="queue-drawer-title" className="flex items-center gap-2 text-sm font-bold text-white">
            <Package className="h-4 w-4 text-cs2-orange" />
            待录制队列
            <span className="rounded bg-cs2-orange/20 px-2 py-0.5 font-mono text-xs text-cs2-orange">
              {queue.length}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 全局节奏设置 */}
        <GlobalPacingPanel
          globalPacing={globalPacing}
          setGlobalPacing={setGlobalPacing}
          resetGlobalPacing={resetGlobalPacing}
          queue={queue}
          onToggleAllVictimPov={toggleVictimPovForAllHighlightsInQueue}
          onToggleAllKillerPov={toggleKillerPovForAllEligibleInQueue}
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {queue.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-zinc-500">
              暂无片段。在片段列表中勾选后点击「加入录制队列」。
            </p>
          ) : (
            <div className="space-y-4">
              {grouped.map(([demoKey, items]) => (
                <div
                  key={demoKey}
                  className="overflow-hidden rounded-lg border border-white/[0.06] bg-black/25"
                >
                  <div className="border-b border-white/[0.06] bg-white/[0.03] px-3 py-2">
                    <p className="truncate font-mono text-[11px] font-semibold text-cs2-orange/90" title={demoKey}>
                      {demoKey}
                    </p>
                    <p className="text-[10px] text-zinc-500">{items.length} 个片段</p>
                  </div>
                  <ul className="divide-y divide-white/[0.04]">
                    {items.map((it) => (
                      <li
                        key={it.id}
                        className="flex items-start gap-2 px-3 py-2 text-[11px] text-zinc-300"
                      >
                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="font-mono text-cs2-text-secondary">{it.clipId}</span>
                            {it.clipData?.category && (
                              <span className="rounded border border-white/10 px-1 py-0 text-[10px] text-zinc-500">
                                {({
                                  highlight: "高光",
                                  fail: "下饭",
                                  meme_death: "坐牢集锦",
                                  compilation: "合集",
                                }[it.clipData.category]) || it.clipData.category}
                              </span>
                            )}
                            {it.clipData?.round != null &&
                              it.clipData?.score_own != null &&
                              it.clipData?.score_opp != null && (
                                <span
                                  className="font-mono text-[10px] tabular-nums text-zinc-500"
                                  title="本回合开局时比分（目标方 : 对方）"
                                >
                                  第 {it.clipData.round} 回合 · {it.clipData.score_own}:{it.clipData.score_opp}
                                </span>
                              )}
                          </div>
                          {(it.targetPlayer || "").trim() ? (
                            <p className="mt-1 text-[10px] text-zinc-400">
                              玩家{" "}
                              <span className="font-semibold text-zinc-200">{String(it.targetPlayer).trim()}</span>
                            </p>
                          ) : null}
                          {it.clipData?.context_tags?.length > 0 && (
                            <p className="mt-0.5 truncate text-[10px] text-zinc-600">
                              {it.clipData.context_tags.join(" · ")}
                            </p>
                          )}
                          <PacingMicroPanel
                            item={it}
                            expanded={pacingExpandedId === it.id}
                            updateItemPacing={updateItemPacing}
                            onToggleExpand={(id) =>
                              setPacingExpandedId((cur) => {
                                if (cur === id) return null;
                                return id;
                              })
                            }
                          />
                          <PovSection item={it} updateItemPacing={updateItemPacing} />
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemove(it.id)}
                          className="shrink-0 rounded p-1 text-zinc-600 hover:bg-red-500/10 hover:text-red-400"
                          aria-label="从队列移除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-white/10 bg-black/20 p-4 space-y-2">
          {queue.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="w-full rounded-md border border-cs2-border py-2 text-xs font-semibold text-zinc-400 hover:border-red-500/40 hover:text-red-300"
            >
              清空队列
            </button>
          )}
          <button
            type="button"
            disabled={queue.length === 0 || batchRecording}
            onClick={onStartBatch}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-cs2-orange py-3.5 text-sm font-extrabold uppercase tracking-widest text-black shadow-lg shadow-cs2-orange/25 transition-all hover:bg-cs2-orange-light disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Rocket className="h-4 w-4" />
            开始批量录制
          </button>
          {batchRecording && typeof onAbortBatch === "function" ? (
            <button
              type="button"
              onClick={() => void onAbortBatch()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 py-3 text-sm font-bold text-red-300 transition-all hover:border-red-400 hover:bg-red-500/20"
            >
              <OctagonX className="h-4 w-4 shrink-0" />
              中止录制
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
