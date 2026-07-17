import { useRef, useState } from "react";
import { ChevronDown, Download, FilePlus2, FolderOpen, Loader2, Save, Settings2, Sparkles, Tags } from "lucide-react";
import { useT } from "../../../i18n/useT.js";
import LiteCutProjectDrawer from "./LiteCutProjectDrawer.jsx";
import LiteCutNewProjectDialog from "./LiteCutNewProjectDialog.jsx";
import LiteCutManagementCenter from "./LiteCutManagementCenter.jsx";
import LiteCutMarkerManager from "./LiteCutMarkerManager.jsx";

export default function LiteCutToolbar({
  projectId = null,
  projectName = "",
  dirty = false,
  saving = false,
  body,
  projects = [],
  projectsLoading = false,
  onProjectNameChange,
  onSave,
  onNewProject,
  projectTemplates = [],
  onOpenProject,
  onDuplicateProject,
  onDeleteProject,
  onDeleteProjects,
  onRefreshProjects,
  onOpenPresets,
  onExportProject,
  onImportProject,
  onProjectSettingsChange,
  onOpenExport,
  onRestoreSnapshot,
  onImportPortable,
  onStartPortableExport,
  onUpdateMarker,
  onDeleteMarker,
  onSeekMarker,
}) {
  const t = useT();
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [markersOpen, setMarkersOpen] = useState(false);
  const templateMenuRef = useRef(null);

  return (
    <header className="relative flex shrink-0 items-center gap-3 border-b border-cs2-border bg-cs2-bg-card px-4 py-2">
      <div className="min-w-0 flex flex-1 items-center gap-2">
        <div className="min-w-0 flex-1">
          <input
            value={projectName}
            onChange={(event) => onProjectNameChange?.(event.target.value)}
            className="block w-full truncate rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-bold text-cs2-text-primary outline-none hover:border-white/10 hover:bg-white/[0.03] focus:border-cs2-accent/60 focus:bg-black/20"
            aria-label={t("liteCut.project.name")}
          />
          <p className="px-1 text-[10px] text-cs2-text-muted">
            {t("liteCut.project.headerMetaDetailed", {
              id: projectId || t("liteCut.project.draft"),
              state: dirty ? t("liteCut.project.unsaved") : t("liteCut.project.saved"),
              width: Number(body?.output?.width) || 1920,
              height: Number(body?.output?.height) || 1080,
              fps: Number(body?.output?.fps) || 60,
            })}
          </p>
        </div>
        <button type="button" title={t("liteCut.project.openManager")} onClick={() => setProjectDrawerOpen(true)} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5 hover:text-cs2-text-primary">
          <FolderOpen className="h-3.5 w-3.5" />
          {t("liteCut.project.manager")}
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <div ref={templateMenuRef} className="relative flex rounded-md hover:bg-white/5">
          <button type="button" title={t("liteCut.project.newProject")} onClick={() => setNewProjectOpen(true)} className="inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] font-semibold text-cs2-text-secondary hover:text-cs2-text-primary">
            <FilePlus2 className="h-3.5 w-3.5" />
            {t("liteCut.project.new")}
          </button>
          <button type="button" title={t("liteCut.project.fromTemplate")} aria-label={t("liteCut.project.fromTemplate")} onClick={() => setTemplateMenuOpen((value) => !value)} className="inline-flex h-8 w-7 items-center justify-center border-l border-white/10 text-cs2-text-muted hover:text-cs2-text-primary">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {templateMenuOpen ? <div className="absolute right-0 top-9 z-40 w-64 overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-elevated p-1 shadow-2xl">
            {projectTemplates.map((template) => <button key={template.id} type="button" onClick={() => { setTemplateMenuOpen(false); onNewProject?.(template); }} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/5">
              <span className="block text-xs font-semibold text-cs2-text-primary">{template.label}</span>
              <span className="mt-0.5 block text-[10px] text-cs2-text-muted">{template.detail}</span>
            </button>)}
          </div> : null}
        </div>
        <button type="button" title={t("liteCut.preset.open")} onClick={() => onOpenPresets?.()} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-cs2-accent hover:bg-cs2-accent-soft">
          <Sparkles className="h-3.5 w-3.5" />
          {t("liteCut.preset.short")}
        </button>
        <button type="button" title="标记点管理" onClick={() => setMarkersOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5 hover:text-cs2-text-primary"><Tags className="h-3.5 w-3.5" />标记</button>
        <button type="button" title="工程与缓存管理" onClick={() => setManagementOpen(true)} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-cs2-text-secondary hover:bg-white/5 hover:text-cs2-text-primary"><Settings2 className="h-3.5 w-3.5" /></button>
        <button type="button" title={t("liteCut.project.save")} disabled={saving || !onSave} onClick={() => onSave?.()} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5 hover:text-cs2-text-primary disabled:opacity-50">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {saving ? t("liteCut.project.saving") : dirty ? t("liteCut.project.save") : t("liteCut.project.saved")}
        </button>
        <button type="button" onClick={() => onOpenExport?.()} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-cs2-accent px-3 text-[11px] font-bold text-black hover:bg-cs2-accent-light">
          <Download className="h-3.5 w-3.5" />
          {t("liteCut.project.export")}
        </button>
      </div>

      <LiteCutProjectDrawer
        open={projectDrawerOpen}
        onClose={() => setProjectDrawerOpen(false)}
        projectId={projectId}
        projectName={projectName}
        dirty={dirty}
        body={body}
        projects={projects}
        loading={projectsLoading}
        projectTemplates={projectTemplates}
        onRefresh={onRefreshProjects}
        onOpenProject={onOpenProject}
        onNewProject={onNewProject}
        onDuplicateProject={onDuplicateProject}
        onDeleteProject={onDeleteProject}
        onDeleteProjects={onDeleteProjects}
        onImportProject={onImportProject}
        onExportProject={onExportProject}
        onProjectNameChange={onProjectNameChange}
        onProjectSettingsChange={onProjectSettingsChange}
        onRequestNewProject={() => setNewProjectOpen(true)}
      />
      <LiteCutNewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreate={onNewProject} />
      <LiteCutManagementCenter open={managementOpen} onClose={() => setManagementOpen(false)} projectId={projectId} onRestoreSnapshot={onRestoreSnapshot} onImportPortable={onImportPortable} onStartPortableExport={onStartPortableExport} />
      <LiteCutMarkerManager open={markersOpen} onClose={() => setMarkersOpen(false)} markers={body?.markers || []} onUpdate={onUpdateMarker} onDelete={onDeleteMarker} onSeek={onSeekMarker} />
    </header>
  );
}
