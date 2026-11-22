const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// --- Config ---
const PORT = parseInt(process.env.PORT || '8443', 10);
const UPSTREAM = process.env.UPSTREAM || '8.8.8.8';
const UPSTREAM_PORT = 53;
const PFX_PATH = process.env.PFX_PATH || path.join(__dirname, 'server.pfx');
const PFX_PASS = process.env.PFX_PASS || 'eevee-demo';

// Rewrite/block rules (demo). Edit to fit your needs.
// action: 'nxdomain' | 'zero' (0.0.0.0) | 'ip:<addr>' | 'cname:<name>' (cname limited) | 'passthrough'
const RULES = [
  // Common Spotify ad/tracking domains (DNS-level blocking; limited effect)
  { domain: 'audio-ak-spotify-com.akamaized.net', action: 'zero' },
  { domain: 'audio-akp-quic-spotify-com.akamaized.net', action: 'zero' },
  { domain: 'heads-ak-spotify-com.akamaized.net', action: 'zero' },
  { domain: 'heads-akp-spotify-com.akamaized.net', action: 'zero' },
  // Add more rules here, e.g. { domain: 'spclient.wg.spotify.com', action: 'ip:203.0.113.10' }
];

function normalizeName(name) {
  return name.toLowerCase().replace(/\.$/, '');
}

function matchRule(qname) {
  const n = normalizeName(qname);
  for (const r of RULES) {
    const d = normalizeName(r.domain);
    if (n === d || n.endsWith('.' + d)) return r;
  }
  return null;
}

function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let jumpOffset = -1;
  let pos = offset;
  for (let i = 0; i < 128; i++) {
    if (pos >= buf.length) throw new Error('name oob');
    const len = buf[pos];
    if (len === 0) { pos += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('ptr oob');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) jumpOffset = pos + 2;
      pos = ptr;
      jumped = true;
      continue;
    }
    pos += 1;
    if (pos + len > buf.length) throw new Error('label oob');
    labels.push(buf.slice(pos, pos + len).toString('ascii'));
    pos += len;
  }
  return { name: labels.join('.'), next: jumped ? jumpOffset : pos };
}

function writeName(name) {
  const out = [];
  const n = normalizeName(name);
  if (n.length) {
    for (const label of n.split('.')) {
      const b = Buffer.from(label, 'ascii');
      out.push(Buffer.from([b.length]));
      out.push(b);
    }
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function parseQuestion(msg) {
  if (msg.length < 12) throw new Error('short');
  const qdcount = msg.readUInt16BE(4);
  if (qdcount < 1) throw new Error('no question');
  const { name, next } = readName(msg, 12);
  if (next + 4 > msg.length) throw new Error('q oob');
  const qtype = msg.readUInt16BE(next);
  const qclass = msg.readUInt16BE(next + 2);
  return { id: msg.readUInt16BE(0), name, qtype, qclass, qend: next + 4 };
}

function buildResponse(query, rcode, answers) {
  const q = parseQuestion(query);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  // QR=1, AA=1, RD copied, RA=1
  const rd = (query[2] & 0x01);
  header.writeUInt16BE(0x8400 | rd | (rcode & 0x0f), 2);
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const question = query.slice(12, q.qend);
  return Buffer.concat([header, question, ...answers]);
}

function rrA(name, ip, ttl = 60) {
  const n = writeName(name);
  const rdata = Buffer.from(ip.split('.').map(x => parseInt(x, 10)));
  const tail = Buffer.alloc(10);
  tail.writeUInt16BE(1, 0); // A
  tail.writeUInt16BE(1, 2); // IN
  tail.writeUInt32BE(ttl, 4);
  tail.writeUInt16BE(4, 8);
  return Buffer.concat([n, tail, rdata]);
}

function rrAAAA(name, ip6, ttl = 60) {
  const n = writeName(name);
  // expand ipv6
  const parts = ip6.split('::');
  let left = parts[0] ? parts[0].split(':') : [];
  let right = parts[1] ? parts[1].split(':') : [];
  if (parts.length === 2) {
    const fill = 8 - (left.filter(Boolean).length + right.filter(Boolean).length);
    left = left.filter(Boolean).concat(Array(fill).fill('0')).concat(right.filter(Boolean));
  } else {
    left = left.filter(Boolean);
  }
  const rdata = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) rdata.writeUInt16BE(parseInt(left[i] || '0', 16), i * 2);
  const tail = Buffer.alloc(10);
  tail.writeUInt16BE(28, 0); // AAAA
  tail.writeUInt16BE(1, 2);
  tail.writeUInt32BE(ttl, 4);
  tail.writeUInt16BE(16, 8);
  return Buffer.concat([n, tail, rdata]);
}

function applyRule(query, rule) {
  const q = parseQuestion(query);
  if (rule.action === 'nxdomain') return buildResponse(query, 3, []);
  if (rule.action === 'zero') {
    if (q.qtype === 1) return buildResponse(query, 0, [rrA(q.name, '0.0.0.0')]);
    if (q.qtype === 28) return buildResponse(query, 0, [rrAAAA(q.name, '::')]);
    return buildResponse(query, 0, []);
  }
  if (rule.action && rule.action.startsWith('ip:')) {
    const ip = rule.action.slice(3);
    if (q.qtype === 1) return buildResponse(query, 0, [rrA(q.name, ip)]);
    if (q.qtype === 28) return buildResponse(query, 0, []);
    return buildResponse(query, 0, []);
  }
  return null;
}

function forwardUdp(msg) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { sock.close(); } catch {} reject(new Error('upstream timeout')); }, 3000);
    sock.on('error', (e) => { clearTimeout(timer); try { sock.close(); } catch {} reject(e); });
    sock.on('message', (res) => { clearTimeout(timer); try { sock.close(); } catch {} resolve(res); });
    sock.send(msg, UPSTREAM_PORT, UPSTREAM, (e) => { if (e) { clearTimeout(timer); try { sock.close(); } catch {} reject(e); } });
  });
}

