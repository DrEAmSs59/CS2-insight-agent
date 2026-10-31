const FREE_NAME_MARKER = "cs2 insight agent";

export function originalCosmeticName(...sources) {
  for (const source of sources) {
    if (typeof source?.custom_name !== "string") continue;
    const name = source.custom_name;
    if (name.trim().toLowerCase() === FREE_NAME_MARKER) continue;
    return name.trim() ? name : "";
  }
  return "";
}

export function replacementCosmeticName(original, replacement) {
  const edited = replacement?.attachment_edit_version === 1
    && (!Array.isArray(replacement.attachment_edit_fields)
      || replacement.attachment_edit_fields.includes("custom_name"));
  const name = replacement?.custom_name;
  return edited && typeof name === "string" && name.trim()
    ? name : originalCosmeticName(original);
}
