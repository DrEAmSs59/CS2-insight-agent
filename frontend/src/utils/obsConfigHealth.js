/** OBS 配置中心健康检查（与 ObsConfigCenterPage 状态列表一致）。 */

export function obsConfigHasIssues(status) {
  if (!status?.obs_connected) return false;
  const monW = status.monitor?.width;
  const monH = status.monitor?.height;
  return !!(
    status.video?.base_width !== monW ||
    status.video?.base_height !== monH ||
    status.video?.output_width !== monW ||
    status.video?.output_height !== monH ||
    !status.scene?.dedicated_scene_exists ||
    !status.scene?.capture_source_exists ||
    !status.scene?.source_fit_to_canvas ||
    status.recording?.format !== "hybrid_mp4" ||
    status.recording?.rec_quality === "Stream"
  );
}
