import { AlertCircle, Loader2, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/useT.js";

function supportedAudioMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function recordFileName(mimeType) {
  const ext = mimeType.includes("ogg") ? "ogg" : "webm";
  return `voiceover-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
}

function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Browser microphone capture which hands the completed audio file to the media bin. */
export default function VoiceoverRecorder({ disabled = false, onRecorded }) {
  const t = useT();
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  const clearStream = useCallback(() => {
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      stopTimer();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      clearStream();
    },
    [clearStream, stopTimer],
  );

  const start = useCallback(async () => {
    if (disabled || recording || processing) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(t("liteCut.voiceover.browserUnsupported"));
      return;
    }
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const mimeType = supportedAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      streamRef.current = stream;
      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => setError(t("liteCut.voiceover.recordingFailed"));
      recorder.onstop = async () => {
        stopTimer();
        setRecording(false);
        setProcessing(true);
        try {
          const actualMimeType = recorder.mimeType || mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type: actualMimeType });
          if (blob.size) await onRecorded?.(new File([blob], recordFileName(actualMimeType), { type: actualMimeType }));
        } catch {
          setError(t("liteCut.voiceover.addFailed"));
        } finally {
          clearStream();
          recorderRef.current = null;
          chunksRef.current = [];
          setProcessing(false);
        }
      };
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      recorder.start(250);
      timerRef.current = window.setInterval(() => setElapsed((Date.now() - startedAtRef.current) / 1000), 250);
    } catch {
      clearStream();
      setError(t("liteCut.voiceover.permissionDenied"));
    }
  }, [clearStream, disabled, onRecorded, processing, recording, stopTimer, t]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-cs2-border/70 bg-cs2-surface-1/50 px-2.5 py-2">
      <button
        type="button"
        title={recording ? t("liteCut.voiceover.stop") : t("liteCut.voiceover.start")}
        disabled={disabled || processing}
        onClick={() => (recording ? stop() : void start())}
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          recording ? "bg-rose-500 text-white hover:bg-rose-400" : "bg-cs2-accent-soft text-cs2-accent hover:bg-cs2-accent hover:text-black"
        }`}
      >
        {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : recording ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className={`text-[10px] font-semibold ${recording ? "text-rose-300" : "text-cs2-text-secondary"}`}>
          {processing ? t("liteCut.voiceover.adding") : recording ? t("liteCut.voiceover.recording", { time: formatElapsed(elapsed) }) : t("liteCut.voiceover.start")}
        </p>
        {error ? (
          <p className="mt-0.5 flex items-center gap-1 text-[9px] text-rose-300"><AlertCircle className="h-3 w-3 shrink-0" />{error}</p>
        ) : (
          <p className="mt-0.5 text-[9px] text-cs2-text-muted">{t("liteCut.voiceover.hint")}</p>
        )}
      </div>
    </div>
  );
}
