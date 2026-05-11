function gcdInt(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** @param {number} w @param {number} h @param {"4:3"|"16:9"|"16:10"} aspect */
function resolutionMatchesAspect(w, h, aspect) {
  const g = gcdInt(w, h);
  const wn = Math.floor(w / g);
  const hn = Math.floor(h / g);
  if (aspect === "4:3") {
    if (wn * 3 === hn * 4) return true;
    return wn * 4 === hn * 5;
  }
  if (aspect === "16:9") return wn * 9 === hn * 16;
  if (aspect === "16:10") return wn * 10 === hn * 16;
  return false;
}

/**
 * 启动分辨率与屏幕比例校验（与 RecordWarmupModal 提交逻辑一致）。
 * @param {Record<string, unknown>} opts 需含 aspect_ratio、resolution_width、resolution_height
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateWarmupResolution(opts) {
  const arRaw = String(opts.aspect_ratio ?? "").trim();
  /** @type {"" | "4:3" | "16:9" | "16:10"} */
  const ar =
    arRaw === "4:3" || arRaw === "16:9" || arRaw === "16:10" ? arRaw : "";

  const w = String(opts.resolution_width ?? "").trim();
  const h = String(opts.resolution_height ?? "").trim();
  const rw = w ? parseInt(w, 10) : null;
  const rh = h ? parseInt(h, 10) : null;

  if ((rw != null && Number.isNaN(rw)) || (rh != null && Number.isNaN(rh))) {
    return { ok: false, message: "分辨率请填写有效数字，或留空。" };
  }
  if ((rw != null && rw <= 0) || (rh != null && rh <= 0)) {
    return { ok: false, message: "分辨率宽高须为正整数，或两者都留空。" };
  }
  if ((rw != null) !== (rh != null)) {
    return { ok: false, message: "分辨率请同时填写宽度与高度，或都留空。" };
  }
  if (ar && (rw == null || rh == null)) {
    return { ok: false, message: "已选择屏幕比例时必须填写启动分辨率宽度与高度。" };
  }
  if (rw != null && rh != null && !ar) {
    return { ok: false, message: "填写启动分辨率时必须选择屏幕比例（4:3 / 16:9 / 16:10）。" };
  }
  if (rw != null && rh != null && ar && !resolutionMatchesAspect(rw, rh, ar)) {
    return {
      ok: false,
      message: `分辨率 ${rw}×${rh} 与所选屏幕比例 ${ar} 不一致，请修正后再试。`,
    };
  }
  return { ok: true };
}

/**
 * 将「录制前观战」UI 状态（与 RecordWarmupModal DEFAULT_OPTIONS 对齐）转为写入配置的扁平对象。
 * @param {Record<string, unknown>} opts
 */
export function warmupUiOptsToPersisted(opts) {
  const rw = opts.resolution_width;
  const rh = opts.resolution_height;
  const fov = opts.fov_cs_debug;
  const hasFov = !!opts.apply_fov && fov != null && Number.isFinite(Number(fov));
  return {
    cl_draw_only_deathnotices: !!opts.cl_draw_only_deathnotices,
    hud_showtargetid_hide: !!opts.hud_showtargetid_hide,
    tv_nochat: !!opts.tv_nochat,
    spec_show_xray:
      opts.spec_show_xray === true ||
      opts.spec_show_xray === 1 ||
      opts.spec_show_xray === "1",
    apply_fov: hasFov,
    fov_cs_debug: hasFov ? Number(fov) : 90,
    viewmodel_fov_68: !!opts.viewmodel_fov_68,
    snd_voipvolume_mute: !!opts.snd_voipvolume_mute,
    hide_demo_playback_ui: !!opts.hide_demo_playback_ui,
    hide_grenade_trajectory_pip: !!opts.hide_grenade_trajectory_pip,
    aspect_ratio: opts.aspect_ratio != null ? String(opts.aspect_ratio) : "",
    resolution_width: rw != null && rw !== "" ? String(rw) : "",
    resolution_height: rh != null && rh !== "" ? String(rh) : "",
    pov_radar_mode: Number(opts.pov_radar_mode) === 0 ? 0 : -1,
    pov_teamcounter_numeric: opts.pov_teamcounter_numeric !== false,
  };
}

/**
 * 批量录制确认时的 API 载荷 → 配置扁平对象（分辨率等为 API 形态）。
 * @param {Record<string, unknown>} warmup
 */
export function warmupApiPayloadToPersisted(warmup) {
  const rw = warmup.resolution_width;
  const rh = warmup.resolution_height;
  const fov = warmup.fov_cs_debug;
  const hasFov = fov != null && Number.isFinite(Number(fov));
  return {
    cl_draw_only_deathnotices: !!warmup.cl_draw_only_deathnotices,
    hud_showtargetid_hide: !!warmup.hud_showtargetid_hide,
    tv_nochat: !!warmup.tv_nochat,
    spec_show_xray:
      warmup.spec_show_xray === 1 ||
      warmup.spec_show_xray === true ||
      warmup.spec_show_xray === "1",
    apply_fov: hasFov,
    fov_cs_debug: hasFov ? Number(fov) : 90,
    viewmodel_fov_68: !!warmup.viewmodel_fov_68,
    snd_voipvolume_mute: !!warmup.snd_voipvolume_mute,
    hide_demo_playback_ui: !!warmup.hide_demo_playback_ui,
    hide_grenade_trajectory_pip: !!warmup.hide_grenade_trajectory_pip,
    aspect_ratio: warmup.aspect_ratio != null ? String(warmup.aspect_ratio) : "",
    resolution_width: rw != null && rw !== "" ? String(rw) : "",
    resolution_height: rh != null && rh !== "" ? String(rh) : "",
    pov_radar_mode: Number(warmup.pov_radar_mode) === 0 ? 0 : -1,
    pov_teamcounter_numeric: warmup.pov_teamcounter_numeric !== false,
  };
}

export function formatResolutionSummary(aspectRatio, wStr, hStr) {
  const w = String(wStr || "").trim();
  const h = String(hStr || "").trim();
  if (w && h) return `${w}×${h}`;
  const ar = String(aspectRatio || "").trim();
  if (ar === "4:3") return "示例 1920×1440（填写宽高后显示实际值）";
  if (ar === "16:9") return "示例 1920×1080（填写宽高后显示实际值）";
  if (ar === "16:10") return "示例 1920×1200（填写宽高后显示实际值）";
  return "未指定输出分辨率";
}

export function aspectHint(aspectRatio) {
  const ar = String(aspectRatio || "").trim();
  if (ar === "4:3") return "适合赛事复古构图，画面两侧黑边或拉伸策略取决于 OBS 场景";
  if (ar === "16:9") return "适合主流视频平台全屏播放";
  if (ar === "16:10") return "适合部分宽屏显示器满屏取景";
  return "选择比例并填写宽高后，本次启动 CS2 将使用该画布录制";
}

export function aspectExportHint(aspectRatio) {
  const ar = String(aspectRatio || "").trim();
  if (ar === "4:3") return "横向成片偏「赛场转播」比例";
  if (ar === "16:9") return "横向成片偏「流媒体的默认」方向";
  if (ar === "16:10") return "横向成片略宽于 16:9 显示器常见比例";
  return "由 OBS 场景与画布决定最终导出方向；此处为游戏内渲染分辨率";
}
