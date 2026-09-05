/**
 * cs数据图 (CS Data Chart) API client — 对局解析后的玩家雷达图素材。
 */
import API, { API_BASE_URL } from "../../api/api";

/** 生成图片的完整 URL（浏览器 dev 走 Vite 代理，桌面壳直连后端）。 */
export function radarImageUrl(pathOrUrl) {
  const raw = String(pathOrUrl || "");
  if (!raw) return "";
  if (/^https?:\/\//.test(raw)) return raw;
  if (raw.startsWith("/api/")) return `${API_BASE_URL}${raw}`;
  return `${API_BASE_URL}/api/cs-data-radar/images/${encodeURIComponent(raw.split("/").pop())}`;
}

/** 开场动画视频的完整 URL。 */
export function radarVideoUrl(pathOrUrl) {
  const raw = String(pathOrUrl || "");
  if (!raw) return "";
  if (/^https?:\/\//.test(raw)) return raw;
  if (raw.startsWith("/api/")) return `${API_BASE_URL}${raw}`;
  return `${API_BASE_URL}/api/cs-data-radar/videos/${encodeURIComponent(raw.split("/").pop())}`;
}

/** 按需生成卡片的「开场动画」MP4（慢入→快出→定格）；未配置 FFmpeg 时返回静态卡。 */
export async function generateCardAnimation(cardId) {
  const { data } = await API.post(`/cs-data-radar/cards/${encodeURIComponent(String(cardId))}/animation`);
  return data;
}

/** 并发批量生成多张卡片的开场动画（帧渲染多进程并行）。 */
export async function batchGenerateCardAnimations(cardIds) {
  const { data } = await API.post("/cs-data-radar/cards/batch-animation", {
    card_ids: (Array.isArray(cardIds) ? cardIds : []).map(String),
  });
  return Array.isArray(data?.cards) ? data.cards : [];
}

/** 列出全部已生成的雷达图卡片（合辑工作台素材池）。 */
export async function listRadarCards() {
  const { data } = await API.get("/cs-data-radar/cards");
  return Array.isArray(data?.cards) ? data.cards : [];
}

/**
 * 为一场对局解析后的全部玩家生成雷达图卡片（自动录制全部人的雷达图）。
 * @param {Array} players 对局工作台 workspace.players（或 roster 行）
 * @param {{demoId?: number, demoName?: string}} demoInfo
 */
export async function generateRadarCards(players, { demoId, demoName } = {}) {
  const { data } = await API.post("/cs-data-radar/cards", {
    demo_id: demoId ?? null,
    demo_name: String(demoName || ""),
    players: (Array.isArray(players) ? players : []).map((p) => toRadarPlayerPayload(p)),
  });
  return Array.isArray(data?.cards) ? data.cards : [];
}

/**
 * 把对局工作台的玩家行转成后端可接受的结构（保留所有统计字段）。
 * 兼容 workspace.players（含 kpr/adr/kast/survival_rate）与 roster 行（仅基础字段）。
 */
export function toRadarPlayerPayload(player) {
  if (!player || typeof player !== "object") return null;
  const out = {
    player_key: String(player.player_key || player.key || ""),
    name: String(player.name || player.display_name || player.player_name || "Unknown"),
    display_name: String(player.display_name || player.name || player.player_name || ""),
    steam_id64: String(
      player.steam_id64 || player.steamid64 || player.target_steamid64 || player.steamid || "",
    ) || null,
    team_key: player.team_key != null ? String(player.team_key) : null,
    team_label: String(player.team_label || ""),
    kills: Number(player.kills) || 0,
    deaths: Number(player.deaths) || 0,
    assists: Number(player.assists) || 0,
    kd: Number(player.kd) || 0,
    kpr: Number(player.kpr) || 0,
    dpr: Number(player.dpr) || 0,
    adr: Number(player.adr) || 0,
    kast: Number(player.kast) || 0,
    survival_rate: Number(player.survival_rate) || 0,
    headshots: Number(player.headshots) || 0,
    first_kills: Number(player.first_kills) || 0,
    first_deaths: Number(player.first_deaths) || 0,
    trade_kills: Number(player.trade_kills) || 0,
    trade_deaths: Number(player.trade_deaths) || 0,
    opening_duel_win_rate: Number(player.opening_duel_win_rate) || 0,
    trade_kill_rate: Number(player.trade_kill_rate) || 0,
    clutch_attempts: Number(player.clutch_attempts) || 0,
    clutch_wins: Number(player.clutch_wins) || 0,
    awp_kills: Number(player.awp_kills) || 0,
    utility_damage: Number(player.utility_damage) || 0,
    rounds: Number(player.rounds || player.total_rounds) || null,
    // Multi-kill（多杀回合）所需：2 杀以上回合分布
    one_kill_rounds: Number(player.one_kill_rounds) || 0,
    two_kill_rounds: Number(player.two_kill_rounds) || 0,
    three_kill_rounds: Number(player.three_kill_rounds) || 0,
    four_kill_rounds: Number(player.four_kill_rounds) || 0,
    five_kill_rounds: Number(player.five_kill_rounds) || 0,
  };
  return out;
}

/** 删除一张雷达图卡片。 */
export async function deleteRadarCard(cardId) {
  await API.delete(`/cs-data-radar/cards/${encodeURIComponent(String(cardId))}`);
}

/** 上传人物图片（前端接口），后端自动重渲染该玩家雷达图。 */
export async function uploadRadarPortrait(cardId, file) {
  const form = new FormData();
  form.append("file", file);
  const { data } = await API.post(
    `/cs-data-radar/cards/${encodeURIComponent(String(cardId))}/portrait`,
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}

/** 上传队伍标志（放大显示在头像后面），后端自动重渲染；已有动画时同步重新生成。 */
export async function uploadRadarTeamLogo(cardId, file) {
  const form = new FormData();
  form.append("file", file);
  const { data } = await API.post(
    `/cs-data-radar/cards/${encodeURIComponent(String(cardId))}/team-logo`,
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}

/** 清除队伍标志并重渲染卡片；已有动画时同步重新生成。 */
export async function clearRadarTeamLogo(cardId) {
  const { data } = await API.delete(`/cs-data-radar/cards/${encodeURIComponent(String(cardId))}/team-logo`);
  return data;
}

/** 用前端 Canvas 渲染的 PNG 替换雷达图成品（例如嵌入游戏内头像后的再渲染）。 */
export async function replaceRadarCardImage(cardId, pngBlob) {
  const form = new FormData();
  form.append("file", pngBlob, "radar.png");
  const { data } = await API.put(
    `/cs-data-radar/cards/${encodeURIComponent(String(cardId))}/image`,
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}
