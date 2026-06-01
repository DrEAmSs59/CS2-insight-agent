# Dequeue from ClipCard & Round Timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dedicated × buttons that let users cancel queue items directly from ClipCard and the Round Timeline, without navigating to the queue drawer.

**Architecture:** A new `removeByClientClipUid` action is added to the Zustand store as the single removal primitive. Leaf components (ClipCard, KillfeedEventRow, RoundSummaryPanel) receive optional `onDequeue`/`onRowRemove`/`onRemoveRound` callbacks that render a × affordance when provided. Three new handlers in App.jsx compute the `clientClipUid` the same way as their corresponding add handlers and call the store action. Props are threaded through ClipList → ClipCard and RoundTimelineView → RoundTimelineItem → leaf components.

**Tech Stack:** React 19, Zustand, Tailwind CSS 4, Lucide React icons, Vite 6 dev server

---

## File Map

| File | Role in this change |
|---|---|
| `frontend/src/stores/recordingQueueStore.js` | Add `removeByClientClipUid` store action |
| `frontend/src/components/ClipCard.jsx` | Add `onDequeue` prop; × button on "队列" badge |
| `frontend/src/components/ClipList.jsx` | Add `onDequeue` prop; wire per-clip callback |
| `frontend/src/components/analysis/timeline/KillfeedEventRow.jsx` | Add `onRowRemove` prop; × on "已入队" badge |
| `frontend/src/components/analysis/timeline/RoundSummaryPanel.jsx` | Add `onRemoveRound` prop; toggle button style |
| `frontend/src/components/analysis/timeline/RoundTimelineItem.jsx` | Thread `onRemoveEvent` / `onRemoveRound` down |
| `frontend/src/components/analysis/timeline/RoundTimelineView.jsx` | Thread `onRemoveEvent` / `onRemoveRound` down |
| `frontend/src/App.jsx` | Add store selector + 3 remove handlers + expose on `s` |
| `frontend/src/pages/AnalysisPage.jsx` | Wire new props to ClipList and RoundTimelineView |

---

## Task 1: Add `removeByClientClipUid` to the Zustand store

**Files:**
- Modify: `frontend/src/stores/recordingQueueStore.js` (around line 137, after `removeFromQueue`)

- [ ] **Step 1: Add the action after `removeFromQueue`**

Open `frontend/src/stores/recordingQueueStore.js`. Locate `removeFromQueue(id)` (line ~137). Insert the new action immediately after:

```js
  removeByClientClipUid(cuid) {
    const toUid = (q) => q.clientClipUid || `legacy:${q.demoFilename}:${q.clipId}`;
    set((s) => ({ queue: s.queue.filter((q) => toUid(q) !== cuid) }));
  },
```

Note: this uses `set` + filter directly (same pattern as `removeFromQueue`) rather than calling `get().removeFromQueue`, to stay consistent with the store's internal style.

- [ ] **Step 2: Verify dev server still starts**

```bash
cd frontend && npm run dev
```

