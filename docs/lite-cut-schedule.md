# LiteCut 开发顺序

> **关联文档**：[lite-cut-design.md](./lite-cut-design.md)（边界、模型、API、验收）
> **分支**：`refactor/lite-cut-tool-for-CS2`
> **当前状态**：Phase 1 已完成（导出联调通过）；**Phase 2 进行中**（资产上传 + 预设 UI + V2–V5 叠层导出首版）
> **用法**：按本文 **从上到下** 顺序用 Cursor 实现；上一阶段「完成标准」全勾后再进下一阶段。

---

## 0. 原则（不变）

- **阶段 A**：新菜单 `/lite-cut` + 新 API `/api/lite-cut/*`，**不动** 旧 `/montage`
- **阶段 B**：设计文档 §11 验收通过后，再 **Cutover** 替换旧入口
- 导出联调以 **Windows + FFmpeg** 为准；预览允许近似

---

## 1. 总顺序（五段）

```
Phase 0  地基          → 真素材、真保存
Phase 1  可剪辑 MVP    → 时间轴、预览、首版导出
Phase 2  资产与预设    → 上传、多轨导出、风格预设库
Phase 3  打磨          → 体验、模板、§11 全量验收
Phase 4  Cutover       → 替换 /montage，下线旧代码
```

**依赖关系**：0 → 1 → 2 → 3 → 4，不可跳阶段。Phase 1 内「导出」依赖「时间轴 + schema」；Phase 2「多轨导出」依赖 Phase 1「单主轨导出」。

---

## 2. Phase 0 — 地基

**目标**：mock 接上真实 `recorded_clips` 与项目持久化。

### 2.1 后端（先做）

| 顺序 | 任务 | 说明 |
|:----:|------|------|
| 1 | `backend/app/lite_cut/models.py` | schema v2 Pydantic；`empty_project()` 工厂（5 视频轨 + overlay + A1/A2） |
| 2 | `backend/app/lite_cut/db.py` | `lite_cut_projects` 表；`lite_cut_presets` 表 |
| 3 | `backend/app/lite_cut/api.py` | Router 骨架 |
| 4 | `main.py` 挂载 | `include_router(..., prefix="/api/lite-cut")` |
| 5 | `GET/POST/PATCH/DELETE /api/lite-cut/projects` | 项目 CRUD |
| 6 | `GET /api/recorded-clips/{id}/stream` | HTTP Range；路径校验；供 `<video>` seek |
| 7 | `GET/POST/PATCH/DELETE /api/lite-cut/presets` | 预设 CRUD（apply 可先 501） |
| 8 | preset apply 纯函数 + 单测 | 不接 UI；见 design §6 |

### 2.2 前端（后端 5、6 完成后再做）

| 顺序 | 任务 | 说明 |
|:----:|------|------|
| 9 | `stores/liteCutEditorStore.js`（或拆 `projectStore`） | 项目 id、name、body、dirty |
| 10 | `LiteCutMediaBin` | `GET /api/recorded-clips`，替换 `mockData` |
| 11 | `LiteCutPreviewPanel` | stream URL 播放、seek |
| 12 | `LiteCutToolbar` Save | `POST/PATCH /api/lite-cut/projects` |

### 2.3 完成标准

- [x] API 可创建空 v2 项目并读回
- [x] 浏览器可播一条已入库录制
- [x] 编辑器：选素材 → 预览 → 保存 → 刷新后仍在
- [x] 旧 `/montage` 与 `/api/montage/*` 行为未改

---

## 3. Phase 1 — 可剪辑 MVP

**目标**：`/lite-cut/editor` 完成「排轨 → 预览 → 导出 MP4」主链路。

### 3.1 Store 与时间轴（先做）

| 顺序 | 任务 | 说明 |
|:----:|------|------|
| 1 | 拆分 store | `timelineStore`（tracks/clips/selection/playhead）、`historyStore` |
| 2 | 时间轴数据结构 | 与 backend schema v2 对齐；同轨片段不重叠 |
| 3 | `LiteCutTimelinePanel` 接 store | 从媒体库拖入 V1；移动、删除、选中 |
| 4 | 多轨壳子 | V1–V5 + Overlay(T) + A1/A2 可见（可先仅 V1 可编辑） |
| 5 | trim / 分割 / 复制 / 删除 | 时间轴工具栏 |
| 6 | undo / redo | 命令栈 |
| 7 | `LiteCutPropertyPanel` 接 store | 片段属性、转场枚举（12+）、调色滑条写回 JSON |
| 8 | Save 含时间轴 | 项目 body 含完整 tracks |

### 3.2 预览（依赖 3.1 的 2、3）

| 顺序 | 任务 | 说明 |
|:----:|------|------|
| 9 | `playbackStore` | 播放/暂停、播放头、与时间轴联动 |
| 10 | 整片连续预览 | 跨片段 seek；多轨叠层（近似即可） |
| 11 | 文字/调色 CSS 预览 | 与导出子集对齐；UI 提示「预览近似，导出为准」 |
| 12 | 预览性能兜底 | 必要时单路解码或降质 |

### 3.3 导出 v2 首版（依赖 3.1 的 2、7）

| 顺序 | 任务 | 说明 |
|:----:|------|------|
| 13 | `compose_lite_cut_montage()` | **先**：V1 主轨 + trim + xfade + eq（`video_composer.py` 新入口，不改 v1） |
| 14 | `POST /api/lite-cut/export` | 收 v2 body；写导出历史 |
| 15 | `LiteCutExportMockPage` 接 API | 复用 FFmpeg 门控 |
| 16 | 联调 | 3 段 clip + 转场 + 调色 → 可播 MP4 |

### 3.4 完成标准

