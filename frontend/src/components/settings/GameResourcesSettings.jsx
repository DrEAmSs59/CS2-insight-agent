import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Maximize2,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import API from "../../api/api";
import { useSkyboxResources } from "../../api/skyboxResources";
import { useT } from "../../i18n/useT.js";
import { formatFileSize } from "../../utils/demoLibraryDisplay.js";
import {
  recordingSkyboxDisplayName,
  RECORDING_SKYBOX_RESET_EVENT,
  sortBuiltinRecordingSkyboxes,
} from "../../utils/recordingSkybox.js";
import { SectionCard } from "../../pages/settings/SettingsControls.jsx";
import Modal from "../ui/Modal.jsx";


function defaultNameFromFile(file) {
  return String(file?.name || "").replace(/\.vmat_c$/i, "");
}

const BUILTIN_GROUPS = [
  { id: "featured", labelKey: "settings.skyboxGroupFeatured" },
  { id: "cartoon", labelKey: "settings.skyboxGroupCartoon" },
  { id: "egg", labelKey: "settings.skyboxGroupEgg" },
];


function builtinGroupId(skyboxId) {
  if (String(skyboxId).startsWith("cartoon")) return "cartoon";
  if (String(skyboxId).startsWith("egg")) return "egg";
  return "featured";
}