Expected: Vite starts with no errors in the terminal. Open http://localhost:5173 and confirm the app loads.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/stores/recordingQueueStore.js
git commit -m "feat(store): add removeByClientClipUid action"
```

---

## Task 2: ClipCard — × button on the "队列" badge

**Files:**
- Modify: `frontend/src/components/ClipCard.jsx`

The "队列" badge is a `<div>` rendered at line ~165 inside the main card `<div role="button">`. We change it to a `<button>` when `onDequeue` is provided, so click on the × targets the badge, not the card body.

- [ ] **Step 1: Add `onDequeue` to the component signature**

Find the `export default function ClipCard({` block (~line 89). Add `onDequeue` to the destructured props:

```js
export default function ClipCard({
  clip,
  targetPlayer = "",
  selected,
  onToggle,
  aiMode = false,
  inQueue = false,
  onDequeue,                       // ← add this line
  matchTotalRounds = 24,
  freezeToDeathDraft = { picked: [] },
  onFreezeToDeathDraftChange,
  roundMontagePickerDisabled = false,
}) {
```

- [ ] **Step 2: Replace the static "队列" badge with a conditional button**

Find this block (line ~163–180):

```jsx
      {/* Selection / 队列状态 */}
      <div
        className={`absolute right-3 top-3 z-10 flex min-h-[1.25rem] min-w-[1.25rem] items-center justify-center rounded-md px-1 text-[9px] font-bold uppercase tracking-wide transition-colors ${
          inQueue
            ? "border border-cs2-border bg-cs2-bg-elevated text-cs2-text-secondary"
            : selected
              ? "bg-cs2-accent"
              : "border border-cs2-border bg-cs2-bg-input group-hover:border-cs2-accent/40"
        }`}
      >
        {inQueue ? (
          "队列"
        ) : ftdEnqueueBlocked ? (
          <span className="px-0.5 text-[8px] font-bold leading-none text-cs2-amber-on-surface/90">—</span>
        ) : selected ? (
          <Check className="h-3 w-3 text-cs2-text-on-accent" />
        ) : null}
      </div>
```

Replace with:

```jsx
      {/* Selection / 队列状态 */}
      {inQueue && onDequeue ? (
        <button
          type="button"
          aria-label="从队列移除"
          onClick={(e) => { e.stopPropagation(); onDequeue(); }}
          className="absolute right-3 top-3 z-10 flex min-h-[1.25rem] items-center gap-0.5 rounded-md border border-cs2-border bg-cs2-bg-elevated px-1 text-[9px] font-bold uppercase tracking-wide text-cs2-text-secondary transition-colors hover:border-rose-500/60 hover:text-rose-400"
        >
          队列<X className="h-2.5 w-2.5" />
        </button>
      ) : (
        <div
          className={`absolute right-3 top-3 z-10 flex min-h-[1.25rem] min-w-[1.25rem] items-center justify-center rounded-md px-1 text-[9px] font-bold uppercase tracking-wide transition-colors ${
            inQueue
              ? "border border-cs2-border bg-cs2-bg-elevated text-cs2-text-secondary"
              : selected
                ? "bg-cs2-accent"
                : "border border-cs2-border bg-cs2-bg-input group-hover:border-cs2-accent/40"
          }`}
        >
          {inQueue ? (
            "队列"
          ) : ftdEnqueueBlocked ? (
            <span className="px-0.5 text-[8px] font-bold leading-none text-cs2-amber-on-surface/90">—</span>
          ) : selected ? (
            <Check className="h-3 w-3 text-cs2-text-on-accent" />
          ) : null}
        </div>
      )}
```

- [ ] **Step 3: Add `X` to the lucide-react import**

Find the existing import at the top of the file:

```js
import { Flame, Skull, Check, Clapperboard, Film } from "lucide-react";
```

Add `X`:

```js
import { Flame, Skull, Check, Clapperboard, Film, X } from "lucide-react";
```

- [ ] **Step 4: Manual verify in browser**

With the dev server running, parse a demo, add a clip to the queue. The clip card should show "队列 ×" badge. Hover over it — badge should turn red-tinted. Click × — clip should disappear from the queue (check queue drawer). Card should become selectable again.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ClipCard.jsx
git commit -m "feat(ClipCard): add onDequeue prop with × button on queued badge"
```

---

## Task 3: ClipList — wire `onDequeue` to each ClipCard

**Files:**
- Modify: `frontend/src/components/ClipList.jsx`

- [ ] **Step 1: Add `onDequeue` to ClipList props**

Find the JSDoc comment (line ~14) and the destructured props (line ~33). Add `onDequeue`:

JSDoc — add one line inside the `@param` block:
```js
 *   onDequeue?: (clientClipUid: string) => void,
```

Destructured props — add after `suppressSummaryHeader`:
```js
  onDequeue,
```

- [ ] **Step 2: Pass `onDequeue` to each `<ClipCard>`**

Find the `<ClipCard` render block (line ~124). Add the prop:

```jsx
              onDequeue={
                onDequeue && clip.client_clip_uid
                  ? () => onDequeue(clip.client_clip_uid)
                  : undefined
              }
```

The full `<ClipCard>` call should look like (add the new prop after `inQueue`):

```jsx
            <ClipCard
              key={clip.client_clip_uid || clip.clip_id}
              clip={clip}
              targetPlayer={targetPlayer}
              selected={selectedIds.has(clip.client_clip_uid)}
              onToggle={onToggle}
              aiMode={aiMode}
              inQueue={Boolean(clip.client_clip_uid && queued.has(clip.client_clip_uid))}
              onDequeue={
                onDequeue && clip.client_clip_uid
                  ? () => onDequeue(clip.client_clip_uid)
                  : undefined
              }
              matchTotalRounds={matchTotalRounds}
              freezeToDeathDraft={freezeToDeathDraft[clip.client_clip_uid] ?? { picked: [] }}
              onFreezeToDeathDraftChange={(next) =>
                onFreezeToDeathDraftChange?.({ ...freezeToDeathDraft, [clip.client_clip_uid]: next })
              }
              roundMontagePickerDisabled={roundMontagePickerDisabled}
            />
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ClipList.jsx
git commit -m "feat(ClipList): thread onDequeue prop to ClipCard"
```

---

## Task 4: KillfeedEventRow — × button on "已入队" badge

**Files:**
- Modify: `frontend/src/components/analysis/timeline/KillfeedEventRow.jsx`

- [ ] **Step 1: Add `X` to lucide-react import**

`KillfeedEventRow.jsx` currently has no lucide import. Add at the top of the file:

```js
import { X } from "lucide-react";
```

- [ ] **Step 2: Add `onRowRemove` to the component signature**

Find the JSDoc and function signature (~line 44):

```js
/**
 * @param {{
 *   event: Record<string, unknown>,
 *   focusedPlayer?: string,
 *   queued?: boolean,
 *   onRowClick?: () => void,
 *   roundNumber?: number,
 *   variant?: "default" | "timeline",
 * }} props
 */
export default function KillfeedEventRow({
  event,
  focusedPlayer = "",
  queued = false,
  onRowClick,
  roundNumber,
  variant = "default",
}) {
```

Update to:

```js
/**
 * @param {{
 *   event: Record<string, unknown>,
 *   focusedPlayer?: string,
 *   queued?: boolean,
 *   onRowClick?: () => void,
 *   onRowRemove?: () => void,
 *   roundNumber?: number,
 *   variant?: "default" | "timeline",
 * }} props
 */
export default function KillfeedEventRow({
  event,
  focusedPlayer = "",
  queued = false,
  onRowClick,
  onRowRemove,
  roundNumber,
  variant = "default",
}) {
```

- [ ] **Step 3: Replace the static "已入队" badge with a conditional button**

Find this block near the bottom of the JSX return (line ~173):

```jsx
        {queued ? (
          <span className="ml-auto shrink-0 rounded border border-cs2-accent/35 px-1.5 py-0.5 text-[10px] font-semibold text-cs2-accent">
            已入队
          </span>
        ) : null}
```

Replace with:

```jsx
        {queued ? (
          onRowRemove ? (
            <button
              type="button"
              aria-label="从队列移除"
              onClick={(e) => { e.stopPropagation(); onRowRemove(); }}
              className="ml-auto shrink-0 flex items-center gap-0.5 rounded border border-cs2-accent/35 px-1.5 py-0.5 text-[10px] font-semibold text-cs2-accent transition-colors hover:border-rose-400/55 hover:text-rose-400"
            >
              已入队<X className="h-2.5 w-2.5" />
            </button>
          ) : (
            <span className="ml-auto shrink-0 rounded border border-cs2-accent/35 px-1.5 py-0.5 text-[10px] font-semibold text-cs2-accent">
              已入队
            </span>
          )
        ) : null}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/analysis/timeline/KillfeedEventRow.jsx
git commit -m "feat(KillfeedEventRow): add onRowRemove prop with × on queued badge"
```

---

## Task 5: RoundSummaryPanel — removable "整回合已入队" button

**Files:**
- Modify: `frontend/src/components/analysis/timeline/RoundSummaryPanel.jsx`

- [ ] **Step 1: Add `X` import and `onRemoveRound` prop**

Add lucide import at the top:

```js
import { X } from "lucide-react";
```

Update the JSDoc and function signature:

```js
/**
 * @param {{
 *   kills: number,
 *   deaths: number,
 *   assists: number,
 *   headshots?: number,
 *   extraTags: string[],
 *   roundQueued: boolean,
 *   killsOnly: unknown[],
 *   deathsOnly: unknown[],
 *   onAddRound?: () => void,
 *   onAddKills?: () => void,
 *   onAddDeaths?: () => void,
 *   onRemoveRound?: () => void,
 * }} props
 */
export default function RoundSummaryPanel({
  kills,
  deaths,
  assists,
  headshots = 0,
  extraTags = [],
  roundQueued,
  killsOnly,
  deathsOnly,
  onAddRound,
  onAddKills,
  onAddDeaths,
  onRemoveRound,
}) {
```

- [ ] **Step 2: Replace the "整回合" button with a conditional**

Find (line ~76):

```jsx
        <button
          type="button"
          onClick={onAddRound}
          disabled={!onAddRound || roundQueued}
          className="w-full rounded-md border border-cs2-border bg-cs2-bg-input/50 py-2 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:border-cs2-accent/50 hover:text-cs2-text-primary disabled:opacity-35"
        >
          {roundQueued ? "整回合已入队" : "加入本回合"}
        </button>
```

Replace with:

```jsx
        {roundQueued && onRemoveRound ? (
          <button
            type="button"
            onClick={onRemoveRound}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 py-2 text-[12px] font-semibold text-cs2-rose-on-surface transition-colors hover:border-rose-400/70"
          >
            整回合已入队<X className="h-3 w-3" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onAddRound}
            disabled={!onAddRound || roundQueued}
            className="w-full rounded-md border border-cs2-border bg-cs2-bg-input/50 py-2 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:border-cs2-accent/50 hover:text-cs2-text-primary disabled:opacity-35"
          >
            {roundQueued ? "整回合已入队" : "加入本回合"}
          </button>
        )}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/analysis/timeline/RoundSummaryPanel.jsx
git commit -m "feat(RoundSummaryPanel): add onRemoveRound with removable round button"
```

---

## Task 6: RoundTimelineItem — thread remove callbacks to leaves

**Files:**
- Modify: `frontend/src/components/analysis/timeline/RoundTimelineItem.jsx`

- [ ] **Step 1: Add `onRemoveEvent` and `onRemoveRound` to props**

Update the JSDoc comment (line ~9) and the function signature (line ~21):

JSDoc — add two lines inside the `@param` block:
```js
 *   onRemoveEvent?: (event: Record<string, unknown>, roundRow: Record<string, unknown>) => void,
 *   onRemoveRound?: (roundRow: Record<string, unknown>) => void,
```

Destructured props — add after `onAddEventsBatch`:
```js
  onRemoveEvent,
  onRemoveRound,
```

- [ ] **Step 2: Wire `onRowRemove` in the KillfeedEventRow render**

Find the `<KillfeedEventRow` usage (line ~165):

```jsx
              <KillfeedEventRow
                event={ev}
                focusedPlayer={focusedPlayer}
                queued={isQueued(ev)}
                variant="timeline"
                onRowClick={
                  ev?.can_record && onAddEvent && String(ev?.type || "") !== "assist_only"
                    ? () => onAddEvent(ev, roundRow)
                    : undefined
                }
              />
```

Replace with:

```jsx
              <KillfeedEventRow
                event={ev}
                focusedPlayer={focusedPlayer}
                queued={isQueued(ev)}
                variant="timeline"
                onRowClick={
                  ev?.can_record && onAddEvent && String(ev?.type || "") !== "assist_only"
                    ? () => onAddEvent(ev, roundRow)
                    : undefined
                }
                onRowRemove={
                  onRemoveEvent && isQueued(ev)
                    ? () => onRemoveEvent(ev, roundRow)
                    : undefined
                }
              />
```

- [ ] **Step 3: Wire `onRemoveRound` in the RoundSummaryPanel render**

Find the `<RoundSummaryPanel` usage (line ~191):

```jsx
        <RoundSummaryPanel
          kills={tk}
          deaths={td}
          assists={ta}
          headshots={ths}
          extraTags={[]}
          roundQueued={Boolean(roundQueued)}
          killsOnly={killsOnly}
          deathsOnly={deathsOnly}
          onAddRound={onAddRound && !roundQueued ? () => onAddRound(roundRow) : undefined}
          onAddKills={
            killsOnly.length && onAddEventsBatch ? () => onAddEventsBatch(killsOnly) : undefined
          }
          onAddDeaths={
            deathsOnly.length && onAddEventsBatch ? () => onAddEventsBatch(deathsOnly) : undefined
          }
        />
```

Replace with:

```jsx
        <RoundSummaryPanel
          kills={tk}
          deaths={td}
          assists={ta}
          headshots={ths}
          extraTags={[]}
          roundQueued={Boolean(roundQueued)}
          killsOnly={killsOnly}
          deathsOnly={deathsOnly}
          onAddRound={onAddRound && !roundQueued ? () => onAddRound(roundRow) : undefined}
          onAddKills={
            killsOnly.length && onAddEventsBatch ? () => onAddEventsBatch(killsOnly) : undefined
          }
          onAddDeaths={
            deathsOnly.length && onAddEventsBatch ? () => onAddEventsBatch(deathsOnly) : undefined
          }
          onRemoveRound={
            onRemoveRound && roundQueued
              ? () => onRemoveRound(roundRow)
              : undefined
          }
        />
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/analysis/timeline/RoundTimelineItem.jsx
git commit -m "feat(RoundTimelineItem): thread onRemoveEvent and onRemoveRound to leaves"
```

---

## Task 7: RoundTimelineView — thread remove props

**Files:**
- Modify: `frontend/src/components/analysis/timeline/RoundTimelineView.jsx`

- [ ] **Step 1: Add `onRemoveEvent` and `onRemoveRound` to JSDoc and destructure**

Update the JSDoc comment (line ~4):
```js
/**
 * @param {{
 *   roundTimeline?: unknown[] | null,
 *   focusedPlayer?: string,
 *   demoFilename?: string,
 *   mapName?: string,
 *   queuedClientClipUids?: Set<string>,
 *   onAddEvent?: (event: Record<string, unknown>, roundRow: Record<string, unknown>) => void,
 *   onAddRound?: (roundRow: Record<string, unknown>) => void,
 *   onAddEventsBatch?: (events: Record<string, unknown>[]) => void,
 *   onRemoveEvent?: (event: Record<string, unknown>, roundRow: Record<string, unknown>) => void,
 *   onRemoveRound?: (roundRow: Record<string, unknown>) => void,
 *   suppressSummaryHeader?: boolean,
 * }} props
 */
```

Update the function signature (line ~17):
```js
export default function RoundTimelineView({
  roundTimeline,
  focusedPlayer = "",
  demoFilename = "",
  mapName = "",
  queuedClientClipUids,
  onAddEvent,
  onAddRound,
  onAddEventsBatch,
  onRemoveEvent,
  onRemoveRound,
  suppressSummaryHeader = false,
}) {
```

- [ ] **Step 2: Pass new props to `<RoundTimelineItem>`**

Find the `<RoundTimelineItem` render (line ~66):

```jsx
              <RoundTimelineItem
                key={`r-${row?.round_number ?? row?.round}`}
                roundRow={row}
                focusedPlayer={focusedPlayer}
                mapName={mapName}
                demoFilename={demoFilename}
                queuedUids={queuedClientClipUids}
                onAddEvent={onAddEvent}
                onAddRound={onAddRound}
                onAddEventsBatch={onAddEventsBatch}
              />
```

Replace with:

```jsx
              <RoundTimelineItem
                key={`r-${row?.round_number ?? row?.round}`}
                roundRow={row}
                focusedPlayer={focusedPlayer}
                mapName={mapName}
                demoFilename={demoFilename}
                queuedUids={queuedClientClipUids}
                onAddEvent={onAddEvent}
                onAddRound={onAddRound}
                onAddEventsBatch={onAddEventsBatch}
                onRemoveEvent={onRemoveEvent}
                onRemoveRound={onRemoveRound}
              />
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/analysis/timeline/RoundTimelineView.jsx
git commit -m "feat(RoundTimelineView): thread onRemoveEvent and onRemoveRound props"
```

---

## Task 8: App.jsx — store selector + 3 remove handlers + expose on `s`

**Files:**
- Modify: `frontend/src/App.jsx`

- [ ] **Step 1: Add `removeByClientClipUid` store selector**

Find the store selectors block (line ~201):

```js
  const queue           = useRecordingQueue((s) => s.queue);
  const addToQueue      = useRecordingQueue((s) => s.addToQueue);
  const removeFromQueue = useRecordingQueue((s) => s.removeFromQueue);
  const clearQueue      = useRecordingQueue((s) => s.clearQueue);
  const globalPacing    = useRecordingQueue((s) => s.globalPacing);
```

Add one line:

```js
  const queue                  = useRecordingQueue((s) => s.queue);
  const addToQueue             = useRecordingQueue((s) => s.addToQueue);
  const removeFromQueue        = useRecordingQueue((s) => s.removeFromQueue);
  const removeByClientClipUid  = useRecordingQueue((s) => s.removeByClientClipUid);
  const clearQueue             = useRecordingQueue((s) => s.clearQueue);
  const globalPacing           = useRecordingQueue((s) => s.globalPacing);
```

- [ ] **Step 2: Add `handleDequeueClip`**

Place this after the existing `handleAddTimelineEventsBatchToQueue` (around line 1535). Import `buildTimelineEventClipData` and `buildTimelineRoundClipData` are already imported — confirm by searching for them at the top of App.jsx.

```js
  const handleDequeueClip = useCallback(
    (clientClipUid) => {
      removeByClientClipUid(clientClipUid);
    },
    [removeByClientClipUid],
  );
```

- [ ] **Step 3: Add `handleRemoveTimelineEventFromQueue`**

Add immediately after `handleDequeueClip`:

```js
  const handleRemoveTimelineEventFromQueue = useCallback(
    (event, roundRow) => {
      if (!currentParsed) return;
      const meta = queueItemMetaForIndex(currentMatchIndex);
      const mapName = matchMeta?.map_name || "";
      const clipData = buildTimelineEventClipData({
        event,
        mapName,
        targetPlayer: meta.targetPlayer,
        round: roundRow?.round ?? event?.round,
      });
      removeByClientClipUid(clipData.client_clip_uid);
    },
    [currentParsed, currentMatchIndex, queueItemMetaForIndex, matchMeta, removeByClientClipUid],
  );
```

- [ ] **Step 4: Add `handleRemoveTimelineRoundFromQueue`**

Add immediately after:

```js
  const handleRemoveTimelineRoundFromQueue = useCallback(
    (roundRow) => {
      if (!currentParsed || !roundRow) return;
      const meta = queueItemMetaForIndex(currentMatchIndex);
      const mapName = matchMeta?.map_name || "";
      const clipData = buildTimelineRoundClipData({
        roundRow,
        mapName,
        targetPlayer: meta.targetPlayer,
      });
      removeByClientClipUid(clipData.client_clip_uid);
    },
    [currentParsed, currentMatchIndex, queueItemMetaForIndex, matchMeta, removeByClientClipUid],
  );
```

- [ ] **Step 5: Confirm `buildTimelineRoundClipData` is imported**

Search near the top of App.jsx for the import of `buildTimelineEventClipData`. The same import should include `buildTimelineRoundClipData`. If not, add it to that import statement.

- [ ] **Step 6: Add the three handlers to the `s` object**

Find the `s` object definition (around line 2270 — after `handleAddTimelineEventsBatchToQueue`):

```js
    handleAddTimelineEventToQueue,
    handleAddTimelineRoundToQueue,
    handleAddTimelineEventsBatchToQueue,
```

Add three lines immediately after:

```js
    handleAddTimelineEventToQueue,
    handleAddTimelineRoundToQueue,
    handleAddTimelineEventsBatchToQueue,
    handleDequeueClip,
    handleRemoveTimelineEventFromQueue,
    handleRemoveTimelineRoundFromQueue,
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "feat(App): add removeByClientClipUid selector and 3 remove handlers"
```

---

## Task 9: AnalysisPage — wire new props to ClipList and RoundTimelineView

**Files:**
- Modify: `frontend/src/pages/AnalysisPage.jsx`

- [ ] **Step 1: Add `onDequeue` to `<ClipList>`**

Find the `<ClipList` usage (line ~195). Add after `queuedClientClipUids`:

```jsx
              <ClipList
                clips={s.clips}
                targetPlayer={s.matchMeta?.target_player ?? ""}
                selectedIds={s.selectedClientClipUids}
                onToggle={s.handleToggleClip}
                aiMode={s.aiMode}
                queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo}
                onDequeue={s.handleDequeueClip}
                playerTabs={s.parsedPlayerNames}
                activePlayerTab={s.currentActivePlayer}
                onPlayerTabChange={(name) =>
                  s.setActivePlayerTabs((prev) => ({ ...prev, [s.currentMatchIndex]: name }))
                }
                parsedPlayers={s.currentParsed?.players ?? {}}
                matchTotalRounds={s.roundMontageMaxRounds}
                freezeToDeathDraft={s.freezeToDeathDraft}
                onFreezeToDeathDraftChange={s.setFreezeToDeathDraft}
                roundMontagePickerDisabled={Boolean(
                  s.parsing || s.parsingByIndex[s.currentMatchIndex] || s.batchRecording
                )}
                suppressSummaryHeader
              />
```

- [ ] **Step 2: Add `onRemoveEvent` and `onRemoveRound` to `<RoundTimelineView>`**

Find the `<RoundTimelineView` usage (line ~253). Add after `onAddEventsBatch`:

```jsx
                <RoundTimelineView
                  roundTimeline={s.roundTimeline}
                  focusedPlayer={s.currentActivePlayer || s.matchMeta?.target_player || ""}
                  demoFilename={s.currentFilename}
                  mapName={s.matchMeta?.map_name ?? ""}
                  queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo}
                  onAddEvent={s.handleAddTimelineEventToQueue}
                  onAddRound={s.handleAddTimelineRoundToQueue}
                  onAddEventsBatch={s.handleAddTimelineEventsBatchToQueue}
                  onRemoveEvent={s.handleRemoveTimelineEventFromQueue}
                  onRemoveRound={s.handleRemoveTimelineRoundFromQueue}
                  suppressSummaryHeader
                />
```

- [ ] **Step 3: Final manual verification**

With the dev server running, test all three removal paths:

1. **ClipCard**: Parse a demo → add a clip to queue → confirm "队列 ×" badge appears → click × → confirm clip leaves queue and card becomes interactive again.

2. **KillfeedEventRow**: Switch to "回合时间线" view → expand a round → click a kill/death row to add to queue → confirm "已入队 ×" badge appears → click × → confirm item leaves queue and badge reverts.

3. **RoundSummaryPanel**: Add a full round to queue (click "加入本回合") → confirm button changes to red "整回合已入队 ×" style → click it → confirm round leaves queue and button reverts to "加入本回合".

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/AnalysisPage.jsx
git commit -m "feat(AnalysisPage): wire dequeue props to ClipList and RoundTimelineView"
```

---

## Self-Review

**Spec coverage:**
- ✅ Store `removeByClientClipUid` → Task 1
- ✅ ClipCard `onDequeue` + × badge → Task 2
- ✅ ClipList threads `onDequeue` → Task 3
- ✅ KillfeedEventRow `onRowRemove` + × badge → Task 4
- ✅ RoundSummaryPanel `onRemoveRound` + toggle button → Task 5
- ✅ RoundTimelineItem threads both → Task 6
- ✅ RoundTimelineView threads both → Task 7
- ✅ App.jsx handlers + `s` exposure → Task 8
- ✅ AnalysisPage wiring → Task 9
- ✅ Backward compat (no `onDequeue` = old behavior) — enforced in Tasks 2, 4, 5

**Type consistency:**
- `removeByClientClipUid(cuid)` defined in Task 1, consumed in Tasks 8 ✅
- `onDequeue` (no args, `() => void`) defined in Task 2, wired in Tasks 3 & 8 ✅
- `onRowRemove` (`() => void`) defined in Task 4, wired in Task 6 ✅
- `onRemoveRound` (`() => void` in panel, `(roundRow) => void` in item/view) — panel receives the already-bound `() => onRemoveRound(roundRow)` from Item ✅
- `onRemoveEvent(ev, roundRow)` defined in Tasks 6/7, implemented in Task 8 ✅

**No placeholders found.**
