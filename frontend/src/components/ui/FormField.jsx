import { AlertCircle } from "lucide-react";
import Input from "./Input";

export default function FormField({
  label,
  hint,
  error,
  required,
  children,
  className = "",
  ...inputProps
}) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {label && (
        <label className="text-[12px] font-semibold text-cs2-text-secondary">
          {label}
          {required && <span className="ml-0.5 text-cs2-text-error">*</span>}
        </label>
      )}
      {children ?? <Input error={error} required={required} {...inputProps} />}
      {error && (
        <div className="flex items-center gap-1 text-[11px] text-cs2-text-error">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {hint && !error && (
        <p className="text-[11px] text-cs2-text-muted">{hint}</p>
      )}
    </div>
  );
}
