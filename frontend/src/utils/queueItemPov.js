import { clipHasNoKillerPovTags } from "../stores/recordingQueueStore";
import { isClipPacingAndPovLocked } from "./montageUtils";

const KILL_COMPILATIONS = ["rival_kills", "all_kills", "weapon_kills"];
const DEATH_COMPILATIONS = ["nemesis_deaths", "all_deaths"];

function cleanNames(list) {
  return (Array.isArray(list) ? list : [])
    .map((name) => String(name ?? "").trim())
    .filter(Boolean);
}

/**
 * 队列条目可用的回看能力，与录制计划的判定保持一致：
 * 高光 / 击杀合集可回看受害者，下饭 / 死亡合集可回看击杀者。
 * @param {Record<string, unknown>} clip
 */
export function queueItemPovCapabilities(clip) {
  const data = clip && typeof clip === "object" ? clip : {};
  const category = String(data.category || "");
  const kind = String(data.compilation_kind || "");
  const victims = cleanNames(data.victims);
  const killers = cleanNames(data.killers);
  const killerName = String(data.killer_name ?? "").trim();
  const locked = isClipPacingAndPovLocked(data);
  const isKillCompilation = category === "compilation" && KILL_COMPILATIONS.includes(kind);
  const isDeathCompilation = category === "compilation" && DEATH_COMPILATIONS.includes(kind);
  const noKillerSource = category === "fail" && clipHasNoKillerPovTags(data);
  const canVictimPov = !locked && (category === "highlight" || isKillCompilation) && victims.length > 0;
  const canKillerPov = !locked && !noKillerSource && (
    (category === "fail" && Boolean(killerName)) || (isDeathCompilation && killers.length > 0)
  );
  return {
    locked,
    isKillCompilation,
    isDeathCompilation,
    noKillerSource,
    canVictimPov,
    canKillerPov,
    victims,
    killers: isDeathCompilation ? killers : killerName ? [killerName] : [],
  };
}
