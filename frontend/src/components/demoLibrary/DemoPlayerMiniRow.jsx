export default function DemoPlayerMiniRow({
  name,
  kills,
  assists,
  deaths,
  kd,
  adr,
  rating,
  steam,
  showAdr,
  showRating,
  highlight,
}) {
  const tipLine = [steam ? `Steam: ${steam}` : null, name].filter(Boolean).join(" · ");

  return (
    <tr
      className={
        highlight
          ? "bg-cs2-accent/[0.14] text-cs2-text-primary shadow-[inset_2px_0_0_0_rgba(225,116,57,0.65)]"
          : "text-cs2-text-secondary hover:bg-cs2-bg-input/50"
      }
    >
      <td className="max-w-[7rem] truncate px-1 py-0.5 font-medium text-cs2-text-secondary" title={tipLine}>
        {name}
      </td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">{kills}</td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">{assists}</td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">{deaths}</td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums text-cs2-text-secondary">{kd}</td>
      {showAdr ? (
        <td className="px-1 py-0.5 text-right font-mono tabular-nums text-cs2-text-muted">
          {adr != null ? Math.round(adr) : "—"}
        </td>
      ) : null}
      {showRating ? (
        <td className="px-1 py-0.5 text-right font-mono tabular-nums text-cs2-text-muted">
          {rating != null ? rating : "—"}
        </td>
      ) : null}
    </tr>
  );
}
