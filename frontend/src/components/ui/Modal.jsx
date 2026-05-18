import { X } from "lucide-react";

/**
 * 共享模态框壳
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   title?: React.ReactNode;
 *   subtitle?: React.ReactNode;
 *   icon?: React.ReactNode;
 *   headerRight?: React.ReactNode;
 *   maxWidth?: string;
 *   maxHeight?: string;
 *   children: React.ReactNode;
 *   footer?: React.ReactNode;
 *   className?: string;
 *   zIndex?: number;
 * }} props
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  headerRight,
  maxWidth = "max-w-2xl",
  maxHeight = "max-h-[85vh]",
  children,
  footer,
  className = "",
  zIndex = 90,
}) {
  if (!open) return null;

  return (
    <div
      style={{ zIndex }}
      className="fixed inset-0 flex items-center justify-center bg-cs2-bg-overlay px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`flex h-full ${maxHeight} w-full ${maxWidth} flex-col overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-lg ${className}`}
      >
        {/* Header */}
        {(title || icon || subtitle) && (
          <div className="flex items-center justify-between border-b border-cs2-border px-5 py-4">
            <div className="min-w-0 flex-1">
              {subtitle && (
                <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-cs2-text-muted">
                  {subtitle}
                </div>
              )}
              <div className="flex items-center gap-2">
                {icon && <span className="shrink-0">{icon}</span>}
                {title && (
                  <h2 className="truncate text-[15px] font-bold text-cs2-text-primary">
                    {title}
                  </h2>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {headerRight}
              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-1.5 text-cs2-text-muted transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="border-t border-cs2-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
