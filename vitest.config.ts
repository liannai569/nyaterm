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
