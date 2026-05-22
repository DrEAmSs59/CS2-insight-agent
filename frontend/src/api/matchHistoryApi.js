import API from "./api";

export async function fetchMatchHistory() {
  const { data } = await API.get("/match-history/matches");
  return data;
}

export async function testSteamConnection(steam_api_key, steam_id64) {
  const { data } = await API.post("/match-history/test-connection", { steam_api_key, steam_id64 });
  return data;
}

export async function downloadMatchDemo(demo_url, match_id, filename) {
  const { data } = await API.post("/match-history/download", { demo_url, match_id, filename });
  return data;
}

export function saveMatchCredentials(steam_api_key, steam_id64, match_mode, match_count) {
  return API.put("/config", { steam_api_key, steam_id64, match_mode, match_count });
}
