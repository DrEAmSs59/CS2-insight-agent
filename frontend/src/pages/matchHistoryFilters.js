// 官匹战绩筛选哨兵值（语言无关，作为 <select> value 与筛选逻辑的稳定标识）。
// 独立模块：避免 MatchHistoryPage ↔ MatchHistoryFilterBar 循环依赖导致的 TDZ。
export const FILTER_ALL_MAPS = "all_maps";
export const FILTER_ALL_RESULTS = "all_results";
export const FILTER_ALL_TIME = "all_time";
export const FILTER_LAST_7 = "last_7";
export const FILTER_LAST_30 = "last_30";
