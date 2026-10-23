import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 个人本地项目，不追求包体积；ECharts 会让主包超过默认的 500 kB 提示线
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
