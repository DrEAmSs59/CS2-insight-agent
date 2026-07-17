export function isInterruptedPlaybackError(error) {
  return error?.name === "AbortError" || /interrupted by a call to pause/i.test(String(error?.message || ""));
}

export function releaseMediaElement(element) {
  if (!element) return;
  try {
    element.pause();
    element.removeAttribute("src");
    if ("srcObject" in element) element.srcObject = null;
    element.load();
  } catch {
    // Detached or already released elements require no further cleanup.
  }
}

/**
 * Keep callback refs stable for a keyed collection of media elements.
 *
 * React detaches an old callback ref whenever its function identity changes.
 * Releasing a media element from an inline ref callback can therefore clear
 * the `src` of the still-live replacement element during an ordinary render.
 * This registry owns the exact element attached to each stable callback, so
 * only the element that is actually being detached is released.
 */
export function createMediaElementRefRegistry(elements = new Map(), release = releaseMediaElement) {
  const entries = new Map();

  const refFor = (rawId) => {
    const id = String(rawId);
    let entry = entries.get(id);
    if (entry) return entry.ref;

    entry = { element: null, ref: null };
    entry.ref = (element) => {
      if (element) {
        entry.element = element;
        elements.set(id, element);
        return;
      }

      const detached = entry.element;
      entry.element = null;
      if (elements.get(id) === detached) elements.delete(id);
      release(detached);
    };
    entries.set(id, entry);
    return entry.ref;
  };

  const releaseAll = () => {
    const released = new Set();
    for (const entry of entries.values()) {
      if (entry.element && !released.has(entry.element)) {
        released.add(entry.element);
        release(entry.element);
      }
      entry.element = null;
    }
    elements.clear();
    entries.clear();
  };

  return { elements, refFor, releaseAll };
}

export function drawVideoFrame(ctx, element, x, y, width, height, fit = "contain") {
  const sourceWidth = Number(element?.videoWidth) || 0;
  const sourceHeight = Number(element?.videoHeight) || 0;
  if (!ctx || !element || element.readyState < 2 || sourceWidth <= 0 || sourceHeight <= 0) return false;
  const scale = fit === "cover" ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(element, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  return true;
}
