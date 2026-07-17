const RECOVERY_PREFIX = "liteCut:recovery:v1:";
const LAST_PROJECT_KEY = "liteCut:lastProjectId";

function storageOrNull() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function recoveryStorageKey(projectId) {
  return `${RECOVERY_PREFIX}${Number(projectId)}`;
}

export function rememberLiteCutProject(projectId) {
  const storage = storageOrNull();
  const id = Number(projectId);
  if (!storage || !Number.isFinite(id) || id <= 0) return false;
  try {
    storage.setItem(LAST_PROJECT_KEY, String(id));
    return true;
  } catch {
    return false;
  }
}

export function rememberedLiteCutProjectId() {
  const storage = storageOrNull();
  if (!storage) return null;
  const id = Number(storage.getItem(LAST_PROJECT_KEY));
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function forgetRememberedLiteCutProject(projectId = null) {
  const storage = storageOrNull();
  if (!storage) return;
  if (projectId != null && Number(storage.getItem(LAST_PROJECT_KEY)) !== Number(projectId)) return;
  storage.removeItem(LAST_PROJECT_KEY);
}

export function writeLiteCutRecoveryDraft({ projectId, projectName, body }) {
  const storage = storageOrNull();
  const id = Number(projectId);
  if (!storage || !Number.isFinite(id) || id <= 0 || !body) return false;
  try {
    storage.setItem(recoveryStorageKey(id), JSON.stringify({
      version: 1,
      projectId: id,
      projectName: String(projectName || "LiteCut Project"),
      body,
      savedAt: Date.now(),
    }));
    rememberLiteCutProject(id);
    return true;
  } catch {
    return false;
  }
}

export function readLiteCutRecoveryDraft(projectId) {
  const storage = storageOrNull();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(recoveryStorageKey(projectId)) || "null");
    return parsed?.version === 1 && Number(parsed.projectId) === Number(projectId) && parsed.body ? parsed : null;
  } catch {
    return null;
  }
}

export function clearLiteCutRecoveryDraft(projectId) {
  storageOrNull()?.removeItem(recoveryStorageKey(projectId));
}

export function recoveryDraftDiffers(draft, projectName, body) {
  if (!draft?.body || !body) return false;
  try {
    return String(draft.projectName || "") !== String(projectName || "")
      || JSON.stringify(draft.body) !== JSON.stringify(body);
  } catch {
    return true;
  }
}
