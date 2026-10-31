import { useEffect, useState } from "react";
import { Box } from "lucide-react";

import { imageUrlForWear } from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

export function defaultWear(item) {
  const min = Number(item?.wear_min ?? 0);
  const max = Number(item?.wear_max ?? 1);
  return Math.min(max, Math.max(min, 0.07));
}

/** Catalogue art, upgraded to the local Pro thumbnail when the item has one. */
export default function WorkshopItemImage({ item, wear, className = "", catalogOnly = false }) {
  const [failed, setFailed] = useState(false);
  const shownWear = wear ?? item?.paint_wear ?? defaultWear(item);
  const source = failed ? "" : imageUrlForWear(item?.image_url, shownWear, item);
  useEffect(() => setFailed(false), [item?.catalog_id, shownWear]);
  return <>
    {source ? <img src={source} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} className={`object-contain ${className}`} />
      : <span className={`flex items-center justify-center text-cs2-text-muted ${className}`}><Box className="h-8 w-8 opacity-45" /></span>}
  </>;
}
