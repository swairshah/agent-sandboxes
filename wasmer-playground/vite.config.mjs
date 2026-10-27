import { defineConfig } from "vite";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

function wispProxy() {
  return {
    name: "local-wisp-proxy",
    configureServer(server) {
      server.httpServer?.on("upgrade", (request, socket, head) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (pathname === "/wisp/") {
          wisp.routeRequest(request, socket, head);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [wispProxy()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
