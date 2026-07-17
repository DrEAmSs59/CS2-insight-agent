import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, FilePlus2, FolderOpen, Loader2, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useT } from "../../../i18n/useT.js";

function projectStats(body) {
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  const clips = tracks.reduce((count, track) => count + (track?.clips?.length || 0), 0);
  return { tracks: tracks.length, clips };
}

function formatProjectTime(value, locale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function LiteCutProjectDrawer({
  open,
  onClose,
  projectId,
  projectName,
  dirty,
  body,
  projects = [],
  loading = false,
  projectTemplates = [],
  onRefresh,
  onOpenProject,
  onNewProject,
  onDuplicateProject,
  onDeleteProject,
  onDeleteProjects,
  onImportProject,
  onExportProject,
  onProjectNameChange,
  onProjectSettingsChange,
  onRequestNewProject,
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const importInputRef = useRef(null);
  const selectAllRef = useRef(null);
  const stats = projectStats(body);
  const output = body?.output || {};
  const width = Number(output.width) || 1920;
  const height = Number(output.height) || 1080;
  const fps = Number(output.fps) || 60;

  useEffect(() => {
    if (open) onRefresh?.();
  }, [open, onRefresh]);

  const matchingProjects = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return [...projects]
      .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
      .filter((project) => !keyword || String(project.name || "").toLocaleLowerCase().includes(keyword));
  }, [projects, query]);
  const matchingIds = useMemo(() => matchingProjects.map((project) => Number(project.id)), [matchingProjects]);
  const matchingSelectedCount = matchingIds.filter((id) => selectedProjectIds.has(id)).length;
  const allMatchingSelected = matchingIds.length > 0 && matchingSelectedCount === matchingIds.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = matchingSelectedCount > 0 && !allMatchingSelected;
    }
  }, [allMatchingSelected, matchingSelectedCount]);

  useEffect(() => {
    const existing = new Set(projects.map((project) => Number(project.id)));
    setSelectedProjectIds((current) => new Set([...current].filter((id) => existing.has(id))));
  }, [projects]);

  useEffect(() => {
    if (!open) setSelectedProjectIds(new Set());
  }, [open]);

  const toggleProject = (id) => {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllMatching = () => {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (allMatchingSelected) matchingIds.forEach((id) => next.delete(id));
      else matchingIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const handleBatchDelete = async () => {
    const ids = [...selectedProjectIds];
    if (!ids.length || batchDeleting) return;
    if (!window.confirm(t("liteCut.project.batchDeleteConfirm", { count: ids.length }))) return;
    setBatchDeleting(true);
    try {
      const result = await onDeleteProjects?.(ids);
      if (result?.ok !== false) setSelectedProjectIds(new Set());
    } finally {
      setBatchDeleting(false);
    }
  };

  const chooseProject = async (id) => {
    await onOpenProject?.(id);
    onClose?.();
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await onImportProject?.(file);
    onClose?.();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/45" role="dialog" aria-modal="true" aria-label={t("liteCut.project.drawerTitle")}>
      <section className="flex h-full w-full max-w-md flex-col border-l border-cs2-border bg-cs2-bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-cs2-border px-4 py-3">
          <div>
            <p className="text-sm font-bold text-cs2-text-primary">{t("liteCut.project.drawerTitle")}</p>
            <p className="mt-0.5 text-[10px] text-cs2-text-muted">{t("liteCut.project.drawerSubtitle")}</p>
          </div>
          <button type="button" title={t("common.close")} onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-cs2-text-muted hover:bg-white/5 hover:text-cs2-text-primary">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <section className="rounded-xl border border-cs2-accent/25 bg-cs2-accent-soft/30 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-cs2-accent">{t("liteCut.project.current")}</p>
            <div className="mt-1 flex items-center justify-between gap-3">
              <input value={projectName || ""} onChange={(event) => onProjectNameChange?.(event.target.value)} className="min-w-0 flex-1 border-b border-transparent bg-transparent text-sm font-bold text-cs2-text-primary outline-none hover:border-white/15 focus:border-cs2-accent" aria-label={t("liteCut.project.name")} />
              <span className={`shrink-0 text-[10px] font-semibold ${dirty ? "text-amber-300" : "text-emerald-300"}`}>{dirty ? t("liteCut.project.unsaved") : t("liteCut.project.saved")}</span>
            </div>
            <p className="mt-2 text-[10px] text-cs2-text-muted">{t("liteCut.project.currentMeta", { id: projectId || t("liteCut.project.draft"), tracks: stats.tracks, clips: stats.clips })}</p>
            <div className="mt-3 border-t border-white/10 pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-cs2-text-muted">{t("liteCut.project.outputSettings")}</p>
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {[
                  ["16:9", 1920, 1080],
                  ["9:16", 1080, 1920],
                  ["1:1", 1080, 1080],
                  ["4:3", 1440, 1080],
                ].map(([label, nextWidth, nextHeight]) => (
                  <button key={label} type="button" onClick={() => onProjectSettingsChange?.({ width: nextWidth, height: nextHeight })} className={`rounded-md border px-1.5 py-1 text-[10px] font-semibold ${width === nextWidth && height === nextHeight ? "border-cs2-accent bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border-subtle text-cs2-text-muted hover:text-white"}`}>{label}</button>
                ))}
              </div>
              <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
                <input type="number" min="320" max="7680" value={width} onChange={(event) => onProjectSettingsChange?.({ width: Number(event.target.value) })} className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs outline-none focus:border-cs2-accent" aria-label={t("liteCut.project.width")} />
                <span className="text-cs2-text-muted">×</span>
                <input type="number" min="180" max="4320" value={height} onChange={(event) => onProjectSettingsChange?.({ height: Number(event.target.value) })} className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs outline-none focus:border-cs2-accent" aria-label={t("liteCut.project.height")} />
              </div>
              <select value={fps} onChange={(event) => onProjectSettingsChange?.({ fps: Number(event.target.value) })} className="mt-2 w-full rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-xs outline-none focus:border-cs2-accent" aria-label={t("liteCut.project.frameRate")}>
                {[24, 25, 30, 60, 120].map((value) => <option key={value} value={value}>{value} FPS</option>)}
              </select>
            </div>
          </section>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <button type="button" onClick={() => { onRequestNewProject?.(); onClose?.(); }} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cs2-border bg-cs2-surface-1 px-3 py-2 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-accent/50 hover:text-cs2-text-primary">
              <FilePlus2 className="h-3.5 w-3.5" />{t("liteCut.project.newBlank")}
            </button>
            <button type="button" onClick={() => importInputRef.current?.click()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cs2-border bg-cs2-surface-1 px-3 py-2 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-accent/50 hover:text-cs2-text-primary">
              <Upload className="h-3.5 w-3.5" />{t("liteCut.project.import")}
            </button>
            <button type="button" disabled={!onExportProject} onClick={() => onExportProject?.()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cs2-border bg-cs2-surface-1 px-3 py-2 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-accent/50 hover:text-cs2-text-primary disabled:opacity-40">
              <Download className="h-3.5 w-3.5" />{t("liteCut.project.exportProject")}
            </button>
            <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImport} />
          </div>

          <section className="mt-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-bold text-cs2-text-secondary">{t("liteCut.project.fromTemplate")}</p>
              <span className="text-[10px] text-cs2-text-muted">{t("liteCut.project.templateCount", { count: projectTemplates.length })}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {projectTemplates.map((template) => (
                <button key={template.id} type="button" onClick={() => { onNewProject?.(template); onClose?.(); }} className="min-w-0 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1/60 px-3 py-2 text-left hover:border-cs2-accent/40 hover:bg-white/[0.03]">
                  <span className="block truncate text-[11px] font-semibold text-cs2-text-primary">{template.label}</span>
                  <span className="mt-0.5 block line-clamp-2 text-[9px] leading-relaxed text-cs2-text-muted">{template.detail}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="mt-5">
            <div className="mb-2 flex items-center gap-2">
              <p className="mr-auto text-xs font-bold text-cs2-text-secondary">{t("liteCut.project.allProjects", { count: projects.length })}</p>
              {selectedProjectIds.size > 0 ? <button type="button" disabled={batchDeleting} onClick={() => void handleBatchDelete()} className="inline-flex h-7 items-center gap-1 rounded bg-rose-500/15 px-2 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/25 disabled:opacity-50">
                {batchDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {t("liteCut.project.deleteSelected", { count: selectedProjectIds.size })}
              </button> : null}
              <button type="button" title={t("liteCut.project.refresh")} onClick={onRefresh} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-cs2-text-muted hover:bg-white/5 hover:text-cs2-text-primary">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
            <div className="relative">
              <FolderOpen className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("liteCut.project.searchPlaceholder")} className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input py-2 pl-8 pr-3 text-xs outline-none focus:border-cs2-accent" />
            </div>
            {matchingProjects.length > 0 ? <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg border border-cs2-border-subtle bg-cs2-surface-1/40 px-2.5 py-1.5 text-[10px] text-cs2-text-secondary">
              <input ref={selectAllRef} type="checkbox" checked={allMatchingSelected} onChange={toggleAllMatching} className="h-3.5 w-3.5 accent-cs2-accent" />
              <span>{t("liteCut.project.selectAllVisible", { count: matchingProjects.length })}</span>
              {selectedProjectIds.size > 0 ? <span className="ml-auto text-cs2-accent">{t("liteCut.project.selectedCount", { count: selectedProjectIds.size })}</span> : null}
            </label> : null}
            <div className="mt-2 space-y-1.5">
              {loading && matchingProjects.length === 0 ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-cs2-text-muted" /></div> : null}
              {!loading && matchingProjects.length === 0 ? <p className="py-6 text-center text-xs text-cs2-text-muted">{query ? t("liteCut.project.noSearchResults") : t("liteCut.project.noProjects")}</p> : null}
              {matchingProjects.map((project) => {
                const active = Number(project.id) === Number(projectId);
                const selected = selectedProjectIds.has(Number(project.id));
                return <div key={project.id} className={`group flex items-center gap-2 rounded-lg border px-2 py-2 ${selected ? "border-cs2-accent/60 bg-cs2-accent-soft" : active ? "border-cs2-accent/45 bg-cs2-accent-soft/30" : "border-cs2-border-subtle bg-cs2-surface-1/50 hover:border-white/15"}`}>
                  <input type="checkbox" checked={selected} onChange={() => toggleProject(Number(project.id))} aria-label={t("liteCut.project.selectProject", { name: project.name || t("liteCut.project.untitled") })} className="h-3.5 w-3.5 shrink-0 accent-cs2-accent" />
                  <button type="button" onClick={() => void chooseProject(project.id)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs font-semibold text-cs2-text-primary">{project.name || t("liteCut.project.untitled")}</span>
                    <span className="mt-0.5 block text-[10px] text-cs2-text-muted">#{project.id} {formatProjectTime(project.updated_at, t("common.localeCode"))}</span>
                  </button>
                  <button type="button" title={t("liteCut.project.duplicate")} onClick={() => { onDuplicateProject?.(project.id); onClose?.(); }} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-cs2-text-muted opacity-0 hover:bg-white/10 hover:text-cs2-text-primary group-hover:opacity-100">
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" title={t("liteCut.project.delete")} onClick={() => { if (window.confirm(t("liteCut.project.deleteConfirm", { name: project.name || t("liteCut.project.untitled") }))) { onDeleteProject?.(project.id, true); onClose?.(); } }} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-cs2-text-muted opacity-0 hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>;
              })}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
