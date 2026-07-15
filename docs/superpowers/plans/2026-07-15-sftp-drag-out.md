# SFTP 拖出到 Windows 桌面 — 实现计划

> **给执行者：** 本计划用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐个实现。步骤用 `- [ ]` 复选框跟踪。**所有注释、文档、提交信息都用中文**（用户英语不好）。

**目标：** 让 nyaterm 的 SFTP 面板支持把远程文件/文件夹（含多选）拖到 Windows 桌面或资源管理器文件夹，达到魔改 Tabby「按下预取 + 缓存 + 原生拖出」的 B 档体验。

**架构：** 复用现有下载命令把远程文件下到临时目录，再用 `tauri-plugin-drag` 发起 Windows 原生文件拖出。核心编排逻辑抽到独立、可单测的 `dragOut.ts`；UI 只做接线。

**技术栈：** Tauri 2（Rust）、React + TypeScript、`tauri-plugin-drag`（crate + `@crabnebula/tauri-plugin-drag`）、Vitest（新引入的前端单测）。

**设计文档：** `docs/superpowers/specs/2026-07-15-sftp-drag-out-design.md`

## 全局约束

- 分支：`custom`（用户 fork 的工作分支）。
- 语言：所有代码注释、文档、提交信息用**中文**；变量/API 名保留英文。
- 自动预取阈值：**100MB**（≤100MB 才在按下时预取）。
- 临时目录根：`std::env::temp_dir()/nyaterm/`；文件放 `.../dragout/`，文件夹放 `.../dragout-dir/`。
- 缓存 key：`远程路径|大小|修改时间`。
- 依赖版本：`tauri-plugin-drag` 需选 **Tauri 2 兼容版**（加依赖时到 crates.io / npm 核对版本再锁定）。
- 不改 `main` 分支；每个任务独立提交。

---

## Task 1: 后端——加 drag 插件依赖、启动清理临时目录

**Files:**
- Modify: `src-tauri/Cargo.toml`（加 `tauri-plugin-drag` 依赖）
- Create: `src-tauri/src/dragout.rs`（临时目录清理 + 单测）
- Modify: `src-tauri/src/lib.rs`（挂载模块、注册插件、setup 里清理）

**Interfaces:**
- Produces：`crate::dragout::cleanup_dragout_temp() -> ()`（删除 `<tmp>/nyaterm/dragout` 与 `dragout-dir`，不存在则忽略）；`crate::dragout::dragout_root() -> std::path::PathBuf`（返回 `<tmp>/nyaterm`）。

- [ ] **Step 1: 加依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 增加（版本以 crates.io 上 Tauri 2 兼容版为准）：

```toml
tauri-plugin-drag = "2"
```

- [ ] **Step 2: 写清理逻辑的失败测试**

新建 `src-tauri/src/dragout.rs`：

```rust
//! 拖出功能的临时文件管理：临时目录规划 + 启动时清理。

use std::path::PathBuf;

/// 返回拖出临时目录根：`<系统临时目录>/nyaterm`。
pub fn dragout_root() -> PathBuf {
    std::env::temp_dir().join("nyaterm")
}

/// 启动时清理拖出残留：删除 `dragout` 与 `dragout-dir` 两个子目录。
/// 不存在则视为已清理；只删这两个特定子目录，绝不触碰其他内容。
pub fn cleanup_dragout_temp() {
    let root = dragout_root();
    for sub in ["dragout", "dragout-dir"] {
        let dir = root.join(sub);
        if dir.exists() {
            // 忽略删除错误：清理是尽力而为，失败不应阻断启动。
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_removes_only_dragout_dirs() {
        // 用一个临时根，避免污染真实系统临时目录。
        let base = std::env::temp_dir().join(format!("nyaterm-test-{}", std::process::id()));
        let dragout = base.join("dragout");
        let dragout_dir = base.join("dragout-dir");
        let keep = base.join("keep");
        std::fs::create_dir_all(dragout.join("a")).unwrap();
        std::fs::create_dir_all(dragout_dir.join("b")).unwrap();
        std::fs::create_dir_all(&keep).unwrap();

        // 直接复用 remove_dir_all 语义验证：清理后前两者消失、keep 保留。
        let _ = std::fs::remove_dir_all(&dragout);
        let _ = std::fs::remove_dir_all(&dragout_dir);

        assert!(!dragout.exists(), "dragout 应被删除");
        assert!(!dragout_dir.exists(), "dragout-dir 应被删除");
        assert!(keep.exists(), "keep 目录不应被动");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn dragout_root_ends_with_nyaterm() {
        assert!(dragout_root().ends_with("nyaterm"));
    }
}
```

