import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Ban,
  Copy,
  Check,
  FolderOpen,
} from "lucide-react";
import Modal from "../ui/Modal";
import API from "../../api/api";

// ─── helpers ────────────────────────────────────────────────────────────────

const CATEGORY_LABEL = {
  highlight: "高光",
  fail: "下饭",
  compilation: "合集",
};

function friendlyName(result) {
  const item = result._queueItem;
  if (!item) return `片段 #${result._index + 1}`;

  const { targetPlayer, demoFilename, clipData } = item;

  let categoryLabel = "";
  if (clipData?.category) {
    const base = CATEGORY_LABEL[clipData.category] ?? clipData.category;
    categoryLabel =
      clipData.category === "compilation" && clipData.compilation_kind
        ? `${base}(${clipData.compilation_kind})`
        : base;
  }

  const parts = [categoryLabel, targetPlayer, demoFilename].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : `片段 #${result._index + 1}`;
}

function isAborted(result) {
  return (
    !result.success &&
    (result.error === "aborted" ||
      String(result.error || "").toLowerCase() === "aborted")
  );
}

// ─── component ──────────────────────────────────────────────────────────────

export default function RecordingResultModal({
  open,
  onClose,
  onClearQueue,
  results = [],
}) {
  const [copiedIdx, setCopiedIdx] = useState(null);

  const successCount = results.filter((r) => r.success).length;
  const abortedCount = results.filter((r) => isAborted(r)).length;
  const failCount = results.filter((r) => !r.success && !isAborted(r)).length;
  const total = results.length;

  function handleCopy(idx, path) {
    navigator.clipboard.writeText(path).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  }

  function handleReveal(path) {
    API.post("/reveal-file-in-explorer", { path }).catch(() => {});
  }

  const footer = (
    <div className="flex items-center justify-end gap-3">
      <button
        type="button"
        onClick={() => {
          onClearQueue();
          onClose();
        }}
        className="rounded-lg border border-cs2-border bg-cs2-bg-input px-4 py-2 text-[12px] font-semibold text-cs2-text-primary hover:border-cs2-accent/50"
      >
        清空队列并关闭
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg bg-cs2-accent px-4 py-2 text-[12px] font-bold text-cs2-text-on-accent hover:brightness-110"
      >
        关闭
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="录制完成"
      maxWidth="max-w-2xl"
      maxHeight="max-h-[85vh]"
      footer={footer}
    >
      {/* Summary strip */}
      <div className="flex items-center gap-4 border-b border-cs2-border px-5 py-3 text-[12px]">
        <span className="flex items-center gap-1.5 text-cs2-text-success">
          <CheckCircle2 className="h-4 w-4" />
          成功 {successCount} / 共 {total}
        </span>
        {failCount > 0 && (
          <span className="flex items-center gap-1.5 text-cs2-rose-on-surface">
            <XCircle className="h-4 w-4" />
            失败 {failCount}
          </span>
        )}
        {abortedCount > 0 && (
          <span className="flex items-center gap-1.5 text-cs2-text-muted">
            <Ban className="h-4 w-4" />
            中止 {abortedCount}
          </span>
        )}
      </div>

      {/* Result list */}
      <ul className="divide-y divide-cs2-border">
        {results.map((result) => {
          const name = friendlyName(result);
          const aborted = isAborted(result);

          if (result.success) {
            return (
              <li
                key={result.request_id ?? result._index}
                className="flex items-center gap-3 px-5 py-3"
              >
                {/* Status icon */}
                <CheckCircle2 className="h-4 w-4 shrink-0 text-cs2-text-success" />

                {/* Name */}
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-cs2-text-primary">
                  {name}
                </span>

                {/* Path + actions */}
                {result.output_path && (
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="max-w-[220px] truncate font-mono text-[11px] text-cs2-text-secondary">
                      {result.output_path}
                    </span>
                    <button
                      type="button"
                      title="复制路径"
                      onClick={() => handleCopy(result._index, result.output_path)}
                      className="rounded p-0.5 text-cs2-text-muted hover:text-cs2-text-primary"
                    >
                      {copiedIdx === result._index ? (
                        <Check className="h-3.5 w-3.5 text-cs2-text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      title="在资源管理器中显示"
                      onClick={() => handleReveal(result.output_path)}
                      className="rounded p-0.5 text-cs2-text-muted hover:text-cs2-text-primary"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </li>
            );
          }

          if (aborted) {
            return (
              <li
                key={result.request_id ?? result._index}
                className="flex items-center gap-3 px-5 py-3"
              >
                <Ban className="h-4 w-4 shrink-0 text-cs2-text-muted" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-cs2-text-primary">
                  {name}
                </span>
                <span className="text-[11px] text-cs2-text-muted">已中止</span>
              </li>
            );
          }

          // failure
          return (
            <li
              key={result.request_id ?? result._index}
              className="flex items-center gap-3 px-5 py-3"
            >
              <XCircle className="h-4 w-4 shrink-0 text-cs2-rose-on-surface" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-cs2-text-primary">
                {name}
              </span>
              {result.error && (
                <span className="max-w-[260px] truncate text-[11px] text-cs2-rose-on-surface">
                  {result.error}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
