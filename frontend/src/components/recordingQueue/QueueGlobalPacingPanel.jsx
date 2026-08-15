import { GlobalPacingPanel } from "../RecordingQueueDrawer";
import { useRecordingQueue } from "../../stores/recordingQueueStore";

/**
 * Global queue controls live in their own workspace card so they do not share
 * the inspector's visual boundary or scroll area.
 *
 * @param {{ queue: import("../../stores/recordingQueueStore").RecordingQueueItem[] }} props
 */
export default function QueueGlobalPacingPanel({ queue }) {
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing = useRecordingQueue((s) => s.setGlobalPacing);
  const resetGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);
  const toggleVictimPov = useRecordingQueue((s) => s.toggleVictimPovForAllHighlightsInQueue);
  const toggleKillerPov = useRecordingQueue((s) => s.toggleKillerPovForAllEligibleInQueue);

  return (
    <GlobalPacingPanel
      standalone
      globalPacing={globalPacing}
      setGlobalPacing={setGlobalPacing}
      resetGlobalPacing={resetGlobalPacing}
      queue={queue}
      onToggleAllVictimPov={toggleVictimPov}
      onToggleAllKillerPov={toggleKillerPov}
    />
  );
}