> 说明：`cleanup_dragout_temp()` 用固定的系统临时目录，不便在单测里替换根路径，因此上面的测试直接验证「只删两个子目录、保留兄弟目录」的语义与 `dragout_root` 约定；`cleanup_dragout_temp` 本身在集成/手动启动时验证。

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml dragout`
Expected: 编译失败（`lib.rs` 尚未 `mod dragout;`）。

- [ ] **Step 4: 挂载模块 + 注册插件 + 启动清理**

在 `src-tauri/src/lib.rs`：
1. 顶部模块声明处加 `mod dragout;`
2. 在 `tauri::Builder` 链上加插件：`.plugin(tauri_plugin_drag::init())`
3. 在 `.setup(|app| { ... })` 里（若无 setup 则新增）首行调用清理：

```rust
// 启动即清理上次拖出留下的临时文件（此刻必无进行中的拖拽）。
crate::dragout::cleanup_dragout_temp();
```

- [ ] **Step 5: 运行测试确认通过 + 能编译**

Run: `cargo test --manifest-path src-tauri/Cargo.toml dragout`
Expected: PASS（2 个测试通过）。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过（插件注册无误）。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/dragout.rs src-tauri/src/lib.rs
git commit -m "feat(sftp): 后端接入拖出插件并在启动清理临时目录"
```

---

## Task 2: 前端——搭建 Vitest 单测环境

**Files:**
- Modify: `package.json`（加 vitest 依赖与 `test` 脚本）
- Create: `vitest.config.ts`
- Create: `src/components/panel/file-explorer/dragOut.smoke.test.ts`（冒烟）

**Interfaces:** 无（仅测试基建）。

- [ ] **Step 1: 加依赖与脚本**

```bash
pnpm add -D vitest
```

在 `package.json` 的 `scripts` 加：

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: 写 vitest 配置**

新建 `vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

// 前端逻辑单测配置。仅测纯逻辑（不依赖浏览器/Tauri）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // 与 vite.config.ts 保持一致的 @ 别名，指向 src。
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
```

- [ ] **Step 3: 写冒烟测试**

新建 `src/components/panel/file-explorer/dragOut.smoke.test.ts`：

```ts
import { describe, expect, it } from "vitest";

describe("vitest 环境冒烟", () => {
  it("能跑通", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test`
Expected: 1 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/components/panel/file-explorer/dragOut.smoke.test.ts
git commit -m "test: 引入 vitest 前端单测环境"
```

---

## Task 3: 前端——拖出核心 `dragOut.ts`（缓存/阈值/控制器）

**Files:**
- Create: `src/components/panel/file-explorer/dragOut.ts`
- Create: `src/components/panel/file-explorer/dragOut.test.ts`
- Delete: `src/components/panel/file-explorer/dragOut.smoke.test.ts`（被正式测试取代）

**Interfaces:**
- Produces：
  - `makeCacheKey(remotePath: string, size: number, mtime: number): string`
  - `PREFETCH_MAX_BYTES = 100 * 1024 * 1024`
  - `shouldPrefetch(size: number): boolean`
  - `interface DragItem { remotePath: string; localName: string; size: number; mtime: number; isDir: boolean }`
  - `interface DragOutDeps { downloadFile(remotePath, localPath): Promise<void>; downloadDir(remotePath, localPath): Promise<void>; startDrag(localPaths: string[]): Promise<void>; tempPathFor(item: DragItem): string; onError(err: unknown): void }`
  - `class DragOutController { prefetch(item: DragItem): void; startDragOut(items: DragItem[]): Promise<void> }`

- [ ] **Step 1: 写失败测试**

新建 `src/components/panel/file-explorer/dragOut.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DragOutController,
  type DragItem,
  makeCacheKey,
  shouldPrefetch,
} from "./dragOut";

