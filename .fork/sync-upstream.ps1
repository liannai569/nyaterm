<#
.SYNOPSIS
    把你的 fork 与上游 nyakang/nyaterm 同步。

.DESCRIPTION
    分支约定：
      - main   : 上游的干净镜像，只跟随 upstream/main，不要在上面直接改代码。
      - custom : 你自己的改动分支（本工具、以及你的定制都在这里）。

    本脚本流程：
      1. 检查工作区是否干净（有未提交改动会中止）。
      2. git fetch upstream。
      3. 把本地 main 快进到 upstream/main。
      4. 把更新后的 main 推到 origin（你的 fork）。
      5. 可选：把 custom 分支 rebase 到最新的 main 上。

.PARAMETER RebaseWork
    同步完 main 后，顺便把 custom 分支 rebase 到最新 main。

.PARAMETER NoPush
    只更新本地 main，不推送到 origin。

.EXAMPLE
    ./.fork/sync-upstream.ps1
    ./.fork/sync-upstream.ps1 -RebaseWork
#>
param(
    [string]$MainBranch = "main",
    [string]$WorkBranch = "custom",
    [switch]$RebaseWork,
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"

# 切到仓库根目录（本脚本位于 <repo>/.fork/ 下）
Set-Location -Path (Join-Path $PSScriptRoot "..")

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# 1) 工作区必须干净
if (git status --porcelain) {
    git status --short
    Fail "`n工作区有未提交改动，请先 commit 或 git stash 后再同步。"
}

$current = (git rev-parse --abbrev-ref HEAD).Trim()

# 2) 拉取上游
Write-Host "==> git fetch upstream ..." -ForegroundColor Cyan
git fetch upstream --prune
if ($LASTEXITCODE -ne 0) { Fail "拉取 upstream 失败，检查 upstream 远程是否配置正确（git remote -v）。" }

# 3) main 快进到 upstream/main
Write-Host "==> 更新 $MainBranch -> upstream/$MainBranch ..." -ForegroundColor Cyan
git checkout $MainBranch
git merge --ff-only "upstream/$MainBranch"
if ($LASTEXITCODE -ne 0) {
    Write-Host "$MainBranch 无法 fast-forward，说明它已偏离上游（可能有人在 main 上直接提交过）。" -ForegroundColor Yellow
    Write-Host "若确认 main 仅作镜像，可手动执行：git reset --hard upstream/$MainBranch" -ForegroundColor Yellow
    Fail "已中止，未做破坏性操作。"
}

# 4) 推送 main 到你的 fork
if (-not $NoPush) {
    Write-Host "==> git push origin $MainBranch ..." -ForegroundColor Cyan
    git push origin $MainBranch
    if ($LASTEXITCODE -ne 0) { Write-Host "推送 main 到 origin 失败（不影响本地已更新）。" -ForegroundColor Yellow }
}

# 5) 可选：rebase 你的工作分支
if ($RebaseWork) {
    if (git branch --list $WorkBranch) {
        Write-Host "==> 将 $WorkBranch rebase 到最新 $MainBranch ..." -ForegroundColor Cyan
        git checkout $WorkBranch
        git rebase $MainBranch
        if ($LASTEXITCODE -ne 0) {
            Write-Host "rebase 出现冲突：手动解决后执行 git rebase --continue。" -ForegroundColor Yellow
            Write-Host "完成后如需更新远程：git push --force-with-lease origin $WorkBranch" -ForegroundColor Yellow
            exit 1
        }
        Write-Host "rebase 完成。如需更新远程：git push --force-with-lease origin $WorkBranch" -ForegroundColor Yellow
    } else {
        Write-Host "未找到 $WorkBranch 分支，跳过 rebase。" -ForegroundColor Yellow
    }
} else {
    # 回到原来的分支
    if ($current -and $current -ne $MainBranch) { git checkout $current }
}

Write-Host "`n同步完成 ✅" -ForegroundColor Green
