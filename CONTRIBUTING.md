# 贡献指南

感谢你对 CS2 Insight Agent 的关注。本文说明分支策略与提交流程，对应 [Issue #76](https://github.com/DrEAmSs59/CS2-insight-agent/issues/76)。

## 分支策略

| 分支 | 用途 |
| --- | --- |
| **`main`** | **稳定分支**。与最近一次正式发布对齐；仅通过发布合并或紧急 hotfix 更新。 |
| **`develop`** | **日常开发集成分支**。所有功能与修复先合入此处。 |
| **`V2.x.x`** | **发布维护线**（按需）。从 `main` 在发版时拉出，仅接收该版本的 hotfix；修复需同步回 `main` 与 `develop`。 |
| **`feat/*` `fix/*` `chore/*`** | **工作分支**。从 `develop` 拉出，完成后 PR 回 `develop`。 |

> **说明**：此前「每周新开 `V2.X` 作为开发分支」的做法已停用。新功能与常规修复一律走 `develop`，不再向旧的版本开发分支提交。

## 日常开发

```bash
git fetch origin
git checkout develop
git pull origin develop

git checkout -b feat/your-feature   # 或 fix/ chore/
# … 开发、自测 …
git push -u origin feat/your-feature
```

在 GitHub 上发起 **Pull Request，目标分支选 `develop`**（不要直接 PR 到 `main`）。

### 分支命名建议

| 前缀 | 场景 |
| --- | --- |
| `feat/` | 新功能 |
| `fix/` | Bug 修复 |
| `chore/` | 构建、依赖、文档、重构等 |
| `refactor/` | 较大范围重构（仍建议基于 `develop`） |

### PR 要求

- 标题简明说明改动意图
- 关联相关 Issue（如有）
- 说明测试方式（命令或手动步骤）
- 避免无关格式化或大范围重排
- 录制、CS2 控制、Windows 打包相关改动，请在描述中注明是否在 Windows 上验证

## 发布流程（维护者）

1. 确认 `develop` 达到发版标准（测试、文档、版本号等）
2. 将 `develop` **合并进 `main`**（建议用 PR，保留记录）
3. 在 `main` 上打版本 Tag（如 `v2.3.0`），走 GitHub Release / 打包流水线
4. 若该版本需要长期 hotfix 支持，从 `main` checkout `V2.3.0`（或 `release/2.3`）维护线
5. 发版后确保 `develop` 已包含 `main` 上的合并提交（通常 merge `main` → `develop` 一次即可对齐）

## Hotfix（已发布版本的紧急修复）

```bash
git checkout main && git pull
git checkout -b fix/critical-bug main
# … 修复 …
```

1. PR → **`main`**，合并后发补丁版本 Tag
2. **必须**将同一修复 cherry-pick 或 PR 合回 **`develop`**，避免下个大版本回归
3. 若存在对应 **`V2.x.x`** 维护线，也需合入该分支

## 环境与本地运行

开发环境搭建见 [docs/developer.md](./docs/developer.md)。架构与命令速查见 [CLAUDE.md](./CLAUDE.md)。

- 后端：Python **3.12**，FastAPI
- 前端：Node.js + Vite；`npm run dev` 代理 `/api` 到 `localhost:8000`
- 录制 / OBS / CS2 控制台注入：**仅 Windows** 可完整验证；macOS / Linux 可开发解析、Demo 库、前端等

## 报告问题

- Bug 与功能请求：使用 [GitHub Issues](https://github.com/DrEAmSs59/CS2-insight-agent/issues)
- 先搜索是否已有重复 Issue
- 安全相关问题请通过邮件联系维护者，勿在公开 Issue 中贴密钥或完整配置

## 许可证

贡献即表示你同意在 [PolyForm Noncommercial 1.0.0](./LICENSE) 下授权你的改动。

---

## 维护者一次性迁移（采纳本策略时）

若远程尚无 `develop`，由维护者执行一次：

```bash
git checkout main
git pull origin main
git checkout -b develop
git push -u origin develop
```

建议在 GitHub 仓库设置中将 **默认分支保持为 `main`**（面向用户与 Release），并将 **PR 默认 base** 设为 `develop`（可在首次 PR 时选择，或通过仓库模板提示贡献者）。
