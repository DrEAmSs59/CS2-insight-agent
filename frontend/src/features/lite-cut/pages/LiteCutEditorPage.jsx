import LiteCutEditorShell from "../editor/LiteCutEditorShell.jsx";

export default function LiteCutEditorPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <LiteCutEditorShell defaultInspectorTab="clip" />
    </div>
  );
}
