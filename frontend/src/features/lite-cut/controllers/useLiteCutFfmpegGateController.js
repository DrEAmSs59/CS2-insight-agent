import { useCallback, useEffect, useState } from "react";
import { liteCutClient } from "../api/liteCutClient.js";
import { ffmpegGateSubtitle } from "../../../utils/ffmpegGateMessages.js";

const FFMPEG_GATE_IDLE = {
  loading: true,
  blocked: false,
  subtitle: "",
  message: "",
  framemeldAvailable: false,
};

export function useLiteCutFfmpegGateController({
  pathname,
  outputFrameMeldEnabled,
  patchOutput,
  t,
}) {
  const [ffmpegGate, setFfmpegGate] = useState(FFMPEG_GATE_IDLE);

  const checkFfmpegGate = useCallback(async ({ showLoading = true } = {}) => {
    if (showLoading) setFfmpegGate((previous) => ({ ...previous, loading: true }));
    try {
      const data = await liteCutClient.checkFfmpeg();
      if (data?.ok) {
        setFfmpegGate({
          loading: false,
          blocked: false,
          subtitle: "",
          message: "",
          framemeldAvailable: data?.framemeld_available === true,
        });
        return;
      }
      setFfmpegGate({
        loading: false,
        blocked: true,
        subtitle: ffmpegGateSubtitle(data?.reason, t),
        message: t("liteCut.ffmpegGateDefaultMessage"),
        framemeldAvailable: false,
      });
    } catch {
      setFfmpegGate({
        loading: false,
        blocked: true,
        subtitle: t("montage.ffmpegGateDetectFail"),
        message: t("montage.ffmpegGateConnectFail"),
        framemeldAvailable: false,
      });
    }
  }, [t]);

  useEffect(() => {
    void checkFfmpegGate();
  }, [checkFfmpegGate, pathname]);

  useEffect(() => {
    if (!ffmpegGate.loading && !ffmpegGate.framemeldAvailable && outputFrameMeldEnabled === true) {
      patchOutput({ framemeld_enabled: false });
    }
  }, [ffmpegGate.framemeldAvailable, ffmpegGate.loading, outputFrameMeldEnabled, patchOutput]);

  useEffect(() => {
    // Native file pickers temporarily blur the window. Recheck after focus
    // returns without remounting the editor or losing the pending file input.
    const onFocus = () => void checkFfmpegGate({ showLoading: false });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkFfmpegGate]);

  return { ffmpegGate, checkFfmpegGate };
}