async function handleDnsMessage(msg) {
  let q;
  try { q = parseQuestion(msg); } catch { return null; }
  const rule = matchRule(q.name);
  console.log(`[dns] ${q.name} type=${q.qtype} rule=${rule ? rule.action : 'forward'}`);
  if (rule && rule.action !== 'passthrough') {
    const crafted = applyRule(msg, rule);
    if (crafted) return crafted;
  }
  try { return await forwardUdp(msg); } catch (e) { console.error('[dns] upstream error', e.message); return buildResponse(msg, 2, []); }
}

function sendDns(res, buf) {
  res.writeHead(200, { 'Content-Type': 'application/dns-message', 'Content-Length': buf.length });
  res.end(buf);
}

const server = https.createServer({
  pfx: fs.readFileSync(PFX_PATH),
  passphrase: PFX_PASS,
  minVersion: 'TLSv1.2',
}, async (req, res) => {
  try {
    const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    if (u.pathname !== '/dns-query') { res.writeHead(404); res.end('not found'); return; }
    if (req.method === 'GET') {
      const dns = u.searchParams.get('dns');
      if (!dns) { res.writeHead(400); res.end('missing dns'); return; }
      const b64 = dns.replace(/-/g, '+').replace(/_/g, '/');
      const pad = '='.repeat((4 - (b64.length % 4)) % 4);
      const msg = Buffer.from(b64 + pad, 'base64');
      const out = await handleDnsMessage(msg);
      if (!out) { res.writeHead(400); res.end('bad query'); return; }
      sendDns(res, out); return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const msg = Buffer.concat(chunks);
      const out = await handleDnsMessage(msg);
      if (!out) { res.writeHead(400); res.end('bad query'); return; }
      sendDns(res, out); return;
    }
    res.writeHead(405); res.end('method not allowed');
  } catch (e) {
    console.error('[http] error', e);
    try { res.writeHead(500); res.end('error'); } catch {}
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DoH demo server listening on https://0.0.0.0:${PORT}/dns-query`);
  console.log(`Upstream DNS: ${UPSTREAM}:${UPSTREAM_PORT}`);
  console.log('Edit RULES in this file to change rewrite/block behavior.');
});
