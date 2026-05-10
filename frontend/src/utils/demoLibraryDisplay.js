import { demoLibraryStatusLabel } from "../constants/demoLibraryFilters";

export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const rounded = v < 10 && i > 0 ? v.toFixed(1) : String(Math.round(v));
  return `${rounded} ${units[i]}`;
}

export function formatScoreLine(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return "—";
  return `${na}:${nb}`;
}

export function formatDurationMins(m) {
  const x = Number(m);
  if (!Number.isFinite(x) || x <= 0) return "—";
  if (x >= 60) return `${(x / 60).toFixed(1)}h`;
  return `${Math.round(x)}′`;
}

/** Demo 库表格：时长一律按「分钟」展示 */
export function formatDurationMinutesPlain(m) {
  const x = Number(m);
  if (!Number.isFinite(x) || x <= 0) return "—";
  return `${Math.round(x)} 分`;
}

/** 入库时间（仅 added_at），格式 yyyy/MM/dd HH:mm */
export function formatLibraryAddedAt(iso) {
  if (iso == null || iso === "") return "—";
  const d = new Date(typeof iso === "string" ? iso : String(iso));
  if (Number.isNaN(d.getTime())) return "—";
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${mo}/${day} ${h}:${min}`;
}

export function formatShortDate(iso) {
  if (!iso || typeof iso !== "string") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.length > 16 ? iso.slice(0, 16) : iso;
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** @param {Record<string, unknown>} it */
export function rowDateValue(it) {
  const r = it.result && typeof it.result === "object" ? it.result : null;
  const mm = r?.match_meta && typeof r.match_meta === "object" ? r.match_meta : {};
  const raw = it.match_date || mm.match_date || it.parsed_at || it.added_at;
  if (typeof raw === "string") return raw;
  return raw != null ? String(raw) : "";
}

export function rowDateSortTs(it) {
  const s = rowDateValue(it);
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 入库时间戳（仅信任 added_at，用于排序） */
export function rowAddedAtTs(it) {
  const raw = it.added_at;
  if (raw == null || raw === "") return 0;
  const t = new Date(typeof raw === "string" ? raw : String(raw)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Demo 库推荐排序：解析失败(0) → 待处理(1) → 已完成(2)
 * @param {Record<string, unknown>} it
 */
export function libraryStatusTier(it) {
  const st = String(it.status ?? "").toLowerCase();
  if (st === "error") return 0;
  if (st === "pending" || st === "loaded" || st === "parsing" || st === "running" || st === "processing") return 1;
  if (st === "done" || st === "parsed") return 2;
  return 1;
}

/** @param {Record<string, unknown>} it */
export function deriveTags(it) {
  const tags = [];
  const r = it.result && typeof it.result === "object" ? it.result : null;
  if (Array.isArray(r?.clips) && r.clips.length) tags.push(`片段×${r.clips.length}`);
  const tgt = r?.auto_target_player || r?.match_meta?.target_player;
  if (tgt) tags.push(String(tgt));
  const map = it.map_name || r?.match_meta?.map_name;
  if (map && tags.length < 3) tags.push(String(map));
  return tags.slice(0, 4);
}

/**
 * @returns {{ kind: 'pending'|'loaded'|'parsing'|'done'|'error'|'meta_missing'|'unknown'; label: string; tooltip?: string }}
 */
export function classifyDemoStatus(it) {
  const st = String(it.status ?? "").toLowerCase();
  const err = it.error_msg ? String(it.error_msg) : "";
  if (st === "error")
    return { kind: "error", label: "解析失败", tooltip: err || undefined };
  if (st === "parsing" || st === "running" || st === "processing")
    return { kind: "parsing", label: "解析中" };
  if (st === "pending") return { kind: "pending", label: "待入库" };
  if (st === "loaded") return { kind: "loaded", label: "待高光解析" };
  const doneLike = st === "done" || st === "parsed";
  if (doneLike) {
    const hasCore =
      !!(it.map_name && String(it.map_name).trim()) ||
      (it.total_rounds != null && Number.isFinite(Number(it.total_rounds))) ||
      (it.result && typeof it.result === "object");
    if (!hasCore) return { kind: "meta_missing", label: "元数据缺失" };
    const datePart =
      it.parsed_at != null && String(it.parsed_at).trim() !== ""
        ? new Date(it.parsed_at).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
        : "未知";
    return { kind: "done", label: `解析于 ${datePart}` };
  }
  return { kind: "unknown", label: demoLibraryStatusLabel(it.status) };
}

/**
 * 客户端筛选（日期 / 回合 / 时长 / Steam 关键词仅占位）：在单页结果上收紧显示。
 * @param {Record<string, unknown>[]} items
 * @param {Record<string, string>} f libraryAdvFilters
 */
export function applyClientSideDemoFilters(items, f) {
  const num = (v) => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };
  const roundsMin = num(f.roundsMin);
  const roundsMax = num(f.roundsMax);
  const durMin = num(f.durationMin);
  const durMax = num(f.durationMax);
  const df = String(f.dateFrom ?? "").trim();
  const dt = String(f.dateTo ?? "").trim();
  const steamQ = String(f.steamQuery ?? "").trim().toLowerCase();

  return items.filter((it) => {
    const r = it.result && typeof it.result === "object" ? it.result : null;
    const mm = r?.match_meta && typeof r.match_meta === "object" ? r.match_meta : {};
    const rounds =
      it.total_rounds != null && Number.isFinite(Number(it.total_rounds))
        ? Number(it.total_rounds)
        : mm.total_rounds != null && Number.isFinite(Number(mm.total_rounds))
          ? Number(mm.total_rounds)
          : null;
    if (roundsMin != null && (rounds == null || rounds < roundsMin)) return false;
    if (roundsMax != null && (rounds == null || rounds > roundsMax)) return false;

    const dur = it.duration_mins != null ? Number(it.duration_mins) : null;
    if (durMin != null && (dur == null || !Number.isFinite(dur) || dur < durMin)) return false;
    if (durMax != null && (dur == null || !Number.isFinite(dur) || dur > durMax)) return false;

    const rowD = rowDateValue(it);
    if (df || dt) {
      if (!rowD) return false;
      const t = new Date(rowD).getTime();
      if (!Number.isFinite(t)) return false;
      if (df) {
        const a = new Date(df);
        a.setHours(0, 0, 0, 0);
        if (t < a.getTime()) return false;
      }
      if (dt) {
        const b = new Date(dt);
        b.setHours(23, 59, 59, 999);
        if (t > b.getTime()) return false;
      }
    }

    if (steamQ) {
      const path = String(it.path ?? "").toLowerCase();
      const fn = String(it.filename ?? "").toLowerCase();
      const hay = `${path} ${fn}`;
      if (!hay.includes(steamQ)) return false;
    }

    return true;
  });
}

/**
 * 路径 / 标签搜索（与接口 q 并列，用于路径包含；当前页内收窄）。
 */
export function filterByPathAndTags(items, rawQuery) {
  const q = String(rawQuery ?? "").trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    const fn = String(it.filename ?? "").toLowerCase();
    const dn = String(it.display_name ?? "").toLowerCase();
    const path = String(it.path ?? "").toLowerCase();
    if (fn.includes(q) || dn.includes(q) || path.includes(q)) return true;
    return deriveTags(it).some((t) => t.toLowerCase().includes(q));
  });
}

const SORT_KEYS = new Set(["library", "date", "size", "duration", "rounds", "status", "map", "filename"]);

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} key
 * @param {'asc'|'desc'} dir
 */
export function sortDemoRows(rows, key, dir) {
  if (!SORT_KEYS.has(key)) return [...rows];
  const mul = dir === "asc" ? 1 : -1;
  const cmpStr = (a, b) => mul * String(a ?? "").localeCompare(String(b ?? ""), "zh-CN");
  const cmpNum = (a, b) => mul * ((Number(a) || 0) - (Number(b) || 0));
  return [...rows].sort((x, y) => {
    switch (key) {
      case "library": {
        const c = libraryStatusTier(x) - libraryStatusTier(y);
        if (c !== 0) return c;
        const ad = rowAddedAtTs(y) - rowAddedAtTs(x);
        return dir === "desc" ? ad : -ad;
      }
      case "date":
        return mul * (rowAddedAtTs(x) - rowAddedAtTs(y));
      case "size":
        return cmpNum(x.file_size, y.file_size);
      case "duration":
        return cmpNum(x.duration_mins, y.duration_mins);
      case "rounds": {
        const rx =
          x.total_rounds != null && Number.isFinite(Number(x.total_rounds))
            ? Number(x.total_rounds)
            : -1;
        const ry =
          y.total_rounds != null && Number.isFinite(Number(y.total_rounds))
            ? Number(y.total_rounds)
            : -1;
        return mul * (rx - ry);
      }
      case "status":
        return cmpStr(x.status, y.status);
      case "map":
        return cmpStr(x.map_name, y.map_name);
      case "filename":
        return cmpStr(x.filename, y.filename);
      default:
        return 0;
    }
  });
}
