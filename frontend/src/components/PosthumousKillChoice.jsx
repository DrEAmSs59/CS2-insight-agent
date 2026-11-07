import { useLocaleStore } from "../i18n/localeStore";
import { posthumousKey, posthumousMode, posthumousRows, usePosthumousChoices } from "../utils/posthumousKills";

export default function PosthumousKillChoice({ clip, disabled = false }) {
  const choices = usePosthumousChoices((s) => s.choices);
  const choose = usePosthumousChoices((s) => s.choose);
  const locale = useLocaleStore((s) => s.locale);
  const en = locale === "en";
  const count = posthumousRows(clip).length || (clip?.posthumous ? 1 : 0);
  if (!count) return null;
  return <div className="mt-2 space-y-1.5 border-l-2 border-cs2-accent/50 pl-3" onClick={(e) => e.stopPropagation()}>
    <div className="text-xs font-semibold text-cs2-accent">{en ? `${count} posthumous kill(s)` : `${count} 条死后击杀 · 不可录击杀者视角`}</div>
    <p className="text-xs text-cs2-text-secondary">{en ? "The attacker was already dead. The spectator camera may have switched to another player." : "击杀发生时已死亡，观战镜头可能已切到其他玩家。"}</p>
    <label className="flex flex-wrap items-center gap-2 text-xs text-cs2-text-primary">
      {en ? "Recording" : "录制处理"}
      <select disabled={disabled} value={posthumousMode(clip, choices)} onChange={(e) => choose(posthumousKey(clip), e.target.value)} className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 text-cs2-text-primary">
        <option value="skip">{en ? "Skip these kills (default)" : "跳过这些击杀（默认）"}</option>
        <option value="victim">{en ? "Record victims separately" : "单独录制受害者视角"}</option>
      </select>
    </label>
    <p className="text-xs text-cs2-text-muted">{en ? "Kills remain in statistics and the timeline. Other clips are unaffected." : "击杀统计与时间线仍保留，其他片段不受影响。"}</p>
  </div>;
}
