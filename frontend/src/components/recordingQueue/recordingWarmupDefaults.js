import { SPECTATOR_FLASHBANG_OPACITY_DEFAULT } from "../../utils/warmupDefaults";
import { DEFAULT_INPUT_HUD_POSITION } from "../../utils/inputHudPlacement.js";
import { DEFAULT_POV_VOICE_MODE } from "../../utils/povVoiceMode.js";
export const RECORD_WARMUP_DEFAULT_OPTIONS = {
  cl_draw_only_deathnotices: true,
  hud_showtargetid_hide: true,
  hide_clan_tags: true,
  persistent_killfeed: false,
  tv_nochat: true,
  spec_show_xray: false,
  apply_fov: false,
  fov_cs_debug: 90,
  viewmodel_fov_68: false,
  third_person_camera: false,
  apply_spectator_flashbang_opacity: false,
  spectator_flashbang_opacity: SPECTATOR_FLASHBANG_OPACITY_DEFAULT,
  hide_demo_playback_ui: true,
  hide_grenade_trajectory_pip: true,
  aspect_ratio: "",
  resolution_width: "",
  resolution_height: "",
  /** POV 雷达不再提供录制选项，成片固定显示。 */
  pov_radar_mode: 0,
  /** POV：true 正上方显示存活人数；false 显示双方十人头像（默认关存活人数条） */
  pov_teamcounter_numeric: false,
  /** POV：语音播放与左下角说话标识使用同一受众范围。 */
  pov_voice_mode: DEFAULT_POV_VOICE_MODE,
  /** Whether to render the authoritative in-game keyboard/mouse HUD. */
  input_hud_enabled: true,
  /** OBS overlay-compatible on-screen anchor for the in-game keyboard/mouse HUD. */
  input_hud_position: DEFAULT_INPUT_HUD_POSITION,
  /** Visibility policy for the in-game keyboard/mouse HUD. */
  input_hud_display_mode: "hybrid",
  /** Preserved while its editor is temporarily hidden; default off. */
  input_audio_enabled: false,
  /** Whether to show the per-Pawn K/D/A and damage block in the recording VPK. */
  combat_stats_hud_enabled: true
  /** Follow the observed player's TAB to open and close the scoreboard. */

  /** POV death flash, fade, and killer banner. Off until explicitly enabled. */
};

/** 录制预热弹窗每次打开时的 OBS 转场推荐默认值；勾选关闭则提交 null 沿用服务器全局配置 */
export const RECORD_WARMUP_DEFAULT_OBS_TRANSITION = {
  enabled: true,
  name: "Fade",
  durationMs: 200
};
