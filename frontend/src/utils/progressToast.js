/**
 * 底部 ProgressBar 是否应显示进行中样式（转圈 + 不确定进度条）。
 * 与「仅有文案的成功/失败提示」区分，避免探测完成仍显示读条。
 */
export function progressToastShowsBusy(
  text,
  { parsing = false, loading = false } = {},
) {
  if (parsing || loading) return true;
  const t = String(text || "").trim();
  if (!t) return false;
  // 进行中文案统一以省略号结尾（中英一致约定）；中文关键词作兜底。
  if (t.endsWith("…") || t.endsWith("...")) return true;
  return /正在|探测中|检测中|上传中|解析中|扫描中|载入中|导播中|恢复中|删除中|保存中/.test(t);
}
