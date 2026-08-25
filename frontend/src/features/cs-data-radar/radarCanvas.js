/**
 * cs数据图 前端 Canvas 渲染 — 复刻 Rock-Radar-main 的六维霓虹雷达图。
 *
 * 与后端 Pillow 渲染器（backend/app/features/cs_data_radar/radar_renderer.py）
 * 保持同一套布局/配色/几何，供合辑工作台预览，以及上传人物图片 / 使用
 * 游戏内头像后在前端重渲染 PNG 并回传后端替换成品图。
 */
import {
  RADAR_DIMENSIONS,
  averageRadarValue,
  formatRadarValue,
  normalizeRadarValues,
} from "./radarDimensions";

export const RADAR_CANVAS_SIZE = 1600;

// Rock-Radar-main 的 20 套主题色
const COLOR_PRESETS = [
  ["#00ffff", "#001a1a", "#000d0d"],
  ["#ff00ff", "#1a001a", "#0d000d"],
  ["#ffff00", "#1a1a00", "#0d0d00"],
  ["#00ff00", "#001a00", "#000d00"],
  ["#ff4500", "#1a0700", "#0d0300"],
  ["#1e90ff", "#000f1a", "#00070d"],
  ["#ff0040", "#1a0006", "#0d0003"],
  ["#7cfc00", "#0c1a00", "#060d00"],
  ["#ba55d3", "#13091a", "#09040d"],
  ["#40e0d0", "#061a18", "#030d0c"],
  ["#f08080", "#1a0e0e", "#0d0707"],
  ["#00fa9a", "#001a10", "#000d08"],
  ["#ff8c00", "#1a0e00", "#0d0700"],
  ["#9370db", "#0f0b1a", "#07050d"],
  ["#00ced1", "#00151a", "#000a0d"],
  ["#ff1493", "#1a0210", "#0d0108"],
  ["#adff2f", "#111a03", "#080d01"],
  ["#b0c4de", "#12141a", "#090a0d"],
  ["#eea2ad", "#1a1112", "#0d0809"],
  ["#00bfff", "#00131a", "#00090d"],
];

