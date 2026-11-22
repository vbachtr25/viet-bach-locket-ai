// Bộ test bảo vệ CÚ PHÁP module YouTube và sự nhất quán giữa module ↔ engine.
//
// Lý do tồn tại: bản module Spotify đầu tiên có 4 lỗi cú pháp mà test protobuf
// không bắt được, khiến module im lặng trên điện thoại. File này khẳng định
// module YouTube chỉ dùng những dạng đã đối chiếu với module Shadowrocket
// đang chạy thật, và mọi `script-path` đều trỏ tới file có thật trong repo.
//
// Nguồn chuẩn: products/spotify/audit/shadowrocket-module-syntax.md
//
// Chạy: node --test tests/products/youtube_module_syntax.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '../../products/youtube/module/youtube-adblock.module');
const ENGINE_PATH = path.resolve(__dirname, '../../products/youtube/engine/youtube_adblock.js');
const RAW = fs.readFileSync(MODULE_PATH, 'utf8');
const LINES = RAW.split('\n');

/** Gom dòng theo section [...] (bỏ comment và dòng trống). */
function sections() {
  const out = {};
  let current = null;
  LINES.forEach((line, idx) => {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) { current = header[1]; out[current] = out[current] || []; return; }
    if (!trimmed || trimmed.startsWith('#')) return;
    if (current) out[current].push({ line: idx + 1, text: trimmed });
  });
  return out;
}

const S = sections();

// ─── metadata ──────────────────────────────────────────────────────────────

