# batch-summary Demo 批量加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Demo 库"载入选中"从 8 个请求优化为 1 个 `POST /api/demos/batch-summary`，后端并发 5，任一失败返回 400 并在前端弹框提示。

**Architecture:** 后端在 `main.py` 新增路由，用 `asyncio.Semaphore(5)` 控制并发调用 `get_player_list_isolated`；前端 `handleLoadSelectedLibraryDemos` 改用批量接口，`handleLoadDemoFromLibrary` 增加跳过已有 players 的逻辑，新增失败弹框组件。

**Tech Stack:** Python / FastAPI / asyncio，React / Axios

---

## Task 1：后端 — 添加 `BatchSummaryBody` 模型和路由

**Files:**
- Modify: `backend/app/main.py`（在 `BatchResolvePlayersBody` 定义附近插入，约第 1818 行）

- [ ] **Step 1: 在 `BatchResolvePlayersBody` 类定义之后，紧接着插入新模型**

在 `backend/app/main.py` 第 1824 行（`manual_lines` 字段那行）之后的空行处，加入：

```python
class BatchSummaryBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=100)
```

- [ ] **Step 2: 在 `batch_resolve_players` 路由之后插入新路由**

在 `backend/app/main.py` 第 1854 行（`batch_resolve_players` 函数结束的 `return` 之后）插入：

```python
@app.post("/api/demos/batch-summary")
async def batch_demo_summary(body: BatchSummaryBody):
    """批量加载 Demo 元数据 + 玩家列表，并发数上限 5。任一失败返回 400。"""
    from .demo_parse_isolation import get_player_list_isolated

    sem = asyncio.Semaphore(5)
    errors: list[dict] = []

    async def fetch_one(demo_id: int) -> dict:
        row = await demo_db.get_demo_list_item(demo_id)
        if not row:
            raise ValueError(f"Demo {demo_id} 不存在")
        dem_path = row.get("path", "")
        async with sem:
            players = await asyncio.to_thread(get_player_list_isolated, dem_path)
        match_meta = {
            "map_name": row.get("map_name"),
            "total_rounds": row.get("total_rounds"),
            "team_a_score": row.get("team_a_score"),
            "team_b_score": row.get("team_b_score"),
            "duration_mins": row.get("duration_mins"),
            "match_date": row.get("match_date"),
        }
        return {**row, "players": players, "match_meta": match_meta}

    results = await asyncio.gather(
        *[fetch_one(did) for did in body.ids],
        return_exceptions=True,
    )

    items: list[dict] = []
    for did, res in zip(body.ids, results):
        if isinstance(res, Exception):
            # 找到 filename 供弹框显示
            try:
                row = await demo_db.get_demo_list_item(did)
                fname = (row.get("display_name") and str(row["display_name"]).strip()) or row.get("filename") or str(did)
            except Exception:
                fname = str(did)
            errors.append({"id": did, "filename": fname, "reason": str(res)})
        else:
            items.append(res)

    if errors:
        raise HTTPException(
            status_code=400,
            detail={"message": "部分 Demo 加载失败", "failed": errors},
        )

    return {"items": items}
```

- [ ] **Step 3: 验证后端启动无报错**

```
cd backend
uvicorn app.main:app --port 8000
```

Expected: 服务正常监听，无 `SyntaxError` / `ImportError`。

- [ ] **Step 4: curl 快速验证接口存在**

```
curl -s -X POST http://localhost:8000/api/demos/batch-summary \
  -H "Content-Type: application/json" \
  -d '{"ids": [99999]}' | python -m json.tool
```

Expected: 返回 400，body 含 `detail.failed[0].id == 99999`（因为不存在）。

- [ ] **Step 5: Commit**

```
git add backend/app/main.py
git commit -m "feat: add POST /api/demos/batch-summary with concurrency 5"
```

---

## Task 2：前端 — 新增失败弹框组件

**Files:**
- Create: `frontend/src/components/BatchLoadErrorModal.jsx`

- [ ] **Step 1: 创建组件**

