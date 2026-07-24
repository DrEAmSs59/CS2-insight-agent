import { useEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  CheckCircle2,
  Copy,
  FileVideo2,
  FolderOpen,
  MonitorPlay,
  Tags,
  XCircle,
} from "lucide-react";
import Modal from "../ui/Modal";
import API, { getRecordedClipStreamUrl } from "../../api/api";
import {
  clipTypeI18nKey,
  friendlyClipTitleForQueue,
  getClipDurationSeconds,
  getMontageExtraVictimPovCount,
  getRecordedClipPerspectivePrimaryZh,
  montageTypeTagBadgeClass,
  normalizeClipType,
} from "../../utils/montageUtils";
import { weaponUsedTokens } from "../../i18n/weaponNames.js";
import { useT } from "../../i18n/useT.js";
import { useLocaleStore } from "../../i18n/localeStore";

const TYPE_ACCENT_CLASSES = {
  "高光": "bg-cs2-highlight",
  "击杀": "bg-cs2-highlight",
  "下饭": "bg-cs2-fail",
  "梗死亡": "bg-fuchsia-400",
  "合集": "bg-cs2-compilation",
  "击杀合集": "bg-cs2-compilation",
  "死亡合集": "bg-cs2-compilation",
  "回合合集": "bg-cs2-compilation",
  "时间线": "bg-cyan-400",
  "时间线击杀": "bg-emerald-400",
  "时间线死亡": "bg-rose-400",
  "时间线整回合": "bg-cyan-400",
};

function isAborted(result) {
  return (
    !result.success &&
    (result.error === "aborted" ||
      String(result.error || "").toLowerCase() === "aborted")
  );
}

function fileName(value) {
  const raw = String(value || "").trim();
  return raw ? raw.split(/[\\/]/).pop() || raw : "";
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function formatDuration(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n >= 0 ? `${n.toFixed(1)}s` : "--";
}

function resultKey(result, fallbackIndex = 0) {
  return String(result?.request_id ?? result?.recorded_clip_id ?? result?._index ?? fallbackIndex);
}

function recordedClipId(result, clip) {
  const id = Number(result?.recorded_clip_id ?? clip?.recorded_clip_id ?? clip?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function resultClip(result) {
  const queueItem = result?._queueItem || {};
  const clipData = queueItem.clipData || {};
  return {
    ...clipData,
    id: result?.recorded_clip_id ?? clipData.id,
    recorded_clip_id: result?.recorded_clip_id ?? null,
    output_path: result?.output_path ?? clipData.output_path,
    duration_sec: result?.recorded_clip_duration_sec ?? clipData.duration_sec,
    player_name: clipData.player_name ?? queueItem.targetPlayer,
    demo_filename: clipData.demo_filename ?? queueItem.demoFilename,
    demo_path: clipData.demo_path ?? queueItem.demoPath,
    clip_id: clipData.clip_id ?? queueItem.clipId,
    pov_hud_enabled: result?.pov_hud_enabled ?? clipData.pov_hud_enabled,
    recording_perspective: result?.recording_perspective ?? clipData.recording_perspective,
    victim_pov_segments: result?.victim_pov_segments ?? clipData.victim_pov_segments,
    planned_segments: result?.planned_segments ?? clipData.planned_segments,
  };
}

function combatSummary(clip, t, locale) {
  const weapons = weaponUsedTokens(clip?.weapon_used, locale);
  const weapon = weapons.join(" / ");
  const category = String(clip?.category || "").toLowerCase();
  const timelineKind = String(clip?.timeline_record_kind || "").trim();
  const requestType = String(clip?.workbench_clip_kind || clip?.recording_request_type || "").trim();
  const isDeath = category === "fail" || timelineKind === "death" || requestType === "timeline_death";
  const victims = uniqueStrings(Array.isArray(clip?.victims) ? clip.victims : []);

  if (isDeath) {
    const killer = String(clip?.killer_name || clip?.killers?.[0] || "").trim();
    if (!killer) return "";
    return weapon
      ? t("queue.modalCombatKilledByWeapon", { name: killer, weapon })
      : t("queue.modalCombatKilledBy", { name: killer });
  }
  if (!victims.length) return "";
  const killed = t("montage.combatKills", { names: victims.join("、") });
  return weapon ? t("queue.modalCombatKill", { weapon, names: victims.join("、") }) : killed;
}

function ResultPreview({ result, clip, duration, t, onDurationDetected }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const clipId = recordedClipId(result, clip);
  const streamUrl = result?.success && clipId
    ? getRecordedClipStreamUrl(clipId)
    : null;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-cs2-border-subtle bg-black shadow-inner">
      {streamUrl && !previewFailed ? (
        <video
          src={streamUrl}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            const measuredDuration = Number(video.duration);
            if (Number.isFinite(measuredDuration) && measuredDuration > 0.05) {
              onDurationDetected?.(measuredDuration);
              video.currentTime = Math.min(0.5, measuredDuration * 0.12);
            }
          }}
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-cs2-bg-elevated via-cs2-bg-card to-black text-cs2-text-muted">
          <FileVideo2 className="h-7 w-7" />
          <span className="text-[10px]">{t("queue.modalPreviewUnavailable")}</span>
        </div>
      )}
      <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
        {formatDuration(duration)}
      </span>
    </div>
  );
}

