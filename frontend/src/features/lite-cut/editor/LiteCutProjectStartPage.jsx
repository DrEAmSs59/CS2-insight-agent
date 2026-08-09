import { useMemo, useState } from "react";
import { Clock3, FilePlus2, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useT } from "../../../i18n/useT.js";
import LiteCutNewProjectDialog from "./LiteCutNewProjectDialog.jsx";

function formatProjectTime(value, locale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function LiteCutProjectStartPage({ projects = [], loading = false, onRefresh, onOpenProject, onNewProject }) {
  const t = useT();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [openingId, setOpeningId] = useState(null);
  const recentProjects = useMemo(
    () => [...projects]
      .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
      .slice(0, 12),
    [projects],
  );

  const openProject = async (id) => {
    if (openingId != null) return;
    setOpeningId(id);
    try {
      await onOpenProject?.(id);
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div data-litecut-start-page className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-cs2-bg-page p-5 sm:p-8">
      <main className="w-full max-w-5xl overflow-hidden rounded-2xl border border-cs2-border bg-cs2-bg-card shadow-2xl">
        <header className="border-b border-cs2-border px-6 py-6 sm:px-8">
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cs2-accent">LiteCut</p>
          <h1 className="mt-2 text-2xl font-bold text-cs2-text-primary">{t("liteCut.project.startTitle")}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-cs2-text-muted">{t("liteCut.project.startHint")}</p>
        </header>

        <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section>
            <button type="button" onClick={() => setNewProjectOpen(true)} className="flex w-full items-center gap-4 rounded-xl border border-cs2-accent/45 bg-cs2-accent-soft/40 p-5 text-left hover:border-cs2-accent hover:bg-cs2-accent-soft/70">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cs2-accent text-black"><FilePlus2 className="h-5 w-5" /></span>
              <span>
                <span className="block text-sm font-bold text-cs2-text-primary">{t("liteCut.project.startNew")}</span>
                <span className="mt-1 block text-[11px] leading-5 text-cs2-text-muted">{t("liteCut.project.startNewHint")}</span>
              </span>
            </button>
            <div className="mt-4 rounded-xl border border-cs2-border-subtle bg-black/15 p-4 text-[11px] leading-5 text-cs2-text-muted">{t("liteCut.project.startNotice")}</div>
          </section>

          <section className="min-w-0">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-cs2-accent" />
              <h2 className="text-sm font-bold text-cs2-text-primary">{t("liteCut.project.startRecent")}</h2>
              <span className="text-[10px] text-cs2-text-muted">{recentProjects.length}</span>
              <button type="button" title={t("liteCut.project.refresh")} onClick={onRefresh} className="ml-auto rounded p-2 text-cs2-text-muted hover:bg-white/5 hover:text-white"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
            </div>

            <div className="mt-3 max-h-[430px] space-y-2 overflow-y-auto pr-1">
              {loading && recentProjects.length === 0 ? <div className="flex items-center justify-center gap-2 rounded-xl border border-cs2-border-subtle py-12 text-xs text-cs2-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t("liteCut.project.loading")}</div> : null}
              {!loading && recentProjects.length === 0 ? <div className="rounded-xl border border-dashed border-cs2-border px-5 py-12 text-center"><p className="text-sm font-semibold text-cs2-text-secondary">{t("liteCut.project.startEmpty")}</p><p className="mt-2 text-[11px] text-cs2-text-muted">{t("liteCut.project.startEmptyHint")}</p></div> : null}
              {recentProjects.map((project) => (
                <button key={project.id} type="button" disabled={openingId != null} onClick={() => void openProject(project.id)} className="group flex w-full items-center gap-3 rounded-xl border border-cs2-border-subtle bg-cs2-surface-1/50 px-4 py-3 text-left hover:border-cs2-accent/45 hover:bg-white/[0.03] disabled:opacity-50">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black/25 text-cs2-text-muted group-hover:text-cs2-accent">{Number(openingId) === Number(project.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-cs2-text-primary">{project.name || t("liteCut.project.untitled")}</span>
                    <span className="mt-1 flex items-center gap-1 text-[10px] text-cs2-text-muted"><Clock3 className="h-3 w-3" />{formatProjectTime(project.updated_at, t("common.localeCode"))}</span>
                  </span>
                  <span className="text-[10px] text-cs2-text-muted">#{project.id}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </main>

      <LiteCutNewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreate={onNewProject} />
    </div>
  );
}
