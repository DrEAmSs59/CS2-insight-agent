/** 素材库 → 时间轴 HTML5 拖放状态（OpenCut TimelineDragSource 简化版） */
let activeMedia = null;

export const liteCutMediaDragSource = {
  begin(item) {
    activeMedia = item;
  },
  end() {
    activeMedia = null;
  },
  get() {
    return activeMedia;
  },
  isActive() {
    return activeMedia != null;
  },
};
