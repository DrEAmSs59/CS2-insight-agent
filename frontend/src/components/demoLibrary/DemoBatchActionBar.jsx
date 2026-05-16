export default function DemoBatchActionBar({

  count,

  onLoadSelected,

  onOpenBatchModal,

  onBatchDelete,

  onClearSelection,

}) {

  if (count <= 0) return null;



  const btn =

    "rounded-md border border-cs2-border px-2.5 py-1.5 text-[12px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/40 hover:text-cs2-text-primary";



  const btnPrimary =

    "rounded-md border border-cs2-accent/45 bg-cs2-accent/10 px-2.5 py-1.5 text-[12px] font-bold text-cs2-accent hover:border-cs2-accent/70";



  const btnDanger =

    "rounded-md border border-red-500/35 bg-red-500/10 px-2.5 py-1.5 text-[12px] font-semibold text-cs2-red-on-surface hover:border-red-500/55";



  return (

    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-cs2-border bg-cs2-bg-card/90 px-3 py-2 backdrop-blur-[1px]">

      <span className="text-[12px] font-semibold tabular-nums text-cs2-text-secondary">

        已选择 <span className="text-cs2-accent">{count}</span> 个

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

