// Preserve the saved appearance when reselecting the currently equipped item.
export function sameWorkshopItem(a, b) {
  return Boolean(a && b) && a.type === b.type
    && Number(a.def_index) === Number(b.def_index)
    && Number(a.paint_index ?? 0) === Number(b.paint_index ?? 0)
    && Number(a.experimental_paint_source_catalog_id ?? 0) === Number(b.experimental_paint_source_catalog_id ?? 0);
}

export function currentItemFirst(items, current, { keepStock = false } = {}) {
  return current ? [current, ...items.filter(item => (keepStock && item.is_base) || !sameWorkshopItem(item, current))] : items;
}
