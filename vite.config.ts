import { defineConfig } from "vite";

/**
 * Dev server for `examples/render` — `pnpm demo:render`.
 *
 * The published package does not ship a bundle; this exists so the renderer can
 * be run and looked at. The demo imports `src/` directly rather than `dist/`, so
 * there is no build step between editing the choreographer and seeing it.
 */
export default defineConfig({
  root: "examples/render",
  server: {
    open: true,
    fs: {
      // The demo imports up out of its own directory, into `src/`.
      allow: ["../.."],
    },
  },
});
