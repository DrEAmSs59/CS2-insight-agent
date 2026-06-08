import { useEffect, useState } from "react";
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
  omitEyebrow = false,
  className,
}) {
  const t = useT();
  const [povNeedsRestore, setPovNeedsRestore] = useState(false);
  const [povStatusLoading, setPovStatusLoading] = useState(false);
  const [povRestoreBusy, setPovRestoreBusy] = useState(false);

  const radarVal = povRadarMode === 0 ? 0 : -1;

  useEffect(() => {
    if (!visible) return;
    setPovStatusLoading(true);
    (async () => {
      try {
        const { data } = await API.get("experimental/pov/status");
        setPovNeedsRestore(!!data?.needs_restore);
      } catch {
        setPovNeedsRestore(false);
      } finally {
        setPovStatusLoading(false);
      }
    })();
  }, [visible, experimentalPovEnabled]);

  const rootClass =
    className ??
    "rounded-lg border border-amber-500/25 bg-cs2-amber-surface p-4";

  return (
    <section className={rootClass}>
      {!omitEyebrow ? (
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-cs2-amber-on-surface">{t("pov.eyebrowLabel")}</p>
      ) : null}
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input/50 px-3 py-2">
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
        <div className="mt-3 space-y-4 rounded-lg border border-cs2-border bg-cs2-bg-input/30 px-3 py-2.5">
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

          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-input/40 px-2 py-2">
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

      <div className="mt-2 rounded border border-cs2-border bg-cs2-bg-input/40 px-2.5 py-2 text-[11px] leading-relaxed text-cs2-text-muted">
        {t("pov.disclaimer")}
      </div>

      {povNeedsRestore && !povStatusLoading ? (
        <div className="mt-3 rounded border border-rose-500/35 bg-cs2-rose-surface px-2.5 py-2 text-[11px] text-cs2-rose-on-surface">
          <p>{t("pov.restoreNeeded")}</p>
          <button
            type="button"
            disabled={povRestoreBusy}
            onClick={async () => {
              setPovRestoreBusy(true);
              try {
                await API.post("experimental/pov/restore");
                setPovNeedsRestore(false);
              } catch {
                /* ignore */
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
    </section>
  );
}
