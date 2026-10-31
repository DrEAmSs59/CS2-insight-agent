import { useState } from "react";
import { CS2Team } from "@ianlucas/cs2-lib";

const KEY = "cs2-insight:cosmetics-workshop-loadout-selection:v1";

export function useWorkshopLoadoutSelection(plans) {
  const [selection, setSelection] = useState(() => {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* Invalid UI preferences do not alter loadouts. */ }
    return {
      // Every workshop visit starts on the first scheme; keep the preview side.
      selectedId: plans[0]?.id || "",
      team: saved?.team === CS2Team.T ? CS2Team.T : CS2Team.CT,
    };
  });
  function update(next) {
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { return false; }
    setSelection(next);
    return true;
  }
  return [selection, update];
}
