import { useEffect } from "react";
import { FolderOpen, RefreshCw, ShieldAlert, CheckCircle2, Loader2 } from "lucide-react";
import { useAppShell } from "../context/AppShellContext";
import PageContainer from "../components/PageContainer";
import { useT } from "../i18n/useT.js";

export default function PlayerGameConfigPage() {
  const t = useT();
  const s = useAppShell();
  const loading = s.configBackupLoading;
  const st = s.configBackupStatus;

  useEffect(() => {
    void s.refreshConfigBackupStatus();
  }, [s.refreshConfigBackupStatus]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <PageContainer>
      <div className="mb-6 shrink-0 border-b border-cs2-border pb-4">
        <h1 className="text-lg font-bold text-cs2-text-primary">{t("playercfg.pageTitle")}</h1>
        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-cs2-text-muted">
          {t("playercfg.pageSubtitle")}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void s.refreshConfigBackupStatus()}
            className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-hover px-3 py-2 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            {t("playercfg.btnRefresh")}
          </button>
          <button
            type="button"
            onClick={() => void s.handleOpenConfigBackupDir()}
            className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-hover px-3 py-2 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary"
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            {t("playercfg.btnOpenBackupDir")}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-card px-4 py-3 text-[12px] text-cs2-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" aria-hidden />
            {t("playercfg.loading")}
          </div>
        ) : st?.fetch_failed ? (
          <section
            className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-4"
            role="alert"
          >
            <p className="text-sm font-bold text-red-200">{t("playercfg.fetchFailTitle")}</p>
            <p className="mt-2 text-[12px] leading-relaxed text-red-100/85">{st.message}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-cs2-text-muted">
              {t("playercfg.fetchFailHint", { data: "data", data2: "data", backup: ".cs2_config_backup" })}
            </p>
          </section>
        ) : st?.restore_required ? (
          <section
            className="rounded-xl border border-amber-500/45 bg-amber-500/10 px-4 py-4 shadow-sm"
            role="status"
          >
            <div className="flex flex-wrap items-start gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-bold text-cs2-amber-on-surface">{t("playercfg.restoreTitle")}</p>
                <p className="text-[12px] leading-relaxed text-cs2-amber-on-surface/85">
                  {t("playercfg.restoreDesc")}
                </p>
                {typeof st.cs2_running === "boolean" && (
                  <p className="font-mono text-[12px] text-cs2-amber-on-surface">
                    {st.cs2_running ? t("playercfg.cs2StatusRunning") : t("playercfg.cs2StatusStopped")}
                  </p>
                )}
                {st.backup_dir ? (
                  <p className="break-all font-mono text-[11px] leading-relaxed text-cs2-text-muted">
                    {t("playercfg.backupDir")}<span className="text-cs2-text-secondary">{st.backup_dir}</span>
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    className="rounded-md border border-amber-400/60 bg-amber-500/25 px-4 py-2 text-[12px] font-bold text-cs2-amber-on-surface hover:bg-amber-500/35"
                    onClick={() => void s.handleRestorePlayerConfig()}
                  >
                    {t("playercfg.btnRestore")}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-md border border-cs2-border bg-cs2-bg-input/40 px-4 py-2 text-[12px] font-semibold text-cs2-text-primary hover:border-cs2-border"
                    onClick={() => void s.handleOpenConfigBackupDir()}
                  >
                    <FolderOpen className="h-4 w-4" aria-hidden />
                    {t("playercfg.btnOpenBackupDir")}
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-4">
            <div className="flex flex-wrap items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-bold text-cs2-emerald-on-surface">{t("playercfg.okTitle")}</p>
                <p className="text-[12px] leading-relaxed text-cs2-emerald-on-surface/80">
                  {t("playercfg.okDesc")}
                </p>
                {st?.backup_dir ? (
                  <p className="break-all font-mono text-[11px] leading-relaxed text-cs2-text-muted">
                    {t("playercfg.backupDir")}<span className="text-cs2-text-secondary">{st.backup_dir}</span>
                  </p>
                ) : null}
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-2 rounded-md border border-cs2-border bg-cs2-bg-input/30 px-3 py-2 text-[12px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/35"
                  onClick={() => void s.handleOpenConfigBackupDir()}
                >
                  <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                  {t("playercfg.btnOpenBackupDir")}
                </button>
              </div>
            </div>
          </section>
        )}

        {st?.message && !st.fetch_failed ? (
          <p className="rounded-lg border border-cs2-border bg-cs2-bg-card px-3 py-2 font-mono text-[12px] text-cs2-text-secondary">
            {st.message}
          </p>
        ) : null}
      </div>
      </PageContainer>
    </div>
  );
}
