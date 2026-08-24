/** OBS 配置健康检查。 */

import { obsEncoderIsConfigured, obsEncoderIsHardware } from "./obsEncoderDisplay.js";

export function obsConfigHasIssues(status) {
  if (!status?.obs_connected) return false;
  const monW = status.monitor?.width;
  const monH = status.monitor?.height;
  const currentEncoder = status.recording?.encoder;
  const recommendedEncoder = status.recording?.recommended_encoder?.id;
  const hardwareUpgradeRecommended = obsEncoderIsConfigured(currentEncoder)
    && !obsEncoderIsHardware(currentEncoder)
    && obsEncoderIsHardware(recommendedEncoder);
  return !!(
    status.video?.base_width !== monW ||
    status.video?.base_height !== monH ||
    status.video?.output_width !== monW ||
    status.video?.output_height !== monH ||
    !status.scene?.dedicated_scene_exists ||
    !status.scene?.capture_source_exists ||
    !status.scene?.source_fit_to_canvas ||
    status.recording?.output_mode !== "Simple" ||
    !obsEncoderIsConfigured(currentEncoder) ||
    hardwareUpgradeRecommended ||
    status.recording?.format !== "hybrid_mp4" ||
    status.recording?.rec_quality === "Stream"
  );
}