const RED_HEX = "#ff3b3b"; // 全场平均线（红色六边形）
const BLUE_OUTER = "#3ea6ff"; // 最外圈最高刻度（发亮蓝色描线）
const GRID_GRAY = "rgba(150,160,175,0.3)"; // 内圈等级区间（灰色线条）
const W = RADAR_CANVAS_SIZE;
const CENTER = { x: 620, y: 840 }; // 居中偏左；半径缩小以容纳超出蓝色外圈的溢出数据
const MAX_R = 430; // 蓝色外圈（最高刻度）半径；超过满分的顶点可溢出圈外
const GRID_LEVELS = 5;
const LABEL_MARGIN = 40;

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function themeForPlayer(playerName, teamKey) {
  const team = String(teamKey || "").toLowerCase();
  if (team === "2" || team === "t" || team === "terrorist" || team === "terrorists") return COLOR_PRESETS[12];
  if (team === "3" || team === "ct" || team === "counter_terrorist" || team === "counter-terrorists") return COLOR_PRESETS[15];
  return COLOR_PRESETS[hashStr(String(playerName || "player")) % COLOR_PRESETS.length];
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return [255, 255, 255];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexVertices(cx, cy, radius, count = 6, rotation = -90) {
  const pts = [];
  for (let i = 0; i < count; i += 1) {
    const angle = ((i * (360 / count) + rotation) * Math.PI) / 180;
    pts.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return pts;
}

function drawGradient(ctx, bg1, bg2) {
  const top = hexToRgb(bg1);
  const bottom = hexToRgb(bg2);
  for (let y = 0; y < W; y += 2) {
    const t = y / W;
    ctx.fillStyle = `rgb(${Math.round(top[0] + (bottom[0] - top[0]) * t)}, ${Math.round(top[1] + (bottom[1] - top[1]) * t)}, ${Math.round(top[2] + (bottom[2] - top[2]) * t)})`;
    ctx.fillRect(0, y, W, 2);
  }
}

function drawParticles(ctx, color, seedText) {
  let seed = hashStr(`cs-data-radar:${seedText}`);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 42; i += 1) {
    const x = rand() * W;
    const y = rand() * W;
    const size = 1 + rand() * 1.6;
    const alpha = 0.08 + rand() * 0.32;
    const grad = 18 + rand() * 28;
    const g = ctx.createRadialGradient(x, y, 0, x, y, grad);
    g.addColorStop(0, rgba(color, alpha * 0.35));
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, grad, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGridAndAxes(ctx) {
  ctx.save();
  for (let layer = 1; layer <= GRID_LEVELS; layer += 1) {
    const r = (layer / GRID_LEVELS) * MAX_R;
    const pts = hexVertices(CENTER.x, CENTER.y, r);
    if (layer === GRID_LEVELS) {
      // 最外圈 = 最高刻度：发亮蓝色描线
      ctx.save();
      ctx.strokeStyle = BLUE_OUTER;
      ctx.lineWidth = 3;
      ctx.shadowColor = BLUE_OUTER;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    } else {
      // 内层灰色等级区间线
      ctx.strokeStyle = GRID_GRAY;
      ctx.lineWidth = 3;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = GRID_GRAY;
  for (let i = 0; i < 6; i += 1) {
    const [x, y] = hexVertices(CENTER.x, CENTER.y, MAX_R)[i];
    ctx.beginPath();
    ctx.moveTo(CENTER.x, CENTER.y);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGlowPolygon(ctx, color, values) {
  const pts = values.map((norm, i) => {
    // 超过满分刻度的顶点允许溢出到蓝色外圈之外（上限 1.6）
    const r = Math.max(0, Math.min(1.6, norm)) * MAX_R;
    return hexVertices(CENTER.x, CENTER.y, r)[i];
  });

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // 基础填充（主题色）
  ctx.fillStyle = rgba(color, 0.25);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fill();

  // 多层霓虹描边：主题色 → 白色高能射线
  const strokes = [
    { color, width: 6, blur: 22, alpha: 0.95 },
    { color, width: 4, blur: 10, alpha: 1 },
    { color: "#ffffff", width: 2, blur: 4, alpha: 0.95 },
    { color: "#ffffff", width: 1, blur: 0, alpha: 1 },
  ];
  for (const s of strokes) {
    ctx.save();
    if (s.blur > 0) {
      ctx.shadowBlur = s.blur;
      ctx.shadowColor = s.color;
    }
    ctx.strokeStyle = s.alpha < 1 ? rgba(s.color, s.alpha) : s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function formatMaxValue(dim) {
  if (dim.percentage) return `${Math.round(dim.maxScore * 100)}%`;
  const digits = dim.key === "kpr" || dim.key === "rating" ? 2 : dim.key === "adr" ? 1 : 0;
  return dim.maxScore.toFixed(digits);
}

function drawLabels(ctx, color, radar) {
  ctx.save();
  for (let i = 0; i < RADAR_DIMENSIONS.length; i += 1) {
    const dim = RADAR_DIMENSIONS[i];
    const angle = ((i * (360 / RADAR_DIMENSIONS.length) - 90) * Math.PI) / 180;
    const x = CENTER.x + (MAX_R + LABEL_MARGIN) * Math.cos(angle);
    const y = CENTER.y + (MAX_R + LABEL_MARGIN) * Math.sin(angle);
    ctx.textAlign = Math.abs(Math.cos(angle)) < 0.1 ? "center" : Math.cos(angle) > 0 ? "left" : "right";
    ctx.textBaseline = "middle";
    ctx.font = 'bold 30px "Rajdhani", "Orbitron", sans-serif';
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(dim.name, x, y - 16);
    ctx.font = '26px "Rajdhani", "Orbitron", sans-serif';
    ctx.fillStyle = rgba(color, 0.95);
    ctx.fillText(formatRadarValue(dim.key, radar?.[dim.key]), x, y + 16);
    // 蓝色外圈满分数值（最高刻度标注）
    ctx.font = '20px "Rajdhani", "Orbitron", sans-serif';
    ctx.fillStyle = "rgba(210,220,235,0.6)";
    ctx.fillText(`满分 ${formatMaxValue(dim)}`, x, y + 40);
  }
  ctx.restore();
}

function drawMatchAvgReference(ctx, radar, matchAvgRadar) {
  let pts;
  let avg;
  if (matchAvgRadar) {
    // 全场平均线：红色六边形（每个顶点 = 该维度全场平均值）
    const values = normalizeRadarValues(matchAvgRadar);
    pts = values.map((norm, i) => {
      const r = Math.max(0, Math.min(1.6, norm)) * MAX_R;
      return hexVertices(CENTER.x, CENTER.y, r)[i];
    });
    avg = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  } else {
    // 兜底：个人六维平均值的小六边形
    avg = averageRadarValue(radar);
    const radius = Math.max(46, avg * MAX_R * 0.55);
    pts = hexVertices(CENTER.x, CENTER.y, radius);
  }

  // 红色描线 + 辉光（无填充）
  ctx.save();
  ctx.shadowColor = RED_HEX;
  ctx.shadowBlur = 12;
  ctx.strokeStyle = RED_HEX;
  ctx.lineWidth = 3;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = 'bold 40px "Rajdhani", sans-serif';
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(avg.toFixed(2), CENTER.x, CENTER.y - 10);
  ctx.font = '24px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = RED_HEX;
  ctx.fillText(matchAvgRadar ? "全场均值" : "AVG", CENTER.x, CENTER.y + 26);
}

function loadPortrait(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    let objectUrl = "";
    fetch(url, { mode: "cors", credentials: "omit" })
      .then((res) => {
        if (!res.ok) throw new Error("portrait fetch failed");
        return res.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => resolve({ img, objectUrl });
        img.onerror = () => {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          resolve(null);
        };
        img.src = objectUrl;
      })
      .catch(() => resolve(null));
  });
}

function drawPortrait(ctx, portrait) {
  const panelX = 1260;
  const panelY = 470;
  const size = 260;
  ctx.save();
  ctx.beginPath();
  ctx.arc(panelX + size / 2, panelY + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (portrait) {
    ctx.drawImage(portrait, panelX, panelY, size, size);
  }
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(panelX + size / 2, panelY + size / 2, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = rgba("#ffffff", 0.9);
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();
}

function drawInitial(ctx, playerName, color) {
  const panelX = 1260;
  const panelY = 470;
  const size = 260;
  const initial = (String(playerName || "?").trim().slice(0, 1) || "?").toUpperCase();
  ctx.save();
  ctx.beginPath();
  ctx.arc(panelX + size / 2, panelY + size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 0.18);
  ctx.fill();
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = 'bold 120px "Rajdhani", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initial, panelX + size / 2, panelY + size / 2);
  ctx.restore();
}

function drawRightPanel(ctx, color, playerName, radar, teamLabel) {
  const panelX = 1260;
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  ctx.font = '46px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText("CS数据图", panelX, 150);

  ctx.font = 'bold 58px "Rajdhani", sans-serif';
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fillStyle = color;
  ctx.fillText(playerName, panelX, 240);
  ctx.shadowBlur = 0;

  if (teamLabel) {
    ctx.font = '24px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText(teamLabel, panelX, 306);
  }

  // 底部六维构成
  ctx.font = '26px "Rajdhani", sans-serif';
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  const line = RADAR_DIMENSIONS.map(
    (dim) => `${dim.name} ${formatRadarValue(dim.key, radar?.[dim.key])}`,
  ).join("  ·  ");
  ctx.fillText(line, 40, 1460);
  ctx.font = '22px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillText("蓝色外圈 = 最高刻度 · 灰色内圈 = 等级区间 · 主题色多边形 = 玩家数据 · 红色六边形 = 全场平均线", 40, 1540);
  ctx.restore();
}

/**
 * 渲染一张 1600×1600 的 cs数据图 雷达卡片到 canvas。
 * @param {HTMLCanvasElement} canvas
 * @param {{playerName: string, radar: object, matchAvgRadar?: object, portraitUrl?: string, teamKey?: string|number, teamLabel?: string}} opts
 * @returns {Promise<void>}
 */
export async function renderRadarCardToCanvas(canvas, opts) {
  const { playerName, radar, matchAvgRadar, portraitUrl = "", teamKey, teamLabel = "" } = opts || {};
  const ctx = canvas.getContext("2d");
  canvas.width = W;
  canvas.height = W;

  const [color, bg1, bg2] = themeForPlayer(playerName, teamKey);

  drawGradient(ctx, bg1, bg2);
  drawParticles(ctx, color, playerName);
  drawGridAndAxes(ctx);
  const values = normalizeRadarValues(radar);
  drawGlowPolygon(ctx, color, values);
  drawLabels(ctx, color, radar);
  drawMatchAvgReference(ctx, radar, matchAvgRadar);

  // 头像：上传图片 / 游戏内头像 URL → 圆形裁剪；失败则昵称首字占位
  const portrait = await loadPortrait(portraitUrl);
  if (portrait) {
    drawPortrait(ctx, portrait.img);
    if (portrait.objectUrl) URL.revokeObjectURL(portrait.objectUrl);
  } else {
    drawInitial(ctx, playerName, color);
  }
  drawRightPanel(ctx, color, playerName, radar, teamLabel);
}

/** 把已渲染的卡片导出为 PNG Blob。 */
export function radarCardToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob failed"))), "image/png");
  });
}
