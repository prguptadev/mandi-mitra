import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@server": path.resolve(import.meta.dirname, "./server"),
    },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    // a second copy against a test API: MANDI_API_PORT=8798 VITE_PORT=5174 npx vite
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.MANDI_API_PORT ?? 8787}`, changeOrigin: true } },
  },
});
