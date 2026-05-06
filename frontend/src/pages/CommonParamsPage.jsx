import CommonParamsModal from "../components/CommonParamsModal";
import { useAppShell } from "../context/AppShellContext";

export default function CommonParamsPage() {
  const s = useAppShell();
  return (
    <div className="h-full min-h-0 w-full overflow-y-auto">
      <CommonParamsModal
        variant="page"
        open
        onClose={() => {}}
        batchRecording={s.batchRecording}
        savedWarmupDefaults={s.savedRecordWarmupDefaults}
        onPersistWarmupDefaults={s.persistWarmupDefaults}
        experimentalPovEnabled={s.experimentalPovEnabled}
        onExperimentalPovChange={s.persistExperimentalPov}
      />
    </div>
  );
}
