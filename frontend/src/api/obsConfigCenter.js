import API from "./api";

export async function getObsConfigStatus() {
  const { data } = await API.get("/obs-config/status");
  return data;
}

export async function applyRecommendedObsPreset(body) {
  const { data } = await API.post("/obs-config/apply-recommended", body ?? {});
  return data;
}

export async function importNativeObsConfig(files, createBackup = true) {
  const form = new FormData();
  for (const f of files) {
    form.append("files", f);
  }
  form.append("create_backup", createBackup ? "true" : "false");
  const { data } = await API.post("/obs-config/import-native", form);
  return data;
}
