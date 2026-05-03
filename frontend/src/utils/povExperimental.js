/** POV 实验性功能：与预热控制台指令冲突的 cvar（与后端 pov_experimental 对齐） */

export const POV_CONFLICT_CVARS = new Set([
  "cl_draw_only_deathnotices",
  "cl_trueview_show_status",
  "cl_spec_show_bindings",
  "cl_teamcounter_playercount_instead_of_avatars",
  "cl_drawhud_force_radar",
]);

/** @param {{ cvar?: string, command?: string, commands?: string[], conflictsWithExperimental?: string[] }} param */
export function isConflictWithPov(param) {
  if (!param) return false;
  if (Array.isArray(param.conflictsWithExperimental) && param.conflictsWithExperimental.includes("pov")) {
    return true;
  }
  if (param.cvar && POV_CONFLICT_CVARS.has(param.cvar)) {
    return true;
  }
  if (Array.isArray(param.commands)) {
    return param.commands.some((cmd) =>
      [...POV_CONFLICT_CVARS].some((cvar) => String(cmd).toLowerCase().includes(cvar.toLowerCase()))
    );
  }
  if (typeof param.command === "string") {
    return [...POV_CONFLICT_CVARS].some((cvar) => param.command.includes(cvar));
  }
  return false;
}
