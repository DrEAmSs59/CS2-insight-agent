import CommonParamsModal from "../components/CommonParamsModal";
import { useAppShell } from "../context/AppShellContext";

export default function CommonParamsPage() {
  const s = useAppShell();
  return (
    <CommonParamsModal
      variant="page"
      open
      onClose={() => {}}
      batchRecording={s.batchRecording}
      savedWarmupDefaults={s.savedRecordWarmupDefaults}
      onPersistWarmupDefaults={s.persistWarmupDefaults}
      experimentalPovEnabled={s.experimentalPovEnabled}
      onExperimentalPovChange={s.persistExperimentalPov}
      cs2ExtraLaunchArgs={s.cs2ExtraLaunchArgs}
      onCs2ExtraLaunchArgsChange={s.setCs2ExtraLaunchArgs}
      recordInjectConsoleLines={s.recordInjectConsoleLines}
      onRecordInjectConsoleLinesChange={s.setRecordInjectConsoleLines}
      onPersistCs2RecordExtras={s.persistCs2RecordExtras}
      specPlayerVerify={s.specPlayerVerify}
      patchSpecPlayerVerify={s.patchSpecPlayerVerify}
    />
  );
}
