// Minimal static server for the Playwright run: serves .dev/ (built by
// `npm run dev:prepare`) with caching off. Kept dependency-free on purpose.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.dev');
const port = Number(process.argv[3] ?? 4173);
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = normalize(join(root, pathname));
    if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
    }
    try {
        const body = await readFile(file);
        res.writeHead(200, {
            'content-type': types[extname(file)] ?? 'application/octet-stream',
            'cache-control': 'no-store',
        });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
}).listen(port, '127.0.0.1');
