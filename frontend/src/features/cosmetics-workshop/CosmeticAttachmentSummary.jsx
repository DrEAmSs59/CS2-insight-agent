import { useT } from "../../i18n/useT.js";

export function CosmeticNameTag({ item }) {
  return item?.custom_name ? <span className="block break-words text-[11px] font-black leading-snug text-cs2-text-primary">“{item.custom_name}”</span> : null;
}

// Attachments belong to the image surface, matching the Demo inventory cards.
export default function CosmeticAttachmentSummary({ item, locale = "zh", onlineAssetsEnabled = true, size = "normal", layout = "summary" }) {
  const t = useT();
  const stickers = Array.isArray(item?.stickers) ? item.stickers : [];
  const keychain = Object.hasOwn(item || {}, "keychain") ? item.keychain : item?.keychains?.[0];
  const name = (value) => (locale.startsWith("zh") ? value.name_zh || value.name_en : value.name_en || value.name_zh) || `#${value.definition_id ?? value.paint_index ?? value.sticker_id ?? "?"}`;
  if (!stickers.length && !keychain) return null;
  const icon = (value, label) => onlineAssetsEnabled && value.image_url
    ? <img src={value.image_url} alt={label} loading="lazy" className="h-full w-full object-contain drop-shadow" />
    : <span className="flex h-full items-center justify-center text-[9px] text-cs2-text-muted" aria-label={label}>◇</span>;
  if (layout === "inventory") return <span data-testid="cosmetic-attachment-summary" className="lucas-tile-attachments">
    {keychain && <span title={`${t("cosmeticsWorkshop.attachments.keychain")} · ${name(keychain)}`}><span className="h-5 w-5">{icon(keychain, name(keychain))}</span></span>}
    {stickers.length > 0 && <span>{stickers.map((sticker, index) => <span key={index} title={name(sticker)} className="h-5 w-5">{icon(sticker, name(sticker))}</span>)}</span>}
  </span>;
  const iconSize = size === "large" ? "h-12 w-12 sm:h-20 sm:w-20" : "h-8 w-8";
  return <span data-testid="cosmetic-attachment-summary" className={`absolute z-[1] flex items-end justify-between gap-1 ${size === "large" ? "inset-x-2 bottom-2" : "inset-x-1 bottom-1"}`}>
    <span className="flex min-w-0 items-end gap-1">{stickers.map((sticker, index) => <span key={index} title={name(sticker)} className={`block ${iconSize} min-w-0 shrink aspect-square`}>{icon(sticker, name(sticker))}</span>)}</span>
    {keychain ? <span title={`${t("cosmeticsWorkshop.attachments.keychain")} · ${name(keychain)}`} className={`block ${iconSize} shrink-0`}>{icon(keychain, name(keychain))}</span> : null}
  </span>;
}
