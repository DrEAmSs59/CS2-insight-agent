import { Link } from "react-router-dom";
import { Library, Microscope, Clapperboard } from "lucide-react";

export default function RecordingQueueEmptyState() {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-black/20 px-6 py-12 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-cs2-orange/20 to-zinc-900/80">
        <Clapperboard className="h-8 w-8 text-cs2-orange/90" aria-hidden />
      </div>
      <h3 className="text-sm font-bold text-zinc-200">录制队列为空</h3>
      <p className="mt-2 max-w-sm text-[11px] leading-relaxed text-zinc-500">
        还没有待生成的 OBS 素材。从解析页勾选高光并「加入录制队列」，或从 Demo 库载入片段后开始编排。
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Link
          to="/library"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[11px] font-semibold text-zinc-300 transition-colors hover:border-cs2-orange/40 hover:text-white"
        >
          <Library className="h-3.5 w-3.5" />
          Demo 库
        </Link>
        <Link
          to="/analysis"
          className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-orange/45 bg-cs2-orange/10 px-3 py-2 text-[11px] font-semibold text-cs2-orange hover:bg-cs2-orange/20"
        >
          <Microscope className="h-3.5 w-3.5" />
          解析分析
        </Link>
      </div>
    </div>
  );
}
