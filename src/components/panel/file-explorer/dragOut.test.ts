import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DragItem, DragOutController, makeCacheKey, shouldPrefetch } from "./dragOut";

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
    expect(deps.downloadFile).toHaveBeenCalledWith("/home/u/a.txt", "C:/tmp/nyaterm/dragout/a.txt");
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
