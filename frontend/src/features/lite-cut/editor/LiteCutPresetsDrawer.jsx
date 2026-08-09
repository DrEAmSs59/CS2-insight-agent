import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2, Wand2, X } from "lucide-react";
import API from "../../../api/api.js";
import { useT } from "../../../i18n/useT.js";

export default function LiteCutPresetsDrawer({
  open,
  onClose,
  projectId,
  body,
  onApplyBody,
  buildColorGradeBody,
  buildTransitionBody,
  buildPackagingBody,
}) {
  const t = useT();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applyingId, setApplyingId] = useState(null);
  const [error, setError] = useState(null);
  const [applyWarnings, setApplyWarnings] = useState([]);
  const [saveName, setSaveName] = useState("");
  const [saveKind, setSaveKind] = useState("color_grade");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await API.get("/lite-cut/presets", { params: { limit: 200 } });
      setItems(data.items || []);
    } catch {
      setError(t("liteCut.preset.loadFailed"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleSave = async () => {
    const name = saveName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      const presetPayload =
        saveKind === "color_grade"
          ? buildColorGradeBody?.() || {}
          : saveKind === "transition_rhythm"
            ? buildTransitionBody?.() || {}
            : buildPackagingBody?.() || {};
      await API.post("/lite-cut/presets", {
        name,
        kind: saveKind,
        body: presetPayload,
        source_project_id: projectId ?? null,
      });
      setSaveName("");
      await load();
    } catch {
      setError(t("liteCut.preset.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async (preset) => {
    if (!body) return;
    setApplyingId(preset.id);
    setError(null);
    setApplyWarnings([]);
    try {
      const { data } = await API.post(`/lite-cut/presets/${preset.id}/apply`, {
        project_id: projectId ?? null,
        project_body: body,
        scope: "project",
      });
      onApplyBody?.(data.project_body);
      setApplyWarnings(Array.isArray(data.warnings) ? data.warnings : []);
    } catch {
      setError(t("liteCut.preset.applyFailed"));
    } finally {
      setApplyingId(null);
    }
  };

  const handleDelete = async (preset) => {
    if (!window.confirm(t("liteCut.preset.deleteConfirm", { name: preset.name }))) return;
    try {
      await API.delete(`/lite-cut/presets/${preset.id}`);
      await load();
    } catch {
      setError(t("liteCut.preset.deleteFailed"));
    }
  };

  if (!open) return null;

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-cs2-border bg-cs2-bg-card shadow-2xl">
      <header className="flex shrink-0 items-center justify-between border-b border-cs2-border px-4 py-3">
        <div>
          <p className="text-sm font-bold text-cs2-text-primary">{t("liteCut.preset.title")}</p>
          <p className="text-[10px] text-cs2-text-muted">{t("liteCut.preset.subtitle")}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-cs2-text-muted hover:bg-white/5">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
        <section className="rounded-xl border border-cs2-border/60 bg-cs2-surface-1/40 p-3 space-y-2">
          <p className="text-[11px] font-bold text-cs2-text-secondary">{t("liteCut.preset.saveCurrent")}</p>
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={t("liteCut.preset.namePlaceholder")}
            className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-2.5 py-2 text-xs"
          />
          <div className="flex gap-1">
            {["color_grade", "transition_rhythm", "packaging_bundle"].map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setSaveKind(id)}
                className={`flex-1 rounded-lg border py-1.5 text-[10px] font-semibold ${
                  saveKind === id
                    ? "border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent"
                    : "border-cs2-border text-cs2-text-muted"
                }`}
              >
                {t(`liteCut.preset.kind.${id}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={saving || !saveName.trim()}
            onClick={() => void handleSave()}
            className="w-full rounded-lg bg-cs2-accent py-2 text-xs font-bold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:opacity-40"
          >
            {saving ? t("liteCut.preset.saving") : t("liteCut.preset.saveAs")}
          </button>
        </section>

        {error ? <p className="text-xs text-rose-400">{error}</p> : null}
        {applyWarnings.length ? (
          <div className="space-y-1 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[10px] text-amber-100">
            {applyWarnings.map((warning) => <p key={`${warning.kind}:${warning.path}`}>{warning.message}</p>)}
          </div>
        ) : null}

        <section>
          <p className="mb-2 text-[11px] font-bold text-cs2-text-secondary">{t("liteCut.preset.savedList")}</p>
          {loading ? (
            <div className="flex justify-center py-6 text-cs2-text-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-4 text-center text-xs text-cs2-text-muted">{t("liteCut.preset.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {items.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-cs2-text-primary">{p.name}</p>
                    <p className="text-[10px] text-cs2-text-muted">
                      {t(`liteCut.preset.kind.${p.kind}`) === `liteCut.preset.kind.${p.kind}` ? p.kind : t(`liteCut.preset.kind.${p.kind}`)}
                    </p>
                  </div>
                  <button
                    type="button"
                    title={t("liteCut.preset.apply")}
                    disabled={applyingId === p.id}
                    onClick={() => void handleApply(p)}
                    className="rounded-lg bg-cs2-accent-soft p-2 text-cs2-accent hover:bg-cs2-accent/20 disabled:opacity-40"
                  >
                    {applyingId === p.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    title={t("liteCut.preset.delete")}
                    onClick={() => void handleDelete(p)}
                    className="rounded-lg p-2 text-cs2-text-muted hover:bg-rose-500/10 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
