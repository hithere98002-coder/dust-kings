// Dust Kings online server.
// Serves the game (index.html next to this file) and relays race data between players in rooms.
// No packages needed: plain Node.js 18+ with a small built-in WebSocket implementation.
// Run locally:  node server.js      then open http://localhost:8080
// On Render:    start command "node server.js" (Render sets PORT for you).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const GAME = path.join(__dirname, 'index.html');
const MAX_ROOM = 8, MAX_ROOMS = 300, MAX_MSG = 64 * 1024;

// ---------------- static files ----------------
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (u === '/' || u === '/index.html') {
    fs.readFile(GAME, (err, buf) => {
      if (err) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset=utf-8><title>Dust Kings server</title><body style="font:16px system-ui;background:#14110d;color:#efe3cb;padding:40px"><h1>Dust Kings server is running</h1><p>Open the game, click <b>Online</b>, and create or join a room. This address relays the races.</p>'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});

// ---------------- minimal WebSocket ----------------
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), frag: [], alive: true, open: true, onmsg: null, onclose: null };
  socket.on('data', d => { c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > MAX_MSG * 4) { close(c); return; } parse(c); });
  socket.on('close', () => done(c)); socket.on('error', () => done(c)); socket.on('end', () => done(c));
  return c;
}
function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; const hi = b.readUInt32BE(2); len = b.readUInt32BE(6); if (hi) { close(c); return; } off = 10; }
    if (len > MAX_MSG) { close(c); return; }
    const mo = off; if (masked) off += 4; if (b.length < off + len) return;
    let p = b.subarray(off, off + len);
    if (masked) { const m = b.subarray(mo, mo + 4), q = Buffer.alloc(len); for (let i = 0; i < len; i++) q[i] = p[i] ^ m[i & 3]; p = q; }
    c.buf = b.subarray(off + len);
    if (op === 8) { close(c); return; }
    if (op === 9) { frame(c, 10, p); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) { c.frag.push(p); if (fin) { const s = Buffer.concat(c.frag).toString('utf8'); c.frag = []; if (c.onmsg) try { c.onmsg(s); } catch (e) { } } }
  }
}
function frame(c, op, data) {
  if (!c.open) return; const n = data.length; let h;
  if (n < 126) { h = Buffer.from([0x80 | op, n]); }
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  try { c.socket.write(Buffer.concat([h, data])); } catch (e) { }
}
const send = (c, o) => frame(c, 1, Buffer.from(JSON.stringify(o)));
function close(c) { if (c.open) { frame(c, 8, Buffer.alloc(0)); try { c.socket.end(); } catch (e) { } } done(c); }
function done(c) { if (!c.open) return; c.open = false; try { c.socket.destroy(); } catch (e) { } if (c.onclose) c.onclose(); }

