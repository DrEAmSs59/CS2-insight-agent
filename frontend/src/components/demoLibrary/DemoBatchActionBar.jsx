export default function DemoBatchActionBar({

  count,

  onLoadSelected,

  onOpenBatchModal,

  onBatchDelete,

  onClearSelection,

}) {

  if (count <= 0) return null;



  const btn =

    "rounded-md border border-white/[0.08] px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:border-cs2-orange/40 hover:text-white";



  const btnPrimary =

    "rounded-md border border-cs2-orange/45 bg-cs2-orange/10 px-2.5 py-1.5 text-[11px] font-bold text-cs2-orange hover:border-cs2-orange/70";



  const btnDanger =

    "rounded-md border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-red-300 hover:border-red-500/55";



  return (

    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/[0.06] bg-cs2-bg-card/90 px-3 py-2 backdrop-blur-[1px]">

      <span className="text-[11px] font-semibold tabular-nums text-zinc-400">

        已选择 <span className="text-cs2-orange">{count}</span> 个

      </span>

      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">

        <button type="button" className={btn} onClick={() => void onLoadSelected()}>

          载入选中

        </button>

        <button type="button" className={btnPrimary} onClick={onOpenBatchModal}>

          载入并解析…

        </button>

        <button type="button" className={btnDanger} onClick={() => void onBatchDelete()}>

          批量删除

        </button>

        <button type="button" className={btn} onClick={onClearSelection}>

          清空选择

        </button>

      </div>

    </div>

  );

}

