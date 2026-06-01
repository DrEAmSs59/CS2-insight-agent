# Dequeue from ClipCard & Round Timeline

**Date:** 2026-06-01  
**Status:** Approved

## Problem

Once a clip or timeline event is added to the recording queue, the only way to remove it is to navigate to the queue drawer/page. The ClipCard and RoundTimeline UI show "已入队" / "整回合已入队" state but offer no in-place removal. This creates unnecessary friction.

## Goal

Allow users to cancel queue items directly from:
1. **ClipCard** — the clip grid in the Analysis tab
2. **KillfeedEventRow** — individual kill/death rows in the Round Timeline
3. **RoundSummaryPanel** — the "加入本回合" button in the timeline right panel

## UX Decision

**Dedicated × button** on the existing state badge/button. The card/row body keeps its current disabled behavior; only the × target is interactive.

---

## Architecture

### Data flow for removal

`removeFromQueue(id)` in the Zustand store takes an internal UUID. A new store action `removeByClientClipUid(cuid)` finds the first queue item where `queueItemClientUid(q) === cuid` and delegates to `removeFromQueue`. This is the single removal primitive all callers use.

### Callback chain

```
App.jsx
  handleDequeueClip(clientClipUid)          → AnalysisPage → ClipList → ClipCard
  handleRemoveTimelineEventFromQueue(ev, rr) → AnalysisPage → RoundTimelineView
                                                            → RoundTimelineItem
                                                            → KillfeedEventRow
  handleRemoveTimelineRoundFromQueue(rr)     → AnalysisPage → RoundTimelineView
                                                            → RoundTimelineItem
                                                            → RoundSummaryPanel
```

All three handlers call `removeByClientClipUid` with the `clientClipUid` computed the same way as the corresponding add handler (mirrors `handleAddTimeline*`).

---

## Component Spec

### `recordingQueueStore.js`

Add action:
```js
removeByClientClipUid(cuid) {
  // Inline same logic as queueItemClientUid() to avoid circular dep
  // (recordingBatch.js already imports from this store)
  const toUid = (q) => q.clientClipUid || `legacy:${q.demoFilename}:${q.clipId}`;
  const item = get().queue.find((q) => toUid(q) === cuid);
  if (item) get().removeFromQueue(item.id);
}
```

### `ClipCard.jsx`

New prop: `onDequeue?: () => void`

When `inQueue=true` AND `onDequeue` is provided, the top-right badge changes from a static `<div>` to a `<button>`:

- Layout: `"队列"` text + `<X size={10} />` icon side by side
- Default: `border-cs2-border bg-cs2-bg-elevated text-cs2-text-secondary` (same as current)
- Hover: `border-rose-500/60 text-rose-400 bg-rose-500/8`
- Click: `e.stopPropagation(); onDequeue()`
- `cursor-default` on the card body is unchanged — only the badge `<button>` is interactive

When `inQueue=true` AND no `onDequeue`: keep existing static badge (backward-compatible).

### `ClipList.jsx`

New prop: `onDequeue?: (clientClipUid: string) => void`

Pass to each ClipCard:
```jsx
onDequeue={onDequeue && clip.client_clip_uid
  ? () => onDequeue(clip.client_clip_uid)
  : undefined}
```

### `KillfeedEventRow.jsx`

New prop: `onRowRemove?: () => void`

When `queued=true` AND `onRowRemove` is provided, the existing `"已入队"` badge `<span>` becomes a `<button>`:

- Append `<X size={9} />` after badge text
- Hover: `border-rose-400/55 text-rose-400`
- Click: `e.stopPropagation(); onRowRemove()`

Row body click behavior (add to queue) is unchanged; the guard inside `handleAddTimelineEventToQueue` already prevents duplicates.

### `RoundSummaryPanel.jsx`

New prop: `onRemoveRound?: () => void`

When `roundQueued=true` AND `onRemoveRound` is provided:
- Button becomes enabled (remove `disabled` attribute)
- Style: `border-rose-500/40 bg-rose-500/10 text-cs2-rose-on-surface hover:border-rose-400/70`
- Content: `整回合已入队 <X size={11} className="inline" />`
- `onClick={onRemoveRound}`

