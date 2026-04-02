// Lightweight health probe for distroless containers (no curl available).
// Runs as the HEALTHCHECK CMD: /nodejs/bin/node /app/healthcheck.js
// Exits 0 when /health returns HTTP 200, exits 1 on any error or non-200 response.
//
// CommonJS (not ESM) — this file is copied to /app/healthcheck.js in the
// container where the repo root package.json (no "type":"module") applies.
'use strict';
const http = require('http');

const req = http.request(
  { host: '127.0.0.1', port: 3000, path: '/health', method: 'GET' },
  (res) => {
    process.exitCode = res.statusCode === 200 ? 0 : 1;
    res.resume(); // drain response so socket closes cleanly
  }
);

req.on('error', () => { process.exitCode = 1; });
req.setTimeout(4000, () => { req.destroy(); process.exitCode = 1; });
req.end();
