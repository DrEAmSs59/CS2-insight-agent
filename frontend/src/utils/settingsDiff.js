/**
 * 统计两份设置之间不同的字段数（逐层比较普通对象，数组与标量整体比较）。
 * 用于设置页「N 项更改未保存」提示。
 */
export function countChangedFields(next, saved) {
  const a = next && typeof next === "object" ? next : {};
  const b = saved && typeof saved === "object" ? saved : {};
  let changed = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    if (isPlainObject(x) && isPlainObject(y)) {
      changed += countChangedFields(x, y);
    } else if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) {
      changed += 1;
    }
  }
  return changed;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