// ---------------- rooms ----------------
const rooms = new Map(); let nextId = 1;
const LET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function code() { let s; do { s = ''; for (let i = 0; i < 4; i++) s += LET[Math.floor(Math.random() * LET.length)]; } while (rooms.has(s)); return s; }
const clean = (s, n) => String(s || '').replace(/[^\w \-.'!?]/g, '').trim().slice(0, n);
const pub = p => ({ id: p.id, name: p.name, truck: p.truck, host: p.room && p.room.host === p.id, res: p.res || null });
function roster(r) { const list = [...r.players.values()].map(pub); for (const p of r.players.values()) send(p.c, { t: 'players', players: list, race: r.race ? { opts: r.race.opts, at: r.race.at } : null }); }
function bcast(r, o, except) { const s = Buffer.from(JSON.stringify(o)); for (const p of r.players.values()) if (p !== except) frame(p.c, 1, s); }
function leave(p) {
  const r = p.room; if (!r) return; r.players.delete(p.id); p.room = null;
  if (!r.players.size) { rooms.delete(r.code); return; }
  if (r.host === p.id) r.host = r.players.keys().next().value;
  bcast(r, { t: 'left', id: p.id }); roster(r);
}

server.on('upgrade', (req, socket) => {
  if (req.url.split('?')[0] !== '/ws') { socket.destroy(); return; }
  const c = accept(req, socket); if (!c) return;
  const p = { id: nextId++, c, name: 'Driver', truck: null, room: null, n: 0, t0: Date.now() };
  c.onclose = () => leave(p);
  c.onmsg = s => {
    // simple flood guard: about 40 messages a second is plenty
    const now = Date.now(); if (now - p.t0 > 1000) { p.t0 = now; p.n = 0; } if (++p.n > 60) return;
    let m; try { m = JSON.parse(s); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
    const r = p.room;
    switch (m.t) {
      case 'ping': send(c, { t: 'pong', c: m.c, s: Date.now() }); break;
      case 'hello': {
        if (r) leave(p);
        p.name = clean(m.name, 16) || 'Driver'; p.truck = sanitizeTruck(m.truck); p.res = null;
        let want = clean(m.room, 4).toUpperCase(), room = want ? rooms.get(want) : null;
        if (want && !room) { send(c, { t: 'err', msg: 'No room called ' + want + '. Check the code, or create a new room.' }); return; }
        if (!room) { if (rooms.size >= MAX_ROOMS) { send(c, { t: 'err', msg: 'Server is full right now.' }); return; } room = { code: code(), players: new Map(), host: p.id, race: null }; rooms.set(room.code, room); }
        if (room.players.size >= MAX_ROOM) { send(c, { t: 'err', msg: 'That room is full (8 drivers).' }); return; }
        room.players.set(p.id, p); p.room = room;
        send(c, { t: 'welcome', id: p.id, room: room.code, s: Date.now() }); roster(room); break;
      }
      case 'truck': if (r) { p.truck = sanitizeTruck(m.truck); roster(r); } break;
      case 'start': {
        if (!r || r.host !== p.id || !m.opts) return;
        const o = m.opts, opts = { seed: (o.seed | 0) >>> 0, biome: clean(o.biome, 10) || 'mixed', len: Math.max(800, Math.min(14000, o.len | 0)), tod: clean(o.tod, 8) || 'day', diff: Math.max(0, Math.min(1.2, +o.diff || .5)) };
        // a custom course from the host's editor: up to 150 features as [kind, x, size, variant]
        if (Array.isArray(o.feats)) { opts.feats = o.feats.slice(0, 150).filter(f => Array.isArray(f) && typeof f[0] === 'string').map(f => [clean(f[0], 12), Math.max(0, Math.min(14000, +f[1] || 0)), Math.max(.1, Math.min(1.6, +f[2] || .6)), (f[3] | 0) & 1023]); opts.cname = clean(o.cname, 30); opts.w = ['dry', 'wet', 'storm'].includes(o.w) ? o.w : 'dry'; }
        r.race = { opts, at: Date.now() + 6000 }; for (const q of r.players.values()) q.res = null;
        bcast(r, { t: 'race', opts, at: r.race.at }); roster(r); break;
      }
      case 'abort': if (r && r.host === p.id && r.race) { r.race = null; bcast(r, { t: 'abort' }); roster(r); } break;
      case 's': if (r && Array.isArray(m.d) && m.d.length <= 12) bcast(r, { t: 's', id: p.id, d: m.d.map(v => +v || 0) }, p); break;
      case 'fin': if (r && r.race) { p.res = { time: +m.time || 0, dnf: clean(m.dnf, 32) || null, dist: +m.dist || 0 }; bcast(r, { t: 'res', id: p.id, res: p.res }); roster(r); } break;
      case 'chat': if (r) { const txt = clean(m.txt, 80); if (txt) bcast(r, { t: 'chat', id: p.id, name: p.name, txt }); } break;
      case 'leave': leave(p); break;
    }
  };
});
function sanitizeTruck(t) {
  if (!t || typeof t !== 'object') return null;
  try { const s = JSON.stringify(t); if (s.length > 6000) return null; return JSON.parse(s); } catch (e) { return null; }
}
// keep connections alive through proxies, and drop dead ones
setInterval(() => {
  for (const r of rooms.values()) for (const p of r.players.values()) { const c = p.c; if (!c.alive) { close(c); continue; } c.alive = false; frame(c, 9, Buffer.alloc(0)); }
}, 20000);

server.listen(PORT, () => console.log('Dust Kings server on port ' + PORT));