function ChipGroup({ label, icon: Icon, className, chips }) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 inline-flex items-center gap-1 text-[10px] font-semibold text-cs2-text-muted">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      {chips.map((chip) => (
        <span key={chip} className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${className}`}>
          {chip}
        </span>
      ))}
    </div>
  );
}

function RecordingResultCard({ result, copiedIdx, onCopy, onReveal, onDurationDetected, durationOverride, t, locale }) {
  const aborted = isAborted(result);
  const clip = resultClip(result);
  const type = normalizeClipType(clip);
  const accent = TYPE_ACCENT_CLASSES[type] || "bg-cs2-border-focus";
  // The browser's media metadata is the source of truth once it has loaded.
  // Until then, leave streamable successful recordings blank instead of showing
  // the wall-clock recording interval, which can diverge from encoded duration.
  const canReadMediaDuration = result.success && recordedClipId(result, clip);
  const duration = Number.isFinite(Number(durationOverride))
    ? Number(durationOverride)
    : canReadMediaDuration
      ? null
      : getClipDurationSeconds(clip);
  const title = friendlyClipTitleForQueue(clip, t);
  const playerName = String(clip.player_name || result?._queueItem?.targetPlayer || "").trim();
  const demo = fileName(clip.demo_filename || clip.demo_path || result?._queueItem?.demoFilename || result?._queueItem?.demoPath);
  const recordId = String(clip.clip_id || result?._queueItem?.clipId || result?.request_id || clip.recorded_clip_id || "").trim();
  const map = String(clip.map_name || clip.map || "").trim();
  const round = Number(clip.round);
  const killCount = Number(clip.kill_count);
  const combat = combatSummary(clip, t, locale);
  const perspective = getRecordedClipPerspectivePrimaryZh(clip, t);
  const extraVictimCount = getMontageExtraVictimPovCount(clip);
  const settingChips = uniqueStrings([
    perspective,
    clip.pov_hud_enabled === true ? "HUD" : "",
    extraVictimCount > 0 ? t("montage.perspectiveVictimSuffix", { n: extraVictimCount }) : "",
  ]);
  const tags = uniqueStrings([
    ...(Array.isArray(clip.context_tags) ? clip.context_tags : []),
    ...(Array.isArray(clip.tags) ? clip.tags : []),
  ]);
  const statusIcon = result.success ? (
    <CheckCircle2 className="h-4 w-4 text-cs2-text-success" />
  ) : aborted ? (
    <Ban className="h-4 w-4 text-cs2-text-muted" />
  ) : (
    <XCircle className="h-4 w-4 text-cs2-rose-on-surface" />
  );

  return (
    <li className="relative overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-input/55 shadow-inner">
      <span className={`absolute inset-y-0 left-0 w-1 ${result.success ? accent : "bg-cs2-fail"}`} />
      <div className="flex flex-col gap-3 p-3 pl-4 sm:flex-row sm:items-stretch">
        <div className="w-full shrink-0 sm:w-[248px] lg:w-[290px]">
          <ResultPreview
            result={result}
            clip={clip}
            duration={duration}
            t={t}
            onDurationDetected={onDurationDetected}
          />
        </div>

        <div className="min-w-0 flex-1 py-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`inline-flex rounded-md px-2 py-1 text-[10px] font-bold ${montageTypeTagBadgeClass(type)}`}>
              {t(clipTypeI18nKey(type))}
            </span>
            {playerName ? <span className="text-[13px] font-bold text-cs2-text-primary">{playerName}</span> : null}
            {recordId ? (
              <span className="max-w-full truncate rounded border border-cs2-border-subtle bg-black/15 px-1.5 py-0.5 font-mono text-[10px] text-cs2-text-muted" title={recordId}>
                {t("queue.modalRecordId")} · {recordId}
              </span>
            ) : null}
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] text-cs2-text-muted">
              {statusIcon}
              {result.success ? null : aborted ? t("queue.modalItemAborted") : t("queue.modalFailed", { n: 1 })}
            </span>
          </div>

          {demo ? (
            <p className="mt-2 truncate font-mono text-[10px] text-cs2-text-secondary" title={demo}>
              <span className="text-cs2-text-muted">{t("queue.modalDemo")} · </span>{demo}
            </p>
          ) : null}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-cs2-text-secondary">
            {map ? <span>{map}</span> : null}
            {Number.isFinite(round) && round > 0 ? <span className="font-mono">R{round}</span> : null}
            {Number.isFinite(round) && round > 0 ? <span>{t("montage.factRound", { n: round })}</span> : null}
            {Number.isFinite(killCount) && killCount > 0 ? <span>{t("montage.killCount", { kc: killCount })}</span> : null}
            <span>{formatDuration(duration)}</span>
          </div>

          {combat ? (
            <p className="mt-2 truncate text-[12px] font-semibold text-cs2-accent" title={combat}>
              {combat}
            </p>
          ) : title ? (
            <p className="mt-2 truncate text-[12px] font-semibold text-cs2-text-primary" title={title}>{title}</p>
          ) : null}

          {result.success ? (
            <div className="mt-3 space-y-2">
              <ChipGroup
                label={t("queue.modalRecordingSettings")}
                icon={MonitorPlay}
                chips={settingChips}
                className="border-cyan-400/25 bg-cyan-400/10 text-cyan-200"
              />
              <ChipGroup
                label={t("queue.modalHighlightTags")}
                icon={Tags}
                chips={tags}
                className="border-amber-400/30 bg-amber-400/10 text-amber-200"
              />
            </div>
          ) : null}

          {!result.success && !aborted && result.error ? (
            <p className="mt-2 text-[11px] text-cs2-rose-on-surface">{result.error}</p>
          ) : null}

          {result.success && result.output_path ? (
            <div className="mt-3 flex min-w-0 items-center gap-1 border-t border-cs2-border-subtle pt-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-cs2-text-muted" title={result.output_path}>
                {result.output_path}
              </span>
              <button
                type="button"
                title={t("queue.modalCopyPath")}
                onClick={() => onCopy(result._index, result.output_path)}
                className="shrink-0 rounded p-1 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
              >
                {copiedIdx === result._index ? <Check className="h-3.5 w-3.5 text-cs2-text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                title={t("queue.modalRevealPath")}
                onClick={() => onReveal(result.output_path)}
                className="shrink-0 rounded p-1 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export default function RecordingResultModal({
  open,
  onClose,
  onClearQueue,
  results = [],
}) {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [mediaDurations, setMediaDurations] = useState({});
  const persistedDurationKeys = useRef(new Set());
  const successCount = results.filter((result) => result.success).length;
  const abortedCount = results.filter((result) => isAborted(result)).length;
  const failCount = results.filter((result) => !result.success && !isAborted(result)).length;
  const pendingMediaDuration = results.some((result, index) => {
    if (!result.success) return false;
    const clip = resultClip(result);
    return recordedClipId(result, clip) && !Number.isFinite(Number(mediaDurations[resultKey(result, index)]));
  });
  const totalDuration = pendingMediaDuration
    ? null
    : results.reduce((sum, result, index) => (
      sum + (Number(mediaDurations[resultKey(result, index)]) || getClipDurationSeconds(resultClip(result)) || 0)
    ), 0);

  useEffect(() => {
    setMediaDurations({});
    persistedDurationKeys.current.clear();
  }, [open, results]);

  function handleCopy(idx, path) {
    navigator.clipboard.writeText(path).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  }

  function handleReveal(path) {
    API.post("/reveal-file-in-explorer", { path }).catch(() => {});
  }

  function handleDurationDetected(result, index, seconds) {
    const duration = Number(seconds);
    if (!Number.isFinite(duration) || duration <= 0.05) return;
    const key = resultKey(result, index);
    setMediaDurations((current) => {
      if (Math.abs((Number(current[key]) || 0) - duration) <= 0.05) return current;
      return { ...current, [key]: duration };
    });

    const clipId = recordedClipId(result, resultClip(result));
    const persistKey = clipId ? `${clipId}:${duration.toFixed(3)}` : "";
    if (!clipId || persistedDurationKeys.current.has(persistKey)) return;
    persistedDurationKeys.current.add(persistKey);
    API.patch(`/recorded-clips/${clipId}/duration`, { duration_sec: duration }).catch(() => {
      persistedDurationKeys.current.delete(persistKey);
    });
  }

  const footer = (
    <div className="flex items-center justify-end gap-3">
      <button
        type="button"
        onClick={() => {
          onClearQueue();
          onClose();
        }}
        className="rounded-lg border border-cs2-border bg-cs2-bg-input px-4 py-2 text-[12px] font-semibold text-cs2-text-primary hover:border-cs2-accent/50"
      >
        {t("queue.modalClearAndClose")}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg bg-cs2-accent px-5 py-2 text-[12px] font-bold text-cs2-text-on-accent hover:brightness-110"
      >
        {t("queue.modalClose")}
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<CheckCircle2 className="h-7 w-7 text-cs2-text-success" />}
      title={`${t("queue.modalTitle")} · ${t("queue.modalHeaderSaved", { n: successCount })}`}
      subtitle={`${t("queue.modalDurationTotal", { duration: formatDuration(totalDuration) })} · ${t("queue.modalSuccess", { n: successCount, total: results.length })}`}
      maxWidth="max-w-6xl"
      maxHeight="max-h-[90vh]"
      footer={footer}
    >
      {(failCount > 0 || abortedCount > 0) ? (
        <div className="flex flex-wrap items-center gap-4 border-b border-cs2-border px-5 py-2 text-[11px]">
          {failCount > 0 ? <span className="flex items-center gap-1 text-cs2-rose-on-surface"><XCircle className="h-3.5 w-3.5" />{t("queue.modalFailed", { n: failCount })}</span> : null}
          {abortedCount > 0 ? <span className="flex items-center gap-1 text-cs2-text-muted"><Ban className="h-3.5 w-3.5" />{t("queue.modalAborted", { n: abortedCount })}</span> : null}
        </div>
      ) : null}
      <ul className="space-y-3 p-4 sm:p-5">
        {results.map((result, index) => (
          <RecordingResultCard
            key={result.request_id ?? result._index ?? index}
            result={result}
            copiedIdx={copiedIdx}
            onCopy={handleCopy}
            onReveal={handleReveal}
            durationOverride={mediaDurations[resultKey(result, index)]}
            onDurationDetected={(duration) => handleDurationDetected(result, index, duration)}
            t={t}
            locale={locale}
          />
        ))}
      </ul>
    </Modal>
  );
}
