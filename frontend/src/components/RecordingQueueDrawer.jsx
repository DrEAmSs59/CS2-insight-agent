import { useT } from "../i18n/useT.js";
import { RecordingQueuePanel } from "./recordingQueue/RecordingQueuePanels.jsx";
export { GlobalPacingPanel, killBadgeColorClass, PacingMicroPanel, PovSection, RecordingQueuePanel } from "./recordingQueue/RecordingQueuePanels.jsx";

export default function RecordingQueueDrawer({ open, onClose, ...rest }) {
  const t = useT();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-cs2-bg-input/80 backdrop-blur-[2px]" role="presentation">
      <button type="button" className="h-full min-w-0 flex-1 cursor-default" aria-label={t("queue.closeDrawerAriaLabel")} onClick={onClose} />
      <aside className="flex h-full w-full max-w-md flex-col border-l border-cs2-border bg-cs2-bg-sidebar shadow-2xl" role="dialog">
        <RecordingQueuePanel {...rest} />
      </aside>
    </div>
  );
}
