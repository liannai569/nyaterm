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
