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
import {
  friendlyClipTitleForQueue,
  formatClipCombatSummaryLine,
} from "../../utils/montageUtils";
import { useT } from "../../i18n/useT.js";
import { useLocaleStore } from "../../i18n/localeStore";

// ─── helpers ────────────────────────────────────────────────────────────────

/** 回合标签：R3 · 5:7 或 R3 */
function roundLabel(cd) {
  if (!cd) return null;
  if (cd.round != null && cd.score_own != null && cd.score_opp != null) {
    return `R${cd.round} · ${cd.score_own}:${cd.score_opp}`;
  }
  if (cd.round != null) return `R${cd.round}`;
  return null;
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
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
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
        {t("queue.modalClearAndClose")}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg bg-cs2-accent px-4 py-2 text-[12px] font-bold text-cs2-text-on-accent hover:brightness-110"
      >
        {t("queue.modalClose")}
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("queue.modalTitle")}
      maxWidth="max-w-2xl"
      maxHeight="max-h-[85vh]"
      footer={footer}
    >
      {/* Summary strip */}
      <div className="flex items-center gap-4 border-b border-cs2-border px-5 py-3 text-[12px]">
        <span className="flex items-center gap-1.5 text-cs2-text-success">
          <CheckCircle2 className="h-4 w-4" />
          {t("queue.modalSuccess", { n: successCount, total })}
        </span>
        {failCount > 0 && (
          <span className="flex items-center gap-1.5 text-cs2-rose-on-surface">
            <XCircle className="h-4 w-4" />
            {t("queue.modalFailed", { n: failCount })}
          </span>
        )}
        {abortedCount > 0 && (
          <span className="flex items-center gap-1.5 text-cs2-text-muted">
            <Ban className="h-4 w-4" />
            {t("queue.modalAborted", { n: abortedCount })}
          </span>
        )}
      </div>

      {/* Result list */}
      <ul className="divide-y divide-cs2-border">
        {results.map((result) => {
          const aborted = isAborted(result);
          const cd = result._queueItem?.clipData ?? null;
          const title = cd ? friendlyClipTitleForQueue(cd, t) : t("queue.modalDefaultClipTitle", { n: result._index + 1 });
          const combatLine = cd ? formatClipCombatSummaryLine(cd, t, locale) : "";
          const rl = roundLabel(cd);
          const killCount = cd?.kill_count ? Number(cd.kill_count) : null;
          const demoFile = String(result._queueItem?.demoFilename || result._queueItem?.demoPath || "").trim();
          const playerName = String(result._queueItem?.targetPlayer || "").trim();

          /* ── 状态图标 ── */
          const statusIcon = result.success ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-cs2-text-success" />
          ) : aborted ? (
            <Ban className="mt-0.5 h-4 w-4 shrink-0 text-cs2-text-muted" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-cs2-rose-on-surface" />
          );

          return (
            <li
              key={result.request_id ?? result._index}
              className="flex items-start gap-3 px-5 py-3"
            >
              {statusIcon}

              {/* 片段信息主体 */}
              <div className="min-w-0 flex-1 space-y-0.5">
                {/* 标题行：片段标题 + 玩家 */}
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-[12px] font-semibold text-cs2-text-primary">
                    {title}
                  </span>
                  {playerName && (
                    <span className="shrink-0 text-[11px] text-cs2-text-muted">{playerName}</span>
                  )}
                </div>

                {/* 元信息行：回合 + 击杀数 + 战斗摘要 */}
                {(rl || killCount || combatLine) && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-cs2-text-secondary">
                    {rl && <span className="font-mono">{rl}</span>}
                    {killCount != null && killCount > 0 && (
                      <span>{killCount}K</span>
                    )}
                    {combatLine && <span className="truncate">{combatLine}</span>}
                  </div>
                )}

                {/* Demo 文件名 */}
                {demoFile && (
                  <div className="truncate font-mono text-[10px] text-cs2-text-muted">
                    {demoFile}
                  </div>
                )}

                {/* 成功：输出路径 + 操作按钮 */}
                {result.success && result.output_path && (
                  <div className="flex min-w-0 items-center gap-1 pt-0.5">
                    <span
                      className="min-w-0 truncate font-mono text-[11px] text-cs2-text-secondary"
                      title={result.output_path}
                    >
                      {result.output_path}
                    </span>
                    <button
                      type="button"
                      title={t("queue.modalCopyPath")}
                      onClick={() => handleCopy(result._index, result.output_path)}
                      className="shrink-0 rounded p-0.5 text-cs2-text-muted hover:text-cs2-text-primary"
                    >
                      {copiedIdx === result._index ? (
                        <Check className="h-3.5 w-3.5 text-cs2-text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      title={t("queue.modalRevealPath")}
                      onClick={() => handleReveal(result.output_path)}
                      className="shrink-0 rounded p-0.5 text-cs2-text-muted hover:text-cs2-text-primary"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                {/* 失败：错误信息 */}
                {!result.success && !aborted && result.error && (
                  <div className="text-[11px] text-cs2-rose-on-surface">{result.error}</div>
                )}

                {/* 中止 */}
                {aborted && (
                  <div className="text-[11px] text-cs2-text-muted">{t("queue.modalItemAborted")}</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
