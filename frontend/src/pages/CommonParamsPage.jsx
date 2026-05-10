import CommonParamsModal from "../components/CommonParamsModal";
import { useAppShell } from "../context/AppShellContext";

export default function CommonParamsPage() {
  const s = useAppShell();
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden px-4 py-3 sm:px-5">
      <CommonParamsModal
        variant="page"
        open
        onClose={() => {}}
        batchRecording={s.batchRecording}
        savedWarmupDefaults={s.savedRecordWarmupDefaults}
        onPersistWarmupDefaults={s.persistWarmupDefaults}
        experimentalPovEnabled={s.experimentalPovEnabled}
        onExperimentalPovChange={s.persistExperimentalPov}
        radarLiveCache={s.radarLiveCache}
        onRadarLiveCacheChange={s.persistRadarLiveCache}
      />
    </div>
  );
}
