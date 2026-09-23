# Issue 跟踪器：GitHub

[English](issue-tracker.md) | 中文

本仓库的 issue 与 PRD 以 GitHub issue 记录。所有操作使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`；多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，评论经 `jq` 过滤，同时取 labels。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` 与 `--state` 过滤。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **打/移标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

在 clone 内运行时 `gh` 会自动从 `git remote -v` 推断仓库。

## Pull request 作为 triage 入口

**PR 作为请求入口：否。** _（本仓库不把外部 PR 视为特性请求；`/triage` 读取此开关。）_

设为 `yes` 时，PR 走与 issue 相同的标签与状态，使用 `gh pr` 等价命令：

- **读取 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE`（剔除 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共享编号空间，裸 `#42` 可能是二者之一——先用 `gh pr view 42` 再回退 `gh issue view 42`。

## 当技能说“发布到 issue 跟踪器”

创建 GitHub issue。

## 当技能说“获取相关工单”

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图**是单个 issue，**子** issue 为工单。

- **地图**：一个打了 `wayfinder:map` 标签的 issue，承载 Notes / Decisions-so-far / Fog 正文。`gh issue create --label wayfinder:map`。
- **子工单**：作为 GitHub sub-issue 挂到地图（`gh api` 的 sub-issues 端点）。sub-issues 不可用时，把子工单加进地图正文的任务列表，并在子工单正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后工单分配给驱动开发的开发者。
- **阻塞**：GitHub **原生 issue 依赖**——权威且在 UI 可见的表达。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，`<blocker-db-id>` 是阻塞者的数字 **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number` 或 `node_id`）。GitHub 上报 `issue_dependencies_summary.blocked_by`（仅开放阻塞者——活跃闸门）。依赖不可用时回退到子工单正文顶部的 `Blocked by: #<n>, #<n>` 行。每个阻塞者都关闭即视为解除阻塞。
- **前沿查询**：列出地图的开放子工单（`gh issue list --state open`，限定地图的 sub-issues / 任务列表），剔除有开放阻塞者（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中有开放 issue）或有 assignee 的；地图顺序第一者胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`——本会话的第一次写。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再往地图的 Decisions-so-far 追加上下文指针（gist + 链接）。
