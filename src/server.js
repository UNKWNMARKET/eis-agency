import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { Router, requireRole } from './http.js';
import { HttpError } from './validate.js';
import { userFromToken, purgeExpiredSessions, hashPassword } from './auth.js';
import { refreshStatuses } from './domain.js';
import { registerCore } from './routes/core.js';
import { registerPolicies } from './routes/policies.js';
import { registerSales } from './routes/sales.js';
import { registerClaims } from './routes/claims.js';
import { registerBilling } from './routes/billing.js';
import { registerWork } from './routes/work.js';
import { registerReports } from './routes/reports.js';
import { registerAdmin } from './routes/admin.js';
import { DEFAULT_TEMPLATES } from './templates.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MAX_BODY = 15 * 1024 * 1024;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function buildRouter() {
  const r = new Router();
  registerCore(r);
  registerPolicies(r);
  registerSales(r);
  registerClaims(r);
  registerBilling(r);
  registerWork(r);
  registerReports(r);
  registerAdmin(r);
  return r;
}

/** One-time setup of an empty database: admin account, agency settings, starter templates. */
export function bootstrap(db, log = console.log) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const generated = !process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD || randomBytes(12).toString('base64url');
    db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, 'Administrator', 'admin', ?)").run(email, hashPassword(password));
    log('\n  ┌──────────────────────────────────────────────────────────┐');
    log(`  │ First run: admin account created`);
    log(`  │   email:    ${email}`);
    log(`  │   password: ${password}${generated ? '   (generated — change it after signing in)' : ''}`);
    log('  └──────────────────────────────────────────────────────────┘\n');
  }
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  ins.run('agency_name', 'My Insurance Agency');
  ins.run('agency_address', '');
  ins.run('agency_phone', '');
  ins.run('agency_email', '');
  ins.run('agency_license', '');
  if (db.prepare('SELECT COUNT(*) AS n FROM templates').get().n === 0) {
    const t = db.prepare('INSERT INTO templates (name, category, subject, body) VALUES (?,?,?,?)');
    for (const x of DEFAULT_TEMPLATES) t.run(x.name, x.category, x.subject, x.body);
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { rej(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': CSP, ...headers,
  });
  res.end(body);
}

const json = (res, status, obj, headers) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = resolve(join(PUBLIC_DIR, decodeURIComponent(rel)));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return send(res, 403, 'Forbidden');
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    if (extname(rel)) return send(res, 404, 'Not found');
    file = join(PUBLIC_DIR, 'index.html');
  }
  const data = await readFile(file);
  send(res, 200, data, { 'Content-Type': STATIC_TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
}

export function createApp(db, { secureCookies = process.env.AMS_SECURE_COOKIES === '1', log = console.error } = {}) {
  const router = buildRouter();

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
        return await serveStatic(res, url.pathname);
      }

      const { route, params, pathMatched } = router.match(req.method, url.pathname);
      if (!route) return json(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed' : 'Not found' });

      const token = parseCookies(req.headers.cookie).ams_session;
      const ctx = {
        db, req, params, token, status: 200, user: userFromToken(db, token),
        query: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress || 'unknown', body: undefined,
      };

      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating) {
        // CSRF defence in depth on top of SameSite=Strict: browsers cannot send this header cross-site without a CORS preflight.
        if (req.headers['x-requested-with'] !== 'ams') throw new HttpError(403, 'Missing X-Requested-With header');
        const raw = await readBody(req);
        if (raw.length) {
          if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
          try { ctx.body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
        } else ctx.body = {};
      }

      if (!route.public) requireRole(ctx, route.roles);
      const out = await route.handler(ctx);

      const headers = {};
      if (ctx.setCookie) {
        const c = ctx.setCookie;
        headers['Set-Cookie'] = `ams_session=${c.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${c.maxAge}${secureCookies ? '; Secure' : ''}`;
      }
      if (out && out.csv !== undefined) {
        return send(res, 200, '﻿' + out.csv, { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' });
      }
      if (out && out.raw !== undefined) {
        return send(res, 200, out.raw, {
          ...headers, 'Content-Type': out.contentType || 'application/octet-stream', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${String(out.filename).replace(/[^\w.\- ]/g, '_')}"`,
        });
      }
      if (out && out.rawHtml !== undefined) {
        return send(res, 200, out.rawHtml, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      return json(res, ctx.status, out ?? { ok: true }, headers);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message, fields: e.fields });
      log(`[error] ${req.method} ${url.pathname}:`, e);
      if (!res.headersSent) return json(res, 500, { error: 'Internal server error' });
      res.end();
    }
  };
}

export function start({ port = Number(process.env.PORT) || 3000, host = process.env.HOST || '127.0.0.1' } = {}) {
  const db = openDb();
  bootstrap(db);
  refreshStatuses(db);
  purgeExpiredSessions(db);
  const timer = setInterval(() => {
    try { refreshStatuses(db); purgeExpiredSessions(db); } catch (e) { console.error('[maintenance]', e); }
  }, 60 * 60 * 1000);
  timer.unref();
  const server = http.createServer(createApp(db));
  server.listen(port, host, () => console.log(`AMS running at http://${host}:${port}`));
  return { server, db };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
