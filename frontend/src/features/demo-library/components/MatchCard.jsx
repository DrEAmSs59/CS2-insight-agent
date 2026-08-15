import React, { useState } from "react";
import { classifyDemoStatus } from "../../../utils/demoLibraryDisplay";
import {
  CirclePlay,
  FolderOpen,
  Clock,
  Trophy,
  Tag,
  MessageSquare,
  CheckCircle2,
  ExternalLink,
  Pencil,
  Save,
  Trash,
  Sparkles,
  Loader2,
} from "lucide-react";
import { useT } from "../../../i18n/useT.js";

/**
 * 格式化分钟数为 xx min
 */
function formatDuration(mins) {
  if (mins == null) return "-- min";
  return `${Math.round(mins)} min`;
}

const SOURCE_LOGOS = {
  "Faceit": { light: "/images/sources/faceit-black.png", dark: "/images/sources/faceit-white.png" },
  "5E": { light: "/images/sources/5eplay.png", dark: "/images/sources/5eplay.png" },
  "Perfect World": { light: "/images/sources/perfectworld-black.png", dark: "/images/sources/perfectworld-white.png" },
  "Matchmaking": { light: "/images/sources/valve-black.png", dark: "/images/sources/valve-white.png" },
  "ESL": { light: "/images/sources/esl-black.png", dark: "/images/sources/esl-white.png" },
  "ESEA": { light: "/images/sources/esea-black.png", dark: "/images/sources/esea-white.png" },
  "Blast": { light: "/images/sources/matchzy.png", dark: "/images/sources/matchzy.png" },
  "Local/Other": { light: "/images/sources/unknown.png", dark: "/images/sources/unknown.png" },
};

function SourceLogo({ source, className = "" }) {
  const logos = SOURCE_LOGOS[source] || SOURCE_LOGOS["Local/Other"];
  if (logos.light === logos.dark) {
    return <img src={logos.light} alt="" aria-hidden="true" className={className} />;
  }
  return (
    <>
      <img src={logos.light} alt="" aria-hidden="true" className={`${className} match-source-logo--light`} />
      <img src={logos.dark} alt="" aria-hidden="true" className={`${className} match-source-logo--dark`} />
    </>
  );
}

/**
 * 列表模式下的行展示
 */
