function isEditableTarget(target) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, [contenteditable='true']"));
}

/** Keep the desktop WebView from exposing browser-native selection/context UI. */
export function installAppInteractionGuards(target = document) {
  const preventContextMenu = (event) => event.preventDefault();
  const preventPageSelection = (event) => {
    if (!isEditableTarget(event.target)) event.preventDefault();
  };

  target.addEventListener("contextmenu", preventContextMenu);
  target.addEventListener("selectstart", preventPageSelection);

  return () => {
    target.removeEventListener("contextmenu", preventContextMenu);
    target.removeEventListener("selectstart", preventPageSelection);
  };
}
