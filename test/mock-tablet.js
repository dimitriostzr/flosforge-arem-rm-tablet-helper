'use strict';

// A fake reMarkable USB web interface, implementing only the endpoints the app uses:
//   GET /                              (reachability)
//   GET /documents/                    (top-level listing)
//   GET /documents/{folderID}          (folder listing)
//   GET /download/{ID}/pdf             (PDF; /placeholder on older firmware)
//   GET /download/{ID}/rmdoc           (the notebook as .rmdoc: here a fake zip)
//   GET /thumbnail/{ID}                (a small PNG)
//   GET /log.txt                       (the tablet's log)
//   POST /upload                       (multipart field "file", into the folder listed last)
// Like the real tablet, listings only contain the direct children of one folder.
//
// Run standalone:  npm run mock-tablet   then   npm run start:mock

const http = require('node:http');

function fakePdf(title, version = 1) {
  return Buffer.from(
    `%PDF-1.4\n% ${title} v${version}\n1 0 obj << /Type /Catalog >> endobj\n` +
      `${'%'.padEnd(2000, '~')}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1'
  );
}

/** A stand-in .rmdoc: starts like a zip, as the real thing does. */
function fakeRmdoc(title, version = 1) {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(` ${title} v${version}\n`, 'utf8')]);
}

// A 1x1 PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * docs: [{ ID, VissibleName?, VisibleName?, Type?, Parent?, ModifiedClient?, behavior?, body?, chunkDelayMs? }]
 *   Type defaults to DocumentType; Parent ('' = top level) is a CollectionType's ID.
 * behavior: 'ok' (default) | 'html' | 'error500' | 'drop' (cut the socket mid-body) | 'stall' (hang mid-body)
 * `formats`: download paths accepted (the real tablet's web UI uses 'pdf'; 'rmdoc' gives a fake zip).
 * `thumbnails`: false answers /thumbnail/{ID} with 404, like firmware without it.
 * Set `tablet.busy = true` to answer every request with 408 after `busyDelayMs`, which is
 * what a real tablet's web server did while the tablet was asleep.
 */
function createMockTablet({
  docs = [],
  port = 0,
  host = '127.0.0.1',
  busyDelayMs = 10000,
  formats = ['pdf', 'placeholder', 'rmdoc'],
  thumbnails = true,
} = {}) {
  const sockets = new Set();
  const requests = [];
  const tablet = { busy: false, uploads: [], lastListed: '' };

  const server = http.createServer((req, res) => {
    requests.push(req.url);

    if (tablet.busy) {
      setTimeout(() => res.writeHead(408, { 'Content-Type': 'text/plain' }).end('408 request timeout\r\n'), busyDelayMs);
      return;
    }

    if (req.method === 'POST' && req.url === '/upload') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1];
        const headerEnd = raw.indexOf('\r\n\r\n');
        const name = /filename="([^"]*)"/.exec(raw.subarray(0, headerEnd).toString('utf8'))?.[1];
        if (!boundary || !name || headerEnd < 0) {
          res.writeHead(400).end('Bad upload');
          return;
        }
        const body = raw.subarray(headerEnd + 4, raw.lastIndexOf(Buffer.from(`\r\n--${boundary}--`)));
        const ext = name.split('.').pop().toLowerCase();
        const doc = {
          ID: `up-${tablet.uploads.length + 1}`,
          VissibleName: name,
          Parent: tablet.lastListed,
          ModifiedClient: new Date().toISOString(),
          fileType: ext === 'epub' ? 'epub' : 'pdf',
          body,
        };
        docs.push(doc);
        tablet.uploads.push({ name, parent: tablet.lastListed, size: body.length, type: req.headers['content-type'] });
        res.writeHead(201, { 'Content-Type': 'text/plain' }).end('Upload successful');
      });
      return;
    }

    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>reMarkable mock</html>');
      return;
    }

    if (req.url === '/log.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('mock tablet: xochitl started\nmock tablet: USB web interface on\n');
      return;
    }

    const thumbMatch = /^\/thumbnail\/([^/]+)$/.exec(req.url);
    if (thumbMatch) {
      const doc = docs.find((d) => d.ID === decodeURIComponent(thumbMatch[1]) && d.Type !== 'CollectionType');
      if (!thumbnails || !doc) return void res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(TINY_PNG);
      return;
    }

    const listMatch = /^\/documents\/([^/]*)$/.exec(req.url);
    if (listMatch) {
      const parent = decodeURIComponent(listMatch[1]);
      tablet.lastListed = parent;
      if (parent && !docs.some((d) => d.ID === parent && d.Type === 'CollectionType')) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid folder"}');
        return;
      }
      const listing = docs
        .filter((d) => (d.Parent ?? '') === parent)
        .map(({ behavior, body, rmdoc, chunkDelayMs, ...item }) => ({ Type: 'DocumentType', Parent: parent, ...item }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(listing));
      return;
    }

    const match = /^\/download\/([^/]+)\/([a-z]+)$/.exec(req.url);
    if (match && !formats.includes(match[2])) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"unsupported format"}');
      return;
    }
    const doc = match && docs.find((d) => d.ID === decodeURIComponent(match[1]));
    if (!doc || doc.Type === 'CollectionType') {
      res.writeHead(404).end('Not found');
      return;
    }

    const title = doc.VissibleName ?? doc.VisibleName ?? doc.ID;
    const body = match[2] === 'rmdoc' ? (doc.rmdoc ?? fakeRmdoc(title)) : (doc.body ?? fakePdf(title));
    switch (doc.behavior) {
      case 'html':
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Something went wrong</html>');
        return;
      case 'error500':
        res.writeHead(500).end('Internal error');
        return;
      case 'drop':
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.write(body.subarray(0, 100), () => setTimeout(() => res.socket?.destroy(), 20));
        return;
      case 'stall':
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.write(body.subarray(0, 100)); // ...and never finish
        return;
      default: {
        // Like the real tablet (a Paper Pro): chunked, but *also* a Content-Length header,
        // which is invalid HTTP. Strict clients such as fetch() reject this.
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(body.length),
          'Transfer-Encoding': 'chunked',
        });
        const chunkSize = 512;
        let offset = 0;
        const next = () => {
          if (res.destroyed) return;
          if (offset >= body.length) return res.end();
          res.write(body.subarray(offset, (offset += chunkSize)));
          setTimeout(next, doc.chunkDelayMs ?? 0);
        };
        next();
      }
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return Object.assign(tablet, {
    server,
    docs,
    requests,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return `http://${host}:${server.address().port}`;
    },
    /** Simulates pulling the cable: drops live connections and refuses new ones. */
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  });
}

