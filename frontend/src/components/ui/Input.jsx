const Input = ({ className = "", error, ...rest }) => (
  <input
    className={`w-full rounded-lg border bg-cs2-bg-input px-3 py-2 text-[13px] text-cs2-text-primary placeholder:text-cs2-text-muted outline-none transition-colors
      focus:border-cs2-border-focus focus:ring-1 focus:ring-cs2-border-focus/25
      disabled:cursor-not-allowed disabled:opacity-50
      ${error ? "border-cs2-border-error" : "border-cs2-border"}
      ${className}`}
    {...rest}
  />
);

export default Input;
