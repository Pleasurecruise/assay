import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    proxy: {
      "/.well-known": "http://127.0.0.1:3001",
      "/a2a": "http://127.0.0.1:3001",
      "/capabilities": "http://127.0.0.1:3001",
      "/healthz": "http://127.0.0.1:3001",
      "/readyz": "http://127.0.0.1:3001",
    },
  },
});