When `roundQueued=true` AND no `onRemoveRound`: keep existing disabled button (backward-compatible).

### `RoundTimelineItem.jsx`

New props: `onRemoveEvent?: (event, roundRow) => void`, `onRemoveRound?: (roundRow) => void`

Pass to `KillfeedEventRow`:
```jsx
onRowRemove={onRemoveEvent && isQueued(ev)
  ? () => onRemoveEvent(ev, roundRow)
  : undefined}
```

Pass to `RoundSummaryPanel`:
```jsx
onRemoveRound={onRemoveRound && roundQueued
  ? () => onRemoveRound(roundRow)
  : undefined}
```

### `RoundTimelineView.jsx`

New props: `onRemoveEvent`, `onRemoveRound` — thread straight through to each `<RoundTimelineItem>`.

### `App.jsx`

Three new callbacks:

```js
const handleDequeueClip = useCallback((clientClipUid) => {
  removeByClientClipUid(clientClipUid);
}, [removeByClientClipUid]);

const handleRemoveTimelineEventFromQueue = useCallback((event, roundRow) => {
  if (!currentParsed) return;
  const meta = queueItemMetaForIndex(currentMatchIndex);
  const mapName = matchMeta?.map_name || "";
  const clipData = buildTimelineEventClipData({
    event, mapName, targetPlayer: meta.targetPlayer,
    round: roundRow?.round ?? event?.round,
  });
  const uid = clipData.client_clip_uid;
  removeByClientClipUid(uid);
}, [currentParsed, currentMatchIndex, queueItemMetaForIndex, matchMeta, removeByClientClipUid]);

const handleRemoveTimelineRoundFromQueue = useCallback((roundRow) => {
  if (!currentParsed || !roundRow) return;
  const meta = queueItemMetaForIndex(currentMatchIndex);
  const mapName = matchMeta?.map_name || "";
  const clipData = buildTimelineRoundClipData({ roundRow, mapName, targetPlayer: meta.targetPlayer });
  removeByClientClipUid(clipData.client_clip_uid);
}, [currentParsed, currentMatchIndex, queueItemMetaForIndex, matchMeta, removeByClientClipUid]);
```

These three are added to the `s` state object passed to AnalysisPage (alongside the existing `handleAddTimeline*`).

### `AnalysisPage.jsx`

`<ClipList>`: add `onDequeue={s.handleDequeueClip}`

`<RoundTimelineView>`: add:
```jsx
onRemoveEvent={s.handleRemoveTimelineEventFromQueue}
onRemoveRound={s.handleRemoveTimelineRoundFromQueue}
```

---

## Files Changed

| File | Change |
|---|---|
| `frontend/src/stores/recordingQueueStore.js` | Add `removeByClientClipUid` action |
| `frontend/src/components/ClipCard.jsx` | Add `onDequeue` prop; × button on "队列" badge |
| `frontend/src/components/ClipList.jsx` | Add `onDequeue` prop; wire to ClipCard |
| `frontend/src/components/analysis/timeline/KillfeedEventRow.jsx` | Add `onRowRemove` prop; × on "已入队" badge |
| `frontend/src/components/analysis/timeline/RoundSummaryPanel.jsx` | Add `onRemoveRound` prop; toggle button style |
| `frontend/src/components/analysis/timeline/RoundTimelineItem.jsx` | Add `onRemoveEvent`/`onRemoveRound`; thread through |
| `frontend/src/components/analysis/timeline/RoundTimelineView.jsx` | Add `onRemoveEvent`/`onRemoveRound`; thread through |
| `frontend/src/App.jsx` | Add 3 remove handlers; expose on `s` |
| `frontend/src/pages/AnalysisPage.jsx` | Wire new props to ClipList and RoundTimelineView |

All changes are additive. No existing props or behaviors are removed.

---

## Out of Scope

- "只录击杀" / "只录死亡" batch buttons in RoundSummaryPanel — these queue multiple individual events; their queued state is reflected per-row in KillfeedEventRow, which is already covered above.
- Queue drawer / RecordingQueuePage — existing removal UI there is unchanged.
