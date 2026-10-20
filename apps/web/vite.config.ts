import { defineConfig } from "vite";
export default defineConfig({
  root: "apps/web",
  build: { outDir: "../../dist/web", emptyOutDir: false },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/auth": "http://127.0.0.1:3000",
    },
  },
});
