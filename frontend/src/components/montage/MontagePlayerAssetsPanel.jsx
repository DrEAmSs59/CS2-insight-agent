import { useState, useRef, useMemo } from "react";
import { Upload, Loader2 } from "lucide-react";
import { CollapsibleSection } from "./MontageWorkbenchPanels";
import API, { API_BASE_URL } from "../../api/api";
import { derivePlayerAssetsFromClips } from "../../utils/montageUtils";
import { useT } from "../../i18n/useT.js";

export function MontagePlayerAssetsPanel({
  clips,
  playerAvatars,
  nameCardsEnabled,
  onPlayerAvatarChange,
  onNameCardsEnabledChange,
}) {
  const t = useT();
  const players = useMemo(() => derivePlayerAssetsFromClips(clips), [clips]);
  const [uploadingKeys, setUploadingKeys] = useState(() => new Set());
  const [uploadErrors, setUploadErrors] = useState({}); // { [player_key]: errorMsg }
  // one hidden file input ref per player_key; keyed by player_key string
  const fileInputRefs = useRef({});

  const hasAnyAvatar = players.some(
    (p) => playerAvatars[p.player_key]?.avatar_path,
  );

  async function handleFileSelected(playerKey, file) {
    if (!file) return;
    setUploadingKeys((prev) => new Set([...prev, playerKey]));
    // clear any previous error for this player
    setUploadErrors((prev) => {
      const n = { ...prev };
      delete n[playerKey];
      return n;
    });
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await API.post("/montage/avatars", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const { path, url } = res?.data ?? {};
      if (path) {
        const fullUrl = url ? (API_BASE_URL ? `${API_BASE_URL}${url}` : url) : null;
        onPlayerAvatarChange?.(playerKey, path, fullUrl);
      }
    } catch (err) {
      console.error("[MontagePlayerAssetsPanel] avatar upload error", err);
      setUploadErrors((prev) => ({ ...prev, [playerKey]: t("montage.playerAssetsUploadError") }));
    } finally {
      setUploadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(playerKey);
        return next;
      });
      // reset input so the same file can be re-selected
      if (fileInputRefs.current[playerKey]) {
        fileInputRefs.current[playerKey].value = "";
      }
    }
  }

  return (
    <CollapsibleSection
      title={t("montage.playerAssetsSectionTitle")}
      hint={t("montage.playerAssetsSectionHint")}
      defaultOpen
    >
      {/* Total enable/disable toggle */}
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs font-semibold text-cs2-text-secondary">
          {t("montage.playerAssetsToggleLabel")}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={nameCardsEnabled}
          aria-label={nameCardsEnabled ? t("montage.playerAssetsToggleOff") : t("montage.playerAssetsToggleOn")}
          onClick={() => onNameCardsEnabledChange?.(!nameCardsEnabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cs2-surface-1 ${
            nameCardsEnabled
              ? "border-cs2-accent bg-cs2-accent"
              : "border-cs2-border-subtle bg-cs2-bg-input shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]"
          }`}
        >
          <span
            className={`pointer-events-none absolute top-0.5 left-0.5 inline-block h-4 w-4 rounded-full shadow-md ring-1 transition-transform ${
              nameCardsEnabled
                ? "translate-x-5 bg-white ring-white/20"
                : "translate-x-0 bg-cs2-text-secondary ring-cs2-border-subtle"
            }`}
          />
        </button>
      </div>

      {/* Player list */}
      {players.length === 0 ? (
        <div
          className={`rounded-xl border p-4 text-center text-xs text-cs2-text-muted border-dashed border-cs2-border-subtle bg-cs2-surface-1/40`}
        >
          {t("montage.playerAssetsEmpty")}
        </div>
      ) : (
        <div
          className={`rounded-xl border p-3 transition-all ${
            hasAnyAvatar
              ? "border-violet-500/40 bg-violet-500/[0.08]"
              : "border-dashed border-cs2-border-subtle bg-cs2-surface-1/40"
          }`}
        >
          <div className="space-y-1">
            {players.map((player) => {
              const avatarUrl = playerAvatars[player.player_key]?.avatar_url;
              const isUploading = uploadingKeys.has(player.player_key);
              const uploadError = uploadErrors[player.player_key];
              const initials = player.display_name
                ? player.display_name.charAt(0).toUpperCase()
                : "?";

              return (
                <div
                  key={player.player_key}
                  className="flex items-center gap-3 py-2"
                >
                  {/* Avatar preview */}
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={player.display_name}
                      className="h-10 w-10 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cs2-surface-2 text-sm font-bold text-cs2-text-secondary">
                      {initials}
                    </div>
                  )}

                  {/* Name + segment count */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-bold text-cs2-text-primary">
                        {player.display_name}
                      </span>
                      {player.no_steamid && (
                        <span className="rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">
                          {t("montage.playerAssetsNoSteamId")}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-cs2-text-muted">
                      {t("montage.playerAssetsSegmentCount", { n: player.segment_count })}
                    </p>
                  </div>

                  {/* Upload button + hidden input */}
                  <div className="shrink-0">
                    <input
                      ref={(el) => {
                        if (el) fileInputRefs.current[player.player_key] = el;
                        else delete fileInputRefs.current[player.player_key];
                      }}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      onChange={(e) =>
                        handleFileSelected(
                          player.player_key,
                          e.target.files?.[0] ?? null,
                        )
                      }
                    />
                    <button
                      type="button"
                      disabled={isUploading}
                      onClick={() =>
                        fileInputRefs.current[player.player_key]?.click()
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-2 py-1 text-xs text-cs2-text-primary transition-all hover:border-cs2-border-focus disabled:opacity-60"
                    >
                      {isUploading ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t("montage.playerAssetsUploading")}
                        </>
                      ) : (
                        <>
                          <Upload className="h-3 w-3" />
                          {t("montage.playerAssetsUploadBtn")}
                        </>
                      )}
                    </button>
                    {uploadError && (
                      <p className="mt-1 text-xs text-rose-400">{uploadError}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}
