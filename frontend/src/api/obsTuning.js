import API from "./api";

export async function discoverObsTuningEnvironment() {
  const { data } = await API.get("/obs-tuning/discovery", { timeout: 20000 });
  return data;
}

export async function bootstrapObsTuningEnvironment({ password, allowWebsocketConfigWrite = true, launchIfNeeded = true } = {}) {
  const { data } = await API.post("/obs-tuning/bootstrap", {
    allow_websocket_config_write: allowWebsocketConfigWrite,
    launch_if_needed: launchIfNeeded,
    password: password || null,
  });
  return data;
}

export async function recommendObsTuningGoal(goal, discovery) {
  const { data } = await API.post("/obs-tuning/recommendation", { goal, discovery });
  return data;
}

export async function createObsTuningPlan(goal) {
  const { data } = await API.post("/obs-tuning/plan", { goal }, { timeout: 50000 });
  return data;
}

export async function applyObsTuningPlan(goal, planHash) {
  const { data } = await API.post("/obs-tuning/apply", { goal, plan_hash: planHash }, { timeout: 75000 });
  return data;
}

export async function restoreObsTuningBackup(backupId) {
  const { data } = await API.post(`/obs-config/backups/${encodeURIComponent(backupId)}/restore`);
  return data;
}
