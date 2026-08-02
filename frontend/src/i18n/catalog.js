export function mergeCatalogs(locale, catalogs) {
  const merged = {};
  const owners = new Map();

  for (const [catalogName, entries] of Object.entries(catalogs)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new TypeError(`[i18n] ${locale}/${catalogName} must export an object`);
    }
    for (const [key, value] of Object.entries(entries)) {
      const previousOwner = owners.get(key);
      if (previousOwner) {
        throw new Error(`[i18n] duplicate key ${key} in ${locale}/${previousOwner} and ${locale}/${catalogName}`);
      }
      if (typeof value !== "string") {
        throw new TypeError(`[i18n] ${locale}/${catalogName}:${key} must be a string`);
      }
      owners.set(key, catalogName);
      merged[key] = value;
    }
  }

  return Object.freeze(merged);
}
