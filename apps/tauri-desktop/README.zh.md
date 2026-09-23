# DeepSeek Harness Tauri 桌面应用

[English](README.md) | 中文

Tauri 桌面应用是围绕完整 dsh Web 应用的 Rust 壳。它在捆绑的运行时 Node 下启动共享的 [Desktop Host](../desktop-host/README.zh.md)，并在 Host 报告就绪后加载其已认证的 Web 应用。它取代了已删除的 Electron 壳；迁移决策见 wayfinder 地图（issue #4）。

## 架构

```
┌────────────────────────── Tauri shell (Rust) ──────────────────────────┐
│  control loop               main window (created on ready frame)       │
│      │  stdin NDJSON              │ WebviewUrl::External(ready.url)    │
│      ▼  ◄── stdout NDJSON ──      ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Desktop Host (Node, spawned from runtime/bin)                   │  │  │
│  │  dsh profile + Web application, authenticated HTTP on 19387      │  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

- **窗口。** 启动时不存在任何窗口。首个 `ready` 帧携带已认证 URL，壳据此创建主窗口并直接加载（`WebviewUrl::External`）；由 Host 服务全部资产与启动注入，因此不存在自定义协议或代理。Token 鉴权与浏览器会话一样落入 WebView2 的 cookie jar。
- **进程遏制。** Windows 上 Host 子进程加入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，孤儿 Host 树随壳一起消亡；spawn 使用 `CREATE_NO_WINDOW`。Unix 上壳直接投递终止信号。
- **Stderr。** 独立读线程在有限尾部保留最后 64 KiB 的 Host stderr 用于失败诊断，与 Electron 壳一致；不会转发到 Web 文档。
- **控制台。** Release 构建设置 `windows_subsystem = "windows"`；debug 构建保留控制台，并支持共享的 `DSH_DESKTOP_HOST_INSPECT_PORT` inspector 覆盖。

## 控制协议

stdin 与 stdout 每行携带一个 JSON 对象（LF 结尾 UTF-8，无长度前缀）。Host 日志只走 stderr，因此 stdout 除本协议外不承载任何内容。Electron 壳以 Node IPC 表达同样的事件（`apps/desktop/src/host-process.ts`）；消息形状共享。

壳 → Host：

|帧|含义|
|---|---|
|`{"type":"shutdown"}`|开始收尾；Host 完成 `shutdown.shutdown(0)` 后退出。|
|`{"type":"update-tasks","requestId":N,"action":"inspect"\|"lock"\|"unlock"}`|读取在执行工作或为更新交接设门；Host 按 `requestId` 应答。|

Host → 壳：

|帧|含义|
|---|---|
|`{"type":"ready","url":"…"}`|已认证 Web 应用开始服务；只发送一次。|
|`{"type":"fatal","message":"…","diagnostic"?}`|Host 选定的失败报告；`diagnostic` 为完整检视错误（如有）。|
|`{"type":"shutdown-complete"}`|Host 已确认 `shutdown` 请求并完成收尾。|
|`{"type":"platform-session","session":…}`|嵌入式平台凭据状态；本壳无平台视图，忽略之。|
|`{"type":"update-tasks","requestId":N,"active":bool,"error"?}`|对匹配请求的应答。|

stdout 上的任何其它字节序列——非法 JSON、未知帧、或未以换行结尾的行——都是协议违规，将转化为壳的致命错误。壳强制单帧 1 MiB 上限。

### 关闭升级

请求停止会发送 `shutdown`，然后等待 10 s。未退出则终止进程（Unix 为 SIGTERM，Windows 为 TerminateProcess——Windows 进程没有更强的请求级别），再等 5 s，然后强杀并再等 5 s。退出前收到 `shutdown-complete` 帧确认优雅停止；干净指选择了确认且退出码为 0 且未经强制步骤。对在 Windows 上熬过每一步的 Host，Job Object 是最后的兜底。

### 更新任务查询

`desktop_update_tasks` Tauri 命令发送 action 并以 10 s 截止等待关联应答；超时与无应答的请求以更新交接错误失败，且只接受 `inspect`/`lock`/`unlock` 三个名字。壳从不自行授权安装；它只记录在执行任务是否会受影响，与 Electron 壳的 update coordinator 契约一致。

## 开发

```sh
pnpm --dir apps/tauri-desktop run dev
pnpm --dir apps/tauri-desktop run start        # skip the workspace build
```

`scripts/dev.ts` 构建工作区，然后 `scripts/dev-runtime.ts` 在 `.tauri-build/development/` 下准备一次性资源：

- `dsh/` — 运行时项目，其 `node_modules` 链接构建出的 CLI（`@deepseek-ai/dsh`）、Desktop Host 及其 `workspace:` 依赖，带 hoisted-linker pnpm workspace 文件，使 Host 入口 `node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` 可解析。
- `runtime/bin/node` — 启动器自己的 Node 可执行文件，即壳启动的进程。
- `runtime/pnpm` + `runtime/primary-runtime/office-skills` — 桌面 Office 插件所需的包管理器入口与 Office 技能资产。
- `home/` — 开发用 Harness home；其 `profiles/desktop` profile 以共享 Web bundle 模板初始化，之后不再覆写。

启动器随后构建壳（`cargo build`），以指向准备好的树的 `DSH_TAURI_RESOURCES` 与 `DSH_HOME` 启动它。Debug 构建（`cfg(debug_assertions)`）读取这些覆盖；打包构建解析可执行文件旁的 `resources/`，尊重用户真实的 `DSH_HOME`，并以 Electron 壳从 `process.resourcesPath` 推导 node、pnpm 与 primary-runtime 路径的同样方式推导。

Host 日志到达控制台（stderr）；应用排障遵循与 Web 应用相同的实践。

## 打包

```sh
pnpm run build:desktop
```

`scripts/build.ts` 校验发布版本在根与应用 manifest、Cargo crate、`tauri.conf.json` 四处完全一致，执行工作区构建（`pnpm run build`），在 `.tauri-build/packaging/resources/` 下组装打包资源，并以 NSIS 目标运行 `tauri build`：

- `resources/dsh/` — 运行时项目，其 `node_modules` 解析 Host 入口。CLI 与 Desktop Host 运行时依赖闭包中的每个 workspace 包都以真实、解析过链接的目录复制——开发用 junction，打包绝不能携带指回构建机的 reparse point。外部依赖放置在其服务对象的公共上级一次；同一名点被两个版本占用的依赖则嵌套在使用方包内。
- `resources/runtime/bin/node(.exe)` — 构建机的 Node 可执行文件，即壳启动的进程。
- `resources/runtime/pnpm/` — 工作区固定版本的 pnpm 包，提供 `bin/pnpm.mjs`。
- `resources/runtime/primary-runtime/office-skills/` — 桌面 Office 插件所需的 Office 技能资产。

`tauri.conf.json` 以 `bundle.resources` 把该树映射到可执行文件旁的 `resources/` 目录，正是打包构建中 `main.rs` 解析 node、pnpm 入口与 primary runtime 的位置。

## 签名

签名挂在 Tauri 的自定义签名命令上：`bundle.windows.signCommand` 指向 `scripts/windows-sign.mjs`。未设置 `DSH_WINDOWS_SIGN` 时，该命令让所有产物保持未签并在构建日志中说明，因此本地构建以未签状态成功。设置 `DSH_WINDOWS_SIGN` 后，命令通过 `signtool` 签名并随后打时间戳（RFC 3161，SHA-256），遵循 SafeNet eToken 契约：

|变量|含义|
|---|---|
|`DSH_WINDOWS_SIGN`|存在（非空）即启用签名。|
|`DSH_WINDOWS_SIGNTOOL`|兼容 SafeNet 的 signtool 可执行文件。|
|`DSH_WINDOWS_CER_FILE`|公开的代码签名证书文件。|
|`DSH_WINDOWS_KEY_CONTAINER`|SafeNet 私钥容器名。|
|`DSH_WINDOWS_TOKEN_PIN`|SafeNet token 密码；绝不传给 signtool 以外的进程或打印。|

Tauri 打包器把壳二进制、NSIS 插件 DLL、安装包以及（安装时经 `!uninstfinalize`）卸载器全部路由到这一条命令；签名失败即中止构建。

## 安装器迁移

`src-tauri/installer/hooks.nsh` 挂接 NSIS `PREINSTALL` 阶段：当已退役的 Electron 桌面版仍存在于 `%LOCALAPPDATA%\Programs\DeepSeek Harness` 时，安装器同步运行其 `Uninstall.exe /S`，清理残留入口，并把结果记录到安装目录下的 `installer-logs/migrate-electron.log`。迁移失败只记日志、绝不阻塞新安装；Harness home 不受影响。

## 布局

```
package.json        workspace package, scripts for dev, build, and cargo checks
scripts/
  build.ts          production build: workspace build, resource assembly, tauri build
  dev.ts            development launcher: build, prepare, launch
  dev-runtime.ts    development resources and profile preparation
  windows-sign.mjs  Tauri custom sign command (signtool, gated by DSH_WINDOWS_SIGN)
tests/
  installer-hooks.spec.ts    NSIS hook compilation against makensis
  windows-sign.spec.ts       sign command argv contract against a fixture signtool
src-tauri/
  Cargo.toml        shell crate (tauri 2, serde_json, windows-sys/libc)
  build.rs          tauri-build context
  tauri.conf.json   identifier/productName/version; NSIS target, resources map, sign command
  installer/
    hooks.nsh       NSIS installer hooks (retired Electron Desktop migration)
  icons/icon.ico    placeholder Windows resource icon
  src/
    main.rs         entry, configuration resolution, control loop, window
    host.rs         Host spawn, argv shape, NDJSON channel, escalation
    frames.rs       NDJSON frame parsing (unit-tested)
    stderr.rs       bounded stderr tail (unit-tested)
    platform.rs     Job Object containment and kill escalation
shell-dist/         static placeholder the window configuration requires
```

`tauri.conf.json` 不携带更新器配置；更新器遵循独立的更新器票。签名经文档化的 `DSH_WINDOWS_*` 环境复用 dsh 发布身份。
