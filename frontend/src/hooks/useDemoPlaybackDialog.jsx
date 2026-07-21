import { useCallback, useState } from "react";

import DemoPlayOptionsModal from "../components/DemoPlayOptionsModal.jsx";
import { useT } from "../i18n/useT.js";
import { getDemoPlaybackPreflight, playDemoErrorLabel, playDemoInCs2 } from "../utils/playDemoInCs2.js";
import { parseApiDetail } from "../utils/apiErrorMessages.js";
import { usePlayDemoToast } from "./usePlayDemoToast.jsx";

function blockedReasonFromPreflight(data) {
  if (!data?.cs2_path_configured) return "path";
  if (data?.cs2_running) return "running";
  if (data?.playback_active) return "busy";
  return "";
}

function blockedReasonFromError(error) {
  const { code } = parseApiDetail(error?.response?.data?.detail);
  if (code === "DEMO_PLAYBACK_CS2_RUNNING") return "running";
  if (code === "DEMO_PLAYBACK_BUSY") return "busy";
  if (code === "DEMO_PLAYBACK_CS2_PATH_MISSING") return "path";
  return "";
}

export function useDemoPlaybackDialog() {
  const t = useT();
  const { showPlayToast, PlayDemoToast } = usePlayDemoToast();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(null);
  const [checking, setChecking] = useState(false);
  const [blockedReason, setBlockedReason] = useState("");
  const [launchingMode, setLaunchingMode] = useState("");
  const [error, setError] = useState("");

  const runPreflight = useCallback(async () => {
    setChecking(true);
    setBlockedReason("");
    setError("");
    try {
      const data = await getDemoPlaybackPreflight();
      setBlockedReason(blockedReasonFromPreflight(data));
    } catch (preflightError) {
      // The launch endpoint remains authoritative; keep the choices available if preflight itself fails.
      setError(playDemoErrorLabel(preflightError, t));
    } finally {
      setChecking(false);
    }
  }, [t]);

  const requestPlayDemo = useCallback(async ({ id = null, path = null, label = "Demo" } = {}) => {
    setTarget({ id, path, label });
    setOpen(true);
    setLaunchingMode("");
    await runPreflight();
  }, [runPreflight]);

  const close = useCallback(() => {
    if (launchingMode) return;
    setOpen(false);
    setTarget(null);
    setBlockedReason("");
    setError("");
  }, [launchingMode]);

  const launch = useCallback(async (mode) => {
    if (!target || launchingMode) return;
    setLaunchingMode(mode);
    setError("");
    try {
      await playDemoInCs2({
        id: target.id,
        path: target.path,
        povHud: {
          enabled: mode === "pov",
          radar_mode: 0,
          teamcounter_numeric: false,
        },
      });
      setOpen(false);
      setTarget(null);
      setBlockedReason("");
      showPlayToast(true, target.label || "Demo");
    } catch (launchError) {
      const nextBlockedReason = blockedReasonFromError(launchError);
      if (nextBlockedReason) {
        setBlockedReason(nextBlockedReason);
      } else {
        setError(playDemoErrorLabel(launchError, t));
      }
    } finally {
      setLaunchingMode("");
    }
  }, [launchingMode, showPlayToast, t, target]);

  const DemoPlaybackUi = useCallback(() => (
    <>
      <DemoPlayOptionsModal
        open={open}
        demoLabel={target?.label}
        checking={checking}
        blockedReason={blockedReason}
        error={error}
        launchingMode={launchingMode}
        onClose={close}
        onRetry={runPreflight}
        onPlayNormal={() => void launch("normal")}
        onPlayPov={() => void launch("pov")}
      />
      <PlayDemoToast />
    </>
  ), [PlayDemoToast, blockedReason, checking, close, error, launch, launchingMode, open, runPreflight, target?.label]);

  return { requestPlayDemo, DemoPlaybackUi };
}
