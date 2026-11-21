export function replayErrorMessage({ reason, key }, locale, t) {
  const detail = reason?.response?.data?.detail;
  const message = typeof detail === "string" ? detail : reason?.message;
  if (message && (locale !== "en" || !/\p{Script=Han}/u.test(message))) {
    return message;
  }
  return t(key);
}
