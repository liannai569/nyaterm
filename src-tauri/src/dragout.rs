//! 拖出功能的临时文件管理：临时目录规划 + 启动时清理。

use std::path::{Path, PathBuf};

/// 返回拖出临时目录根：`<系统临时目录>/nyaterm`。
pub fn dragout_root() -> PathBuf {
    std::env::temp_dir().join("nyaterm")
}

/// 删除指定根目录下的 `dragout` 与 `dragout-dir` 两个子目录（可测试的核心）。
/// 子目录不存在则忽略；只删这两个特定子目录，绝不触碰其他内容。
pub fn cleanup_in(root: &Path) {
    for sub in ["dragout", "dragout-dir"] {
        let dir = root.join(sub);
        if dir.exists() {
            // 忽略删除错误：清理是尽力而为，失败不应阻断启动。
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

/// 启动时清理拖出残留（对系统临时目录调用可测核心）。
pub fn cleanup_dragout_temp() {
    cleanup_in(&dragout_root());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_removes_only_dragout_dirs() {
        // 用一个隔离的临时根，避免污染真实系统临时目录。
        let base = std::env::temp_dir().join(format!("nyaterm-test-{}", std::process::id()));
        let dragout = base.join("dragout");
        let dragout_dir = base.join("dragout-dir");
        let keep = base.join("keep");
        std::fs::create_dir_all(dragout.join("a")).unwrap();
        std::fs::create_dir_all(dragout_dir.join("b")).unwrap();
        std::fs::create_dir_all(&keep).unwrap();

        cleanup_in(&base); // 直接测目标函数

        assert!(!dragout.exists(), "dragout 应被删除");
        assert!(!dragout_dir.exists(), "dragout-dir 应被删除");
        assert!(keep.exists(), "keep 目录不应被动");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn cleanup_in_is_noop_when_absent() {
        let base = std::env::temp_dir().join(format!("nyaterm-test-none-{}", std::process::id()));
        // 不创建任何子目录，调用不应 panic。
        cleanup_in(&base);
        assert!(!base.join("dragout").exists());
    }

    #[test]
    fn dragout_root_ends_with_nyaterm() {
        assert!(dragout_root().ends_with("nyaterm"));
    }
}
