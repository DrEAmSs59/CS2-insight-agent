# Demo Ingest Skip Compat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `ensure_demo_compatible` from `batch_ingest_demos` so library ingest no longer pays full-file compat repair cost while keeping inspect metadata unchanged.

**Architecture:** One-line removal in `_inspect_candidate` inside `batch_ingest_demos`. Compat repair remains on upload, play, analyze, and recording paths. Update the existing batch-ingest unit test to assert compat is never invoked.

**Tech Stack:** Python 3.12, FastAPI, pytest, monkeypatch/AsyncMock

## Global Constraints

- Do not raise inspect concurrency or change `inspect_demo`
- Do not defer roster/scoreboard to background
- Do not change frontend ingest UI
- Do not change `ensure_demo_compatible` implementation or cache format

---

### Task 1: Assert ingest skips compat + remove the call

**Files:**
- Modify: `backend/tests/test_demo_roster_cache.py` (`test_batch_ingest_bounds_inspection_concurrency_and_reuses_rosters`)
- Modify: `backend/app/main.py` (`batch_ingest_demos` → `_inspect_candidate`)
- Test: `backend/tests/test_demo_roster_cache.py`

**Interfaces:**
- Consumes: `main.batch_ingest_demos`, `main.BatchIngestBody`
- Produces: ingest path that only calls `_inspect_demo_meta` under the semaphore (no `ensure_demo_compatible`)

- [x] **Step 1: Write the failing assertion**

In `test_batch_ingest_bounds_inspection_concurrency_and_reuses_rosters`, replace the stub:

```python
monkeypatch.setattr(main, "ensure_demo_compatible", lambda _path: None)
```

with a call tracker that fails if invoked, and assert zero calls after ingest:

```python
compat_calls: list[str] = []

def fake_ensure(path):
    compat_calls.append(str(path))
    raise AssertionError("batch ingest must not call ensure_demo_compatible")

monkeypatch.setattr(main, "ensure_demo_compatible", fake_ensure)
# ... existing ingest run ...
assert compat_calls == []
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd backend; python -m pytest tests/test_demo_roster_cache.py::test_batch_ingest_bounds_inspection_concurrency_and_reuses_rosters -v`

Expected: FAIL — ingest still calls `ensure_demo_compatible`, hitting the AssertionError (or failed ingest entries).

- [x] **Step 3: Remove compat from batch ingest**

In `backend/app/main.py` `_inspect_candidate`, delete:

```python
await asyncio.to_thread(ensure_demo_compatible, dem_path)
```

Keep only:

```python
async with inspect_sem:
    players, meta = await _inspect_demo_meta(Path(dem_path))
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd backend; python -m pytest tests/test_demo_roster_cache.py::test_batch_ingest_bounds_inspection_concurrency_and_reuses_rosters -v`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_demo_roster_cache.py
git commit -m "perf: skip demo compat repair during library ingest"
```
