import { LayoutGrid, List, Download } from "lucide-react";

const MAPS = ["全部地图", "de_mirage", "de_inferno", "de_dust2", "de_nuke", "de_ancient", "de_vertigo", "de_anubis", "de_overpass"];
const RESULTS = ["全部结果", "win", "loss", "tie"];
const RESULT_LABELS = { "全部结果": "全部结果", win: "胜", loss: "负", tie: "平" };
const TIMES = ["全部时间", "近 7 天", "近 30 天"];
const MODES = [
  { value: "all", label: "全部" },
  { value: "premier", label: "优先排位" },
  { value: "competitive", label: "竞技" },
];

function Sel({ value, onChange, options, labels }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-[7px] border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[12.5px] text-cs2-text-primary focus:border-cs2-accent focus:outline-none"
    >
      {options.map((o) => (
        <option key={o} value={o}>{labels?.[o] ?? o}</option>
      ))}
    </select>
  );
}

export default function MatchHistoryFilterBar({ filters, onFiltersChange, viewMode, onViewModeChange, onExportCsv }) {
  function set(key, val) {
    onFiltersChange({ ...filters, [key]: val });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input
        type="text"
        value={filters.search}
        onChange={(e) => set("search", e.target.value)}
        placeholder="搜索 Match ID / 备注…"
        className="min-w-[220px] rounded-[7px] border border-cs2-border bg-cs2-bg-input px-3 py-1.5 text-[12.5px] text-cs2-text-primary placeholder:text-cs2-text-muted focus:border-cs2-accent focus:outline-none"
      />
      <Sel value={filters.map} onChange={(v) => set("map", v)} options={MAPS} />
      <Sel value={filters.result} onChange={(v) => set("result", v)} options={RESULTS} labels={RESULT_LABELS} />
      <Sel value={filters.time} onChange={(v) => set("time", v)} options={TIMES} />

      <div className="ml-auto flex items-center gap-2">
        <div className="flex rounded-[7px] border border-cs2-border overflow-hidden">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => set("mode", m.value)}
              className={`px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                filters.mode === m.value
                  ? "bg-cs2-accent text-black"
                  : "text-cs2-text-secondary hover:text-cs2-text-primary"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex rounded-[7px] border border-cs2-border overflow-hidden">
          {[["list", <List className="h-4 w-4" key="l" />], ["grid", <LayoutGrid className="h-4 w-4" key="g" />]].map(([v, icon]) => (
            <button
              key={v}
              onClick={() => onViewModeChange(v)}
              className={`px-2.5 py-1.5 transition-colors ${viewMode === v ? "bg-cs2-accent text-black" : "text-cs2-text-secondary hover:text-cs2-text-primary"}`}
            >
              {icon}
            </button>
          ))}
        </div>

        <button
          onClick={onExportCsv}
          className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border px-3 py-1.5 text-[12.5px] text-cs2-text-secondary hover:text-cs2-text-primary"
        >
          <Download className="h-3.5 w-3.5" />
          导出 CSV
        </button>
      </div>
    </div>
  );
}