module.exports = { createMockTablet, fakePdf, fakeRmdoc, TINY_PNG };

if (require.main === module) {
  const docs = [
    { ID: 'f-work', VissibleName: 'Work / Projects', Type: 'CollectionType' },
    { ID: 'f-2026', VissibleName: '2026', Type: 'CollectionType', Parent: 'f-work' },
    { ID: 'aaaa1111-0000-0000-0000-000000000001', VissibleName: 'Meeting notes', ModifiedClient: '2026-10-01T09:00:00Z' },
    { ID: 'aaaa1111-0000-0000-0000-000000000002', VissibleName: 'Ideas: 2026/Q4?', ModifiedClient: '2026-10-02T09:00:00Z', Parent: 'f-work' },
    { ID: 'aaaa1111-0000-0000-0000-000000000003', VisibleName: 'Sketches <draft>', ModifiedClient: '2026-10-03T09:00:00Z', Parent: 'f-2026' },
    { ID: 'aaaa1111-0000-0000-0000-000000000004', VissibleName: 'Meeting notes', ModifiedClient: '2026-10-04T09:00:00Z' },
  ].map((d) => ({ chunkDelayMs: 150, ...d })); // slow enough to watch "Syncing X of Y"

  const tablet = createMockTablet({ docs, port: Number(process.env.PORT) || 8099 });
  tablet.start().then((url) => {
    console.log(`Mock reMarkable listening on ${url}`);
    console.log('Run the app against it with:  npm run start:mock');
    console.log('Press Ctrl+C to "unplug" the tablet.');
  });
}
