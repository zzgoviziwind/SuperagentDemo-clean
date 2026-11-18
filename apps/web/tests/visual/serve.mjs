import { createServer } from "vite";

const api = `http://127.0.0.1:${Number(process.env.SUPERAGENT_VISUAL_API_PORT ?? 8877)}`;
const server = await createServer({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.SUPERAGENT_VISUAL_WEB_PORT ?? 5177),
    strictPort: true,
    open: false,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/health": { target: api, changeOrigin: false },
    },
  },
});

await server.listen();
server.printUrls();
