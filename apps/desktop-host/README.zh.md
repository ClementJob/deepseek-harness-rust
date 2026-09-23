# DeepSeek Harness Desktop Host

[English](README.md) | 中文

Desktop Host 是桌面壳背后的私有 Node 模式子进程。它经 `runProfile` 启动共享的 Desktop profile，在保留端口 `19387` 上服务完整 Web 应用，并经控制通道向壳上报其已认证 URL、账号会话与生命周期。Electron 壳以 Electron Node 模式启动它并走 Node IPC；Tauri 壳在同一 argv 后追加 `--stdio-control`，在 stdin/stdout 上走 LF 分帧的 NDJSON。已删除 Electron 壳的 `apps/desktop/src/host-process.ts` 是本协议的 IPC 侧对应物，`src/shell-control.ts` 拥有两种传输共同接入的共享控制层。

## 控制通道

帧是 JSON 对象。Node IPC 传输经 `process.send` 与 `process.on('message')` 传递。stdio 传输向 stdout 每行写一个 JSON 对象（LF 结尾、UTF-8、无长度前缀），并从 stdin 读取壳命令；stdout 只承载控制帧，所有 Host 诊断都走 stderr。无法解析或被拒绝的 stdio 帧记录到 stderr 并忽略，绝不使 Host 崩溃。stdin 到达文件末尾——壳先死了——执行与 IPC `disconnect` 相同的关闭。

壳 → Host：

| 帧 | 含义 |
| --- | --- |
| `{"type":"shutdown"}` | 停止 profile 树。 |
| `{"type":"update-tasks","requestId":<安全整数>,"action":"inspect"\|"lock"\|"unlock"}` | 为桌面更新检查在执行的 agent 与 job 工作，或为其设门。 |

Host → 壳：

| 帧 | 含义 |
| --- | --- |
| `{"type":"ready","url":"<authenticatedUrl>"}` | Web 应用开始服务；启动后发送一次。stdio 帧省略 `injections`，因为 Tauri 壳直接加载已认证 URL，而 Electron 为其打包资产窗口接收 `injections`。 |
| `{"type":"fatal","message":"...","diagnostic"?: "..."}` | 启动失败；进程随后以退出码 1 退出。 |
| `{"type":"shutdown-complete"}` | profile 树完成了 `shutdown.shutdown(0)`。 |
| `{"type":"platform-session","session":...}` | 当前账号会话；凭据移除时为 `null`。 |
| `{"type":"update-tasks","requestId":N,"active":<布尔>,"error"?: "..."}` | 对匹配请求的应答；失败时报告 `active: true` 加 `error`。 |

`ready` 在启动后发送一次。`shutdown` 命令执行 `shutdown.shutdown(0)`，随后 Host 发送 `shutdown-complete`、释放通道（IPC `disconnect`、stdin 收尾），并在事件循环排空后退出；升级超时由壳自行负责。壳先死时停止流程照常执行但不投递帧，因为通道已不存在。在启动前或关闭开始后到达的 `update-tasks` 命令以 `active: true` 加 `desktop update: Host is unavailable` 应答；请求超时预算由壳负责。

## 开发

`tests/stdio-control.spec.ts` 以真实 stdio 管道对接 `tests/fixtures/stdio-host.ts` 覆盖协议，并以注入通道覆盖共享控制层与两种传输。
