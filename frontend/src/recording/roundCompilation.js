// Shared by Free and Pro. Only raw demo facts cross this boundary; recording
// windows belong exclusively to the backend round planner.
export class RoundCompilationDataError extends Error {
  constructor(key = "ftd.errorNoWindows") { super(key); this.translationKey = key; }
}

const tick = (value) => value != null && value !== "" && typeof value !== "boolean" && Number.isInteger(Number(value)) && Number(value) >= 0
  ? Number(value) : null;

export function readRoundFacts(clip) {
  const raw = clip?.round_facts ?? clip?.freeze_to_death_round_windows;
  if (!Array.isArray(raw) || !raw.length) throw new RoundCompilationDataError();
  const seen = new Set();
  return raw.map((row) => {
    if (!row || typeof row !== "object") throw new RoundCompilationDataError();
    const round = Number(row.round);
    const freeze = tick(row.freeze_end_tick);
    if (!Number.isInteger(round) || round < 1 || seen.has(round) || freeze == null) throw new RoundCompilationDataError();
    seen.add(round);
    for (const key of ["round_start_tick", "round_end_tick", "death_tick"]) {
      if (row[key] != null && tick(row[key]) == null) throw new RoundCompilationDataError();
    }
    return { round, round_start_tick: tick(row.round_start_tick), freeze_end_tick: freeze,
      round_end_tick: tick(row.round_end_tick), death_tick: tick(row.death_tick) };
  }).sort((a, b) => a.round - b.round);
}

export function selectedRoundFacts(clip, facts = readRoundFacts(clip)) {
  const filter = clip.freeze_to_death_round_filter;
  if (filter == null) return facts;
  if (!Array.isArray(filter) || !filter.length) throw new RoundCompilationDataError("ftd.errorNeedsRound");
  const picks = new Set(filter.map(Number));
  const selected = facts.filter((row) => picks.has(row.round));
  if (!selected.length) throw new RoundCompilationDataError("ftd.errorNoIntersect");
  return selected;
}

export function withoutLegacyRoundWindows(clip) {
  const result = { ...clip };
  for (const key of ["source_ticks", "source_rounds", "source_round_ends", "fixed_segment_pacing",
    "kill_ticks", "death_ticks", "death_tick", "clip_min_tick", "clip_max_tick",
    "freeze_to_death_round_windows"]) delete result[key];
  return result;
}
