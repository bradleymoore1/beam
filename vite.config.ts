import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { resolve } from "node:path";

// The app lives at a GitHub Pages subpath (/beam/). The base must be
// absolute: a relative base breaks service-worker scope and registration
// from the send/ and receive/ subpages, which kills offline after "Add to
// Home Screen". One HTTPS load, cached forever — that's the whole trick.
// The pages use %BASE_URL% for the manifest + SW registration, so a repo
// rename needs only this one constant.
//
// The service worker and manifest are plain files in public/ — no workbox.
// (workbox-build 7.4.1 deadlocks on Node 22 under load; a hand-written SW
// is deterministic and does exactly what this app needs: precache the
// shell, cache-first everything else, no network after first load.)
export default defineConfig({
  base: "/beam/",
  plugins: [
    // Self-signed dev cert only — never shipped; the deployed app is real
    // HTTPS via GitHub Pages.
    basicSsl(),
  ],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        send: resolve(__dirname, "send/index.html"),
        receive: resolve(__dirname, "receive/index.html"),
        beacon: resolve(__dirname, "beacon/index.html"),
        print: resolve(__dirname, "print/index.html"),
      },
    },
  },
  server: { host: true },
  preview: { host: true },
});
