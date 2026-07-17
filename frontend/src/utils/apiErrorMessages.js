/** Maps backend api_errors codes → frontend i18n keys. */

export const API_ERROR_I18N_KEYS = {
  RECORDING_DEMO_PATH_EMPTY: "api.err.recordingDemoPathEmpty",
  RECORDING_DEMO_NOT_FOUND: "api.err.recordingDemoNotFound",
  RECORDING_CS2_PATH_MISSING: "api.err.recordingCs2PathMissing",
  RECORDING_CS2_RUNNING: "api.err.recordingCs2Running",
  RECORDING_CONFIG_RESTORE_REQUIRED: "app.recordBlockedConfigNotRestored",
  RECORDING_OBS_CONNECT_FAIL: "api.err.recordingObsConnectFail",
  RECORDING_ALREADY_RUNNING: "api.err.recordingAlreadyRunning",
  RECORDING_GSI_NOT_READY: "api.err.recordingGsiNotReady",
  RECORDING_FAILED: "api.err.recordingFailed",
  CS2_RUNNING: "app.restoreBlockedCs2Running",
  CONFIG_RESTORE_OK: "app.playerConfigRestored",
  CONFIG_RESTORE_NOT_NEEDED: "playercfg.okTitle",
  CONFIG_RESTORE_PARTIAL: "app.playerConfigRestorePartial",
  CONFIG_NO_MANIFEST: "api.err.configNoManifest",
  CONFIG_OPEN_DIR_FAIL: "app.openDirManual",
  MONTAGE_EXPORT_FAILED: "montage.exportErrorGeneric",
  MONTAGE_NO_CLIPS: "montage.exportErrorNoClips",
  MONTAGE_PROJECT_NOT_FOUND: "montage.err.projectNotFound",
  MONTAGE_CLIP_NOT_FOUND: "montage.err.clipNotFound",
  MONTAGE_CLIP_ALREADY_DELETED: "montage.err.clipAlreadyDeleted",
  MONTAGE_FFMPEG_NOT_FOUND: "montage.err.ffmpegNotFound",
  MONTAGE_FFMPEG_PATH_MISSING: "montage.err.ffmpegPathMissing",
  MONTAGE_FFMPEG_NOT_RUNNABLE: "montage.err.ffmpegNotRunnable",
  MONTAGE_FFPROBE_NOT_FOUND: "montage.err.ffprobeNotFound",
  MONTAGE_FFPROBE_FAILED: "montage.err.ffprobeFailed",
  MONTAGE_OUTPUT_PATH_EMPTY: "montage.err.outputPathEmpty",
  MONTAGE_OUTPUT_PATH_NOT_ABSOLUTE: "montage.err.outputPathNotAbsolute",
  MONTAGE_OUTPUT_NOT_MP4: "montage.err.outputNotMp4",
  MONTAGE_OUTPUT_PATH_INVALID: "montage.err.outputPathInvalid",
  MONTAGE_OUTPUT_PARENT_CREATE_FAILED: "montage.err.outputParentCreateFailed",
  MONTAGE_OUTPUT_DIR_NOT_FOLDER: "montage.err.outputDirNotFolder",
  MONTAGE_OUTPUT_NAME_EXHAUSTED: "montage.err.outputNameExhausted",
  MONTAGE_OUTPUT_SPACE_CHECK_FAILED: "montage.err.outputSpaceCheckFailed",
  MONTAGE_OUTPUT_DISK_FULL: "montage.err.outputDiskFull",
  MONTAGE_OUTPUT_NOT_PLAYABLE: "montage.err.outputNotPlayable",
  MONTAGE_CLIPS_EMPTY: "montage.exportErrorNoClips",
  MONTAGE_CLIP_FILE_MISSING: "montage.err.clipFileMissing",
  MONTAGE_SOURCE_NOT_READABLE: "montage.err.sourceNotReadable",
  LITECUT_EXPORT_INTERRUPTED: "montage.err.exportInterrupted",
  MONTAGE_INTRO_MISSING: "montage.err.introMissing",
  MONTAGE_OUTRO_MISSING: "montage.err.outroMissing",
  MONTAGE_BGM_MISSING: "montage.err.bgmMissing",
  MONTAGE_CLIP_NORMALIZE_FAILED: "montage.err.clipNormalizeFailed",
  MONTAGE_TRANSITION_TOO_LONG: "montage.err.transitionTooLong",
  MONTAGE_TRANSITION_FAILED: "montage.err.transitionFailed",
  MONTAGE_CONCAT_FAILED: "montage.err.concatFailed",
  MONTAGE_FINALIZE_FAILED: "montage.err.finalizeFailed",
  MONTAGE_BGM_MIX_FAILED: "montage.err.bgmMixFailed",
  MONTAGE_IMAGE_TO_VIDEO_FAILED: "montage.err.imageToVideoFailed",
  MONTAGE_FIRST_CLIP_NO_RESOLUTION: "montage.err.firstClipNoResolution",
};

export const API_ERROR_SUBTITLE_KEYS = {
  RECORDING_CS2_RUNNING: "dialog.recordBlockedSubRunning",
  RECORDING_CONFIG_RESTORE_REQUIRED: "dialog.recordBlockedSubConfigRestore",
  RECORDING_ALREADY_RUNNING: "dialog.recordBlockedSubAlreadyRecording",
  RECORDING_GSI_NOT_READY: "dialog.recordBlockedSubGsi",
  RECORDING_OBS_CONNECT_FAIL: "dialog.recordBlockedSubDefault",
  RECORDING_CS2_PATH_MISSING: "dialog.recordBlockedSubDefault",
  CS2_RUNNING: "dialog.recordBlockedSubRunning",
};

/**
 * @param {unknown} detail - FastAPI detail field
 * @returns {{ code: string | null, params: Record<string, unknown> }}
 */
export function parseApiDetail(detail) {
  if (detail != null && typeof detail === "object" && !Array.isArray(detail)) {
    const code = typeof detail.code === "string" ? detail.code : null;
    const params =
      detail.params && typeof detail.params === "object" && !Array.isArray(detail.params)
        ? detail.params
        : {};
    return { code, params };
  }
  return { code: null, params: {} };
}

/**
 * @param {string | null} code
 * @param {(key: string, params?: object) => string} t
 * @param {Record<string, unknown>} [params]
 * @returns {string | null}
 */
export function messageFromApiCode(code, t, params = {}) {
  if (!code) return null;
  const key = API_ERROR_I18N_KEYS[code];
  if (!key) return null;
  return t(key, params);
}
