import { useCallback, useEffect, useState } from "react";
import API from "../api/api";
import { useT } from "../i18n/useT.js";

/**
 * 实验性 POV：与常用参数 / 录制前观战弹窗共用；勾选写入 experimental.pov_enabled。
 * POV 开启时可调节雷达与 HUD 正上方玩家显示（写入预热参数）。
 */
export default function ExperimentalPovSection({
  visible,
  experimentalPovEnabled,
  onExperimentalPovChange,
  checkboxDisabled = false,
  povRadarMode = 0,
  onPovRadarModeChange,
  povTeamcounterNumeric = false,
  onPovTeamcounterNumericChange,
  povVoiceDisabled = false,
  onPovVoiceDisabledChange,
  omitEyebrow = false,
  className,
}) {
  const t = useT();
  const [povStatus, setPovStatus] = useState(null);
  const [povStatusLoading, setPovStatusLoading] = useState(false);
  const [povStatusError, setPovStatusError] = useState("");
  const [povRestoreBusy, setPovRestoreBusy] = useState(false);
  const [povRestoreResult, setPovRestoreResult] = useState(null);

  const radarVal = povRadarMode === 0 ? 0 : -1;

  const loadPovStatus = useCallback(async () => {
    setPovStatusLoading(true);
    setPovStatusError("");
    try {
      const { data } = await API.get("experimental/pov/status");
      setPovStatus(data && typeof data === "object" ? data : null);
    } catch (error) {
      setPovStatus(null);
      setPovStatusError(
        error?.response?.data?.detail || error?.message || t("pov.statusError"),
      );
    } finally {
      setPovStatusLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!visible) return;
    setPovRestoreResult(null);
    void loadPovStatus();
  }, [visible, experimentalPovEnabled, loadPovStatus]);

  const povNeedsRestore = Boolean(povStatus?.needs_restore);
  const restoreState = String(povStatus?.state || "managed").toLowerCase();
  const restoreNeededKey = restoreState === "orphaned"
    ? "pov.restoreOrphaned"
    : restoreState === "corrupted"
      ? "pov.restoreCorrupted"
      : "pov.restoreManaged";

  const rootClass =
    className ??
    "rounded-lg border border-amber-500/25 bg-cs2-amber-surface p-4";

  return (
    <section className={rootClass}>
      {!omitEyebrow ? (
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-cs2-amber-on-surface">{t("pov.eyebrowLabel")}</p>
      ) : null}
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-cs2-border bg-cs2-bg-card px-3 py-2">
        <input
          type="checkbox"
          disabled={checkboxDisabled || !onExperimentalPovChange}
          checked={!!experimentalPovEnabled}
          onChange={(e) => onExperimentalPovChange?.(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-40"
        />
        <span className="min-w-0 text-[12px] leading-snug text-cs2-text-primary">
          <span className="font-semibold text-cs2-amber-on-surface/95">{t("pov.checkboxTitle")}</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-cs2-text-muted">
            {t("pov.checkboxDescMain")}<br />{t("pov.checkboxDescNote")}
          </span>
        </span>
      </label>
      {experimentalPovEnabled ? (
        <p className="mt-2 text-[11px] leading-relaxed text-cs2-amber-on-surface">
          {t("pov.enabledNote")}
        </p>
      ) : null}

      {experimentalPovEnabled && onPovRadarModeChange && onPovTeamcounterNumericChange ? (
        <div className="mt-3 space-y-4 rounded-lg border border-cs2-border bg-cs2-bg-elevated px-3 py-2.5">
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-card px-2 py-2">
            <input
              type="checkbox"
              disabled={!onPovVoiceDisabledChange}
              checked={!!povVoiceDisabled}
              onChange={(e) => onPovVoiceDisabledChange?.(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-40"
            />
            <span className="min-w-0 text-[11px] leading-snug text-cs2-text-secondary">
              <span className="font-semibold text-cs2-text-primary">{t("pov.voiceDisabledTitle")}</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-cs2-text-muted">
                {t("pov.voiceDisabledHint")}
              </span>
            </span>
          </label>

          <label className="block text-[11px] text-cs2-text-secondary">
            <span className="mb-1 block font-medium text-cs2-text-secondary">{t("pov.radarLabel")}</span>
            <select
              value={String(radarVal)}
              onChange={(e) => onPovRadarModeChange(parseInt(e.target.value, 10))}
              className="mt-1 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/50"
            >
              <option value="-1">{t("pov.radarHide")}</option>
              <option value="0">{t("pov.radarShow")}</option>
            </select>
            <span className="mt-1 block text-[10px] leading-relaxed text-cs2-text-muted">
              {t("pov.radarHint")}
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-card px-2 py-2">
            <input
              type="checkbox"
              checked={!!povTeamcounterNumeric}
              onChange={(e) => onPovTeamcounterNumericChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
            />
            <span className="min-w-0 text-[11px] leading-snug text-cs2-text-secondary">
              <span className="font-semibold text-cs2-text-primary">{t("pov.teamcounterTitle")}</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-cs2-text-muted">
                <code className="text-cs2-accent/90">cl_teamcounter_playercount_instead_of_avatars</code>
                {t("pov.teamcounterHintPre")}<strong className="text-cs2-text-secondary">{t("pov.teamcounterStrongOn")}</strong>{t("pov.teamcounterHintMid")}<strong className="text-cs2-text-secondary">{t("pov.teamcounterStrongOff")}</strong>{t("pov.teamcounterHintPost")}
              </span>
            </span>
          </label>
        </div>
      ) : null}

      <div className="mt-2 rounded border border-cs2-border bg-cs2-bg-card px-2.5 py-2 text-[11px] leading-relaxed text-cs2-text-muted">
        {t("pov.disclaimer")}
      </div>

      {povStatusError && !povStatusLoading ? (
        <div className="mt-3 rounded border border-amber-500/35 bg-cs2-amber-surface px-2.5 py-2 text-[11px] text-cs2-amber-on-surface">
          <p>{t("pov.statusError")}</p>
          <p className="mt-1 break-all text-[10px] opacity-85">{povStatusError}</p>
          <button
            type="button"
            onClick={() => void loadPovStatus()}
            className="mt-2 rounded border border-amber-400/40 px-2 py-1 text-[11px] font-semibold hover:bg-cs2-amber-surface"
          >
            {t("pov.statusRetryBtn")}
          </button>
        </div>
      ) : null}

      {povNeedsRestore && !povStatusLoading ? (
        <div className="mt-3 rounded border border-rose-500/35 bg-cs2-rose-surface px-2.5 py-2 text-[11px] text-cs2-rose-on-surface">
          <p className="font-semibold">{t(restoreNeededKey)}</p>
          <p className="mt-1 text-[10px] opacity-85">
            {povStatus?.cs2_running ? t("pov.restoreCloseCs2") : t("pov.restoreReady")}
          </p>
          {povRestoreResult?.tone === "error" ? (
            <p className="mt-2 break-all rounded border border-rose-400/30 bg-cs2-rose-surface px-2 py-1.5 text-[10px]">
              {t("pov.restoreFailed", { msg: povRestoreResult.message })}
            </p>
          ) : null}
          <button
            type="button"
            disabled={povRestoreBusy}
            onClick={async () => {
              setPovRestoreBusy(true);
              setPovRestoreResult(null);
              try {
                const { data } = await API.post("experimental/pov/restore");
                const restore = data?.restore && typeof data.restore === "object"
                  ? data.restore
                  : {};
                if (data?.ok !== true || restore.verified !== true) {
                  throw new Error(restore.error || t("pov.restoreUnverified"));
                }
                const mode = String(restore.verification_mode || "none").toLowerCase();
                const messageKey = mode === "strict"
                  ? "pov.restoreStrictSuccess"
                  : mode === "semantic"
                    ? "pov.restoreSemanticSuccess"
                    : "pov.restoreNoneSuccess";
                setPovRestoreResult({ tone: "success", messageKey });
                setPovStatus((current) => ({
                  ...(current || {}),
                  state: "clean",
                  needs_restore: false,
                  installed: false,
                  gameinfo_patched: false,
                  manifest_exists: false,
                  backup_exists: false,
                }));
              } catch (error) {
                setPovRestoreResult({
                  tone: "error",
                  message: error?.response?.data?.detail || error?.message || t("common.requestFail"),
                });
              } finally {
                setPovRestoreBusy(false);
              }
            }}
            className="mt-2 rounded border border-rose-400/40 px-2 py-1 text-[11px] font-semibold text-rose-100 hover:bg-cs2-rose-surface disabled:opacity-40"
          >
            {povRestoreBusy ? t("pov.restoringBtn") : t("pov.restoreBtn")}
          </button>
        </div>
      ) : null}

      {!povNeedsRestore && povRestoreResult?.tone === "success" ? (
        <div className="mt-3 rounded border border-emerald-500/35 bg-cs2-emerald-surface px-2.5 py-2 text-[11px] text-cs2-emerald-on-surface">
          {t(povRestoreResult.messageKey)}
        </div>
      ) : null}
    </section>
  );
}