export function MatchListRow({
  demo,
  isSelected,
  onSelect,
  onPlay,
  onOpenFile,
  onDelete,
  onUpdateRemark,
  onLoad,
  isLoading = false,
  loadDisabled = false,
  expectedPlayers = [],
}) {
  const t = useT();
  const [isEditingRemark, setIsEditingRemark] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState(demo.remark || "");

  React.useEffect(() => {
    setRemarkDraft(demo.remark || "");
  }, [demo.remark]);

  const handleSaveRemark = () => {
    onUpdateRemark?.(demo.id, remarkDraft);
    setIsEditingRemark(false);
  };

  const result = demo.result || {};
  const matchMeta = result.match_meta || {
    map_name: demo.map_name,
    team_a_score: demo.team_a_score,
    team_b_score: demo.team_b_score,
    team_a_name: demo.team_a_name,
    team_b_name: demo.team_b_name,
    total_rounds: demo.total_rounds,
    duration_mins: demo.duration_mins,
    match_date: demo.match_date,
  };

  const mapName = matchMeta.map_name || "unknown";
  const players = demo.players || [];
  const teamA = players.filter(p => p.team_number === 2 || p.team === 2 || p.team === "TERRORIST");
  const teamB = players.filter(p => p.team_number === 3 || p.team === 3 || p.team === "CT");

  const isHighlighted = (name) => {
    if (!name) return false;
    const n = name.toLowerCase();
    return expectedPlayers.some(p => p.toLowerCase() === n || n.includes(p.toLowerCase()));
  };
  const isAnalyzedPlayer = (name) =>
    !!result.players?.[name] ||
    (Array.isArray(demo.analyzed_targets) && demo.analyzed_targets.includes(name)) ||
    demo.primary_target === name;

  const listStatus = classifyDemoStatus(demo);
  const listStatusLabel = t(listStatus.labelKey, listStatus.labelParams);
  const listStatusTooltip = listStatus.tooltipKey
    ? t(listStatus.tooltipKey, listStatus.tooltipParams)
    : listStatus.tooltip;
  const listStatusDot =
    listStatus.kind === "done"
      ? "bg-cs2-highlight"
      : listStatus.kind === "error"
        ? "bg-cs2-fail"
        : listStatus.kind === "parsing"
          ? "bg-cs2-accent"
          : listStatus.kind === "pending"
            ? "bg-cs2-amber-on-surface"
            : listStatus.kind === "loaded"
              ? "bg-cs2-cyan-on-surface"
              : "bg-cs2-text-muted";
  const listStatusText =
    listStatus.kind === "done"
      ? "text-cs2-emerald-on-surface"
      : listStatus.kind === "error"
        ? "text-cs2-red-on-surface"
        : listStatus.kind === "parsing"
          ? "text-cs2-accent"
          : listStatus.kind === "pending"
            ? "text-cs2-amber-on-surface"
            : listStatus.kind === "loaded"
              ? "text-cs2-cyan-on-surface"
              : "text-cs2-text-secondary";

  return (
    <div
      className={`match-list-row group relative flex min-w-0 items-center gap-4 rounded-lg border px-4 py-2 transition-all ${loadDisabled ? 'cursor-wait' : 'cursor-pointer'} ${isSelected ? 'border-cs2-accent bg-cs2-accent/5 shadow-md shadow-cs2-accent/5' : 'border-cs2-border bg-cs2-bg-card/40 hover:border-cs2-border'}`}
      onClick={() => !loadDisabled && onLoad?.(demo.id)}
      aria-busy={isLoading}
    >
      {isLoading ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-lg bg-cs2-bg-card/90 text-[11px] font-bold text-cs2-accent backdrop-blur-[1px]" onClick={(event) => event.stopPropagation()}>
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("app.libraryLoadingDemo")}
        </div>
      ) : null}
      {/* 1. 勾选 */}
      <div onClick={e => e.stopPropagation()} className="shrink-0">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => onSelect(demo.id, e.target.checked)}
          className="h-4 w-4 rounded border-white/40 bg-cs2-bg-input/70 text-cs2-accent focus:ring-offset-0"
        />
      </div>

      {/* 2. 地图与来源 */}
      <div className="match-list-row__map flex min-w-0 items-center gap-3 w-[180px] shrink-0">
        <div className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-cs2-bg-input/70 border border-cs2-border relative">
          <img
            src={`/images/maps/${mapName}.webp`}
            alt={mapName}
            className="h-full w-full object-cover opacity-60"
            onError={(e) => { e.target.src = "/images/maps/thumbnail_unknown.webp"; }}
          />
          <span className="absolute text-[10px] font-black text-cs2-text-primary uppercase italic tracking-tighter drop-shadow-md">
            {mapName.replace('de_', '').replace('cs_', '').slice(0, 3)}
          </span>
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-black text-cs2-text-primary uppercase truncate tracking-tight">
            {mapName.replace('de_', '').replace('cs_', '')}
          </span>
          <div className="flex items-center gap-1 opacity-60">
            <SourceLogo source={demo.source} className="h-2.5 object-contain" />
            <span className="text-[9px] font-bold uppercase truncate">{demo.source || "Local"}</span>
          </div>
        </div>
      </div>

      {/* 3. 核心：Team A + Score + Team B */}
      <div className="match-list-row__teams flex min-w-0 flex-1 items-center justify-between gap-6 px-4">
        {/* Team A & Players */}
        <div className="match-list-row__team flex min-w-0 flex-1 flex-col items-end">
          <span className="text-xs font-black text-cs2-text-secondary truncate w-full text-right mb-0.5">
            {matchMeta.team_a_name || t("match.teamA")}
          </span>
          <div className="flex flex-wrap justify-end gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-cs2-text-muted">
            {teamA.slice(0, 5).map((p, i) => (
              <span key={i} className={`flex max-w-full min-w-0 items-center gap-0.5 [overflow-wrap:anywhere] ${isHighlighted(p.name) ? "text-cs2-accent font-bold" : ""}`} title={p.name}>
                {p.name}{isAnalyzedPlayer(p.name) && <Sparkles className="h-2 w-2 shrink-0 text-cs2-accent animate-pulse" />}
              </span>
            ))}
          </div>
        </div>

        {/* Score */}
        <div className="match-list-row__score flex shrink-0 items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input/70 px-3 py-1">
           <span className="text-lg font-black text-cs2-accent tabular-nums">{matchMeta.team_a_score ?? 0}</span>
           <div className="h-3 w-[1px] bg-cs2-border" />
           <span className="text-lg font-black text-cs2-accent tabular-nums">{matchMeta.team_b_score ?? 0}</span>
        </div>

        {/* Team B & Players */}
        <div className="match-list-row__team flex min-w-0 flex-1 flex-col items-start">
          <span className="text-xs font-black text-cs2-text-secondary truncate w-full mb-0.5">
            {matchMeta.team_b_name || t("match.teamB")}
          </span>
          <div className="flex flex-wrap justify-start gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-cs2-text-muted">
            {teamB.slice(0, 5).map((p, i) => (
              <span key={i} className={`flex max-w-full min-w-0 items-center gap-0.5 [overflow-wrap:anywhere] ${isHighlighted(p.name) ? "text-cs2-accent font-bold" : ""}`} title={p.name}>
                {p.name}{isAnalyzedPlayer(p.name) && <Sparkles className="h-2 w-2 shrink-0 text-cs2-accent animate-pulse" />}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 4. 右侧动态区域：平时显示状态/时间，悬停显示操作 */}
      <div className="match-list-row__details relative ml-auto flex min-w-0 shrink-0 items-center justify-end">
        {/* 平时显示：状态 + 入库日期 + 时长 */}
        <div className="match-list-row__details-normal flex items-center gap-6 group-hover:hidden animate-in fade-in duration-200">
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${listStatusDot} ${
                  listStatus.kind === "pending" || listStatus.kind === "parsing" ? "animate-pulse" : ""
                }`}
              />
              <span className={`max-w-[9rem] truncate text-[10px] font-bold ${listStatusText}`} title={listStatusTooltip || listStatusLabel}>
                {listStatusLabel}
              </span>
            </div>
            <div className="text-[9px] font-bold text-cs2-text-muted font-mono">
              {demo.added_at ? new Date(demo.added_at).toLocaleDateString('zh-CN', { year: '2-digit', month: '2-digit', day: '2-digit' }) : ""}
            </div>
          </div>

          <div className="flex items-center gap-1 text-[11px] font-black text-cs2-text-secondary w-12 tabular-nums">
            <Clock className="h-3.5 w-3.5 opacity-40 text-cs2-accent" />
            {formatDuration(matchMeta.duration_mins).replace(' min', '')}
            <span className="text-[9px] opacity-40 ml-0.5 font-normal">M</span>
          </div>
        </div>

        {/* 悬停显示：操作按钮 */}
        <div className="match-list-row__details-actions hidden items-center gap-1 group-hover:flex animate-in fade-in duration-200" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => !loadDisabled && onLoad?.(demo.id)}
            disabled={loadDisabled}
            className="p-2 text-cs2-accent hover:bg-cs2-accent/10 rounded-md transition-colors"
            title={t("library.batchLoad")}
            aria-label={t("library.batchLoad")}
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          <button
            onClick={() => setIsEditingRemark(!isEditingRemark)}
            className={`p-2 rounded-md transition-colors ${demo.remark ? 'text-cs2-accent' : 'text-cs2-text-muted'} hover:bg-cs2-bg-input/50`}
            title={t("match.btnRemark")}
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button onClick={() => onPlay(demo.id)} className="p-2 text-cs2-emerald-on-surface hover:bg-cs2-emerald-surface rounded-md transition-colors" title={t("match.btnPlayCs2")}>
            <CirclePlay className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <button onClick={() => onOpenFile(demo.id)} className="p-2 text-cs2-cyan-on-surface hover:bg-cs2-cyan-surface rounded-md transition-colors" title={t("match.btnLocate")}>
            <FolderOpen className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <button onClick={() => onDelete(demo.id, demo.filename)} className="p-2 text-cs2-red-on-surface hover:bg-cs2-red-surface rounded-md transition-colors" title={t("match.btnDelete")}>
            <Trash className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {/* 6. 展开备注编辑区 */}
      {isEditingRemark && (
        <div
          className="absolute top-full left-0 right-0 z-10 mt-1 rounded-lg border border-cs2-border bg-cs2-bg-card p-3 shadow-2xl animate-in fade-in zoom-in-95 duration-150"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={remarkDraft}
              onChange={(e) => setRemarkDraft(e.target.value)}
              className="w-full bg-cs2-bg-input/70 border border-cs2-border rounded-md p-2 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/40 resize-none"
              placeholder={t("match.remarkPlaceholder")}
              rows={2}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsEditingRemark(false)} className="text-[10px] text-cs2-text-muted hover:text-cs2-text-primary uppercase font-bold tracking-tighter">{t("match.remarkCancel")}</button>
              <button onClick={handleSaveRemark} className="flex items-center gap-1 rounded bg-cs2-accent px-3 py-1 text-[10px] font-black text-cs2-text-on-accent uppercase tracking-tighter shadow-lg shadow-cs2-accent/20">
                <Save className="h-3 w-3" /> {t("match.remarkSave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 网格/缩略图模式
 */
export default function MatchCard({
  demo,
  isSelected,
  onSelect,
  onPlay,
  onOpenFile,
  onDelete,
  onUpdateRemark,
  onLoad,
  isLoading = false,
  loadDisabled = false,
  expectedPlayers = [],
}) {
  const t = useT();
  const [isEditingRemark, setIsEditingRemark] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState(demo.remark || "");

  React.useEffect(() => {
    setRemarkDraft(demo.remark || "");
  }, [demo.remark]);

  const result = demo.result || {};
  const matchMeta = result.match_meta || {
    map_name: demo.map_name,
    team_a_score: demo.team_a_score,
    team_b_score: demo.team_b_score,
    team_a_name: demo.team_a_name,
    team_b_name: demo.team_b_name,
    total_rounds: demo.total_rounds,
    duration_mins: demo.duration_mins,
    match_date: demo.match_date,
  };

  const mapName = matchMeta.map_name || "unknown";
  const mapThumbnail = `/images/maps/${mapName}.webp`;
  const players = demo.players || [];
  const teamA = players.filter(p => p.team_number === 2 || p.team === 2 || p.team === "TERRORIST");
  const teamB = players.filter(p => p.team_number === 3 || p.team === 3 || p.team === "CT");

  const isHighlighted = (name) => {
    if (!name) return false;
    const n = name.toLowerCase();
    return expectedPlayers.some(p => p.toLowerCase() === n || n.includes(p.toLowerCase()));
  };
  const isAnalyzedPlayer = (name) =>
    !!result.players?.[name] ||
    (Array.isArray(demo.analyzed_targets) && demo.analyzed_targets.includes(name)) ||
    demo.primary_target === name;

  const getKillTags = () => {
    if (!result.clips) {
      const tags = [];
      const k4 = Number(demo.four_k_count) || 0;
      const k5 = Number(demo.five_k_count) || 0;
      if (k4 > 0) tags.push({ label: `4K x ${k4}`, color: "bg-cs2-accent/20 text-cs2-accent" });
      if (k5 > 0) tags.push({ label: `5K x ${k5}`, color: "bg-cs2-red-surface text-cs2-red-on-surface" });
      return tags;
    }
    const tags = [];
    let k4 = 0, k5 = 0;
    result.clips.forEach(c => {
      if (c.category === "highlight") {
        if (c.kill_count === 4) k4++;
        if (c.kill_count >= 5) k5++;
      }
    });
    if (k4 > 0) tags.push({ label: `4K x ${k4}`, color: "bg-cs2-accent/20 text-cs2-accent" });
    if (k5 > 0) tags.push({ label: `5K x ${k5}`, color: "bg-cs2-red-surface text-cs2-red-on-surface" });
    return tags;
  };

  const killTags = getKillTags();

  const gridStatus = classifyDemoStatus(demo);
  const gridStatusLabel = t(gridStatus.labelKey, gridStatus.labelParams);
  const gridStatusBadgeClass =
    {
      done: "bg-cs2-emerald-surface text-cs2-emerald-on-surface border-cs2-emerald-surface",
      error: "bg-cs2-red-surface text-cs2-red-on-surface border-cs2-red-surface",
      parsing: "bg-cs2-accent/10 text-cs2-accent border-cs2-accent/25",
      loaded: "bg-cs2-cyan-surface text-cs2-cyan-on-surface border-cs2-cyan-surface",
      pending: "bg-cs2-amber-surface text-cs2-amber-on-surface border-cs2-amber-surface",
      meta_missing: "bg-cs2-bg-input text-cs2-text-secondary border-cs2-border-subtle",
      unknown: "bg-cs2-bg-hover text-cs2-text-secondary border-cs2-border",
    }[gridStatus.kind] || "bg-cs2-bg-hover text-cs2-text-secondary border-cs2-border";

  const handleSaveRemark = () => {
    onUpdateRemark?.(demo.id, remarkDraft);
    setIsEditingRemark(false);
  };

  return (
    <div
      className={`match-card group relative flex min-w-0 flex-col overflow-hidden rounded-lg border transition-all ${loadDisabled ? 'cursor-wait' : 'cursor-pointer'} ${isSelected ? 'border-cs2-accent bg-cs2-accent/5 shadow-lg shadow-cs2-accent/5' : 'border-cs2-border bg-cs2-bg-card hover:border-cs2-border'}`}
      onClick={() => !loadDisabled && onLoad?.(demo.id)}
      aria-busy={isLoading}
    >
      {isLoading ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-cs2-bg-card/90 text-[11px] font-bold text-cs2-accent backdrop-blur-[1px]" onClick={(event) => event.stopPropagation()}>
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("app.libraryLoadingDemo")}
        </div>
      ) : null}
      {/* 顶部：地图缩略图背景（图绝对定位，文案叠在上层；比分绝对居中） */}
      <div className="match-card__hero relative h-[70px] w-full overflow-hidden">
        <img
          src={mapThumbnail}
          alt={mapName}
          className="match-card__hero-image absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
          onError={(e) => { e.target.src = "/images/maps/thumbnail_unknown.webp"; }}
        />
        <div className="match-card__hero-shade absolute inset-0" />

        {/* 顶部悬浮信息 */}
        <div className="match-card__hero-content absolute inset-0 z-[1] flex min-w-0 flex-col justify-center px-2 py-0.5">
          <div className="match-card__hero-main relative flex min-w-0 items-center">
            <div className="match-card__hero-meta flex min-w-0 items-center gap-2" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={(e) => onSelect(demo.id, e.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-white/40 bg-cs2-bg-input/70 text-cs2-accent focus:ring-offset-0"
              />
              <span className="min-w-0 truncate text-lg font-black text-cs2-text-primary uppercase italic tracking-tighter drop-shadow-md pr-[0.28em]">
                {mapName.replace('de_', '').replace('cs_', '')}
              </span>
            </div>

            {/* 比分：相对整张卡片水平居中，不受左右内容宽度影响 */}
            <div className="match-card__score pointer-events-none absolute left-1/2 z-[1] grid grid-cols-[minmax(0,1fr)_min-content_minmax(0,1fr)] items-center -translate-x-1/2">
              <span className="text-right text-xl font-black text-cs2-accent tabular-nums drop-shadow-md">
                {matchMeta.team_a_score ?? 0}
              </span>
              <Trophy className="h-5 w-5 mx-1.5 text-yellow-400 drop-shadow" />
              <span className="text-left text-xl font-black text-cs2-accent tabular-nums drop-shadow-md">
                {matchMeta.team_b_score ?? 0}
              </span>
            </div>

          </div>

          {/* 底部行：来源 / 时长 / 日期 */}
          <div className="match-card__source-row relative flex min-w-0 items-center justify-between text-[10px] font-bold text-cs2-text-primary/80 drop-shadow-md">
            <div className="flex items-center gap-1.5">
              <SourceLogo source={demo.source} className="match-card__source-logo h-3 object-contain" />
              <span className="uppercase">{demo.source || "Local"}</span>
            </div>
            <div className="match-card__clock absolute left-1/2 flex items-center gap-1 -translate-x-1/2">
              <Clock className="h-3 w-3" />
              {formatDuration(matchMeta.duration_mins)}
            </div>
            <div className="opacity-80 tabular-nums">
              {demo.added_at ? new Date(demo.added_at).toLocaleDateString('zh-CN', { year: '2-digit', month: '2-digit', day: '2-digit' }) : ""}
            </div>
          </div>

          <div className="match-card__actions absolute bottom-2.5 right-2 top-2.5 z-[2] flex items-center gap-1 rounded-lg border border-cs2-border bg-cs2-bg-elevated p-2 opacity-0 shadow-sm transition-opacity group-hover:opacity-100" onClick={e => e.stopPropagation()}>
            <button aria-label={t("match.btnPlayCs2")} onClick={() => onPlay(demo.id)} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-cs2-emerald-on-surface transition-colors hover:bg-cs2-emerald-surface" title={t("match.btnPlayCs2")}><CirclePlay className="h-[18px] w-[18px]" strokeWidth={1.8} /></button>
            <button aria-label={t("match.btnLocate")} onClick={() => onOpenFile(demo.id)} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-cs2-cyan-on-surface transition-colors hover:bg-cs2-cyan-surface" title={t("match.btnLocate")}><FolderOpen className="h-[18px] w-[18px]" strokeWidth={1.8} /></button>
            <button aria-label={t("match.btnDelete")} onClick={() => onDelete(demo.id, demo.filename)} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-cs2-red-on-surface transition-colors hover:bg-cs2-red-surface" title={t("match.btnDelete")}><Trash className="h-[18px] w-[18px]" strokeWidth={1.8} /></button>
          </div>
        </div>
      </div>

      {/* 中部：队伍与成员 */}
      <div className="grid grid-cols-2 border-y border-cs2-border bg-cs2-bg-input/30 group/roster w-full transition-colors hover:bg-cs2-bg-hover">
        <div className="relative border-r border-cs2-border px-3 py-1">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-cs2-text-muted">{matchMeta.team_a_name || t("match.teamA")}</div>
          <div className="flex min-h-[70px] flex-col gap-0.5">
            {teamA.length > 0 ? teamA.slice(0, 5).map((p, i) => (
              <span key={i} className={`relative flex min-w-0 items-start gap-0.5 text-[10px] leading-[13px] ${isHighlighted(p.name) ? 'font-bold text-cs2-accent underline underline-offset-2' : 'text-cs2-text-secondary'}`} title={p.name}>
                <span className="min-w-0 [overflow-wrap:anywhere]">{p.name}</span>
                {isAnalyzedPlayer(p.name) && <Sparkles className="mt-0.5 h-2 w-2 shrink-0 text-cs2-accent animate-pulse" />}
              </span>
            )) : <span className="text-[10px] text-cs2-text-muted italic">No roster</span>}
          </div>
        </div>
        <div className="px-3 py-1">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-cs2-text-muted">{matchMeta.team_b_name || t("match.teamB")}</div>
          <div className="flex min-h-[70px] flex-col gap-0.5">
            {teamB.length > 0 ? teamB.slice(0, 5).map((p, i) => (
              <span key={i} className={`relative flex min-w-0 items-start gap-0.5 text-[10px] leading-[13px] ${isHighlighted(p.name) ? 'font-bold text-cs2-accent underline underline-offset-2' : 'text-cs2-text-secondary'}`} title={p.name}>
                <span className="min-w-0 [overflow-wrap:anywhere]">{p.name}</span>
                {isAnalyzedPlayer(p.name) && <Sparkles className="mt-0.5 h-2 w-2 shrink-0 text-cs2-accent animate-pulse" />}
              </span>
            )) : <span className="text-[10px] text-cs2-text-muted italic">No roster</span>}
          </div>
        </div>
      </div>

      {/* 底部：Tags 与备注 */}
      <div className="flex flex-col p-2 px-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 overflow-hidden">
          <div className="flex flex-1 items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            <span
              className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-medium border ${gridStatusBadgeClass}`}
            >
              <CheckCircle2 className="h-2.5 w-2.5" />
              {gridStatusLabel}
            </span>
            {killTags.map((tag, i) => (
              <span key={i} className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase ${tag.color}`}>
                <Tag className="h-2.5 w-2.5" />
                {tag.label}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-2 flex items-stretch gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-input/70 p-1.5">
            <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-cs2-text-muted" />
            {isEditingRemark ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <textarea autoFocus value={remarkDraft} onChange={(e) => setRemarkDraft(e.target.value)} className="w-full bg-transparent p-0 text-[12px] text-cs2-text-primary outline-none placeholder:text-cs2-text-muted resize-none" placeholder={t("match.remarkPlaceholder")} rows={2} />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setIsEditingRemark(false)} className="text-[10px] text-cs2-text-muted hover:text-cs2-text-primary">{t("match.remarkCancel")}</button>
                  <button onClick={handleSaveRemark} className="flex items-center gap-1 rounded bg-cs2-accent px-2 py-0.5 text-[10px] font-bold text-cs2-text-on-accent"><Save className="h-2.5 w-2.5" /> {t("match.remarkSave")}</button>
                </div>
              </div>
            ) : (
              <div className="group/remark flex min-w-0 flex-1 cursor-pointer items-start justify-between gap-2" onClick={() => setIsEditingRemark(true)}>
                <p className={`truncate text-[12px] leading-relaxed ${demo.remark ? 'text-cs2-text-secondary' : 'text-cs2-text-muted italic'}`}>{demo.remark || t("match.remarkClickAdd")}</p>
                <Pencil className="h-2.5 w-2.5 shrink-0 text-cs2-text-muted opacity-0 group-hover/remark:opacity-100" />
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => !loadDisabled && onLoad?.(demo.id)}
            disabled={loadDisabled}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-cs2-accent/35 bg-cs2-accent/10 px-2.5 text-[11px] font-bold text-cs2-accent transition-colors hover:border-cs2-accent/60 hover:bg-cs2-accent/15"
            title={t("library.batchLoad")}
          >
            <ExternalLink className="h-3 w-3" />
            {t("library.batchLoad")}
          </button>
        </div>
      </div>
    </div>
  );
}