test('có đủ metadata #!name / #!desc / #!author', () => {
  assert.match(RAW, /^#!name=.+$/m);
  assert.match(RAW, /^#!desc=.+$/m);
  assert.match(RAW, /^#!author=Xwuan$/m);
});

test('không có BOM và không có CRLF', () => {
  assert.notStrictEqual(RAW.charCodeAt(0), 0xfeff, 'file không được có BOM');
  assert.ok(!RAW.includes('\r'), 'file không được dùng CRLF — Shadowrocket parse sai');
});

// ─── [Script] ──────────────────────────────────────────────────────────────

test('[Script] mỗi hook http-response có requires-body=1 và binary-body-mode=1', () => {
  const scripts = S['Script'];
  assert.ok(scripts && scripts.length >= 5, 'phải có ít nhất 5 hook');
  const resp = scripts.filter(({ text }) => /type=http-response/.test(text));
  assert.strictEqual(resp.length, scripts.length - 1, 'chỉ self-test được là http-request');
  resp.forEach(({ line, text }) => {
    assert.match(text, /^[\w-]+\s*=\s*type=http-response,/, `dòng ${line}: phải là http-response`);
    assert.match(text, /requires-body=1/, `dòng ${line}: thiếu requires-body=1 → body rỗng`);
    assert.match(text, /binary-body-mode=1/, `dòng ${line}: thiếu binary-body-mode=1 → protobuf bị cắt`);
  });
});

test('[Script] hook binary khai engine=jsc và máy đọc bodyBytes tương ứng', () => {
  // Đổi kết luận sau khi đối chiếu hmxxgit/shadowrocket-youtube-adblock: bản
  // tương thích Shadowrocket đầy đủ nhất khai `engine=jsc` + đọc
  // `$response.bodyBytes` + trả `{bodyBytes: ArrayBuffer}`. Trước đó repo này
  // để mặc định webview, và engine trả `{body}` — sai với binary-body-mode.
  const bin = (S['Script'] || []).filter(({ text }) => /binary-body-mode=1/.test(text));
  assert.ok(bin.length >= 5, 'phải có hook binary');
  bin.forEach(({ line, text }) => {
    assert.match(text, /engine=jsc/, `dòng ${line}: hook binary phải khai engine=jsc`);
    assert.match(text, /max-size=-1/, `dòng ${line}: bản tương thích dùng max-size=-1`);
  });
});

test('[Script] có hook self-test kiểu http-request (Shadowrocket chạy được)', () => {
  const req = (S['Script'] || []).filter(({ text }) => /type=http-request/.test(text));
  assert.strictEqual(req.length, 1, 'phải có đúng 1 hook http-request cho self-test');
  assert.match(req[0].text, /youtube_selftest\.js/, 'self-test phải trỏ tới youtube_selftest.js');
});

test('[Script] max-size hợp lệ (-1 hoặc số dương), không dùng 0', () => {
  (S['Script'] || []).forEach(({ line, text }) => {
    const m = text.match(/max-size=(-?\d+)/);
    if (!m) return; // hook http-request của self-test không cần body
    assert.notStrictEqual(Number(m[1]), 0, `dòng ${line}: max-size=0 mơ hồ giữa "vô hạn" và "bị cắt"`);
  });
});

test('[Script] script-path trỏ tới engine có thật và có ?v= chống cache', () => {
  const engineRaw = 'https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/'
    + 'products/youtube/engine/youtube_adblock.js';
  (S['Script'] || []).filter(({ text }) => /type=http-response/.test(text)).forEach(({ line, text }) => {
    const m = text.match(/script-path=([^,]+)/);
    assert.ok(m, `dòng ${line}: thiếu script-path`);
    const url = m[1];
    assert.ok(url.startsWith(engineRaw), `dòng ${line}: script-path phải trỏ tới engine chuẩn`);
    assert.match(url, /\?v=\d{8}_\d+$/, `dòng ${line}: thiếu ?v= → user chạy code cũ`);
  });
});

test('[Script] có hook cho cả 4 nhóm endpoint đã implement', () => {
  const all = (S['Script'] || []).map((s) => s.text).join('\n');
  ['/player', '/get_watch', '/browse', '/next', '/search', '/reel_watch_sequence'].forEach((ep) => {
    assert.ok(all.includes(ep.replace('/', '\\/')), `thiếu hook cho ${ep}`);
  });
});

test('[Script] tên hook là duy nhất', () => {
  const names = (S['Script'] || []).map((s) => s.text.split('=')[0].trim());
  assert.strictEqual(new Set(names).size, names.length, 'có hook trùng tên');
});

// ─── [MITM] ────────────────────────────────────────────────────────────────

test('[MITM] dùng %APPEND% và h2 = true', () => {
  const mitm = S['MITM'];
  assert.ok(mitm, 'thiếu section [MITM]');
  const hostLine = mitm.find((l) => l.text.startsWith('hostname'));
  assert.ok(hostLine, 'thiếu hostname');
  assert.match(hostLine.text, /%APPEND%/, 'thiếu %APPEND% → ghi đè host của config user');
  assert.ok(mitm.some((l) => /^h2\s*=\s*true$/.test(l.text)), 'thiếu h2 = true');
});

test('[MITM] có host của mọi endpoint được hook', () => {
  const hostLine = S['MITM'].find((l) => l.text.startsWith('hostname')).text;
  assert.ok(hostLine.includes('youtubei.googleapis.com'), 'thiếu youtubei.googleapis.com');
});

// ─── [Rule] ────────────────────────────────────────────────────────────────

test('[Rule] dùng PROTOCOL,UDP chứ không phải PROTOCOL,QUIC', () => {
  const rules = S['Rule'] || [];
  assert.ok(rules.length > 0, 'thiếu section [Rule]');
  const joined = rules.map((r) => r.text).join('\n');
  assert.ok(!/PROTOCOL,\s*QUIC/.test(joined), 'QUIC không phải token của Shadowrocket');
  assert.ok(/PROTOCOL,\s*UDP/.test(joined), 'phải chặn UDP để ép YouTube rời QUIC');
});

// ─── [URL Rewrite] ─────────────────────────────────────────────────────────

test('[Url Rewrite] đúng cú pháp và có luật &oad của Maasea/hmxxgit', () => {
  // Tên section viết đúng như Maasea và hmxxgit dùng: [Url Rewrite].
  const rewrites = S['Url Rewrite'] || [];
  assert.ok(rewrites.length > 0, 'thiếu section [Url Rewrite] (chú ý chữ U thường)');

  const statsEndpoints = [];
  rewrites.forEach(({ line, text }) => {
    assert.match(text, /^(\^|\(\^|https?:)/, `dòng ${line}: phải bắt đầu bằng regex URL`);
    // Hai dạng hợp lệ: `<regex> _ reject-200` và `<regex> $1$2$3 302`
    const reject = text.match(/\s_\s(\S+)\s*$/);
    const redirect = text.match(/\s(\$1\S*)\s+302\s*$/);
    assert.ok(reject || redirect, `dòng ${line}: sai cú pháp (cần " _ reject-200" hoặc "$1$2$3 302")`);
    if (reject) assert.strictEqual(reject[1], 'reject-200', `dòng ${line}: chỉ reject-200`);
    if (/api\\?\/stats\\?\/ads/.test(text)) statsEndpoints.push(text);
  });

  const joined = rewrites.map((r) => r.text).join('\n');
  // Đây là chỗ bản đầu của module thiếu — Maasea và hmxxgit đều có.
  assert.ok(/&oad/.test(joined), 'thiếu luật chặn &oad (video ad) — Maasea/hmxxgit đều có');
  assert.ok(/googlevideo/.test(joined), 'thiếu luật cho googlevideo.com');
  assert.ok(/youtube\\.com/.test(joined), 'thiếu luật cho youtube.com');
  assert.ok(/ctier=L/.test(joined), 'thiếu luật bỏ &ctier=L');
  assert.ok(statsEndpoints.length >= 1, 'thiếu luật chặn /api/stats/ads');
});

// ─── engine ↔ module ───────────────────────────────────────────────────────

test('engine dùng đúng số field protobuf đã đối chiếu (7 và 68)', () => {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  assert.match(src, /var FIELD_AD_PLACEMENTS = 7;/, 'field adPlacements phải là 7');
  assert.match(src, /var FIELD_AD_SLOTS = 68;/, 'field adSlots phải là 68');
  assert.match(src, /var FIELD_ELEMENT_RENDERER = 153515154;/, 'elementRenderer phải là 153515154');
});

test('engine không bao giờ dùng $done({}) làm passthrough', () => {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  // Bỏ comment trước khi đếm: trong file có câu giải thích "$done({}) sẽ xoá
  // body" — nếu không lọc thì chính comment làm test fail.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // $done({}) chỉ được phép ở đúng một chỗ: khi body vốn đã rỗng (304).
  const bare = code.match(/\$done\(\{\}\)/g) || [];
  assert.ok(bare.length <= 2, 'chỉ được $done({}) ở nhánh body rỗng và fallback exception');
  assert.match(src, /function donePassthrough/, 'phải có donePassthrough trả body gốc');
});

test('engine trả ArrayBuffer khi chạy jsc, Uint8Array khi webview', () => {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  assert.match(src, /function buildDoneResponse/, 'thiếu buildDoneResponse');
  assert.match(src, /\$environment\[.engine.\]/, 'phải đọc engine từ $environment');
  assert.match(src, /new ArrayBuffer\(bytes\.length\)/, 'jsc phải nhận ArrayBuffer');
});

test('engine không require thư viện ngoài', () => {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  assert.ok(!/require\(['"](?!node:)?[a-z@]/i.test(src.replace(/module\.exports[\s\S]*$/, '')),
    'engine phải tự chứa, không require thư viện — Shadowrocket không có node_modules');
});

test('engine bọc entry trong try/catch để không bao giờ làm sập response', () => {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  assert.match(src, /try\s*\{\s*youtubeMain\(\);/, 'entry phải được bọc try/catch');
});
