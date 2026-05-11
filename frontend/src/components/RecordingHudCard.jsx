/** POV 开启时与简化观战 HUD 的说明（常用参数与录制前观战共用） */
export const POV_CONFLICT_HUD =
  "POV HUD 已启用：观战 HUD 由 POV 资源接管，此项与简化 HUD 冲突，无法单独调节。";

/** 录制画面效果：名称 / 指令 / 开关 / 说明 / 启用后的成片预期 */
export function RecordingHudCard({
  title,
  code,
  description,
  checked,
  onChange,
  outcomeOn,
  disabled = false,
  disabledReason,
}) {
  return (
    <div
      title={disabled ? disabledReason : undefined}
      className={`flex flex-col rounded-lg border border-white/[0.07] bg-black/30 p-3 ${
        disabled ? "opacity-45" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-zinc-100">{title}</p>
          <code className="mt-0.5 block font-mono text-[10px] text-cs2-orange/90">{code}</code>
          <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">{description}</p>
        </div>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => {
            if (disabled) return;
            onChange(e.target.checked);
          }}
          className="mt-1 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-50"
        />
      </div>
      {checked && !disabled && outcomeOn ? (
        <p className="mt-3 border-t border-white/[0.06] pt-2.5 text-[10px] leading-relaxed text-emerald-400/95">
          成片预期：{outcomeOn}
        </p>
      ) : null}
      {disabled ? (
        <p className="mt-2 text-[10px] leading-relaxed text-amber-200/80">{disabledReason}</p>
      ) : null}
    </div>
  );
}
