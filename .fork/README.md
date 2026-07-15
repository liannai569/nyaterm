# Fork 工作区说明（nyaterm 下游）

本仓库是 [`nyakang/nyaterm`](https://github.com/nyakang/nyaterm) 的下游 fork，用于在跟随上游更新的同时维护你自己的定制。

## 远程（remotes）

| 名称 | 指向 | 用途 |
| --- | --- | --- |
| `origin` | 你的 fork（你的 GitHub） | 推送你的分支 |
| `upstream` | `nyakang/nyaterm` | 只读，用来拉上游更新 |

查看：`git remote -v`

## 分支约定

| 分支 | 作用 | 规则 |
| --- | --- | --- |
| `main` | 上游的**干净镜像** | 只跟随 `upstream/main`，**不要**在上面直接改代码 |
| `custom` | 你的**工作分支** | 你的所有改动、以及 `.fork/` 工具都在这里 |

保持 `main` 干净，是为了让每次同步上游都能**快进（fast-forward）**、几乎不冲突。

## 日常操作

### 1. 写自己的改动

```powershell
git checkout custom
# ...改代码...
git add -A
git commit -m "你的改动说明"
git push origin custom
```

### 2. 同步上游更新（推荐用脚本）

```powershell
# 只更新 main 镜像并推到你的 fork
./.fork/sync-upstream.ps1

# 更新 main，并把 custom rebase 到最新 main 上
./.fork/sync-upstream.ps1 -RebaseWork
```

脚本做的事：`fetch upstream` → 快进 `main` → 推 `main` 到 `origin` →（可选）`custom` rebase 到 `main`。
如遇 rebase 冲突，按提示解决后 `git rebase --continue`，再 `git push --force-with-lease origin custom`。

### 3. 手动等价命令（不想用脚本时）

```powershell
git fetch upstream --prune
git checkout main
git merge --ff-only upstream/main
git push origin main
git checkout custom
git rebase main            # 把你的改动叠到最新上游之上
```

## 构建 / 运行

前置：Node 18+、pnpm、Rust（本项目已用 `rustup override` 固定为 MSVC 工具链）、WebView2、MSVC C++ 生成工具。

```powershell
pnpm install         # 安装前端依赖
pnpm tauri dev       # 开发版（热重载 + 桌面窗口）
pnpm tauri build     # 打包发布版（.msi/.exe）
```

## 备注

- `.fork/` 目录是本 fork 自带的工具，不属于上游；它只存在于 `custom` 分支，因此不会与上游文件冲突。
- Rust 工具链是用 `rustup override set stable-x86_64-pc-windows-msvc` 针对本目录设置的，不影响你的全局默认（仍是 gnu）。
