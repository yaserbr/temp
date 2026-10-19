// Minimal zero-dependency static file server for the QA Lite frontend.
// Usage: node scripts/serve.mjs [directory=web] [port=5173]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "web");
const port = Number(process.env.PORT ?? process.argv[3] ?? 5173);

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
};

const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        let filePath = normalize(join(root, pathname));

        if (filePath !== root && !filePath.startsWith(root + sep)) {
            response.writeHead(403).end("Forbidden");
            return;
        }

        if ((await stat(filePath).catch(() => null))?.isDirectory()) {
            filePath = join(filePath, "index.html");
        }

        const body = await readFile(filePath);
        response.writeHead(200, {
            "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
            "Cache-Control": "no-cache"
        });
        response.end(body);
    } catch (error) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    }
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use - QA Lite may already be running at http://localhost:${port}/login.html`);
        console.error(`Stop the other process, or use another port: PORT=5174 npm run dev`);
        process.exit(1);
    }
    throw error;
});

server.listen(port, () => {
    console.log(`QA Lite (frontend-only demo) serving ${root}`);
    console.log(`  -> http://localhost:${port}/login.html`);
});
