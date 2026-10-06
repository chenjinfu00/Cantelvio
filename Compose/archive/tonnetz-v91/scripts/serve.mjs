import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"], [".webmanifest", "application/manifest+json"],
  [".json", "application/json; charset=utf-8"], [".ogg", "audio/ogg"],
  [".mid", "audio/midi"], [".wav", "audio/wav"], [".woff2", "font/woff2"]
]);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    const relative = normalize(pathname.replace(/^\/+/, ""));
    if (relative.startsWith("..")) throw new Error("invalid path");
    let file = join(root, relative || "index.html");
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    const headers = {
      "Content-Type": types.get(extname(file)) || "application/octet-stream",
      "Cache-Control": "no-store, max-age=0",
      "Accept-Ranges": "bytes"
    };
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = match?.[1] ? Number(match[1]) : 0;
      let end = match?.[2] ? Number(match[2]) : body.length - 1;
      if (match && !match[1] && match[2]) {
        start = Math.max(0, body.length - Number(match[2]));
        end = body.length - 1;
      }
      if (!match || (!match[1] && !match[2]) || start >= body.length || start > end || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        response.writeHead(416, { ...headers, "Content-Range": `bytes */${body.length}`, "Content-Length": 0 });
        response.end();
        return;
      }
      end = Math.min(end, body.length - 1);
      response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${body.length}`, "Content-Length": end - start + 1 });
      response.end(request.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    } else {
      response.writeHead(200, { ...headers, "Content-Length": body.length });
      response.end(request.method === "HEAD" ? undefined : body);
    }
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Tonnetz Karaoke: http://127.0.0.1:${port}/`);
});
