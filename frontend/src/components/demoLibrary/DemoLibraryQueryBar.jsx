import { Filter, X, Search, Calendar, ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
import { DEMO_LIBRARY_MAP_OPTIONS, DEMO_LIBRARY_STATUS_FILTER_OPTIONS } from "../../constants/demoLibraryFilters";

const SORT_OPTIONS = [
  { value: "library", label: "状态+入库时间" },
  { value: "date", label: "入库时间" },
  { value: "size", label: "大小" },
  { value: "duration", label: "时长" },
  { value: "rounds", label: "回合" },
  { value: "map", label: "地图" },
  { value: "filename", label: "文件名" },
];

export default function DemoLibraryQueryBar({
  librarySearchInput,
  onSearchChange,
  onSearchSubmit,
  libraryAdvFilters,
  setLibraryAdvFilters,
  sortKey,
  sortDir,
  onSortKeyChange,
  onSortDirChange,
  advancedOpen,
  onToggleAdvanced,
  onClearQuickFilters,
  hasQuickOrAdvancedFilters,
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-cs2-border pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[min(100%,14rem)] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" />
          <input
            type="search"
            enterKeyHint="search"
            placeholder="文件名 / 展示名"
            className="w-full rounded-md border border-cs2-border bg-cs2-bg-input py-1.5 pl-8 pr-2 font-mono text-[12px] text-cs2-text-primary outline-none placeholder:text-cs2-text-muted focus:border-cs2-accent/40"
            value={librarySearchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSearchSubmit();
              }
            }}
            aria-label="搜索 Demo"
          />
        </div>

        <select
          className="rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] text-cs2-text-primary outline-none focus:border-cs2-accent/40"
          value={libraryAdvFilters.mapName}
          onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, mapName: e.target.value }))}
          aria-label="地图"
        >
          <option value="">全部地图</option>
          {DEMO_LIBRARY_MAP_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <select
          className="rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-[12px] text-cs2-text-primary outline-none focus:border-cs2-accent/40"
          value={libraryAdvFilters.status}
          onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, status: e.target.value }))}
          aria-label="状态"
        >
          <option value="all">全部状态</option>
          {DEMO_LIBRARY_STATUS_FILTER_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 rounded-md border border-cs2-border bg-cs2-bg-input px-1 py-0.5">
          <Calendar className="h-3 w-3 shrink-0 text-cs2-text-muted" aria-hidden />
          <input
            type="date"
            className="max-w-[8.5rem] bg-transparent py-1 font-mono text-[11px] text-cs2-text-secondary outline-none"
            value={libraryAdvFilters.dateFrom}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, dateFrom: e.target.value }))}
          />
          <span className="text-cs2-text-muted">—</span>
          <input
            type="date"
            className="max-w-[8.5rem] bg-transparent py-1 font-mono text-[11px] text-cs2-text-secondary outline-none"
            value={libraryAdvFilters.dateTo}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, dateTo: e.target.value }))}
          />
        </div>

        <div className="flex items-center gap-1">
          <ArrowUpDown className="h-3.5 w-3.5 text-cs2-text-muted" aria-hidden />
          <select
            className="rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-[12px] text-cs2-text-primary outline-none focus:border-cs2-accent/40"
            value={sortKey}
            onChange={(e) => {
              const k = e.target.value;
              onSortKeyChange(k);
              onSortDirChange(k === "filename" || k === "map" ? "asc" : "desc");
            }}
            aria-label="排序字段"
          >
            {SORT_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md border border-cs2-border px-2 py-1.5 font-mono text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary"
            title={sortDir === "asc" ? "升序" : "降序"}
            onClick={() => onSortDirChange(sortDir === "asc" ? "desc" : "asc")}
          >
            {sortDir === "asc" ? "升序" : "降序"}
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleAdvanced}
          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
            advancedOpen
              ? "border-cs2-accent/45 bg-cs2-accent/10 text-cs2-accent"
              : "border-cs2-border bg-cs2-bg-hover text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary"
          }`}
        >
          <Filter className="h-3.5 w-3.5" />
          高级筛选
          {advancedOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {hasQuickOrAdvancedFilters ? (
          <button
            type="button"
            onClick={onClearQuickFilters}
            className="inline-flex items-center gap-1 rounded-md border border-cs2-border px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-muted hover:border-cs2-border hover:text-cs2-text-secondary"
          >
            <X className="h-3.5 w-3.5" />
            清空筛选
          </button>
        ) : null}
      </div>
    </div>
  );
}
