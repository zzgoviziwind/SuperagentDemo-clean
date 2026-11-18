const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const config = require("./fixture.json");
if (config.fail) {
  console.error("fixture startup failure");
  process.exit(42);
}

const port = Number(process.env.SUPERAGENT_PORT);
const data = process.env.SUPERAGENT_DATA_DIR;
const web = process.env.SUPERAGENT_WEB_DIST;
if (!data || !web || !port || process.cwd() !== data ||
    process.env.SUPERAGENT_TEST_INHERITED || !process.env.USERPROFILE.startsWith(data)) {
  throw new Error("invalid isolated environment");
}

const stateFile = path.join(data, "fixture-counter.txt");
const readCount = () => fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, "utf8")) : 0;
const sendJson = (response, body) => response
  .writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    sendJson(response, { status: "ok", version: config.version, node: process.version, pid: process.pid });
    return;
  }
  if (request.url === "/fixture-counter" && request.method === "POST") {
    const value = readCount() + 1;
    fs.writeFileSync(stateFile, String(value));
    sendJson(response, { value });
    return;
  }
  const isWorkbenchFile = request.url === "/" ||
    request.url === "/field-timeline.example.json" || /^\/assets\/[a-zA-Z0-9_.-]+$/.test(request.url);
  if (request.method !== "GET" || !isWorkbenchFile) {
    response.writeHead(404).end();
    return;
  }
  const file = path.join(web, request.url === "/" ? "index.html" : request.url.slice(1));
  if (!fs.existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1");
process.once("SIGTERM", () => server.close());
