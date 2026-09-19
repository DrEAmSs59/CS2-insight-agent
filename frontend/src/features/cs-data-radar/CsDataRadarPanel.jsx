/**
 * 数据雷达图专栏：从当前时间线成片推导候选项，插入为独立时间线段。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Check,
  Clock,
  ImagePlus,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  UserRound,
} from "lucide-react";
import { useT } from "../../i18n/useT.js";
import { useSteamPlayerAvatars } from "../../hooks/useSteamPlayerAvatars.js";
import { radarImageUrl, uploadRadarCandidatePortrait } from "./csDataRadarApi";
import {
  deriveRadarStats,
  hasManualRating,
  radarCompositionLine,
} from "./radarDimensions";
import { ANIMATION_DURATION_SEC, isCandidateOnTimeline } from "./radarTimeline.js";

function initialLetter(name) {
  const text = String(name || "").trim();
  return text ? text.slice(0, 1).toUpperCase() : "?";
}

export default function CsDataRadarPanel({
  candidates = [],
  loading = false,
  error = "",
  onRefresh,
  radarEnabled = true,
  onRadarEnabledChange,
  radarItems = [],
  candidateState = {},
  onCandidateRatingChange,
  onCandidateMedianRatingChange,
  onCandidatePortraitChange,
  timelineClips = [],
  selectedTimelineId = null,
  onInsertBefore,
  onInsertAfter,
  onRemoveRadarItem,
  onRadarDurationChange,
}) {
  const t = useT();
  const [busyKey, setBusyKey] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(null);
  const [notice, setNotice] = useState(null);
  const fileInputRef = useRef(null);

  const steamPlayers = useMemo(
    () =>
      (Array.isArray(candidates) ? candidates : [])
        .filter((row) => row?.steamid64)
        .map((row) => ({ steam_id64: row.steamid64 })),
    [candidates],
  );
  const { avatars: steamAvatars } = useSteamPlayerAvatars(steamPlayers);

  useEffect(() => {
    if (fileInputKey && fileInputRef.current) fileInputRef.current.click();
  }, [fileInputKey]);

  const showNotice = useCallback((msg) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const handlePortraitFile = useCallback(
    async (candidate, file) => {
      if (!file || !candidate?.key) return;
      setBusyKey(candidate.key);
      try {
        const uploaded = await uploadRadarCandidatePortrait(file);
        onCandidatePortraitChange?.(candidate.key, {
          portrait_path: uploaded.path,
          portrait_url: radarImageUrl(uploaded.url),
        });
        showNotice(t("radar.noticePortraitUploaded"));
      } catch {
        showNotice(t("radar.noticePortraitFail"));
      } finally {
        setBusyKey(null);
        setFileInputKey(null);
      }
    },
    [onCandidatePortraitChange, showNotice, t],
  );

  const handleUseSteamAvatar = useCallback(
    async (candidate) => {
      const avatarUrl = candidate?.steamid64 ? steamAvatars[String(candidate.steamid64)] : null;
      if (!avatarUrl) {
        showNotice(t("radar.noticeNoSteamAvatar"));
        return;
      }
      setBusyKey(candidate.key);
      try {
        const res = await fetch(avatarUrl, { mode: "cors", credentials: "omit" });
        if (!res.ok) throw new Error("avatar fetch failed");
        const blob = await res.blob();
        const file = new File([blob], `avatar-${candidate.key}.jpg`, { type: blob.type || "image/jpeg" });
        const uploaded = await uploadRadarCandidatePortrait(file);
        onCandidatePortraitChange?.(candidate.key, {
          portrait_path: uploaded.path,
          portrait_url: radarImageUrl(uploaded.url),
        });
        showNotice(t("radar.noticeSteamAvatarApplied"));
      } catch {
        showNotice(t("radar.noticeSteamAvatarFail"));
      } finally {
        setBusyKey(null);
      }
    },
    [onCandidatePortraitChange, showNotice, steamAvatars, t],
  );

  const insertTargetLabel = selectedTimelineId != null
    ? t("radar.insertRelativeSelected")
    : t("radar.insertRelativeDefault");

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-cs2-accent" aria-hidden />
          <p className="text-xs font-bold text-cs2-text-primary">{t("radar.panelTitle")}</p>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-cs2-text-muted">{t("radar.panelHint")}</p>
        {notice ? (
          <p className="mt-2 rounded-lg border border-cs2-accent/25 bg-cs2-accent-soft px-2.5 py-1.5 text-[11px] font-medium text-cs2-accent">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="mt-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">
            {String(error)}
          </p>
        ) : null}
      </div>

      <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-cs2-text-primary">{t("radar.exportToggleTitle")}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">{t("radar.exportToggleHint")}</p>
          </div>
          <button
            type="button"
            aria-pressed={radarEnabled}
            onClick={() => onRadarEnabledChange?.(!radarEnabled)}
            className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 active:scale-95 ${
              radarEnabled
                ? "border-cs2-accent bg-cs2-accent text-white shadow-sm"
                : "border-cs2-border bg-cs2-bg-input text-transparent hover:border-cs2-accent/70"
            }`}
          >
            <Check size={17} strokeWidth={3} aria-hidden="true" />
          </button>
        </div>
        {!radarEnabled ? (
          <p className="mt-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
            {t("radar.exportToggleOffHint")}
          </p>
        ) : null}
      </div>

      {radarItems.length > 0 ? (
        <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
          <div className="flex items-center gap-2">
            <Play className="h-3.5 w-3.5 text-cs2-accent" />
            <p className="text-xs font-bold text-cs2-text-primary">
              {t("radar.segmentsTitle", { n: radarItems.length })}
            </p>
          </div>
          <ul className="mt-2.5 space-y-2">
            {radarItems.map((item) => {
              const live = isCandidateOnTimeline(item.candidateKey, timelineClips);
              return (
                <li key={item.id} className="rounded-lg border border-cs2-border-subtle bg-cs2-bg-input/50 p-2.5">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-cs2-text-primary">
                        {item.playerName || t("radar.unknownPlayer")}
                      </p>
                      {!live ? (
                        <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300">
                          {t("radar.orphanBadge")}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveRadarItem?.(item.id)}
                      className="shrink-0 rounded-lg p-1.5 text-cs2-text-muted hover:bg-rose-500/15 hover:text-rose-400 transition-colors"
                      aria-label={t("radar.segmentRemove")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] text-cs2-text-muted">
                      <Clock className="h-3 w-3" />
                      {t("radar.segmentDurationLabel")}
                    </span>
                    <input
                      type="number"
                      min={0.5}
                      max={60}
                      step={0.5}
                      value={item.duration ?? ANIMATION_DURATION_SEC}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (Number.isFinite(v) && v >= 0.5) onRadarDurationChange?.(item.id, v);
                      }}
                      className="w-16 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent"
                    />
                    <span className="text-[11px] text-cs2-text-muted">{t("radar.segmentSec")}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-bold text-cs2-text-primary">{t("radar.cardsTitle")}</p>
          <span className="ml-auto font-mono text-[10px] text-cs2-text-muted">
            {Array.isArray(candidates) ? candidates.length : 0}
          </span>
          {onRefresh ? (
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={loading}
              title={t("radar.refreshBtn")}
              className="rounded-lg border border-cs2-border-subtle p-1.5 text-cs2-text-muted hover:border-cs2-accent/60 hover:text-cs2-text-primary disabled:opacity-40"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-cs2-text-muted">{insertTargetLabel}</p>
        {loading ? (
          <div className="mt-3 flex items-center justify-center gap-2 py-6 text-xs text-cs2-text-muted">
            <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />
            {t("radar.cardsLoading")}
          </div>
        ) : Array.isArray(candidates) && candidates.length > 0 ? (
          <ul className="mt-3 space-y-2.5">
            {candidates.map((candidate) => {
              const state = candidateState[candidate.key] || {};
              const ratingRaw = state.rating;
              const ratingNum = ratingRaw === "" || ratingRaw == null ? null : Number(ratingRaw);
              const medianRatingRaw = state.avg_rating ?? state.median_rating;
              const radar = deriveRadarStats(
                candidate.stats || {},
                Number.isFinite(ratingNum) ? ratingNum : null,
              );
              const portraitUrl = state.portrait_url || (candidate.steamid64 ? steamAvatars[String(candidate.steamid64)] : "");
              const missing = !candidate.has_parse_data;
              return (
                <li
                  key={candidate.key}
                  className="rounded-xl border border-cs2-border-subtle bg-cs2-bg-input/40 p-2.5"
                >
                  <div className="flex items-start gap-2.5">
                    {portraitUrl ? (
                      <img
                        src={portraitUrl}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-md border border-cs2-border object-cover"
                      />
                    ) : (
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-cs2-border bg-cs2-surface-2 text-sm font-black text-cs2-text-primary">
                        {initialLetter(candidate.player_name)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-cs2-text-primary">
                        {candidate.player_name || t("radar.unknownPlayer")}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-cs2-text-muted">
                        {candidate.demo_filename || candidate.demo_path || t("radar.cardTeamUnknown")}
                        {` · ${t("radar.segmentCount", { n: candidate.segment_count || 1 })}`}
                      </p>
                      {missing ? (
                        <p className="mt-1 text-[10px] font-medium text-rose-300">{t("radar.missingParse")}</p>
                      ) : (
                        <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-cs2-text-muted" title={radarCompositionLine(radar)}>
                          {radarCompositionLine(radar)}
                          {hasManualRating(radar) ? "" : ` · ${t("radar.ratingOptional")}`}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="flex items-center gap-2 text-[11px] text-cs2-text-muted">
                      <span className="shrink-0">{t("radar.ratingLabel")}</span>
                      <input
                        type="number"
                        min={0}
                        max={3}
                        step={0.01}
                        placeholder="—"
                        value={ratingRaw ?? ""}
                        onChange={(e) => onCandidateRatingChange?.(candidate.key, e.target.value)}
                        className="w-full rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-[11px] text-cs2-text-muted">
                      <span className="shrink-0">{t("radar.medianRatingLabel")}</span>
                      <input
                        type="number"
                        min={0}
                        max={3}
                        step={0.01}
                        placeholder="—"
                        value={medianRatingRaw ?? ""}
                        onChange={(e) => onCandidateMedianRatingChange?.(candidate.key, e.target.value)}
                        className="w-full rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent"
                      />
                    </label>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button
                      type="button"
                      disabled={!timelineClips.length}
                      onClick={() => onInsertBefore?.(candidate)}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-cs2-accent px-2 py-1.5 text-[10px] font-bold text-cs2-text-on-accent transition-all hover:bg-cs2-accent-light disabled:opacity-40"
                    >
                      {t("radar.cardInsertBefore")}
                    </button>
                    <button
                      type="button"
                      disabled={!timelineClips.length}
                      onClick={() => onInsertAfter?.(candidate)}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-cs2-accent/40 bg-cs2-accent-soft px-2 py-1.5 text-[10px] font-bold text-cs2-accent transition-all hover:bg-cs2-accent hover:text-white disabled:opacity-40"
                    >
                      {t("radar.cardInsertAfter")}
                    </button>
                    <button
                      type="button"
                      disabled={busyKey === candidate.key}
                      onClick={() => setFileInputKey(candidate.key)}
                      title={t("radar.cardUploadPortraitTitle")}
                      className="inline-flex items-center justify-center rounded-lg border border-cs2-border-subtle px-2 py-1.5 text-cs2-text-secondary transition-all hover:border-cs2-accent/60 hover:text-cs2-text-primary disabled:opacity-40"
                    >
                      {busyKey === candidate.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      disabled={busyKey === candidate.key}
                      onClick={() => void handleUseSteamAvatar(candidate)}
                      title={t("radar.cardSteamAvatarTitle")}
                      className="inline-flex items-center justify-center rounded-lg border border-cs2-border-subtle px-2 py-1.5 text-cs2-text-secondary transition-all hover:border-cs2-accent/60 hover:text-cs2-text-primary disabled:opacity-40"
                    >
                      <UserRound className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-cs2-border-subtle bg-cs2-surface-1/50 px-3 py-5 text-center">
            <p className="text-[11px] font-medium text-cs2-text-secondary">{t("radar.cardsEmpty")}</p>
            <p className="mt-1 text-[10px] leading-relaxed text-cs2-text-muted">{t("radar.cardsEmptyHint")}</p>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const candidate = (Array.isArray(candidates) ? candidates : []).find((c) => c.key === fileInputKey);
          const file = e.target.files?.[0];
          e.target.value = "";
          if (candidate && file) void handlePortraitFile(candidate, file);
          else setFileInputKey(null);
        }}
      />
    </div>
  );
}