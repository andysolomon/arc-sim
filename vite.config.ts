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
  /*
   * `pnpm build:demo` — the same demo as a static site, which is all it needs
   * to be: the engine does no I/O, so a game is simulated in the visitor's
   * browser and there is nothing to deploy behind it.
   *
   * Out of the tree rather than into `examples/render/dist`, so the demo's
   * build never sits inside the sources it is built from, and named apart
   * from `dist/` so it cannot be mistaken for the published package.
   */
  build: {
    outDir: "../../dist-demo",
    emptyOutDir: true,
  },
  server: {
    open: true,
    fs: {
      // The demo imports up out of its own directory, into `src/`.
      allow: ["../.."],
    },
  },
});
