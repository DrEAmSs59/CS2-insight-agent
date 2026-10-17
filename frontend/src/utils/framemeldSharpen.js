export function normalizeSharpenAmount(value) {
  const amount = Number(value);
  return value == null || value === "" || !Number.isFinite(amount) ? 0.15 : Math.round(Math.max(0.1, Math.min(0.3, amount)) * 100) / 100;
}
