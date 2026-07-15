# SFTP 拖出到 Windows 桌面 — 设计文档

- 日期：2026-07-15
- 状态：已获用户口头批准，待用户复核本文档
- 作者：Claude（受 liannai569 委托，在 nyaterm 下游 fork 上开发）
- 目标分支：`custom`

## 1. 背景与目标

用户从魔改版 Tabby 迁到 nyaterm，认为 nyaterm 的 SFTP 不如自己魔改的 Tabby 好用。经排查，最大差距是：**nyaterm 无法把远程文件/文件夹拖到 Windows 桌面或资源管理器文件夹里**（nyaterm 的文件行不可拖，只支持 OS→远程的上传拖拽）。

本设计实现「远程 → Windows」的拖出功能，达到与魔改 Tabby「按下预取 + 缓存 + 原生拖出」相当的体验（下称 **B 档**）。

**非目标（本期不做）：**
- C 档「虚拟文件流式拖拽」（边下边写、超大文件/文件夹直接流进落点目录、系统复制进度）——需自写原生 Rust/Win32 OLE 插件，留作后续拔高。
- 拖入落点目录后自动放置（Windows 不向源程序回报落点路径，B 档做不到）。
- 面板内「远程 → 远程」跨文件夹拖拽移动（属另一个「浏览手感」子项目）。
- 本地文件面板 / 双栏（另一个子项目）。

## 2. 术语

- **预取（prefetch）**：在远程文件行上按下鼠标左键的瞬间，静默地把该文件下载到临时目录，以便拖拽时立即可用。
- **拖出（drag-out）**：用户从 nyaterm 拖动文件行，松手落到 Windows 桌面/文件夹，文件被复制过去。
- **会话级缓存**：以 `远程路径|大小|修改时间` 为 key，记录已下载到临时目录的本地路径，命中即秒拖。

## 3. 架构总览

复用 nyaterm 现有的下载命令把远程文件/文件夹下到临时目录，再用第三方插件 `tauri-plugin-drag` 发起 Windows 原生文件拖出。后端改动极小，主要工作在前端编排。

```
远程文件行
  ├─ onMouseDown ── 预取（≤100MB 且未缓存）── download_remote_file → 临时目录 → 存入缓存
  └─ onDragStart ── preventDefault()（取消会被资源管理器拒绝的 HTML5 拖拽）
                    ├─ 已就绪：startDrag({ item:[本地临时路径], icon })
                    └─ 未就绪：先 await 下载（进入传输队列显示进度）→ 再 startDrag
松手落到 Windows 目录 → 系统把临时文件复制过去
```

## 4. 依赖

- Rust：`tauri-plugin-drag`（crate，锁定 Tauri 2 兼容版本）。
- 前端：`@crabnebula/tauri-plugin-drag`（提供 `startDrag`）。
- 说明：该插件是 Electron `webContents.startDrag` 在 Tauri 上的对应物，支持 Windows + Tauri 2。前提是**拖之前文件必须已落盘**，因此需要「下载到临时目录 + 预取 + 缓存」配套。

## 5. 组件与文件改动

### 5.1 前端（均在 `src/components/panel/file-explorer/`）

- **新增 `dragOut.ts`**：拖出逻辑核心（与 UI 解耦，便于单测）。职责：
  - 维护会话级缓存 Map：`key(远程路径|大小|修改时间) → 临时本地路径`。
  - `prefetch(entry)`：满足阈值时静默下载到临时目录并入缓存。
  - `startDragOut(entries)`：确保选中项都已落盘（命中缓存则跳过，否则带进度下载），然后调用 `startDrag`。
  - 临时路径规划：文件放 `<tmp>/nyaterm/dragout/<id>/<文件名>`；文件夹放 `<tmp>/nyaterm/dragout-dir/<id>/<文件夹名>`。
- **`FileListItem.tsx`**：给文件/文件夹行加 `draggable`；接 `onMouseDown`（触发预取）与 `onDragStart`（先 `preventDefault()`，再调 `dragOut.startDragOut`）。要与现有「橡皮筋框选」的鼠标逻辑区分开（按下不立即进入框选，拖到某个方向阈值才判定是「拖出」还是「框选」）。
- **`FileExplorerView.tsx`**：接线——把当前 `session_id`、当前选中集合、缓存实例注入 `dragOut`；会话切换时隔离/清空对应缓存。

### 5.2 后端（`src-tauri/`）

