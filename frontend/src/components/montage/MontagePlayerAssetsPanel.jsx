import { useState, useRef, useMemo } from "react";
import { Upload, Loader2 } from "lucide-react";
import { CollapsibleSection } from "./MontageWorkbenchPanels";
import API from "../../api/api";
import { derivePlayerAssetsFromClips } from "../../utils/montageUtils";

export function MontagePlayerAssetsPanel({
  clips,
  playerAvatars,
  nameCardsEnabled,
  onPlayerAvatarChange,
  onNameCardsEnabledChange,
}) {
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
        onPlayerAvatarChange?.(playerKey, path, url);
      }
    } catch (err) {
      console.error("[MontagePlayerAssetsPanel] avatar upload error", err);
      setUploadErrors((prev) => ({ ...prev, [playerKey]: "上传失败，请重试" }));
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
      title="玩家头像"
      hint="为每位玩家配置头像和名字信息卡"
      defaultOpen
    >
      {/* Total enable/disable toggle */}
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs font-semibold text-cs2-text-secondary">
          显示玩家信息卡
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={nameCardsEnabled}
          onClick={() => onNameCardsEnabledChange?.(!nameCardsEnabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent ${
            nameCardsEnabled ? "bg-cs2-accent" : "bg-cs2-surface-2"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
              nameCardsEnabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* Player list */}
      {players.length === 0 ? (
        <div
          className={`rounded-xl border p-4 text-center text-xs text-cs2-text-muted border-dashed border-cs2-border-subtle bg-cs2-surface-1/40`}
        >
          编排时间线中暂无可识别玩家
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
                          未识别 ID
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-cs2-text-muted">
                      参与 {player.segment_count} 段
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
                          上传中
                        </>
                      ) : (
                        <>
                          <Upload className="h-3 w-3" />
                          上传头像
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
