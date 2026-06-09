import { useT } from "../../i18n/useT.js";

export default function RoundsStrip({ rounds = [] }) {
  const t = useT();
  const cells = [...rounds];
  while (cells.length < 24) cells.push(null);
  return (
    <div>
      <div className="mb-1 font-mono text-[10.5px] text-cs2-text-muted">{t("match.roundsStripLabel")}</div>
      <div className="grid grid-cols-[repeat(24,1fr)] gap-[2px]" style={{ height: 18 }}>
        {cells.slice(0, 24).map((won, i) => (
          <div
            key={i}
            className="rounded-[1px]"
            style={{
              backgroundColor:
                won === true ? "#2eb86a" : won === false ? "#e0556a" : "#25252c",
            }}
          />
        ))}
      </div>
    </div>
  );
}
