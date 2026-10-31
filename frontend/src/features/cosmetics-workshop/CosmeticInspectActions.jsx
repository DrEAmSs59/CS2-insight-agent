import { buildCs2InspectLink } from "../../utils/cs2Inspect.js";

export function cosmeticInspectLink(item) {
  if (!["weapon", "melee", "glove"].includes(item?.type) || item.experimental_paint_source_catalog_id) return "";
  try { return buildCs2InspectLink(item); } catch { return ""; }
}

export default function CosmeticInspectActions({ item, locale, busy, onInspectInGame, onCopy }) {
  const link = cosmeticInspectLink(item);
  return <>
    <button disabled={!link || busy} onClick={() => onInspectInGame(item)}>{locale === "en" ? "Inspect in game" : "游戏内检视"}</button>
    <button disabled={!link} onClick={() => onCopy(link)}>{locale === "en" ? "Copy inspect URL" : "复制饰品 URL"}</button>
  </>;
}
