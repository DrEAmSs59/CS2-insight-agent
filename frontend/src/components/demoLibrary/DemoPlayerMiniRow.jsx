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
          ? "bg-cs2-orange/[0.14] text-zinc-100 shadow-[inset_2px_0_0_0_rgba(225,116,57,0.65)]"
          : "text-zinc-400 hover:bg-white/[0.04]"
      }
    >
      <td className="max-w-[7rem] truncate px-1 py-0.5 font-medium text-zinc-300" title={tipLine}>
        {name}
      </td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">{kills}</td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">{assists}</td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">{deaths}</td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums text-zinc-300">{kd}</td>
      {showAdr ? (
        <td className="px-1 py-0.5 text-right font-mono tabular-nums text-zinc-500">
          {adr != null ? Math.round(adr) : "—"}
        </td>
      ) : null}
      {showRating ? (
        <td className="px-1 py-0.5 text-right font-mono tabular-nums text-zinc-500">
          {rating != null ? rating : "—"}
        </td>
      ) : null}
    </tr>
  );
}
