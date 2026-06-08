import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "../../i18n/useT.js";

const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];

export default function DemoPagination({
  libraryPage,
  libraryTotalPages,
  libraryHasNextPage,
  libraryPageSize,
  onPageSizeChange,
  libraryJumpDraft,
  onPageChange,
  onJumpDraftChange,
  onJumpSubmit,
}) {
  const t = useT();

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] text-cs2-text-muted">
      <button
        type="button"
        disabled={libraryPage <= 1}
        className="rounded border border-cs2-border px-1.5 py-1 text-cs2-text-secondary hover:border-cs2-accent/40 hover:text-cs2-text-primary disabled:opacity-35"
        onClick={() => onPageChange(Math.max(1, libraryPage - 1))}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums text-cs2-text-muted">
        {libraryTotalPages == null
          ? t("library.paginationPage", { page: libraryPage })
          : t("library.paginationPageOf", { page: libraryPage, total: libraryTotalPages })}
      </span>
      <button
        type="button"
        disabled={!libraryHasNextPage}
        className="rounded border border-cs2-border px-1.5 py-1 text-cs2-text-secondary hover:border-cs2-accent/40 hover:text-cs2-text-primary disabled:opacity-35"
        onClick={() => onPageChange(libraryPage + 1)}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <label className="flex items-center gap-1 border-l border-cs2-border pl-2">
        <span className="text-cs2-text-muted">{t("library.paginationPerPage")}</span>
        <select
          className="rounded border border-cs2-border bg-cs2-bg-input px-1 py-0.5 font-mono text-[11px] text-cs2-text-primary outline-none focus:border-cs2-accent/45"
          value={libraryPageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label={t("library.paginationPerPageAriaLabel")}
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {t("library.paginationPerPageUnit") ? (
          <span className="text-cs2-text-muted">{t("library.paginationPerPageUnit")}</span>
        ) : null}
      </label>
      <form
        className="flex items-center gap-1 border-l border-cs2-border pl-2"
        onSubmit={(e) => {
          e.preventDefault();
          onJumpSubmit();
        }}
      >
        <label htmlFor="demo-lib-page-jump" className="sr-only">
          {t("library.paginationJumpSrOnly")}
        </label>
        <span className="text-cs2-text-muted">{t("library.paginationJump")}</span>
        <input
          id="demo-lib-page-jump"
          inputMode="numeric"
          className="w-11 rounded border border-cs2-border bg-cs2-bg-input px-1 py-0.5 text-center font-mono text-[11px] text-cs2-text-primary outline-none focus:border-cs2-accent/45"
          value={libraryJumpDraft}
          onChange={(e) => onJumpDraftChange(e.target.value.replace(/\D/g, "").slice(0, 5))}
        />
        <button
          type="submit"
          className="rounded border border-cs2-border px-1.5 py-0.5 text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary"
        >
          Go
        </button>
      </form>
    </div>
  );
}
