import API from "./api";

export async function getObsConfigStatus() {
  const { data } = await API.get("/obs-config/status");
  return data;
}

export async function calibrateObs() {
  const { data } = await API.post("/obs-config/calibrate");
  return data;
}