- [x] V1 主轨 + V2 叠层可拖入编辑（V3–V5 / Overlay 只读壳）
- [x] 分割 / 复制 / 删除 / undo·redo 可用（trim 手柄 Phase 3）
- [x] 整片连续预览（跨片段 stream 切换 + 播放头联动）
- [x] `POST /api/lite-cut/export` + 属性面板导出 UI 已接
- [x] Windows + FFmpeg 联调：3 段 clip + 转场 + 调色 → 可播 MP4
- [x] 保存再打开，时间轴完整恢复（tracks 写入 body_json）

---

## 3.5 Phase 1 实现备注（2026-06-12）

| 区域 | 路径 |
|------|------|
| timeline / history | `frontend/src/stores/liteCut/{timelineStore,historyStore,timelineUtils}.js` |
| 预览 | `playbackUtils.js` + `LiteCutPreviewPanel` sequenceMode |
| 导出 | `backend/app/lite_cut/composer.py` + `exportUtils.js` + 属性面板 Export 页 |

## 4. Phase 2 — 资产与预设

**目标**：补齐 v1 Must：上传、5 轨导出、风格预设库。

### 4.1 顺序

| 顺序 | 任务 | 说明 |
|:----:|------|------|
| 1 | `POST /api/lite-cut/assets/upload` | 字体、WebM、PNG、GIF — **已接** |
| 2 | 媒体库「叠加素材」Tab | 持久化列表 + 拖落 V2–V5 — **已接** |
| 3 | composer 扩展 | 多轨 overlay、透明 WebM — **V2–V5 文件叠层首版** |
| 4 | 5 视频轨导出 | 叠层顺序与预览一致 — **首版（居中 overlay）** |
| 5 | 预设 UI「我的配置」 | save / list / delete / apply — **已接** |
| 6 | `POST /api/lite-cut/presets/{id}/apply` | 接 Phase 0 纯函数 — **已接** |
| 7 | 预设最小闭环 | `color_grade`、`transition_rhythm` — **已接** |
| 8 | 导出进度 | SSE 或轮询 + 可选取消 — 未做 |

### 4.2 完成标准

- [x] 上传 PNG/WebM 进库且可拖到 V2–V5 时间轴
- [x] 预设 save → apply → V1 调色/转场一致
- [x] V2–V5 文件叠层导出（居中 overlay，按 timeline_start）
- [ ] 透明 WebM / drawtext 文字导出与预览一致
- [ ] 设计文档 §11 第 1–8 条 **大部分** 可手动走通

---

## 5. Phase 3 — 打磨

**目标**：§11 全量验收；Should 项按优先级做。

### 5.1 建议顺序（P1 先于 P2）

| 顺序 | 优先级 | 任务 |
|:----:|:------:|------|
| 1 | P1 | 时间轴缩略图条 |
| 2 | P1 | 键盘快捷键（分割、删除、播放、保存） |
| 3 | P1 | 模板 M1：1–2 个内置 manifest + 画廊 + `from-template` |
| 4 | P1 | §11 验收清单逐项勾；修 P0 bug |
| 5 | P2 | BGM 波形（可简化） |
| 6 | P2 | CS2 tick 刻度 overlay（只读） |
| 7 | P2 | 预设 import/export zip |
| 8 | P2 | 用户另存为模板 |

### 5.2 完成标准

- [ ] 设计文档 §11 八条 **全部** 通过
- [ ] Windows 上至少 3 次真实录制素材端到端导出成功
- [ ] 无阻塞性 P0 问题

---

## 6. Phase 4 — Cutover

**前置**：Phase 3 完成标准全满足。

| 顺序 | 任务 |
|:----:|------|
| 1 | `SidebarNav`：「合集工作台」→ LiteCut；去掉或隐藏独立「LiteCut」试验菜单 |
| 2 | `/montage` → redirect 到 LiteCut（路由二选一定稿） |
| 3 | `/api/montage/projects`、`/api/montage/export` → 410 或只读 |
| 4 | 删除或归档 `MontageWorkbenchDrawer` 等旧 UI |
| 5 | 更新 README、`CLAUDE.md`、design §1.3 状态为「已切换」 |
| 6 | 可选：v1 项目只读打开或迁移说明（不强制迁草稿） |

---

## 7. 依赖简图

```
recorded_clips (已有)
       │
       ▼
stream + projects CRUD ──► MediaBin / Preview / Save
       │
       ▼
timeline store + UI ──► trim / undo / PropertyPanel
       │
       ├──► 整片预览
       │
       └──► compose_lite_cut_montage (先主轨，后多轨)
                 │
                 ▼
            assets upload + presets apply
                 │
                 ▼
            §11 验收 → Cutover
```

---

## 8. 明确后置（做完前面再做）

| 任务 | 为何后置 |
|------|----------|
| 删 `MontageWorkbenchDrawer` | Phase 4 |
| 改 `/api/montage/export` 收 v2 | 永不；走 `/api/lite-cut/export` |
| 模板 M2/M3、预设 zip | Phase 3 P2 |
| 缩略图 / 波形 / 快捷键 | Phase 3；不挡 MVP |
| v1→v2 自动迁移 | Cutover 可选，非 Must |

---

## 9. Cursor 会话入口

**Phase 2 核心进行中**；下一会话可补 **导出进度 SSE**、**文字 overlay 导出**，或进入 **Phase 3**。

---

## 10. 文档维护

| 事件 | 更新 |
|------|------|
| 某 Phase 完成标准全勾 | design 文档顶部「状态」 |
| 范围变更 | 先改 design §2，再改本文顺序 |
| Cutover 完成 | 本文 §1 标注「已完成」 |

---

*最后更新：2026-06-12*
