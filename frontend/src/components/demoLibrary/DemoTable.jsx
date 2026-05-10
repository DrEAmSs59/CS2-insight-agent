import { Fragment } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Pencil,
  ScanSearch,
  Trash2,
} from "lucide-react";
import DemoScoreboardPreview from "./DemoScoreboardPreview";
import DemoStatusBadge from "./DemoStatusBadge";
import {
  deriveTags,
  formatDurationMinutesPlain,
  formatFileSize,
  formatLibraryAddedAt,
  formatScoreLine,
} from "../../utils/demoLibraryDisplay";
import { canLikelyPreviewScoreboard } from "../../utils/demoScoreboardModel";

function dirnameFromPath(p) {
  if (!p || typeof p !== "string") return "";
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i <= 0) return norm;
  return norm.slice(0, i);
}

function mapLabel(it) {
  const r = it.result && typeof it.result === "object" ? it.result : null;
  const mm = r?.match_meta && typeof r.match_meta === "object" ? r.match_meta : {};
  const v =
    (it.map_name && String(it.map_name).trim()) ||
    (mm.map_name && String(mm.map_name).trim()) ||
    "";
  return v || "—";
}

function roundsLabel(it) {
  const r = it.result && typeof it.result === "object" ? it.result : null;
  const mm = r?.match_meta && typeof r.match_meta === "object" ? r.match_meta : {};
  const roundsRaw = it.total_rounds ?? mm.total_rounds;
  if (roundsRaw != null && Number.isFinite(Number(roundsRaw))) return String(roundsRaw);
  return "—";
}

function SortChevron({ active, dir }) {
  if (!active) return <span className="inline-block w-3 shrink-0" aria-hidden />;
  return dir === "asc" ? (
    <ChevronUp className="h-3 w-3 shrink-0 text-cs2-orange" aria-hidden />
  ) : (
    <ChevronDown className="h-3 w-3 shrink-0 text-cs2-orange" aria-hidden />
  );
}

/** 电竞风自定义勾选：无原生 accent */
function DemoRowCheckbox({ checked, onToggle, title }) {
  return (
    <label className="group/chk relative inline-flex cursor-pointer items-center justify-center">
      <input type="checkbox" className="sr-only" checked={checked} onChange={onToggle} aria-label={title} />
      <span
        className={[
          "flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[3px]",
          "border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-[border-color,background-color,box-shadow] duration-150",
          "border-white/[0.14] bg-[#161618] group-hover/chk:border-white/[0.22] group-hover/chk:bg-zinc-800/85",
          checked
            ? "border-cs2-orange/55 bg-cs2-orange/14 shadow-[0_0_12px_rgba(225,116,57,0.22),inset_0_1px_0_rgba(255,255,255,0.06)]"
            : "",
        ].join(" ")}
      >
        <Check
          className={[
            "h-2.5 w-2.5 stroke-[3] text-cs2-orange transition-opacity duration-150",
            checked ? "opacity-100" : "opacity-0",
          ].join(" ")}
          aria-hidden
        />
      </span>
    </label>
  );
}

const COL_SPAN = 11;

