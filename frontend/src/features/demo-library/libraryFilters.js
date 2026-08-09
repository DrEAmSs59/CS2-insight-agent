export function appendLibraryFilterParams(params, filters) {
  const f = filters;
  if (f.mapName.trim()) params.map_name = f.mapName.trim();
  if (f.status && f.status !== "all") params.status = f.status;

  const playerQuery = f.playerQuery.trim();
  if (playerQuery) params.player_query = playerQuery;
  const steamQuery = f.steamQuery.trim();
  if (steamQuery) params.steam_query = steamQuery;

  const integer = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const parsed = parseInt(text, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const decimal = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const parsed = parseFloat(text);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const dateBoundary = (value, endOfDay) => {
    const date = String(value ?? "").trim();
    if (!date) return null;
    const local = new Date(`${date}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
    return Number.isNaN(local.getTime()) ? null : local.toISOString();
  };

  const minKills = integer(f.minKills);
  if (minKills != null) params.min_kills = minKills;
  const maxDeaths = integer(f.maxDeaths);
  if (maxDeaths != null) params.max_deaths = maxDeaths;
  const minAssists = integer(f.minAssists);
  if (minAssists != null) params.min_assists = minAssists;
  const minKd = decimal(f.minKd);
  if (minKd != null) params.min_kd = minKd;
  const roundsMin = integer(f.roundsMin);
  if (roundsMin != null) params.rounds_min = roundsMin;
  const roundsMax = integer(f.roundsMax);
  if (roundsMax != null) params.rounds_max = roundsMax;
  const durationMin = decimal(f.durationMin);
  if (durationMin != null) params.duration_min = durationMin;
  const durationMax = decimal(f.durationMax);
  if (durationMax != null) params.duration_max = durationMax;
  const dateFrom = dateBoundary(f.dateFrom, false);
  if (dateFrom) params.date_from = dateFrom;
  const dateTo = dateBoundary(f.dateTo, true);
  if (dateTo) params.date_to = dateTo;

  return params;
}

export function hasActiveLibraryFilters(filters) {
  const text = (value) => String(value ?? "").trim();
  return Boolean(
    filters.mapName.trim() ||
      (filters.status && filters.status !== "all") ||
      filters.playerQuery.trim() ||
      filters.steamQuery.trim() ||
      text(filters.minKills) ||
      text(filters.maxDeaths) ||
      text(filters.minAssists) ||
      text(filters.minKd) ||
      text(filters.roundsMin) ||
      text(filters.roundsMax) ||
      text(filters.durationMin) ||
      text(filters.durationMax) ||
      text(filters.dateFrom) ||
      text(filters.dateTo)
  );
}