- **`lib.rs`**：注册 `tauri_plugin_drag::init()`。
- **启动清理**：在 Rust 的 `setup` 钩子里执行（应用启动即清理，**无需前端触发**），删除临时拖出目录 `<tmp>/nyaterm/dragout` 与 `dragout-dir`（单一、可预测的清理点；启动时必无正在进行的拖拽，绝不会与进行中的复制抢删）。前端若需临时目录根路径，通过 Tauri 路径 API（`@tauri-apps/api/path` 的 `tempDir`）或一条只读命令获取，二者对齐同一根目录 `<tmp>/nyaterm/`。
- **下载命令复用（无需新增下载命令）**：
  - 文件：`download_remote_file(session_id, remote_path, local_path, transfer_id?)`。
  - 文件夹：`download_remote_directory(session_id, remote_path, local_path, transfer_id?)`。
  - 二者都能下到**任意本地路径**，且 `transfer_id` 可选：传了就进传输队列显示进度，不传则静默（用于预取）。

## 6. 数据流细节

### 6.1 单文件
1. `onMouseDown`：若文件 ≤100MB 且缓存未命中 → 静默 `download_remote_file`（不传 transfer_id）下到临时目录 → 入缓存。>100MB 不自动预取。
2. `onDragStart`：`preventDefault()`；
   - 缓存命中且文件就绪 → 立即 `startDrag({ item:[临时路径] })`；
   - 未就绪（大文件或预取未完成）→ 生成 transfer_id、带进度下载完成后再 `startDrag`。
3. 松手 → 系统从临时路径复制到落点。

### 6.2 文件夹
- 不自动预取（可能很大）。`onDragStart` 时 `download_remote_directory` 下整个目录到临时目录（带进度、进传输队列），完成后 `startDrag({ item:[临时文件夹路径] })`。

### 6.3 多选（纳入第一版）
- 拖动时对选中的每一项分别确保落盘（命中缓存跳过，否则带进度下载），然后一次 `startDrag({ item:[路径1, 路径2, ...] })`。多选**不做逐项预取**（只对当前按下的单行预取）。

## 7. 缓存、临时文件与大文件保护

- **缓存 key** = `远程路径|大小|修改时间`；会话内有效；`size`/`mtime` 变化视为失效并重下。
- **自动预取阈值**：默认 ≤100MB（后续可做成设置项）。超过阈值仅在拖拽时下载并显示进度。
- **临时目录**：`<系统临时目录>/nyaterm/dragout`（文件）与 `dragout-dir`（文件夹）。
- **清理**：仅在**应用启动时**统一清理上述两目录（覆盖上次正常退出/崩溃/强杀的残留）。

## 8. 进度与错误处理

- **进度显示**：复用现有传输队列（`transfer-event` / `TransferContext`）。拖拽时需要的下载传 `transfer_id`，在队列里以 **dragout 类型**标注；预取则静默、不进队列，避免刷屏。
- **下载失败**：toast 报错并取消本次拖拽；不留半截临时文件（失败即清理该项临时文件）。
- **拖拽发起前未落盘**：`onDragStart` 内 await 下载完成再 `startDrag`；期间队列有进度可见。
- **缓存失效**：`size`/`mtime` 变化则忽略旧缓存、重下。

## 9. 已知限制与取舍（B 档固有）

- Windows 不把「拖拽落点目录」回报给源程序，所以无法做到「先拖、下载完自动放进落点目录」——本期是「下载到临时再拖」。要「边下边写进落点」得上 C 档。
- `startDrag` 要求文件已落盘且拖拽期间鼠标左键保持按住。有了预取，小/中文件几乎无感；超大文件若预取未完成且很快松手，可能需要按住等进度走完。
- WebView2 拖拽事件有一些已知坑（如隐藏窗口收不到 DnD 事件）——主窗口正常显示，不受影响。

## 10. 测试计划

- **后端**：
  - `tauri_plugin_drag::init()` 注册冒烟（能编译、能启动）。
  - 启动清理逻辑单测（临时目录存在/不存在都不报错，且不误删其他目录）。
- **前端（单测）**：
  - 缓存 key 生成、命中/失效（改 size 或 mtime 后失效）。
  - 预取阈值判定（≤100MB 预取、>100MB 不预取）。
  - `onDragStart` 编排：mock `startDrag` 与下载命令，验证「命中缓存直接拖」「未就绪先下再拖」「失败取消并 toast」「多选拼接多路径」。
- **手动端到端**：单文件秒拖到桌面；>100MB 文件拖时显示进度；文件夹拖出；多选拖出；重复拖命中缓存即时完成；断网/权限失败给 toast；重启后临时目录被清空。

## 11. 里程碑 / 后续

- 本期（B 档）：单文件 + 文件夹 + 多选拖出，含预取/缓存/大文件保护。
- 后续可选：预取阈值做成设置项；C 档虚拟文件流式拖拽（自写原生插件）；面板内远程→远程拖移；本地/双栏面板。

## 12. 决策记录

- **进度显示** 选「复用现有传输队列（dragout 标注）」而非新建每行进度条：省事、可靠、复用成熟基础设施。
- **多选** 纳入第一版：`startDrag` 接收路径数组，成本小、体验更完整。
- **注释与文档语言**：全部用中文（用户英语不好，需能自行复核）。