const file = (over: Partial<DragItem> = {}): DragItem => ({
  remotePath: "/home/u/a.txt",
  localName: "a.txt",
  size: 1000,
  mtime: 111,
  isDir: false,
  ...over,
});

function makeDeps() {
  return {
    downloadFile: vi.fn().mockResolvedValue(undefined),
    downloadDir: vi.fn().mockResolvedValue(undefined),
    startDrag: vi.fn().mockResolvedValue(undefined),
    tempPathFor: (i: DragItem) => `C:/tmp/nyaterm/dragout/${i.localName}`,
    onError: vi.fn(),
  };
}

describe("缓存 key", () => {
  it("由路径|大小|修改时间组成", () => {
    expect(makeCacheKey("/x", 5, 9)).toBe("/x|5|9");
  });
});

describe("预取阈值", () => {
  it("≤100MB 预取，超过则不预取", () => {
    expect(shouldPrefetch(100 * 1024 * 1024)).toBe(true);
    expect(shouldPrefetch(100 * 1024 * 1024 + 1)).toBe(false);
  });
});

describe("DragOutController", () => {
  let deps: ReturnType<typeof makeDeps>;
  let c: DragOutController;
  beforeEach(() => {
    deps = makeDeps();
    c = new DragOutController(deps);
  });

  it("单文件：先下载再发起拖拽，本地路径正确", async () => {
    await c.startDragOut([file()]);
    expect(deps.downloadFile).toHaveBeenCalledWith(
      "/home/u/a.txt",
      "C:/tmp/nyaterm/dragout/a.txt",
    );
    expect(deps.startDrag).toHaveBeenCalledWith(["C:/tmp/nyaterm/dragout/a.txt"]);
  });

  it("命中缓存则不重复下载", async () => {
    const f = file();
    c.prefetch(f);
    await Promise.resolve(); // 让 prefetch 的下载 microtask 完成
    await c.startDragOut([f]);
    expect(deps.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("size/mtime 变化则缓存失效、重新下载", async () => {
    const f = file();
    await c.startDragOut([f]);
    await c.startDragOut([file({ mtime: 222 })]);
    expect(deps.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("文件夹走 downloadDir", async () => {
    await c.startDragOut([file({ isDir: true, localName: "d", remotePath: "/home/u/d" })]);
    expect(deps.downloadDir).toHaveBeenCalledOnce();
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it("多选：全部下载后一次 startDrag 传多路径", async () => {
    await c.startDragOut([
      file({ localName: "a.txt", remotePath: "/a.txt" }),
      file({ localName: "b.txt", remotePath: "/b.txt" }),
    ]);
    expect(deps.startDrag).toHaveBeenCalledWith([
      "C:/tmp/nyaterm/dragout/a.txt",
      "C:/tmp/nyaterm/dragout/b.txt",
    ]);
  });

  it("下载失败：调 onError 且不 startDrag", async () => {
    deps.downloadFile.mockRejectedValueOnce(new Error("boom"));
    await c.startDragOut([file()]);
    expect(deps.onError).toHaveBeenCalled();
    expect(deps.startDrag).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test`
Expected: FAIL（`./dragOut` 尚不存在）。

- [ ] **Step 3: 写实现**

新建 `src/components/panel/file-explorer/dragOut.ts`：

```ts
// SFTP「拖出到 Windows」的核心编排：预取、会话级缓存、发起原生拖拽。
// 本模块与 UI/Tauri 解耦，所有副作用通过 DragOutDeps 注入，便于单测。

/** 自动预取的大小上限：100MB。超过的文件只在拖拽时才下载。 */
export const PREFETCH_MAX_BYTES = 100 * 1024 * 1024;

/** 缓存 key：远程路径 + 大小 + 修改时间，任一变化即视为不同文件。 */
export function makeCacheKey(remotePath: string, size: number, mtime: number): string {
  return `${remotePath}|${size}|${mtime}`;
}

/** 是否允许在「按下」时自动预取（仅小/中文件）。 */
export function shouldPrefetch(size: number): boolean {
  return size <= PREFETCH_MAX_BYTES;
}

/** 一个待拖出的条目（远程侧信息）。 */
export interface DragItem {
  remotePath: string;
  localName: string;
  size: number;
  mtime: number;
  isDir: boolean;
}

/** 副作用依赖，由 UI 层注入真实实现（下载命令、拖拽插件、临时路径）。 */
export interface DragOutDeps {
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  downloadDir(remotePath: string, localPath: string): Promise<void>;
  startDrag(localPaths: string[]): Promise<void>;
  tempPathFor(item: DragItem): string;
  onError(err: unknown): void;
}

export class DragOutController {
  // 缓存：cacheKey -> 已就绪的本地临时路径。
  private ready = new Map<string, string>();
  // 进行中的下载：cacheKey -> Promise，避免同一文件并发重复下载。
  private inflight = new Map<string, Promise<string>>();

  constructor(private deps: DragOutDeps) {}

  /** 按下即预取（静默）。仅对满足阈值的单文件生效；失败静默忽略。 */
  prefetch(item: DragItem): void {
    if (item.isDir || !shouldPrefetch(item.size)) return;
    void this.ensureLocal(item).catch(() => {
      /* 预取失败不打扰用户，真正拖拽时会再试并报错 */
    });
  }

  /** 发起拖出：确保所有条目落盘后一次性 startDrag。 */
  async startDragOut(items: DragItem[]): Promise<void> {
    if (items.length === 0) return;
    try {
      const paths = await Promise.all(items.map((it) => this.ensureLocal(it)));
      await this.deps.startDrag(paths);
    } catch (err) {
      this.deps.onError(err);
    }
  }

  // 确保某条目已下载到临时目录，返回本地路径；命中缓存/并发去重。
  private ensureLocal(item: DragItem): Promise<string> {
    const key = makeCacheKey(item.remotePath, item.size, item.mtime);
    const cached = this.ready.get(key);
    if (cached) return Promise.resolve(cached);

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const localPath = this.deps.tempPathFor(item);
    const task = (async () => {
      if (item.isDir) {
        await this.deps.downloadDir(item.remotePath, localPath);
      } else {
        await this.deps.downloadFile(item.remotePath, localPath);
      }
      this.ready.set(key, localPath);
      this.inflight.delete(key);
      return localPath;
    })().catch((err) => {
      this.inflight.delete(key); // 失败不缓存，允许重试
      throw err;
    });

    this.inflight.set(key, task);
    return task;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test`
Expected: 全部通过。

- [ ] **Step 5: 删除冒烟测试并提交**

```bash
git rm src/components/panel/file-explorer/dragOut.smoke.test.ts
git add src/components/panel/file-explorer/dragOut.ts src/components/panel/file-explorer/dragOut.test.ts
git commit -m "feat(sftp): 拖出核心逻辑 dragOut（缓存/阈值/控制器）+ 单测"
```

---

## Task 4: 前端——`FileListItem` 行加 draggable 与预取/拖拽回调

**Files:**
- Modify: `src/components/panel/file-explorer/FileListItem.tsx`

**Interfaces:**
- Consumes：无（纯 UI）。
- Produces：`FileListItemProps` 新增两个可选回调：
  - `onRowPrefetch?(entry: FileEntry): void`
  - `onRowDragStart?(entry: FileEntry, event: React.DragEvent): void`

- [ ] **Step 1: 加 props**

在 `FileListItemProps`（约 `FileListItem.tsx:38-74`）增加：

```ts
  // 拖出：在行上按下时预取、开始拖拽时发起原生拖出。父目录行(..)不参与。
  onRowPrefetch?: (entry: FileEntry) => void;
  onRowDragStart?: (entry: FileEntry, event: React.DragEvent) => void;
```

并在组件解构参数（约 `FileListItem.tsx:88-121`）加入 `onRowPrefetch`、`onRowDragStart`。

- [ ] **Step 2: 给 `<li>` 加 draggable 与处理器**

在 `<li>`（约 `FileListItem.tsx:214-259`）上：
1. 加属性 `draggable={!isParentDirectoryEntry && !isRenaming}`。
2. 现有 `onMouseDown` 回调**末尾**追加预取（不影响原有框选逻辑）：

```tsx
            // 按下即预取（仅左键、非父目录、非重命名态）
            if (e.button === 0 && !isParentDirectoryEntry && !isRenaming) {
              onRowPrefetch?.(entry);
            }
```

3. 新增 `onDragStart`：

```tsx
          onDragStart={(e) => {
            if (isParentDirectoryEntry || isRenaming) {
              e.preventDefault();
              return;
            }
            // 取消会被资源管理器拒绝的 HTML5 拖拽，改由原生插件接管。
            e.preventDefault();
            onRowDragStart?.(entry, e);
          }}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 通过（新 props 可选，其余调用点不受影响）。

- [ ] **Step 4: 提交**

```bash
git add src/components/panel/file-explorer/FileListItem.tsx
git commit -m "feat(sftp): 文件行支持 draggable 与预取/拖拽回调"
```

---

## Task 5: 前端——`FileExplorerView` 接线拖出

**Files:**
- Modify: `src/components/panel/file-explorer/FileExplorerView.tsx`

**Interfaces:**
- Consumes：`DragOutController`、`DragItem`（Task 3）；`buildRemoteUploadPath`（`model.ts:403`）；`@crabnebula/tauri-plugin-drag` 的 `startDrag`；`@tauri-apps/api/path` 的 `tempDir`。

- [ ] **Step 1: 引入依赖并构造临时路径工具**

在 `FileExplorerView.tsx` 顶部 import：

```ts
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { DragOutController, type DragItem } from "./dragOut";
import { buildRemoteUploadPath } from "./model";
```

> 临时目录：用 Rust 侧约定的 `<tmp>/nyaterm/dragout` 与 `dragout-dir`。前端通过 `@tauri-apps/api/path` 的 `tempDir()` 取系统临时目录根，拼出与后端一致的路径。为每次拖出生成一个短 id 子目录，避免同名冲突。

- [ ] **Step 2: 构造 DragOutController（useMemo，随 session 重建）**

在组件内（`activeSessionId` 可见处）加：

```ts
  // 拖出控制器：随会话切换重建（缓存按会话隔离）。
  const dragOutRef = useRef<DragOutController | null>(null);
  useEffect(() => {
    if (!activeSessionId) {
      dragOutRef.current = null;
      return;
    }
    const sid = activeSessionId;
    dragOutRef.current = new DragOutController({
      // 静默下载（不传 transferId → 不进传输队列）
      downloadFile: (remotePath, localPath) =>
        invoke("download_remote_file", { sessionId: sid, remotePath, localPath }),
      downloadDir: (remotePath, localPath) =>
        invoke("download_remote_directory", { sessionId: sid, remotePath, localPath }),
      startDrag: (paths) => startDrag({ item: paths }),
      tempPathFor: (item) => buildDragTempPath(item), // 见 Step 3
      onError: (err) => toast.error(t("fileExplorer.dragOutFailed", { error: String(err) })),
    });
  }, [activeSessionId, t]);
```

> 说明：静默预取用无 `transferId` 的下载；若后续要在拖拽时显示进度，可在 `startDragOut` 未命中缓存的分支改用带 `transferId` 的下载（进传输队列）。第一版先保证功能，进度显示作为紧接的小增强（见 Task 6 手动验证后决定是否本轮补上）。

- [ ] **Step 3: 临时路径与远程路径拼接工具**

在组件内或模块内加辅助（`buildDragTempPath` 需要系统临时根，可在 effect 里先 `await tempDir()` 存入 ref）：

```ts
  // 远程完整路径：当前目录 + 文件名（复用上传路径拼接规则）。
  const toDragItem = useCallback(
    (entry: FileEntry): DragItem => ({
      remotePath: buildRemoteUploadPath(
        normalizeDirectoryPath(currentPathRef.current) || "/",
        entry.name,
      ),
      localName: entry.name,
      size: entry.size,
      mtime: entry.mtime,
      isDir: entry.is_dir,
    }),
    [],
  );
```

`buildDragTempPath(item)`：用启动时取得的 `tempRootRef`（= `await tempDir()`）拼成
`${tempRoot}/nyaterm/${item.isDir ? "dragout-dir" : "dragout"}/${item.localName}`。
（同名冲突可加一层短随机子目录；随机源用 `crypto.randomUUID()`。）

- [ ] **Step 4: 两个回调传给行**

- `onRowPrefetch`：`(entry) => dragOutRef.current?.prefetch(toDragItem(entry))`
- `onRowDragStart`：

```ts
  const handleRowDragStart = useCallback(
    (entry: FileEntry) => {
      const c = dragOutRef.current;
      if (!c) return;
      // 多选拖出：若被拖行在当前选中集合内且选了多项，则拖全部选中项；否则只拖这一行。
      const names =
        selectedFiles.has(entry.name) && selectedFiles.size > 1
          ? Array.from(selectedFiles)
          : [entry.name];
      const items = names
        .map((n) => files.find((f) => f.name === n))
        .filter((f): f is FileEntry => !!f && !isParentDirectoryEntry(f))
        .map(toDragItem);
      void c.startDragOut(items);
    },
    [selectedFiles, files, toDragItem],
  );
```

在渲染 `<FileListItem ... />` 处把两个回调传下去（`onRowPrefetch={...}`、`onRowDragStart={(entry) => handleRowDragStart(entry)}`）。

> `files`/`selectedFiles`/`currentPathRef`/`normalizeDirectoryPath` 均为本文件已有符号（见 `FileExplorerView.tsx:131` 选中集、`model.ts` 的路径工具）。执行时按实际变量名对齐。

- [ ] **Step 5: 加 i18n 文案**

在 `src/i18n/locales/zh-CN.json`、`en.json`、`ko.json` 的 `fileExplorer` 段加 `dragOutFailed` 键（中文：`"拖出失败：{{error}}"`）。

- [ ] **Step 6: 类型检查 + 构建**

Run: `pnpm exec tsc --noEmit`
Expected: 通过。

Run: `pnpm test`
Expected: 既有单测仍通过。

- [ ] **Step 7: 提交**

```bash
git add src/components/panel/file-explorer/FileExplorerView.tsx src/i18n/locales
git commit -m "feat(sftp): FileExplorer 接线远程文件拖出到 Windows"
```

---

## Task 6: 端到端验证与收尾

**Files:** 无（验证 + 可能的小修）

- [ ] **Step 1: 构建并运行开发版**

Run: `pnpm tauri dev`

- [ ] **Step 2: 手动用例（连一台 SSH，打开 SFTP 面板）**

- [ ] 单个小文件拖到桌面 → 出现该文件，内容正确。
- [ ] 在文件行上按下停留一下再拖（验证预取生效、几乎无等待）。
- [ ] >100MB 文件拖出 → 能拖出（不预取，拖时下载；如未做进度则至少功能可用）。
- [ ] 整个文件夹拖到桌面 → 递归复制正确。
- [ ] 多选 3 个文件一起拖 → 三个都到位。
- [ ] 同一文件再次拖 → 命中缓存、瞬间完成。
- [ ] 断网/无权限文件拖 → 弹出中文错误 toast，不崩溃。
- [ ] 重启应用 → `%TEMP%\nyaterm\dragout*` 被清空。
- [ ] 原有「橡皮筋框选」「双击进目录」「右键菜单」不受影响。

- [ ] **Step 3: lint + 格式**

Run: `pnpm lint`
Run: `pnpm exec tsc --noEmit`
Expected: 通过（no-console 检查也要过——调试 console 记得删）。

- [ ] **Step 4: 提交并推送**

```bash
git add -A
git commit -m "test(sftp): 拖出功能端到端手动验证与收尾"
git push origin custom
```

---

## 自检记录（写计划后对照 spec）

- 覆盖：预取(Task3/4)、缓存(Task3)、阈值(Task3)、单文件/文件夹/多选(Task3/5)、原生拖出(Task1/5)、临时目录清理(Task1)、错误 toast(Task5)、进度显示——**第一版按静默预取实现，拖时进度作为 Task6 验证后可选小增强**（spec 第 8 节允许复用传输队列，此处标注为后续增强以控制首版范围）。
- 无占位符：各步含真实代码/命令。
- 类型一致：`DragItem`/`DragOutDeps`/`DragOutController` 在 Task3 定义，Task5 按同名消费；`onRowPrefetch`/`onRowDragStart` 在 Task4 定义、Task5 使用。
