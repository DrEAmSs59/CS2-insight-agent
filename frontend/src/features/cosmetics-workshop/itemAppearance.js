/** Free edits only paint wear and pattern; original attachments stay with the Demo. */
export function editorDraft(item) {
  return { ...item, paint_seed: 0, paint_wear: Number(item.wear_min || 0) };
}
