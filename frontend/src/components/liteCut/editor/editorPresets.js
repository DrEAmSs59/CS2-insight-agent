/** LiteCut editor presets. */

import effectContract from "../../../../../data/lite_cut_effect_contract.json";

export const LITE_CUT_EFFECT_CONTRACT = effectContract;

const FILTER_THUMBNAIL_BACKGROUNDS = {
  none: "linear-gradient(135deg, #52525b 0%, #27272a 100%)",
  esports: "linear-gradient(135deg, #047857 0%, #18181b 100%)",
  cold: "linear-gradient(135deg, #155e75 0%, #0f172a 100%)",
  warm: "linear-gradient(135deg, #92400e 0%, #1c1917 100%)",
  vintage: "linear-gradient(135deg, #78350f 0%, #0c0a09 100%)",
  highcon: "linear-gradient(135deg, #404040 0%, #000000 100%)",
  fade: "linear-gradient(135deg, #78716c 0%, #292524 100%)",
  night: "linear-gradient(135deg, #172554 0%, #000000 100%)",
};

export const FILTER_PRESETS = effectContract.filter_presets.map((preset) => ({
  id: preset.id,
  label: preset.label_zh,
  filter: preset.css,
  ffmpeg: preset.ffmpeg,
  thumb: preset.thumb,
  thumbnailBackground: FILTER_THUMBNAIL_BACKGROUNDS[preset.id] || FILTER_THUMBNAIL_BACKGROUNDS.none,
}));

export function filterStyleFromColor({ brightness = 0, contrast = 0, saturation = 0, preset = "none" } = {}) {
  const presetFilter = FILTER_PRESETS.find((item) => item.id === preset)?.filter;
  const brightnessScale = 1 + (Number(brightness) || 0) / 100;
  const contrastScale = 1 + (Number(contrast) || 0) / 100;
  const saturationScale = 1 + (Number(saturation) || 0) / 100;
  return {
    filter: [
      presetFilter,
      `brightness(${brightnessScale})`,
      `contrast(${contrastScale})`,
      `saturate(${saturationScale})`,
    ]
      .filter((value) => value && value !== "none")
      .join(" "),
  };
}

/** Clipchamp-style visual text style cards */
export const TEXT_STYLE_CARDS = [
  {
    id: "plain",
    group: "plain",
    label: "纯文本",
    preview: "Aa",
    sample: "在此输入文字",
    className: "text-white font-medium tracking-wide",
    cardClass: "bg-zinc-800/90",
  },
  {
    id: "creator",
    group: "styles",
    label: "创作者",
    preview: "创作者",
    sample: "创作者",
    className: "text-yellow-300 font-black italic tracking-tighter drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]",
    cardClass: "bg-gradient-to-br from-zinc-800 to-zinc-950",
  },
  {
    id: "retro",
    group: "styles",
    label: "复古",
    preview: "复古",
    sample: "复古",
    className: "font-black text-transparent bg-clip-text bg-gradient-to-b from-pink-300 to-fuchsia-600",
    cardClass: "bg-gradient-to-br from-fuchsia-950 to-zinc-900",
  },
  {
    id: "bubble",
    group: "styles",
    label: "气泡",
    preview: "气泡",
    sample: "气泡",
    className: "rounded-full bg-white px-3 py-1 text-sm font-bold text-zinc-900",
    cardClass: "bg-zinc-700/80",
  },
  {
    id: "large-title",
    group: "titles",
    label: "大标题",
    preview: "标题",
    sample: "大标题",
    className: "text-2xl font-black uppercase tracking-[0.2em] text-white",
    cardClass: "bg-gradient-to-br from-neutral-800 to-black",
  },
  {
    id: "ace",
    group: "titles",
    label: "ACE 电竞",
    preview: "ACE",
    sample: "ACE!!",
    className: "text-3xl font-black italic text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)]",
    cardClass: "bg-gradient-to-br from-amber-950/80 to-zinc-950",
  },
  {
    id: "clutch",
    group: "titles",
    label: "残局",
    preview: "残局",
    sample: "CLUTCH",
    className: "text-xl font-black tracking-widest text-cyan-300",
    cardClass: "bg-gradient-to-br from-cyan-950 to-zinc-950",
  },
  {
    id: "namecard",
    group: "cs2",
    label: "CS2 名牌",
    preview: "Dream",
    sample: "Dream",
    className: "flex items-center gap-1.5 text-sm font-bold text-white",
    cardClass: "bg-gradient-to-r from-sky-950/90 to-zinc-900",
    badge: true,
  },
];

export const FONT_OPTIONS = [
  "思源黑体 Medium",
  "微软雅黑",
  "Impact",
  "Noto Sans SC",
];

export const TEXT_ANIMATION_OPTIONS = [
  { id: "", label: "无" },
  { id: "fade", label: "淡化" },
  { id: "slide_up", label: "上滑" },
  { id: "slide_down", label: "下滑" },
  { id: "slide_left", label: "左滑" },
  { id: "slide_right", label: "右滑" },
];

export const TRANSITION_OPTIONS = [
  { id: "cut", label: "硬切", icon: "▶|", builtin: true },
  { id: "fade", label: "淡化", icon: "◐", builtin: true },
  { id: "flash", label: "闪白", icon: "⚡", builtin: true },
  { id: "dip", label: "黑场", icon: "▪", builtin: true },
  { id: "zoom", label: "缩放", icon: "◎", builtin: true },
  { id: "wipe_l", label: "左擦", icon: "◀", builtin: true },
  { id: "wipe_r", label: "右擦", icon: "▶", builtin: true },
  { id: "slide_up", label: "上滑", icon: "↑", builtin: true },
  { id: "slide_down", label: "下滑", icon: "↓", builtin: true },
  { id: "blur", label: "模糊", icon: "◎", builtin: true },
  { id: "glitch", label: "故障", icon: "⌗", builtin: true },
  { id: "spin", label: "旋转", icon: "↻", builtin: true },
];

export const TOTAL_DURATION_SEC = 68;
