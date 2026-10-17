import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // The emulator worker is an ES module (it imports the wasm-bindgen glue).
  worker: { format: "es" },
  server: {
    // Rooms API and WebSockets come from `wrangler dev` (apps/server) in development.
    proxy: { "/api": { target: "http://localhost:8787", ws: true } },
  },
});
