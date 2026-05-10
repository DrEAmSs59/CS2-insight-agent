import React, { useState } from "react";
import { classifyDemoStatus } from "../utils/demoLibraryDisplay";
import {
  Play,
  FolderSearch,
  Clock,
  Map as MapIcon,
  Trophy,
  User,
  Users,
  Tag,
  MessageSquare,
  CheckCircle2,
  ExternalLink,
  Pencil,
  Save,
  X,
  Trash2,
  Info,
  Sparkles,
} from "lucide-react";

/**
 * 格式化分钟数为 xx min
 */
function formatDuration(mins) {
  if (mins == null) return "-- min";
  return `${Math.round(mins)} min`;
}

const SOURCE_LOGOS = {
  "Faceit": "/images/sources/faceit-white.png",
  "5E": "/images/sources/5eplay.png",
  "Perfect World": "/images/sources/perfectworld-white.png",
  "Matchmaking": "/images/sources/valve-white.png",
  "ESL": "/images/sources/esl-white.png",
  "ESEA": "/images/sources/esea-white.png",
  "Blast": "/images/sources/matchzy.png",
  "Local/Other": "/images/sources/unknown.png",
};

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
  onOpenInfo,
  expectedPlayers = [],
}) {
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
  const sourceLogo = SOURCE_LOGOS[demo.source] || SOURCE_LOGOS["Local/Other"];
  const players = demo.players || [];
  const teamA = players.filter(p => p.team_number === 2 || p.team === 2 || p.team === "TERRORIST");
  const teamB = players.filter(p => p.team_number === 3 || p.team === 3 || p.team === "CT");

  const isHighlighted = (name) => {
    if (!name) return false;
    const n = name.toLowerCase();
    return expectedPlayers.some(p => p.toLowerCase() === n || n.includes(p.toLowerCase()));
  };

  const listStatus = classifyDemoStatus(demo);
  const listStatusDot =
    listStatus.kind === "done"
      ? "bg-emerald-500 shadow-[0_0_5px_#10b981]"
      : listStatus.kind === "error"
        ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.35)]"
        : listStatus.kind === "parsing"
          ? "bg-cs2-orange"
          : listStatus.kind === "pending"
            ? "bg-amber-500"
            : listStatus.kind === "loaded"
              ? "bg-sky-500"
              : "bg-zinc-500";
  const listStatusText =
    listStatus.kind === "done"
      ? "text-emerald-400"
      : listStatus.kind === "error"
        ? "text-red-400"
        : listStatus.kind === "parsing"
          ? "text-cs2-orange"
          : listStatus.kind === "pending"
            ? "text-amber-200"
            : listStatus.kind === "loaded"
              ? "text-sky-300"
              : "text-zinc-400";

  return (
    <div 
      className={`group relative flex items-center gap-4 rounded-lg border px-4 py-2 transition-all cursor-pointer ${isSelected ? 'border-cs2-orange bg-cs2-orange/5 shadow-md shadow-cs2-orange/5' : 'border-white/5 bg-cs2-bg-card/40 hover:border-white/20'}`}
      onClick={() => onOpenInfo?.(demo.id)}
    >
      {/* 1. 勾选 */}
      <div onClick={e => e.stopPropagation()} className="shrink-0">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => onSelect(demo.id, e.target.checked)}
          className="h-4 w-4 rounded border-white/40 bg-black/40 text-cs2-orange focus:ring-offset-0"
        />
      </div>

      {/* 2. 地图与来源 */}
      <div className="flex items-center gap-3 w-[180px] shrink-0">
        <div className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-black/40 border border-white/5 relative">
          <img 
            src={`/images/maps/${mapName}.png`}
            alt={mapName}
            className="h-full w-full object-cover opacity-60"
            onError={(e) => { e.target.src = "/images/maps/thumbnail_unknown.png"; }}
          />
          <span className="absolute text-[10px] font-black text-white uppercase italic tracking-tighter drop-shadow-md">
            {mapName.replace('de_', '').replace('cs_', '').slice(0, 3)}
          </span>
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-black text-white uppercase truncate tracking-tight">
            {mapName.replace('de_', '').replace('cs_', '')}
          </span>
          <div className="flex items-center gap-1 opacity-60">
            <img src={sourceLogo} alt={demo.source} className="h-2.5 object-contain" />
            <span className="text-[9px] font-bold uppercase truncate">{demo.source || "Local"}</span>
          </div>
        </div>
      </div>

      {/* 3. 核心：Team A + Score + Team B */}
      <div className="flex min-w-0 flex-1 items-center justify-between gap-6 px-4">
        {/* Team A & Players */}
        <div className="flex-1 flex flex-col items-end min-w-0">
          <span className="text-xs font-black text-zinc-300 truncate w-full text-right mb-0.5">
            {matchMeta.team_a_name || "Team A"}
          </span>
          <div className="flex flex-wrap justify-end gap-x-1.5 gap-y-0 text-[10px] text-zinc-500 overflow-hidden h-[16px]">
            {teamA.slice(0, 5).map((p, i) => (
              <span key={i} className={`truncate flex items-center gap-0.5 ${isHighlighted(p.name) ? "text-cs2-orange font-bold" : ""}`}>
                {p.name?.slice(0, 8)}{!!result.players?.[p.name] && <Sparkles className="h-2 w-2 text-cs2-orange animate-pulse" />}
              </span>
            ))}
          </div>
        </div>

        {/* Score */}
        <div className="flex items-center gap-2 px-3 py-1 bg-black/40 rounded-lg border border-white/5 shrink-0">
           <span className="text-lg font-black text-cs2-orange tabular-nums">{matchMeta.team_a_score ?? 0}</span>
           <div className="h-3 w-[1px] bg-white/10" />
           <span className="text-lg font-black text-cs2-orange tabular-nums">{matchMeta.team_b_score ?? 0}</span>
        </div>

        {/* Team B & Players */}
        <div className="flex-1 flex flex-col items-start min-w-0">
          <span className="text-xs font-black text-zinc-300 truncate w-full mb-0.5">
            {matchMeta.team_b_name || "Team B"}
          </span>
          <div className="flex flex-wrap justify-start gap-x-1.5 gap-y-0 text-[10px] text-zinc-500 overflow-hidden h-[16px]">
            {teamB.slice(0, 5).map((p, i) => (
              <span key={i} className={`truncate flex items-center gap-0.5 ${isHighlighted(p.name) ? "text-cs2-orange font-bold" : ""}`}>
                {p.name?.slice(0, 8)}{!!result.players?.[p.name] && <Sparkles className="h-2 w-2 text-cs2-orange animate-pulse" />}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 4. 右侧动态区域：平时显示状态/时间，悬停显示操作 */}
      <div className="relative ml-auto shrink-0 min-w-[160px] flex justify-end items-center">
        {/* 平时显示：状态 + 入库日期 + 时长 */}
        <div className="flex items-center gap-6 group-hover:hidden animate-in fade-in duration-200">
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${listStatusDot} ${
                  listStatus.kind === "pending" || listStatus.kind === "parsing" ? "animate-pulse" : ""
                }`}
              />
              <span className={`max-w-[9rem] truncate text-[10px] font-bold ${listStatusText}`} title={listStatus.tooltip}>
                {listStatus.label}
              </span>
            </div>
            <div className="text-[9px] font-bold text-zinc-600 font-mono">
              {demo.added_at ? new Date(demo.added_at).toLocaleDateString('zh-CN', { year: '2-digit', month: '2-digit', day: '2-digit' }) : ""}
            </div>
          </div>
          
          <div className="flex items-center gap-1 text-[11px] font-black text-zinc-400 w-12 tabular-nums">
            <Clock className="h-3.5 w-3.5 opacity-40 text-cs2-orange" />
            {formatDuration(matchMeta.duration_mins).replace(' min', '')}
            <span className="text-[9px] opacity-40 ml-0.5 font-normal">M</span>
          </div>
        </div>

        {/* 悬停显示：操作按钮 */}
        <div className="hidden group-hover:flex items-center gap-1 animate-in fade-in duration-200" onClick={e => e.stopPropagation()}>
          <button 
            onClick={() => setIsEditingRemark(!isEditingRemark)} 
            className={`p-2 rounded-md transition-colors ${demo.remark ? 'text-cs2-orange' : 'text-zinc-500'} hover:bg-white/10`}
            title="备注"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button onClick={() => onPlay(demo.id)} className="p-2 text-emerald-400 hover:bg-emerald-500/10 rounded-md transition-colors" title="观看">
            <Play className="h-4 w-4 fill-current" />
          </button>
          <button onClick={() => onOpenFile(demo.id)} className="p-2 text-zinc-400 hover:bg-white/10 rounded-md transition-colors" title="定位">
            <FolderSearch className="h-4 w-4" />
          </button>
          <button onClick={() => onDelete(demo.id, demo.filename)} className="p-2 text-red-400 hover:bg-red-500/10 rounded-md transition-colors" title="删除">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 6. 展开备注编辑区 */}
      {isEditingRemark && (
        <div 
          className="absolute top-full left-0 right-0 z-10 mt-1 rounded-lg border border-white/10 bg-cs2-bg-card p-3 shadow-2xl animate-in fade-in zoom-in-95 duration-150"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={remarkDraft}
              onChange={(e) => setRemarkDraft(e.target.value)}
              className="w-full bg-black/40 border border-white/5 rounded-md p-2 text-xs text-white outline-none focus:border-cs2-orange/40 resize-none"
              placeholder="添加备注..."
              rows={2}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsEditingRemark(false)} className="text-[10px] text-zinc-500 hover:text-white uppercase font-bold tracking-tighter">取消</button>
              <button onClick={handleSaveRemark} className="flex items-center gap-1 rounded bg-cs2-orange px-3 py-1 text-[10px] font-black text-black uppercase tracking-tighter shadow-lg shadow-cs2-orange/20">
                <Save className="h-3 w-3" /> 保存
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
  onOpenInfo,
  expectedPlayers = [],
}) {
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
  const mapThumbnail = `/images/maps/${mapName}.png`;
  const sourceLogo = SOURCE_LOGOS[demo.source] || SOURCE_LOGOS["Local/Other"];

  const players = demo.players || [];
  const teamA = players.filter(p => p.team_number === 2 || p.team === 2 || p.team === "TERRORIST");
  const teamB = players.filter(p => p.team_number === 3 || p.team === 3 || p.team === "CT");

  const isHighlighted = (name) => {
    if (!name) return false;
    const n = name.toLowerCase();
    return expectedPlayers.some(p => p.toLowerCase() === n || n.includes(p.toLowerCase()));
  };

  const getKillTags = () => {
    if (!result.clips) return [];
    const tags = [];
    let k4 = 0, k5 = 0;
    result.clips.forEach(c => {
      if (c.category === "highlight") {
        if (c.kill_count === 4) k4++;
        if (c.kill_count >= 5) k5++;
      }
    });
    if (k4 > 0) tags.push({ label: `4K x ${k4}`, color: "bg-cs2-orange/20 text-cs2-orange" });
    if (k5 > 0) tags.push({ label: `5K x ${k5}`, color: "bg-red-500/20 text-red-400" });
    return tags;
  };

  const killTags = getKillTags();

  const gridStatus = classifyDemoStatus(demo);
  const gridStatusBadgeClass =
    {
      done: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
      error: "bg-red-500/10 text-red-400 border-red-500/20",
      parsing: "bg-cs2-orange/10 text-cs2-orange border-cs2-orange/25",
      loaded: "bg-sky-500/10 text-sky-300 border-sky-500/25",
      pending: "bg-amber-500/10 text-amber-200 border-amber-500/25",
      meta_missing: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
      unknown: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    }[gridStatus.kind] || "bg-blue-500/10 text-blue-400 border-blue-500/20";

  const handleSaveRemark = () => {
    onUpdateRemark?.(demo.id, remarkDraft);
    setIsEditingRemark(false);
  };

  return (
    <div 
      className={`group relative flex flex-col overflow-hidden rounded-lg border transition-all cursor-pointer ${isSelected ? 'border-cs2-orange bg-cs2-orange/5 shadow-lg shadow-cs2-orange/5' : 'border-white/10 bg-cs2-bg-card hover:border-white/20'}`}
      onClick={() => onOpenInfo?.(demo.id)}
    >
      {/* 顶部：地图缩略图背景 */}
      <div className="relative h-[70px] w-full overflow-hidden">
        <img 
          src={mapThumbnail} 
          alt={mapName}
          className="h-full w-full object-cover opacity-40 transition-transform duration-500 group-hover:scale-110"
          onError={(e) => { e.target.src = "/images/maps/thumbnail_unknown.png"; }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-cs2-bg-card to-transparent" />
        
        {/* 顶部悬浮信息 */}
        <div className="absolute inset-0 flex flex-col justify-center px-2 py-0.5">
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={(e) => onSelect(demo.id, e.target.checked)}
                className="h-4 w-4 rounded border-white/40 bg-black/40 text-cs2-orange focus:ring-offset-0"
              />
              <span className="text-lg font-black text-white uppercase italic tracking-tighter drop-shadow-md">
                {mapName.replace('de_', '').replace('cs_', '')}
              </span>
            </div>

            {/* 比分：Trophy 严格居中 */}
            <div className="absolute left-1/2 -translate-x-1/2 grid grid-cols-[minmax(0,1fr)_min-content_minmax(0,1fr)] items-center">
              <span className="text-right text-xl font-black text-cs2-orange tabular-nums drop-shadow-md">
                {matchMeta.team_a_score ?? 0}
              </span>
              <Trophy className="h-5 w-5 mx-1.5 text-yellow-400 drop-shadow" />
              <span className="text-left text-xl font-black text-cs2-orange tabular-nums drop-shadow-md">
                {matchMeta.team_b_score ?? 0}
              </span>
            </div>

            <div className="flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100" onClick={e => e.stopPropagation()}>
              <button onClick={() => onPlay(demo.id)} className="flex h-8 w-8 items-center justify-center rounded-md border border-emerald-500/50 bg-black/60 text-emerald-400 hover:bg-emerald-500 hover:text-white transition-all"><Play className="h-4 w-4 fill-current" /></button>
              <button onClick={() => onOpenFile(demo.id)} className="flex h-8 w-8 items-center justify-center rounded-md border border-white/20 bg-black/60 text-white hover:bg-white hover:text-black transition-all"><FolderSearch className="h-4 w-4" /></button>
              <button onClick={() => onDelete(demo.id, demo.filename)} className="flex h-8 w-8 items-center justify-center rounded-md border border-red-500/50 bg-black/60 text-red-400 hover:bg-red-500 hover:text-white transition-all"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>

          {/* 底部行：来源 / 时长 / 日期 */}
          <div className="relative flex items-center justify-between text-[10px] font-bold text-white/70 drop-shadow-md">
            <div className="flex items-center gap-1.5">
              <img src={sourceLogo} alt={demo.source} className="h-3 object-contain opacity-80" />
              <span className="uppercase">{demo.source || "Local"}</span>
            </div>
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(matchMeta.duration_mins)}
            </div>
            <div className="opacity-80 tabular-nums">
              {demo.added_at ? new Date(demo.added_at).toLocaleDateString('zh-CN', { year: '2-digit', month: '2-digit', day: '2-digit' }) : ""}
            </div>
          </div>
        </div>
      </div>

      {/* 中部：队伍与成员 */}
      <div className="grid grid-cols-2 border-y border-white/5 bg-black/20 group/roster w-full transition-colors hover:bg-white/[0.03]">
        <div className="relative border-r border-white/5 px-3 py-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{matchMeta.team_a_name || "Team A"}</div>
          <div className="flex flex-wrap gap-1">
            {teamA.length > 0 ? teamA.slice(0, 5).map((p, i) => (
              <span key={i} className={`relative flex items-center gap-0.5 text-[10px] ${isHighlighted(p.name) ? 'font-bold text-cs2-orange underline underline-offset-2' : 'text-zinc-400'}`} title={p.name}>
                {p.name?.slice(0, 8)}{p.name?.length > 8 ? '..' : ''}
                {!!result.players?.[p.name] && <Sparkles className="h-2 w-2 text-cs2-orange animate-pulse" />}
                {i < 4 && i < teamA.length - 1 ? ',' : ''}
              </span>
            )) : <span className="text-[10px] text-zinc-600 italic">No roster</span>}
          </div>
        </div>
        <div className="px-3 py-1">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{matchMeta.team_b_name || "Team B"}</div>
          <div className="flex flex-wrap gap-1">
            {teamB.length > 0 ? teamB.slice(0, 5).map((p, i) => (
              <span key={i} className={`relative flex items-center gap-0.5 text-[10px] ${isHighlighted(p.name) ? 'font-bold text-cs2-orange underline underline-offset-2' : 'text-zinc-400'}`} title={p.name}>
                {p.name?.slice(0, 8)}{p.name?.length > 8 ? '..' : ''}
                {!!result.players?.[p.name] && <Sparkles className="h-2 w-2 text-cs2-orange animate-pulse" />}
                {i < 4 && i < teamB.length - 1 ? ',' : ''}
              </span>
            )) : <span className="text-[10px] text-zinc-600 italic">No roster</span>}
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
              {gridStatus.label}
            </span>
            {killTags.map((tag, i) => (
              <span key={i} className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase ${tag.color}`}>
                <Tag className="h-2.5 w-2.5" />
                {tag.label}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-2 flex items-start gap-2 rounded bg-black/40 p-1.5 border border-white/5">
          <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" />
          {isEditingRemark ? (
            <div className="flex flex-1 flex-col gap-1.5">
              <textarea autoFocus value={remarkDraft} onChange={(e) => setRemarkDraft(e.target.value)} className="w-full bg-transparent p-0 text-[11px] text-white outline-none placeholder:text-zinc-700 resize-none" placeholder="添加备注..." rows={2} />
              <div className="flex justify-end gap-2">
                <button onClick={() => setIsEditingRemark(false)} className="text-[10px] text-zinc-500 hover:text-white">取消</button>
                <button onClick={handleSaveRemark} className="flex items-center gap-1 rounded bg-cs2-orange px-2 py-0.5 text-[10px] font-bold text-black"><Save className="h-2.5 w-2.5" /> 保存</button>
              </div>
            </div>
          ) : (
            <div className="group/remark flex flex-1 cursor-pointer items-start justify-between gap-2" onClick={() => setIsEditingRemark(true)}>
              <p className={`text-[11px] leading-relaxed ${demo.remark ? 'text-zinc-300' : 'text-zinc-600 italic'}`}>{demo.remark || "点击添加备注..."}</p>
              <Pencil className="h-2.5 w-2.5 text-zinc-600 opacity-0 group-hover/remark:opacity-100" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
