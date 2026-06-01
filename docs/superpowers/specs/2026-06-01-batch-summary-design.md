# batch-summary Demo 批量加载 Design

## Goal

将 Demo 库"载入选中"从 8 个串行请求（4x `GET /demos/{id}` + 4x `GET /demos/{id}/players`）优化为 1 个批量请求，并发数上限 5，任一失败弹框提示后留在库页面。

## Backend

### 新增路由 `POST /api/demos/batch-summary`

位置：`backend/app/main.py`，放在现有 `/api/demos/batch-resolve-players` 附近。

**Request body**
```json
{ "ids": [8268, 8270, 11449, 11692] }
```
约束：`ids` 非空，最大 100 条（防滥用）。

**成功 Response 200**
```json
{
  "items": [
    {
      "id": 8268,
      "filename": "match_de_dust2.dem",
      "display_name": "周赛 dust2",
      "path": "C:/demos/match_de_dust2.dem",
      "players": [ { "name": "...", "kills": 18, ... } ],
      "match_meta": { "map_name": "de_dust2", "total_rounds": 24, ... },
      "result": { ... },        // 原 cached_result，字段名与 GET /demos/{id} 一致
      "status": "parsed",
      ...                        // GET /demos/{id} 返回的所有其余字段
    }
  ]
}
```

**失败 Response 400**
```json
{
  "detail": "部分 Demo 加载失败",
  "failed": [
    { "id": 11449, "filename": "broken.dem", "reason": "Demo 文件不存在" }
  ]
}
```

### 并发实现

```python
sem = asyncio.Semaphore(5)

async def fetch_one(demo_id):
    row = await demo_db.get_demo_list_item(demo_id)
    if not row:
        raise ValueError(f"Demo not found: {demo_id}")
    async with sem:
        players = await asyncio.to_thread(get_player_list_isolated, row["path"])
    return { **row, "players": players, "match_meta": { ... } }

results = await asyncio.gather(*[fetch_one(i) for i in body.ids], return_exceptions=True)
```

- `asyncio.gather` 并发发起全部任务，Semaphore 保证同时最多 5 个进入 `to_thread`
- 完成后检查结果列表，有 Exception → 收集失败信息 → 返回 400
- `filename` 优先取 `display_name`，fallback `filename`，用于前端弹框

### Pydantic 模型

```python
class BatchSummaryBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=100)
```

## Frontend

### `handleLoadSelectedLibraryDemos`（App.jsx:742）

**改前**：`Promise.all(ids.map(id => GET /demos/{id}))` → `handleLoadDemoFromLibrary(items)`

**改后**：
```js
const { data } = await API.post('/demos/batch-summary', { ids });
await handleLoadDemoFromLibrary(data.items);
```

失败时（axios 抛出 4xx）：
```js
const failed = e.response?.data?.failed || [];
setBatchLoadErrorModal({ open: true, failed });
// 不跳转，不清空 selectedLibraryDemoIds
```

### `handleLoadDemoFromLibrary`（App.jsx:585）

在 `list.map` 内部，跳过已有数据的 `/players` 请求：

```js
const playersResult = item.players != null
  ? { players: item.players, match_meta: item.match_meta }
  : (await API.get(`/demos/${item.id}/players`)).data;
```

这保留了单 demo 上传路径的兼容性（`item.players` 为 null 时仍走原逻辑）。

### 失败弹框

新状态：`batchLoadErrorModal: { open: bool, failed: [{id, filename, reason}] }`

弹框内容：
- 标题：「部分 Demo 加载失败」
- 列表：每行 `{filename}：{reason}`
- 按钮：「重新选择」→ 关闭弹框，停留库页面

可复用现有 Modal 组件，无需新增组件。

## Error Cases

| 情形 | 处理 |
|------|------|
| demo_id 在 DB 中不存在 | failed 列表，400 |
| demo 文件路径不存在 | `get_player_list_isolated` 抛异常，captured → failed 列表，400 |
| demoparser2 Rust panic | 子进程超时/崩溃，captured → failed 列表，400 |
| ids 超过 100 | Pydantic 校验 → 422 |
| ids 为空 | Pydantic 校验 → 422 |

## What Does NOT Change

- `GET /api/demos/{id}/players` 保留，单 demo 上传路径继续使用
- `GET /api/demos/{id}` 保留
- 其余 `handleLoadDemoFromLibrary` 调用路径（单 demo 拖拽上传等）行为不变
