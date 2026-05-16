const Select = ({ className = "", children, ...rest }) => (
  <select
    className={`w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[13px] text-cs2-text-primary outline-none transition-colors
      focus:border-cs2-border-focus focus:ring-1 focus:ring-cs2-border-focus/25
      disabled:cursor-not-allowed disabled:opacity-50
      ${className}`}
    {...rest}
  >
    {children}
  </select>
);

export default Select;