export default function DemoTable({
  rows,
  selectedIds,
  onToggleSelect,
  sortKey,
  sortDir,
  onColumnSort,
  libraryLoading,
  emptyHint,
  expandedScoreboardIds,
  onToggleScoreboardExpand,
  highlightQuery,
  steamHighlightQuery,
  onRename,
  onDelete,
  onAnalyze,
}) {
  const iconBtn =
    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-zinc-500 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-200 active:bg-white/[0.09]";
  const iconBtnDanger =
    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-zinc-500 transition-colors duration-150 hover:bg-red-500/12 hover:text-red-400 active:bg-red-500/18";

  const thBtn =
    "group inline-flex w-full items-center gap-0.5 text-left font-semibold text-zinc-500 hover:text-zinc-300";

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      <table className="w-full min-w-[880px] border-collapse text-left text-[11px] text-zinc-300">
        <thead className="sticky top-0 z-[1] bg-cs2-bg-card/95 backdrop-blur-[2px]">
          <tr className="border-b border-white/[0.06]">
            <th className="w-[8.75rem] min-w-[8rem] px-2 py-2">
              <span className="sr-only">展开预览与选择</span>
            </th>
            <th className="min-w-[200px] px-2 py-2">
              <button type="button" className={thBtn} onClick={() => onColumnSort("filename")}>
                文件名
                <SortChevron active={sortKey === "filename"} dir={sortDir} />
              </button>
            </th>
            <th className="min-w-[7rem] px-2 py-2">
              <button type="button" className={thBtn} onClick={() => onColumnSort("map")}>
                地图
                <SortChevron active={sortKey === "map"} dir={sortDir} />
              </button>
            </th>
            <th className="min-w-[3.5rem] px-2 py-2 text-zinc-500">比分</th>
            <th className="min-w-[3.5rem] px-2 py-2">
              <button type="button" className={thBtn} onClick={() => onColumnSort("rounds")}>
                回合
                <SortChevron active={sortKey === "rounds"} dir={sortDir} />
              </button>
            </th>
            <th className="min-w-[4rem] px-2 py-2">
              <button type="button" className={thBtn} onClick={() => onColumnSort("duration")}>
                时长
                <SortChevron active={sortKey === "duration"} dir={sortDir} />
              </button>
            </th>
            <th className="min-w-[6.5rem] px-2 py-2">
              <button type="button" className={thBtn} onClick={() => onColumnSort("date")}>
                入库时间
                <SortChevron active={sortKey === "date"} dir={sortDir} />
              </button>
            </th>
            <th className="min-w-[4rem] px-2 py-2">
              <button type="button" className={thBtn} onClick={() => onColumnSort("size")}>
                大小
                <SortChevron active={sortKey === "size"} dir={sortDir} />
              </button>
            </th>
            <th className="min-w-[5.5rem] px-2 py-2">
              <button type="button" className={thBtn} onClick={() => onColumnSort("library")}>
                状态
                <SortChevron active={sortKey === "library"} dir={sortDir} />
              </button>
            </th>
            <th className="min-w-[7rem] px-2 py-2 text-zinc-500">标签</th>
            <th className="min-w-[10rem] px-2 py-2 text-right text-zinc-500">操作</th>
          </tr>
        </thead>
        <tbody>
          {libraryLoading && rows.length === 0 ? (
            <tr>
              <td colSpan={COL_SPAN} className="px-3 py-10 text-center text-[11px] text-zinc-500">
                加载中…
              </td>
            </tr>
          ) : null}
          {!libraryLoading && rows.length === 0 && emptyHint ? (
            <tr>
              <td colSpan={COL_SPAN} className="px-3 py-12 text-center text-[11px] leading-relaxed text-zinc-500">
                {emptyHint}
              </td>
            </tr>
          ) : null}
          {rows.map((it) => {
            const id = it.id;
            const title = (it.display_name && String(it.display_name).trim()) || it.filename || `#${id}`;
            const pathStr = typeof it.path === "string" ? it.path : "";
            const subLine = dirnameFromPath(pathStr) || pathStr || "—";
            const checked = selectedIds.has(id);
            const expanded = expandedScoreboardIds.has(id);
            const previewLikely = canLikelyPreviewScoreboard(it);

            const rowAccent = checked || expanded;

            return (
              <Fragment key={id}>
                <tr
                  className={[
                    "group/row cursor-pointer border-b border-white/[0.04] transition-[background-color,border-color] duration-150 last:border-b-0",
                    expanded ? "border-b-0" : "",
                    checked ? "bg-cs2-orange/[0.055]" : "hover:bg-white/[0.035]",
                  ].join(" ")}
                  onClick={() => onAnalyze?.(it)}
                >
                  <td
                    className={[
                      "align-middle py-1.5 pl-2 pr-2",
                      rowAccent ? "border-l-[2px] border-l-cs2-orange/90" : "border-l-[2px] border-l-transparent",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleScoreboardExpand(id);
                        }}
                        className={[
                          "flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 py-0.5 text-left",
                          "-ml-0.5 outline-none transition-colors duration-150",
                          "focus-visible:ring-2 focus-visible:ring-cs2-orange/35 focus-visible:ring-offset-2 focus-visible:ring-offset-cs2-bg-card",
                          expanded
                            ? "text-cs2-orange"
                            : "text-zinc-600 group-hover/row:text-zinc-400",
                        ].join(" ")}
                        aria-expanded={expanded}
                        title={expanded ? "收起比分预览" : "展开比分预览"}
                      >
                        <ChevronRight
                          className={[
                            "h-3.5 w-3.5 shrink-0 transition-transform duration-150 ease-out",
                            expanded ? "rotate-90 text-cs2-orange" : "rotate-0 text-zinc-500 opacity-[0.35] group-hover/row:opacity-100",
                          ].join(" ")}
                          aria-hidden
                        />
                        <span
                          className={[
                            "select-none text-[10px] font-medium tracking-tight",
                            expanded ? "text-cs2-orange" : "text-zinc-600 opacity-75 group-hover/row:text-cs2-orange group-hover/row:opacity-100",
                          ].join(" ")}
                        >
                          比分预览
                        </span>
                      </button>
                      <span onClick={(e) => e.stopPropagation()}>
                        <DemoRowCheckbox checked={checked} onToggle={() => onToggleSelect(id)} title={`选择 ${title}`} />
                      </span>
                    </div>
                  </td>
                  <td className="max-w-[240px] align-middle px-2 py-2">
                    <div className="flex min-h-[40px] items-start gap-1.5">
                      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                        <span
                          className="truncate font-medium text-zinc-200 transition-colors duration-150 group-hover/row:text-zinc-50"
                          title={title}
                        >
                          {title}
                        </span>
                        <span
                          className="truncate font-mono text-[10px] leading-tight text-zinc-600 transition-colors group-hover/row:text-zinc-500"
                          title={pathStr || subLine}
                        >
                          {subLine}
                        </span>
                      </div>
                      {previewLikely ? (
                        <span title="可预览比分数据" className="opacity-70 transition-opacity group-hover/row:opacity-100">
                          <Eye className="mt-0.5 h-3 w-3 shrink-0 text-cs2-orange/75" aria-hidden />
                        </span>
                      ) : (
                        <span title="需解析并索引玩家数据后可预览" className="opacity-50">
                          <EyeOff className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" aria-hidden />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="max-w-[10rem] truncate align-middle px-2 py-2 font-mono text-[10px] text-zinc-400 transition-colors group-hover/row:text-zinc-300">
                    {mapLabel(it)}
                  </td>
                  <td className="whitespace-nowrap align-middle px-2 py-2 font-mono text-[10px] text-zinc-400 transition-colors group-hover/row:text-zinc-300">
                    {formatScoreLine(it.team_a_score, it.team_b_score)}
                  </td>
                  <td className="whitespace-nowrap align-middle px-2 py-2 font-mono text-[10px] text-zinc-400 transition-colors group-hover/row:text-zinc-300">
                    {roundsLabel(it)}
                  </td>
                  <td className="whitespace-nowrap align-middle px-2 py-2 font-mono text-[10px] text-zinc-400 transition-colors group-hover/row:text-zinc-300">
                    {formatDurationMinutesPlain(it.duration_mins)}
                  </td>
                  <td className="whitespace-nowrap align-middle px-2 py-2 font-mono text-[10px] text-zinc-400 transition-colors group-hover/row:text-zinc-300">
                    {formatLibraryAddedAt(it.added_at)}
                  </td>
                  <td className="whitespace-nowrap align-middle px-2 py-2 font-mono text-[10px] text-zinc-400 transition-colors group-hover/row:text-zinc-300">
                    {formatFileSize(it.file_size)}
                  </td>
                  <td className="align-middle px-2 py-2">
                    <DemoStatusBadge item={it} />
                  </td>
                  <td className="max-w-[9rem] align-middle px-2 py-2">
                    <div className="flex flex-wrap gap-1">
                      {deriveTags(it).map((t, ti) => (
                        <span
                          key={`${id}-t-${ti}-${t}`}
                          className="max-w-full truncate rounded border border-white/[0.06] bg-black/20 px-1 py-0.5 font-mono text-[9px] text-zinc-500"
                          title={t}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="align-middle px-1 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap items-center justify-end gap-0.5 opacity-90 transition-opacity group-hover/row:opacity-100">
                      <button type="button" className={iconBtn} title="战绩 / 高光分析" onClick={() => onAnalyze?.(it)}>
                        <ScanSearch className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" className={iconBtn} title="重命名展示名" onClick={() => onRename(it)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" className={iconBtnDanger} title="从库中删除" onClick={() => onDelete(it)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded ? (
                  <tr className="border-b border-white/[0.05] bg-black/[0.22]">
                    <td colSpan={COL_SPAN} className="p-0 align-top">
                      <DemoScoreboardPreview
                        demoItem={it}
                        highlightQuery={highlightQuery}
                        steamHighlightQuery={steamHighlightQuery}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
