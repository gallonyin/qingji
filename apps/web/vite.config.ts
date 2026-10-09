import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "lucide-react"],
          editor: ["codemirror", "@codemirror/lang-markdown", "@codemirror/state", "@codemirror/view"],
          markdown: ["react-markdown", "remark-gfm"],
          storage: ["dexie", "dexie-react-hooks"]
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    clearMocks: true
  }
});
