import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = `localhost:${process.env.UTD_BACKEND_PORT ?? 8000}`;

export default defineConfig({
  plugins: [react()],
  // The details editor is lazy-loaded; pre-bundle its deps at startup so
  // the dev server never discovers them mid-session (which re-optimizes
  // and can load a second React).
  optimizeDeps: {
    include: [
      "@tiptap/react",
      "@tiptap/core",
      "@tiptap/pm/state",
      "@tiptap/starter-kit",
      "@tiptap/markdown",
      "@tiptap/extension-list",
      "@tiptap/extensions",
    ],
  },
  server: {
    proxy: {
      // xfwd: the backend sees the address the browser used (calendar
      // feed links back to cards).
      "/api": { target: `http://${backend}`, xfwd: true },
      "/admin": `http://${backend}`,
      "/static": `http://${backend}`,
      "/ws": { target: `ws://${backend}`, ws: true },
    },
  },
});
