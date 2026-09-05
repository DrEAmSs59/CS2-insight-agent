import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BarChart3,
  Check,
  CheckSquare,
  Clapperboard,
  Clock,
  Flag,
  ImagePlus,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useT } from "../../i18n/useT.js";
import { useSteamPlayerAvatars } from "../../hooks/useSteamPlayerAvatars.js";
import {
  batchGenerateCardAnimations,
  clearRadarTeamLogo,
  deleteRadarCard,
  generateCardAnimation,
  radarImageUrl,
  radarVideoUrl,
  uploadRadarPortrait,
  uploadRadarTeamLogo,
} from "./csDataRadarApi";
import { radarCompositionLine, RADAR_DIMENSIONS, compareToMatchAvg } from "./radarDimensions";

const DEFAULT_RADAR_DURATION = 4;

/**
 * 剪辑编排中的「cs数据图」专栏。
 *
 * 剪辑前是否加入 CS 雷达图 → 确认（toggle）→ 从对局解析后的人物（已生成的
 * 雷达图卡片）中选择 → 插入到指定片段之前；人物图片可通过前端接口上传，
 * 未上传者使用游戏内头像（Steam）或昵称首字占位。
 */
export default function CsDataRadarPanel({
  cards,
  loading,
  error,
  onRefresh,
  timelineClips = [],
  radarSegments = [],
  onInsertRadarSegment,
  onRemoveRadarSegment,
  onRadarSegmentDurationChange,
  onRadarSegmentTargetChange,
  insertingCardId = null,
}) {
  const t = useT();
  const [enabled, setEnabled] = useState(false); // 是否确认在剪辑前加入雷达图
  const [busyCardId, setBusyCardId] = useState(null);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [fileInputCardId, setFileInputCardId] = useState(null);
  const fileInputRef = useRef(null);
  const [logoInputCardId, setLogoInputCardId] = useState(null);
  const logoInputRef = useRef(null);
  // 多选批量生成：勾选的卡片 id 集合（空集合 = 未启用多选）
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [notice, setNotice] = useState(null);

  const toggleSelect = useCallback((cardId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const showNotice = useCallback((msg) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  // 卡片列表中的 Steam ID → 游戏内头像（用于「使用游戏内头像」）
  const steamPlayers = useMemo(
    () =>
      (Array.isArray(cards) ? cards : [])
        .filter((card) => card?.steam_id64)
        .map((card) => ({ steam_id64: card.steam_id64 })),
    [cards],
  );
  const { avatars: steamAvatars } = useSteamPlayerAvatars(steamPlayers);

  useEffect(() => {
    if (fileInputCardId && fileInputRef.current) fileInputRef.current.click();
  }, [fileInputCardId]);

  useEffect(() => {
    if (logoInputCardId && logoInputRef.current) logoInputRef.current.click();
  }, [logoInputCardId]);

  const refreshAfterChange = useCallback(async () => {
    if (onRefresh) await onRefresh();
  }, [onRefresh]);

  const handlePortraitFile = useCallback(
    async (card, file) => {
      if (!file) return;
      const hadVideo = Boolean(card.video_url);
      setBusyCardId(card.id);
      try {
        await uploadRadarPortrait(card.id, file);
        showNotice(hadVideo ? t("radar.noticePortraitVideoRegenerated") : t("radar.noticePortraitUploaded"));
        await refreshAfterChange();
      } catch (e) {
        showNotice(t("radar.noticePortraitFail"));
      } finally {
        setBusyCardId(null);
        setFileInputCardId(null);
      }
    },
    [refreshAfterChange, showNotice, t],
  );

  const handleUseSteamAvatar = useCallback(
    async (card) => {
      const avatarUrl = card?.steam_id64 ? steamAvatars[String(card.steam_id64)] : null;
      if (!avatarUrl) {
        showNotice(t("radar.noticeNoSteamAvatar"));
        return;
      }
      setBusyCardId(card.id);
      try {
        const res = await fetch(avatarUrl, { mode: "cors", credentials: "omit" });
        if (!res.ok) throw new Error("avatar fetch failed");
        const blob = await res.blob();
        const file = new File([blob], `avatar-${card.id}.jpg`, { type: blob.type || "image/jpeg" });
        await uploadRadarPortrait(card.id, file);
        showNotice(card.video_url ? t("radar.noticePortraitVideoRegenerated") : t("radar.noticeSteamAvatarApplied"));
        await refreshAfterChange();
      } catch {
        showNotice(t("radar.noticeSteamAvatarFail"));
      } finally {
        setBusyCardId(null);
      }
    },
    [refreshAfterChange, showNotice, steamAvatars, t],
  );

  const handleTeamLogoFile = useCallback(
    async (card, file) => {
      if (!file) return;
      const hadVideo = Boolean(card.video_url);
      setBusyCardId(card.id);
      try {
        await uploadRadarTeamLogo(card.id, file);
        showNotice(hadVideo ? t("radar.noticeTeamLogoVideoRegenerated") : t("radar.noticeTeamLogoUploaded"));
        await refreshAfterChange();
      } catch {
        showNotice(t("radar.noticeTeamLogoFail"));
      } finally {
        setBusyCardId(null);
        setLogoInputCardId(null);
      }
    },
    [refreshAfterChange, showNotice, t],
  );

  const handleClearTeamLogo = useCallback(
    async (card) => {
      if (!card.team_logo_file) return;
      const hadVideo = Boolean(card.video_url);
      setBusyCardId(card.id);
      try {
        await clearRadarTeamLogo(card.id);
        showNotice(hadVideo ? t("radar.noticeTeamLogoVideoRegenerated") : t("radar.noticeTeamLogoCleared"));
        await refreshAfterChange();
      } catch {
        showNotice(t("radar.noticeTeamLogoClearFail"));
      } finally {
        setBusyCardId(null);
      }
    },
    [refreshAfterChange, showNotice, t],
  );

  const handleDelete = useCallback(
    async (card) => {
      setBusyCardId(card.id);
      try {
        await deleteRadarCard(card.id);
        showNotice(t("radar.noticeCardDeleted"));
        await refreshAfterChange();
      } catch {
        showNotice(t("radar.noticeCardDeleteFail"));
      } finally {
        setBusyCardId(null);
      }
    },
    [refreshAfterChange, showNotice, t],
  );

  const handleInsert = useCallback(
    async (card) => {
      if (!enabled) {
        showNotice(t("radar.noticeNeedEnable"));
        return;
      }
      if (!timelineClips.length) {
        showNotice(t("radar.noticeNeedTimeline"));
        return;
      }
      // 优先以「开场动画」视频段插入：没有动画则先生成（约 40-60s，生成中可看到忙碌态）
      let effective = card;
      if (!card.video_url) {
        setBusyCardId(card.id);
        try {
          effective = await generateCardAnimation(card.id);
          if (!effective?.video_url) showNotice(t("radar.noticeAnimationFallback"));
          else await refreshAfterChange();
        } catch {
          showNotice(t("radar.noticeAnimationFail"));
        } finally {
          setBusyCardId(null);
        }
      }
      const targetId = timelineClips[0]?.id;
      onInsertRadarSegment?.(effective || card, targetId);
      showNotice(t("radar.noticeInserted", { player: card.player_name }));
    },
    [enabled, onInsertRadarSegment, refreshAfterChange, showNotice, t, timelineClips],
  );

  // 单独「生成开场动画」：不插入，仅生成视频供预览
  const handleEnsureAnimation = useCallback(
    async (card) => {
      if (card.video_url) {
        showNotice(t("radar.noticeAnimationExists"));
        return;
      }
      setBusyCardId(card.id);
      try {
        const updated = await generateCardAnimation(card.id);
        if (updated?.video_url) showNotice(t("radar.noticeAnimationDone"));
        else showNotice(t("radar.noticeAnimationNeedsFfmpeg"));
        await refreshAfterChange();
      } catch {
        showNotice(t("radar.noticeAnimationFail"));
      } finally {
        setBusyCardId(null);
      }
    },
    [refreshAfterChange, showNotice, t],
  );

  // 批量生成开场动画：勾选了卡片 → 只生成选中的（尚未有动画的）；未勾选 → 全部尚未有动画的
  const handleBatchAnimation = useCallback(async () => {
    const all = Array.isArray(cards) ? cards : [];
    const targets = selectedIds.size
      ? all.filter((c) => selectedIds.has(c.id) && !c.video_url)
      : all.filter((c) => !c.video_url);
    if (!targets.length) {
      showNotice(selectedIds.size ? t("radar.noticeBatchSelectedSkip") : t("radar.noticeBatchAllReady"));
      return;
    }
    setBatchGenerating(true);
    try {
      const updated = await batchGenerateCardAnimations(targets.map((c) => c.id));
      const ok = (updated || []).filter((c) => c && c.video_url).length;
      showNotice(
        selectedIds.size
          ? t("radar.noticeBatchSelectedDone", { n: ok, total: targets.length })
          : t("radar.noticeBatchDone", { n: ok, total: targets.length }),
      );
      await refreshAfterChange();
      clearSelection();
    } catch {
      showNotice(t("radar.noticeBatchFail"));
    } finally {
      setBatchGenerating(false);
    }
  }, [cards, clearSelection, refreshAfterChange, selectedIds, showNotice, t]);

  const segmentTargetLabel = useCallback(
    (clipId) => {
      const clip = timelineClips.find((c) => c.id === clipId);
      if (!clip) return t("radar.segmentTargetMissing");
      return String(clip.player_name || clip.output_path || clipId);
    },
    [timelineClips, t],
  );

  return (
    <div className="space-y-4">
      {/* 专栏头 */}
      <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-cs2-accent" aria-hidden />
          <p className="text-xs font-bold text-cs2-text-primary">{t("radar.panelTitle")}</p>
          <button
            type="button"
            disabled={batchGenerating || loading || !(Array.isArray(cards) && cards.length)}
            onClick={() => void handleBatchAnimation()}
            title={
              selectedIds.size
                ? t("radar.batchAnimationSelectedTitle", { n: selectedIds.size })
                : t("radar.batchAnimationTitle")
            }
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-cs2-accent/40 bg-cs2-accent-soft px-2 py-1 text-[11px] font-bold text-cs2-accent transition-all hover:bg-cs2-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {batchGenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Clapperboard className="h-3 w-3" />
            )}
            {selectedIds.size
              ? t("radar.batchAnimationSelected", { n: selectedIds.size })
              : t("radar.batchAnimationBtn")}
          </button>
          {selectedIds.size ? (
            <button
              type="button"
              onClick={clearSelection}
              title={t("radar.cardClearSelection")}
              className="inline-flex items-center gap-1 rounded-lg border border-cs2-border-subtle px-2 py-1 text-[11px] text-cs2-text-secondary transition-all hover:border-rose-500/30 hover:text-rose-400"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void onRefresh?.()}
            className="inline-flex items-center gap-1 rounded-lg border border-cs2-border-subtle px-2 py-1 text-[11px] text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            {t("radar.refreshBtn")}
          </button>
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

      {/* 是否在剪辑前加入 CS 雷达图（确认开关） */}
      <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-cs2-text-primary">{t("radar.confirmTitle")}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">{t("radar.confirmHint")}</p>
          </div>
          <button
            type="button"
            aria-pressed={enabled}
            onClick={() => setEnabled((v) => !v)}
            className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 active:scale-95 ${
              enabled
                ? "border-cs2-accent bg-cs2-accent text-white shadow-sm"
                : "border-cs2-border bg-cs2-bg-input text-transparent hover:border-cs2-accent/70"
            }`}
          >
            <Check size={17} strokeWidth={3} aria-hidden="true" />
          </button>
        </div>
        {enabled ? (
          <p className="mt-2.5 rounded-lg border border-cs2-accent/25 bg-cs2-accent-soft px-2.5 py-2 text-[11px] leading-relaxed text-cs2-accent">
            {t("radar.confirmEnabledHint")}
          </p>
        ) : null}
      </div>

      {/* 已插入的雷达段（剪辑前的编排） */}
      {radarSegments.length > 0 ? (
        <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
          <div className="flex items-center gap-2">
            <Play className="h-3.5 w-3.5 text-cs2-accent" />
            <p className="text-xs font-bold text-cs2-text-primary">
              {t("radar.segmentsTitle", { n: radarSegments.length })}
            </p>
          </div>
          <ul className="mt-2.5 space-y-2">
            {radarSegments.map((seg) => (
              <li key={seg.uid} className="rounded-lg border border-cs2-border-subtle bg-cs2-bg-input/50 p-2.5">
                <div className="flex items-center gap-2">
                  <img
                    src={seg.imageUrl}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded-md border border-cs2-border object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold text-cs2-text-primary">{seg.playerName}</p>
                    <p className="mt-0.5 truncate text-[11px] text-cs2-text-muted">
                      {t("radar.segmentTargetLabel")}{" "}
                      <span className="text-cs2-text-secondary">{segmentTargetLabel(seg.beforeClipId)}</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveRadarSegment?.(seg.uid)}
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
                    min={1}
                    max={60}
                    step={0.5}
                    value={seg.duration}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v) && v >= 1) onRadarSegmentDurationChange?.(seg.uid, v);
                    }}
                    className="w-16 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2 py-1 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent"
                  />
                  <span className="text-[11px] text-cs2-text-muted">{t("radar.segmentSec")}</span>
                  <select
                    value={seg.beforeClipId}
                    onChange={(e) => onRadarSegmentTargetChange?.(seg.uid, Number(e.target.value))}
                    className="min-w-0 flex-1 rounded-lg border border-cs2-border-subtle bg-cs2-bg-input px-2 py-1 text-[11px] text-cs2-text-primary outline-none focus:border-cs2-accent"
                  >
                    {timelineClips.map((clip, idx) => (
                      <option key={clip.id} value={clip.id}>
                        {t("radar.segmentBeforeOption", { n: idx + 1, name: clip.player_name || String(clip.id) })}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 对局解析后的人物卡片（雷达图素材池） */}
      <div className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5">
        <div className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-cs2-accent" />
          <p className="text-xs font-bold text-cs2-text-primary">{t("radar.cardsTitle")}</p>
          <span className="ml-auto font-mono text-[10px] text-cs2-text-muted">
            {Array.isArray(cards) ? cards.length : 0}
          </span>
        </div>
        {loading ? (
          <div className="mt-3 flex items-center justify-center gap-2 py-6 text-xs text-cs2-text-muted">
            <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />
            {t("radar.cardsLoading")}
          </div>
        ) : Array.isArray(cards) && cards.length > 0 ? (
          <ul className="mt-3 grid grid-cols-2 gap-2.5">
            {cards.map((card) => (
              <li
                key={card.id}
                className="group flex flex-col overflow-hidden rounded-xl border border-cs2-border-subtle bg-cs2-bg-input/40 transition-all hover:border-cs2-border-focus"
              >
                <div className="relative aspect-square w-full overflow-hidden bg-black/40">
                  {card.video_url ? (
                    <video
                      src={radarVideoUrl(card.video_url)}
                      className="h-full w-full object-cover"
                      muted
                      loop
                      autoPlay
                      playsInline
                      title={card.player_name}
                    />
                  ) : (
                    <img
                      src={radarImageUrl(card.image_url)}
                      alt={card.player_name}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => toggleSelect(card.id)}
                    aria-pressed={selectedIds.has(card.id)}
                    title={t("radar.cardSelect")}
                    className={`absolute left-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-md border backdrop-blur-sm transition-all ${
                      selectedIds.has(card.id)
                        ? "border-cs2-accent bg-cs2-accent text-white"
                        : "border-white/30 bg-black/50 text-transparent hover:border-cs2-accent/80"
                    }`}
                  >
                    {selectedIds.has(card.id) ? (
                      <Check size={13} strokeWidth={3} aria-hidden />
                    ) : (
                      <Square size={13} aria-hidden />
                    )}
                  </button>
                  <span className="absolute left-1.5 top-7 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                    {card.player_name}
                  </span>
                  {card.video_url ? (
                    <span className="absolute right-1.5 top-1.5 rounded-md bg-cs2-accent/85 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {t("radar.cardHasAnimation")}
                    </span>
                  ) : null}
                  {card.portrait_file ? (
                    <span className="absolute right-1.5 top-6.5 rounded-md bg-emerald-500/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {t("radar.cardHasPortrait")}
                    </span>
                  ) : null}
                  {card.team_logo_file ? (
                    <span className="absolute right-1.5 top-12 rounded-md bg-cyan-500/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {t("radar.cardHasTeamLogo")}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1 p-2">
                  <div className="flex items-center gap-1.5">
                    <p className="min-w-0 truncate text-[11px] font-semibold text-cs2-text-secondary">
                      {card.team_label || t("radar.cardTeamUnknown")}
                      {card.demo_name ? ` · ${String(card.demo_name).replace(/\.[^.]+$/, "")}` : ""}
                    </p>
                    {(() => {
                      const cmp = compareToMatchAvg(card.radar, card.match_avg);
                      if (cmp > 0) {
                        return <span className="shrink-0 rounded bg-emerald-500/10 px-1 py-0.5 text-[9px] font-bold text-emerald-300">▲ {t("radar.cardAboveMatch")}</span>;
                      }
                      if (cmp < 0) {
                        return <span className="shrink-0 rounded bg-rose-500/10 px-1 py-0.5 text-[9px] font-bold text-rose-300">▼ {t("radar.cardBelowMatch")}</span>;
                      }
                      return <span className="shrink-0 rounded bg-cs2-bg-input px-1 py-0.5 text-[9px] font-bold text-cs2-text-muted">= {t("radar.cardAtMatch")}</span>;
                    })()}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-cs2-text-muted" title={radarCompositionLine(card.radar)}>
                    {radarCompositionLine(card.radar)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {RADAR_DIMENSIONS.slice(0, 3).map((dim) => (
                      <span key={dim.key} className="rounded bg-cs2-bg-input px-1 py-0.5 text-[9px] font-medium text-cs2-text-secondary">
                        {dim.name} {card.radar?.[dim.key] != null ? card.radar[dim.key] : "—"}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 border-t border-cs2-border-subtle p-2">
                  <button
                    type="button"
                    disabled={busyCardId === card.id}
                    onClick={() => handleInsert(card)}
                    className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-cs2-accent px-2 py-1.5 text-[10px] font-bold text-cs2-text-on-accent transition-all hover:bg-cs2-accent-light disabled:opacity-40"
                  >
                    {busyCardId === card.id && insertingCardId === card.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    {t("radar.cardInsertBefore")}
                  </button>
                  <button
                    type="button"
                    disabled={busyCardId === card.id}
                    onClick={() => void handleEnsureAnimation(card)}
                    title={t("radar.cardAnimationTitle")}
                    className="inline-flex items-center justify-center rounded-lg border border-cs2-border-subtle px-2 py-1.5 text-cs2-text-secondary transition-all hover:border-cs2-accent/60 hover:text-cs2-text-primary disabled:opacity-40"
                  >
                    {busyCardId === card.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Clapperboard className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={busyCardId === card.id}
                    onClick={() => setFileInputCardId(card.id)}
                    title={t("radar.cardUploadPortraitTitle")}
                    className="inline-flex items-center justify-center rounded-lg border border-cs2-border-subtle px-2 py-1.5 text-cs2-text-secondary transition-all hover:border-cs2-accent/60 hover:text-cs2-text-primary disabled:opacity-40"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busyCardId === card.id}
                    onClick={() => void handleUseSteamAvatar(card)}
                    title={t("radar.cardSteamAvatarTitle")}
                    className="inline-flex items-center justify-center rounded-lg border border-cs2-border-subtle px-2 py-1.5 text-cs2-text-secondary transition-all hover:border-cs2-accent/60 hover:text-cs2-text-primary disabled:opacity-40"
                  >
                    <UserRound className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busyCardId === card.id}
                    onClick={() => setLogoInputCardId(card.id)}
                    title={t("radar.cardTeamLogoTitle")}
                    className="inline-flex items-center justify-center rounded-lg border border-cs2-border-subtle px-2 py-1.5 text-cs2-text-secondary transition-all hover:border-cyan-500/50 hover:text-cyan-300 disabled:opacity-40"
                  >
                    <Flag className="h-3.5 w-3.5" />
                  </button>
                  {card.team_logo_file ? (
                    <button
                      type="button"
                      disabled={busyCardId === card.id}
                      onClick={() => void handleClearTeamLogo(card)}
                      title={t("radar.clearTeamLogoTitle")}
                      className="inline-flex items-center justify-center rounded-lg border border-cs2-border-subtle px-2 py-1.5 text-cs2-text-muted transition-all hover:border-rose-500/30 hover:text-rose-400 disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busyCardId === card.id}
                    onClick={() => void handleDelete(card)}
                    title={t("radar.cardDeleteTitle")}
                    className="inline-flex items-center justify-center rounded-lg border border-cs2-border-subtle px-2 py-1.5 text-cs2-text-muted transition-all hover:border-rose-500/30 hover:text-rose-400 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-cs2-border-subtle bg-cs2-surface-1/50 px-3 py-5 text-center">
            <p className="text-[11px] font-medium text-cs2-text-secondary">{t("radar.cardsEmpty")}</p>
            <p className="mt-1 text-[10px] leading-relaxed text-cs2-text-muted">{t("radar.cardsEmptyHint")}</p>
            <Link
              to="/analysis"
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-cs2-accent/40 bg-cs2-accent-soft px-3 py-1.5 text-[11px] font-bold text-cs2-accent transition-all hover:bg-cs2-accent hover:text-white"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              {t("radar.goAnalysisBtn")}
            </Link>
          </div>
        )}
      </div>

      {/* 隐藏的文件选择器：上传人物图片 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const card = (Array.isArray(cards) ? cards : []).find((c) => c.id === fileInputCardId);
          const file = e.target.files?.[0];
          e.target.value = "";
          if (card && file) void handlePortraitFile(card, file);
          else setFileInputCardId(null);
        }}
      />

      {/* 隐藏的文件选择器：上传队伍标志（放大显示在头像后面） */}
      <input
        ref={logoInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const card = (Array.isArray(cards) ? cards : []).find((c) => c.id === logoInputCardId);
          const file = e.target.files?.[0];
          e.target.value = "";
          if (card && file) void handleTeamLogoFile(card, file);
          else setLogoInputCardId(null);
        }}
      />
    </div>
  );
}