```jsx
// frontend/src/components/BatchLoadErrorModal.jsx
import { X, AlertCircle } from "lucide-react";

/**
 * @param {{
 *   open: boolean;
 *   failed: Array<{ id: number; filename: string; reason: string }>;
 *   onClose: () => void;
 * }} props
 */
export default function BatchLoadErrorModal({ open, failed = [], onClose }) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-3 py-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md rounded-xl bg-zinc-900 border border-zinc-700 shadow-2xl">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-zinc-700">
          <div className="flex items-center gap-2 text-red-400">
            <AlertCircle size={18} />
            <span className="font-semibold text-sm">部分 Demo 加载失败</span>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <ul className="px-5 py-4 space-y-2 max-h-60 overflow-y-auto">
          {failed.map((item) => (
            <li key={item.id} className="text-sm">
              <span className="text-zinc-200 font-medium">{item.filename}</span>
              <span className="text-zinc-500 ml-2">— {item.reason}</span>
            </li>
          ))}
        </ul>

        <div className="px-5 pb-5 pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm text-zinc-200 transition-colors"
          >
            重新选择
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```
git add frontend/src/components/BatchLoadErrorModal.jsx
git commit -m "feat: add BatchLoadErrorModal component"
```

---

## Task 3：前端 — 接入批量接口，更新加载逻辑

**Files:**
- Modify: `frontend/src/App.jsx`

- [ ] **Step 1: 在 App.jsx 顶部 import 区加入新组件**

在现有 `import LibraryLoadModeModal` 那行（约第 10 行）下方插入：

```jsx
import BatchLoadErrorModal from "./components/BatchLoadErrorModal";
```

- [ ] **Step 2: 在 useState 区（约第 196 行附近）加入弹框状态**

在 `const [libraryBatchModalOpen, setLibraryBatchModalOpen] = useState(false);` 之后插入：

```jsx
const [batchLoadError, setBatchLoadError] = useState({ open: false, failed: [] });
```

- [ ] **Step 3: 修改 `handleLoadDemoFromLibrary`（约第 594-595 行）**

将：
```jsx
const { data } = await API.get(`/demos/${item.id}/players`);
```
替换为：
```jsx
const playersResult =
  item.players != null
    ? { players: item.players, match_meta: item.match_meta }
    : (await API.get(`/demos/${item.id}/players`)).data;
const data = playersResult;
```

- [ ] **Step 4: 修改 `handleLoadSelectedLibraryDemos`（约第 742-752 行）**

将整个函数体替换为：

```jsx
const handleLoadSelectedLibraryDemos = useCallback(async () => {
  const ids = Array.from(selectedLibraryDemoIds);
  if (!ids.length) return;
  try {
    ids.sort((a, b) => Number(a) - Number(b));
    const { data } = await API.post("/demos/batch-summary", { ids });
    await handleLoadDemoFromLibrary(data.items);
  } catch (e) {
    const failed = e.response?.data?.detail?.failed;
    if (Array.isArray(failed) && failed.length) {
      setBatchLoadError({ open: true, failed });
    } else {
      setProgressText(`载入选中失败: ${e.response?.data?.detail?.message || e.response?.data?.detail || e.message}`);
    }
  }
}, [selectedLibraryDemoIds, handleLoadDemoFromLibrary, setProgressText]);
```

- [ ] **Step 5: 在 JSX 渲染区加入弹框**

在现有 `<LibraryLoadModeModal` 组件（约第 2493 行）下方插入：

```jsx
<BatchLoadErrorModal
  open={batchLoadError.open}
  failed={batchLoadError.failed}
  onClose={() => setBatchLoadError({ open: false, failed: [] })}
/>
```

- [ ] **Step 6: Commit**

```
git add frontend/src/App.jsx
git commit -m "feat: use batch-summary for library demo loading, add error modal"
```

---

## Task 4：端到端验证

- [ ] **Step 1: 启动前后端**

```
# Terminal 1
cd backend && uvicorn app.main:app --port 8000

# Terminal 2
cd frontend && npm run dev
```

- [ ] **Step 2: 正常路径验证**

1. 打开 `http://localhost:5173`，进入 Demo 库
2. 勾选 4 个 Demo，点击「载入选中」
3. 打开 Chrome DevTools → Network → Fetch/XHR
4. Expected: 只出现 **1 个** `batch-summary` 请求（200），不再有 4 个 `/demos/{id}` + 4 个 `/players` 请求
5. Expected: 正常进入解析/分析页面

- [ ] **Step 3: 失败路径验证**

通过 DB 工具或直接修改文件路径，确保其中一个 demo 的文件不存在，然后重复载入操作。

Expected：
- `batch-summary` 返回 400
- 页面弹出「部分 Demo 加载失败」Modal，列出失败的文件名和原因
- 不跳转到分析页面
- 点击「重新选择」Modal 关闭，勾选状态保留

- [ ] **Step 4: 单 Demo 路径兼容性验证**

通过其他入口（如单文件拖拽上传）加载一个 Demo，确认该路径仍走 `GET /demos/{id}/players`，功能正常。

- [ ] **Step 5: 最终 Commit**

```
git add -A
git commit -m "feat: batch-summary end-to-end verified"
```

---

## 自查

**Spec 覆盖：**
- [x] `POST /api/demos/batch-summary` 接口 → Task 1
- [x] `asyncio.Semaphore(5)` 并发限制 → Task 1
- [x] 失败返回 400 含 `failed` 列表 → Task 1
- [x] 失败弹框含 filename + reason → Task 2
- [x] `handleLoadSelectedLibraryDemos` 改为批量 → Task 3
- [x] `handleLoadDemoFromLibrary` 跳过已有 players → Task 3
- [x] 单 demo 路径不受影响 → Task 3（item.players != null 检查兼容）
- [x] 端到端验证 → Task 4

**关键类型一致性：**
- `failed` 字段：后端 `list[dict]` 含 `id/filename/reason`，前端 `Array<{id, filename, reason}>`，Modal props 一致
- `data.items`：后端返回 `{"items": [...]}`, 前端 `data.items` 解构一致
