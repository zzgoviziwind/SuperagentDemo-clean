import { createServer } from "vite";

const server = await createServer({
  server: {
    host: "127.0.0.1",
    port: 5177,
    strictPort: true,
    open: false,
    proxy: {
      "/api": { target: "http://127.0.0.1:8877", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:8877", changeOrigin: false },
    },
  },
});

await server.listen();
server.printUrls();