export default function GameResourcesSettings({ search = "" }) {
  const t = useT();
  const { items, loading, error, refresh } = useSkyboxResources(true);
  const [formOpen, setFormOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [materialFile, setMaterialFile] = useState(null);
  const [textureFile, setTextureFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [inputVersion, setInputVersion] = useState(0);
  const [previewItem, setPreviewItem] = useState(null);
  const formRef = useRef(null);

  const builtins = useMemo(() => items.filter((item) => item.source === "builtin"), [items]);
  const custom = useMemo(() => items.filter((item) => item.source === "custom"), [items]);
  const groupedBuiltins = useMemo(() => BUILTIN_GROUPS.map((group) => ({
    ...group,
    items: sortBuiltinRecordingSkyboxes(
      builtins.filter((item) => builtinGroupId(item.id) === group.id),
    ),
  })), [builtins]);
  const itemDisplayName = (item) => (
    item.source === "builtin"
      ? recordingSkyboxDisplayName(item.id, item.display_name, t)
      : item.display_name
  );
  const searchText = `${t("settings.gameResourcesTitle")} ${t("settings.skyboxResourcesTitle")} ${items.map(itemDisplayName).join(" ")}`.toLowerCase();
  if (search && !searchText.includes(search.trim().toLowerCase())) return null;

  const resetForm = () => {
    setDisplayName("");
    setMaterialFile(null);
    setTextureFile(null);
    setInputVersion((value) => value + 1);
    formRef.current?.reset();
  };

  const uploadSkybox = async (event) => {
    event.preventDefault();
    if (busy || !displayName.trim() || !materialFile || !textureFile) return;
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.append("display_name", displayName.trim());
    form.append("material_file", materialFile);
    form.append("texture_file", textureFile);
    try {
      await API.post("game-resources/skyboxes", form);
      await refresh();
      resetForm();
      setFormOpen(false);
      setMessage({ tone: "ok", text: t("settings.skyboxUploadSuccess") });
    } catch (requestError) {
      setMessage({
        tone: "error",
        text: requestError?.response?.data?.detail
          || requestError?.message
          || t("settings.skyboxUploadFailed"),
      });
    } finally {
      setBusy(false);
    }
  };

  const renameSkybox = async (item) => {
    const nextName = window.prompt(t("settings.skyboxRenamePrompt"), item.display_name);
    if (!nextName?.trim() || nextName.trim() === item.display_name) return;
    setBusy(true);
    setMessage(null);
    try {
      await API.patch(`game-resources/skyboxes/${encodeURIComponent(item.id)}`, {
        display_name: nextName.trim(),
      });
      await refresh();
      setMessage({ tone: "ok", text: t("settings.skyboxRenameSuccess") });
    } catch (requestError) {
      setMessage({
        tone: "error",
        text: requestError?.response?.data?.detail || requestError?.message,
      });
    } finally {
      setBusy(false);
    }
  };

  const removeSkybox = async (item) => {
    if (!window.confirm(t("settings.skyboxDeleteConfirm", { name: item.display_name }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const { data } = await API.delete(`game-resources/skyboxes/${encodeURIComponent(item.id)}`);
      await refresh();
      if (data?.recording_skybox_reset) {
        window.dispatchEvent(new Event(RECORDING_SKYBOX_RESET_EVENT));
      }
      setMessage({
        tone: "ok",
        text: data?.recording_skybox_reset
          ? t("settings.skyboxDeleteResetSuccess")
          : t("settings.skyboxDeleteSuccess"),
      });
    } catch (requestError) {
      setMessage({
        tone: "error",
        text: requestError?.response?.data?.detail || requestError?.message,
      });
    } finally {
      setBusy(false);
    }
  };

  const renderCustomResource = (item) => (
    <div
      key={item.id}
      data-testid="custom-skybox-resource"
      className="flex items-center gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input/35 px-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-xs font-semibold text-cs2-text-primary">{itemDisplayName(item)}</p>
          <span className="rounded border border-cs2-border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-cs2-text-muted">
            {item.source === "builtin" ? t("settings.skyboxBuiltinBadge") : t("settings.skyboxCustomBadge")}
          </span>
          {!item.available ? (
            <span className="text-[10px] font-semibold text-amber-300">{t("settings.skyboxBroken")}</span>
          ) : null}
        </div>
        <p className="mt-1 truncate font-mono text-[10px] text-cs2-text-muted">
          {item.material_original_name} + {item.texture_original_name}
          {item.size_bytes ? ` · ${formatFileSize(item.size_bytes)}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void renameSkybox(item)}
          aria-label={t("settings.skyboxRename")}
          className="rounded-md border border-cs2-border p-1.5 text-cs2-text-muted hover:border-cs2-accent/50 hover:text-cs2-accent disabled:opacity-40"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void removeSkybox(item)}
          aria-label={t("settings.skyboxDelete")}
          className="rounded-md border border-cs2-border p-1.5 text-cs2-text-muted hover:border-rose-400/50 hover:text-rose-300 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <SectionCard
        title={t("settings.skyboxResourcesTitle")}
        hint={t("settings.skyboxResourcesHint")}
        contentClassName=""
      >
        <div className="flex items-center justify-between gap-3 pb-3">
          <div>
            <p className="text-xs font-semibold text-cs2-text-primary">{t("settings.skyboxResourceCount", { count: items.length })}</p>
            <p className="mt-1 text-[10px] text-cs2-text-muted">{t("settings.skyboxUploadRules")}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setFormOpen((value) => !value);
              setMessage(null);
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-cs2-accent px-3 py-2 text-xs font-bold text-black hover:bg-cs2-accent-light"
          >
            <Plus className="h-3.5 w-3.5" /> {t("settings.skyboxAdd")}
          </button>
        </div>

        {formOpen ? (
          <form ref={formRef} onSubmit={uploadSkybox} className="mb-4 space-y-3 rounded-lg border border-cs2-accent/25 bg-cs2-accent/5 p-3">
            <label className="block text-[11px] font-semibold text-cs2-text-secondary">
              {t("settings.skyboxDisplayName")}
              <input
                type="text"
                maxLength={64}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("settings.skyboxDisplayNamePlaceholder")}
                className="mt-1.5 w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/50"
              />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-[11px] font-semibold text-cs2-text-secondary">
                {t("settings.skyboxMaterialFile")}
                <input
                  key={`material-${inputVersion}`}
                  type="file"
                  accept=".vmat_c"
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    setMaterialFile(file);
                    if (!displayName.trim()) setDisplayName(defaultNameFromFile(file));
                  }}
                  className="mt-1.5 block w-full rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-[10px] text-cs2-text-muted file:mr-2 file:rounded file:border-0 file:bg-cs2-accent/15 file:px-2 file:py-1 file:text-[10px] file:font-semibold file:text-cs2-accent"
                />
              </label>
              <label className="block text-[11px] font-semibold text-cs2-text-secondary">
                {t("settings.skyboxTextureFile")}
                <input
                  key={`texture-${inputVersion}`}
                  type="file"
                  accept=".vtex_c"
                  onChange={(event) => setTextureFile(event.target.files?.[0] || null)}
                  className="mt-1.5 block w-full rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-[10px] text-cs2-text-muted file:mr-2 file:rounded file:border-0 file:bg-cs2-accent/15 file:px-2 file:py-1 file:text-[10px] file:font-semibold file:text-cs2-accent"
                />
              </label>
            </div>
            <p className="text-[10px] leading-relaxed text-cs2-text-muted">{t("settings.skyboxPairingHint")}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  resetForm();
                  setFormOpen(false);
                }}
                className="rounded-md border border-cs2-border px-3 py-1.5 text-xs text-cs2-text-secondary hover:text-cs2-text-primary disabled:opacity-40"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={busy || !displayName.trim() || !materialFile || !textureFile}
                className="inline-flex items-center gap-1.5 rounded-md bg-cs2-accent px-3 py-1.5 text-xs font-bold text-black hover:bg-cs2-accent-light disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {busy ? t("settings.skyboxUploading") : t("settings.skyboxUpload")}
              </button>
            </div>
          </form>
        ) : null}

        {message ? (
          <p className={`mb-3 rounded-md border px-3 py-2 text-[11px] ${message.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : "border-rose-500/30 bg-rose-500/5 text-rose-300"}`}>
            {message.text}
          </p>
        ) : null}
        {error ? <p className="mb-3 text-[11px] text-rose-300">{error}</p> : null}

        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-cs2-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("settings.skyboxLoading")}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-cs2-text-muted">{t("settings.skyboxBuiltins")}</h3>
                <span className="rounded border border-cs2-border px-2 py-0.5 text-[9px] font-semibold text-cs2-text-muted">
                  {t("settings.skyboxBuiltinsSummary", { count: builtins.length })}
                </span>
              </div>
              <div className="space-y-2">
                {groupedBuiltins.map((group) => (
                  <details
                    key={group.id}
                    open={group.id === "featured"}
                    className="group rounded-lg border border-cs2-border bg-cs2-bg-input/20"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-semibold text-cs2-text-primary">
                      <span>{t(group.labelKey)}</span>
                      <span className="flex items-center gap-2 text-[10px] font-normal text-cs2-text-muted">
                        {t("settings.skyboxGroupCount", { count: group.items.length })}
                        <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                      </span>
                    </summary>
                    <div className="grid gap-2 border-t border-cs2-border p-2 sm:grid-cols-2 xl:grid-cols-3">
                      {group.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          aria-label={t("settings.skyboxPreviewOpen", { name: itemDisplayName(item) })}
                          onClick={() => setPreviewItem(item)}
                          className="group/preview min-w-0 overflow-hidden rounded-md border border-cs2-border/80 bg-cs2-bg-card text-left transition hover:border-cs2-accent/55 hover:bg-cs2-bg-hover"
                        >
                          <div className="relative aspect-[2/1] overflow-hidden bg-black/25">
                            <img
                              src={item.preview_url}
                              alt={t("settings.skyboxPreviewAlt", { name: itemDisplayName(item) })}
                              loading="lazy"
                              className="h-full w-full object-cover transition duration-200 group-hover/preview:scale-[1.02]"
                            />
                            <span className="absolute right-1.5 top-1.5 rounded bg-black/55 p-1 text-white/85 opacity-0 transition group-hover/preview:opacity-100">
                              <Maximize2 className="h-3 w-3" />
                            </span>
                          </div>
                          <div className="px-2.5 py-2">
                            <div className="flex items-center gap-2">
                              {item.available ? (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                              ) : (
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                              )}
                              <p className="truncate text-[11px] font-semibold text-cs2-text-primary">{itemDisplayName(item)}</p>
                            </div>
                            <p className="mt-1 truncate font-mono text-[9px] text-cs2-text-muted">{item.id}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-cs2-text-muted">{t("settings.skyboxMine")}</h3>
              {custom.length ? (
                <div className="space-y-2">{custom.map(renderCustomResource)}</div>
              ) : (
                <div className="rounded-lg border border-dashed border-cs2-border px-3 py-6 text-center text-xs text-cs2-text-muted">
                  {t("settings.skyboxEmpty")}
                </div>
              )}
            </div>
          </div>
        )}
      </SectionCard>
      <Modal
        open={Boolean(previewItem)}
        onClose={() => setPreviewItem(null)}
        title={previewItem ? itemDisplayName(previewItem) : ""}
        subtitle={previewItem?.id}
        maxWidth="max-w-5xl"
        maxHeight="max-h-[90vh]"
        fillHeight={false}
        contentClassName="overflow-hidden"
      >
        {previewItem ? (
          <div className="bg-black p-2">
            <img
              src={previewItem.preview_url}
              alt={t("settings.skyboxPreviewAlt", { name: itemDisplayName(previewItem) })}
              className="aspect-[2/1] w-full rounded-md object-contain"
            />
            <p className="px-2 pb-1 pt-2 text-center text-[10px] text-white/55">
              {t("settings.skyboxPreviewPanoramaHint")}
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
