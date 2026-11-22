// Test cho engine Locket Remote Config.
//
// Trọng tâm không phải "lật được cờ" (dễ) mà là ba chỗ dễ làm hỏng app của
// người dùng mà không báo lỗi:
//   1. Token hoá tên key — `pro` không được khớp `project`/`product`.
//   2. Passthrough — khi không sửa gì phải trả NGUYÊN body. `$done({})` là
//      body RỖNG, không phải passthrough. Đây là lỗi đã mắc ở module YouTube.
//   3. Không ghi đè giá trị không phải boolean-tắt. Ghi đè bừa là làm hỏng
//      cấu hình thật của app.
//
// Chạy: node --test tests/products/locket_remoteconfig.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ENGINE = path.resolve(__dirname, '../../products/locket/engine/locket_remoteconfig.js');
const SELFTEST = path.resolve(__dirname, '../../products/locket/engine/locket_selftest.js');
const ENGINE_SRC = fs.readFileSync(ENGINE, 'utf8');

const L = require(ENGINE);

// ─── runtime giả lập Shadowrocket ──────────────────────────────────────────

function runEngine({ url, bodyBytes, body, argument }) {
  const store = {};
  const probes = [];
  const doneCalls = [];
  const sandbox = {
    $request: { url: url },
    $response: {},
    $argument: argument === undefined ? 'flags' : argument,
    $environment: { engine: 'jsc' },
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; return true; }
    },
    $httpClient: {
      get: (opts, cb) => { probes.push(opts.url); if (cb) cb(null, { status: 200 }, ''); }
    },
    $done: (r) => doneCalls.push(r),
    console: { log: () => {} }
  };
  if (bodyBytes !== undefined) sandbox.$response.bodyBytes = bodyBytes;
  if (body !== undefined) sandbox.$response.body = body;

  vm.runInNewContext(ENGINE_SRC, sandbox);
  return { store, probes, doneCalls, store_key: L.STORE_KEY };
}

const URL_RC = 'https://firebaseremoteconfig.googleapis.com/v1/projects/locket-4252a/namespaces/firebase:fetch?key=AIzaTEST';

/** Lấy body engine đã trả, dạng chuỗi (hỗ trợ cả body và bodyBytes). */
function returnedText(doneCall) {
  if (!doneCall) return null;
  if (typeof doneCall.body === 'string') return doneCall.body;
  if (doneCall.bodyBytes) {
    const view = new Uint8Array(doneCall.bodyBytes);
    let s = '';
    for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
    return s;
  }
  return null;
}

// ─── token hoá tên key ─────────────────────────────────────────────────────

test('tokensOf: camelCase, snake_case, SCREAMING-KEBAB cùng kết quả', () => {
  assert.deepStrictEqual(L.tokensOf('isPremiumUser'), ['is', 'premium', 'user']);
  assert.deepStrictEqual(L.tokensOf('premium_user'), ['premium', 'user']);
  assert.deepStrictEqual(L.tokensOf('PREMIUM-USER'), ['premium', 'user']);
  assert.deepStrictEqual(L.tokensOf('goldEnabled'), ['gold', 'enabled']);
});

test('isFlagKey: nhận cờ thật', () => {
  for (const k of ['isPremium', 'gold_enabled', 'hasGold', 'premiumUser', 'isVip',
                   'subscriptionActive', 'entitlementsPro', 'unlockAll', 'paywallEnabled']) {
    assert.strictEqual(L.isFlagKey(k), true, `phải nhận: ${k}`);
  }
});

// Đây là test quan trọng nhất của file: substring matching sẽ làm hỏng app.
test('isFlagKey: KHÔNG nhận key không phải cờ (pro != project)', () => {
  for (const k of ['projectId', 'productUrl', 'processName', 'profileImage',
                   'apiEndpoint', 'premium_price', 'giftProductId',
                   'subscriptionPrice', 'paywallUrl', 'entitlementKey']) {
    assert.strictEqual(L.isFlagKey(k), false, `không được nhận: ${k}`);
  }
});

test('isOffValue: chỉ false/0/no/off/disabled', () => {
  for (const v of ['false', 'FALSE', '0', 'no', 'off', 'disabled', ' false ']) {
    assert.strictEqual(L.isOffValue(v), true, `phải là off: ${v}`);
  }
  for (const v of ['true', '1', 'yes', 'on', 'enabled', 'pro', '12', '']) {
    assert.strictEqual(L.isOffValue(v), false, `không phải off: ${v}`);
  }
  assert.strictEqual(L.isOffValue(true), false, 'boolean true không phải string');
  assert.strictEqual(L.isOffValue(0), false, 'number 0 không phải string');
});

// ─── áp cờ ─────────────────────────────────────────────────────────────────

test('applyFlags: lật cờ đang false, giữ nguyên cờ đã true', () => {
  const obj = { state: 'UPDATE', entries: {
    isPremium: 'false',
    gold_enabled: 'true',
    other: 'value'
  }};
  const { obj: out, stats } = L.applyFlags(obj, 'flags');
  assert.strictEqual(out.entries.isPremium, 'true');
  assert.strictEqual(out.entries.gold_enabled, 'true');
  assert.strictEqual(out.entries.other, 'value');
  assert.strictEqual(stats.flipped, 1);
  assert.strictEqual(stats.keyCount, 3);
});

test('applyFlags: KHÔNG ghi đè giá trị khác boolean-tắt', () => {
  const obj = { state: 'UPDATE', entries: {
    premiumTier: 'silver',
    goldPrice: '4.99',
    premium_count: '3'
  }};
  const { obj: out, stats } = L.applyFlags(obj, 'flags');
  assert.strictEqual(out.entries.premiumTier, 'silver');
  assert.strictEqual(out.entries.goldPrice, '4.99');
  assert.strictEqual(out.entries.premium_count, '3');
  assert.strictEqual(stats.flipped, 0);
});

test('applyFlags: mode=capture không sửa gì nhưng vẫn ghi danh sách key', () => {
  const obj = { state: 'UPDATE', entries: { isPremium: 'false' } };
  const { obj: out, stats } = L.applyFlags(obj, 'capture');
  assert.strictEqual(out.entries.isPremium, 'false');
  assert.strictEqual(stats.flipped, 0);
  assert.strictEqual(stats.keyCount, 1);
  assert.ok(stats.flagsSeen.includes('isPremium'));
});

test('applyFlags: mode=off không sửa gì', () => {
  const obj = { state: 'UPDATE', entries: { isPremium: 'false' } };
  const { obj: out } = L.applyFlags(obj, 'off');
  assert.strictEqual(out.entries.isPremium, 'false');
});

test('applyFlags: state=NO_TEMPLATE -> reason=no_template, không ném lỗi', () => {
  const { stats } = L.applyFlags({ state: 'NO_TEMPLATE' }, 'flags');
  assert.strictEqual(stats.reason, 'no_template');
  assert.strictEqual(stats.flipped, 0);
});

test('applyFlags: giải base64 để đọc giá trị (không sửa bên trong)', () => {
  const inner = JSON.stringify({ premium: false });
  const b64 = Buffer.from(inner, 'utf8').toString('base64');
  const { obj: out, stats } = L.applyFlags({ state: 'UPDATE', entries: { configBlob: b64 } }, 'capture');
  assert.strictEqual(stats.b64Count, 1);
  assert.strictEqual(out.entries.configBlob, b64, 'không được ghi đè blob base64');
  assert.ok(stats.examples.some((e) => e.includes('b64:')), 'phải ghi ví dụ đã giải mã');
});

// ─── body: ba dạng runtime ─────────────────────────────────────────────────

test('bodyToText: nhận string', () => {
  const r = L.bodyToText('{"a":1}');
  assert.strictEqual(r.kind, 'json-string');
  assert.strictEqual(r.text, '{"a":1}');
});

test('bodyToText: nhận Uint8Array', () => {
  const r = L.bodyToText(new Uint8Array([0x7b, 0x7d]));
  assert.strictEqual(r.kind, 'bytes');
  assert.strictEqual(r.text, '{}');
});

test('bodyToText: nhận ArrayBuffer', () => {
  const buf = new Uint8Array([0x7b, 0x7d]).buffer;
  const r = L.bodyToText(buf);
  assert.strictEqual(r.kind, 'bytes');
  assert.strictEqual(r.text, '{}');
});

test('bodyToText: nhận diện gzip bằng magic 1f 8b', () => {
  const r = L.bodyToText(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]));
  assert.strictEqual(r.kind, 'gzip');
});

test('bodyToText: UTF-8 nhiều byte (tiếng Việt)', () => {
  const bytes = new Uint8Array(L.utf8Encode('giá vàng'));
  assert.strictEqual(L.bodyToText(bytes).text, 'giá vàng');
});

// ─── entry qua runtime giả lập ─────────────────────────────────────────────

test('entry: lật cờ và trả JSON đã sửa', () => {
  const body = JSON.stringify({ state: 'UPDATE', entries: { isPremium: 'false' } });
  const { doneCalls } = runEngine({ url: URL_RC, body: body, argument: 'flags' });
  assert.strictEqual(doneCalls.length, 1);
  const out = JSON.parse(returnedText(doneCalls[0]));
  assert.strictEqual(out.entries.isPremium, 'true');
});

test('entry: arguments "flags&probe=true" bật probe và vẫn lật cờ', () => {
  const body = JSON.stringify({ state: 'UPDATE', entries: { hasGold: 'false' } });
  const { doneCalls, probes } = runEngine({ url: URL_RC, body: body, argument: 'flags&probe=true' });
  assert.strictEqual(probes.length, 1);
  assert.ok(probes[0].includes('xwuan=rc'));
  assert.ok(probes[0].includes('st=ok'));
  assert.ok(probes[0].includes('fl=1'));
  assert.strictEqual(JSON.parse(returnedText(doneCalls[0])).entries.hasGold, 'true');
});

test('entry: probe không gửi body hay token ra ngoài', () => {
  const body = JSON.stringify({ state: 'UPDATE', entries: { isPremium: 'false' } });
  const { probes } = runEngine({ url: URL_RC, body: body, argument: 'flags&probe=true' });
  assert.strictEqual(probes.length, 1);
  const u = probes[0];
  assert.ok(!u.includes('AIzaTEST'), 'không được rò api key');
  assert.ok(!u.includes('isPremium'), 'không được rò tên key ở probe');
  assert.ok(!u.includes('firebaseremoteconfig'), 'probe không đi qua host bị MITM');
});

// Passthrough: đây là lỗi kinh điển. `$done({})` = body rỗng = app hỏng.
test('entry: JSON không có entries -> trả NGUYÊN body, không rỗng', () => {
  const body = JSON.stringify({ state: 'NO_TEMPLATE' });
  const { doneCalls } = runEngine({ url: URL_RC, body: body });
  assert.strictEqual(returnedText(doneCalls[0]), body);
});

test('entry: JSON hỏng -> trả NGUYÊN body, không rỗng', () => {
  const body = '<html>not json</html>';
  const { doneCalls } = runEngine({ url: URL_RC, body: body });
  assert.strictEqual(returnedText(doneCalls[0]), body);
});

test('entry: gzip -> trả NGUYÊN BYTE qua bodyBytes', () => {
  const raw = [0x1f, 0x8b, 0x08, 0x00, 0x11, 0x22];
  const { doneCalls } = runEngine({ url: URL_RC, bodyBytes: new Uint8Array(raw) });
  const call = doneCalls[0];
  assert.ok(call.bodyBytes, 'phải trả bodyBytes, không phải body rỗng');
  const view = new Uint8Array(call.bodyBytes);
  assert.strictEqual(view.length, raw.length);
  for (let i = 0; i < raw.length; i++) assert.strictEqual(view[i], raw[i]);
});

test('entry: không có body -> trả body rỗng (không treo)', () => {
  const { doneCalls } = runEngine({ url: URL_RC });
  assert.strictEqual(doneCalls.length, 1);
  assert.strictEqual(returnedText(doneCalls[0]), '');
});

test('entry: ghi chẩn đoán vào store ở mọi nhánh', () => {
  const body = JSON.stringify({ state: 'UPDATE', entries: { isPremium: 'false' } });
  const { store } = runEngine({ url: URL_RC, body: body });
  assert.ok(store[L.STORE_KEY], 'phải ghi store');
  const rec = JSON.parse(store[L.STORE_KEY]);
  assert.strictEqual(rec.reason, 'ok');
  assert.strictEqual(rec.keyCount, 1);
});

test('entry: bỏ qua chính request probe (không đệ quy)', () => {
  const { doneCalls, probes } = runEngine({
    url: 'https://firebaseremoteconfig.googleapis.com/v1/x?xwuan=rc&st=ok',
    body: '{}', argument: 'flags&probe=true'
  });
  assert.strictEqual(doneCalls.length, 1);
  assert.strictEqual(probes.length, 0, 'không được gửi probe từ request probe');
});

test('entry: body bị lật cờ nhưng lỗi giữa đường -> vẫn trả body gốc', () => {
  // Mô phỏng: applyFlags ném lỗi. Đường catch phải cứu body, không trả rỗng.
  const body = JSON.stringify({ state: 'UPDATE', entries: { isPremium: 'false' } });
  const store = {}; const doneCalls = [];
  const sandbox = {
    $request: { url: URL_RC },
    $response: { body: body },
    $argument: 'flags',
    $persistentStore: { read: (k) => store[k], write: (v, k) => { store[k] = v; } },
    $httpClient: { get: () => {} },
    $done: (r) => doneCalls.push(r),
    console: { log: () => {} }
  };
  // Làm hỏng JSON.parse để chắc chắn rơi vào đường lỗi ở applyFlags:
  // thay vì vậy ta làm hỏng $done lần đầu, buộc catch phải cứu.
  let firstDone = true;
  sandbox.$done = (r) => {
    if (firstDone) { firstDone = false; throw new Error('boom'); }
    doneCalls.push(r);
  };
  vm.runInNewContext(ENGINE_SRC, sandbox);
  assert.strictEqual(doneCalls.length, 1, 'phải gọi $done lần hai để cứu body');
  assert.strictEqual(returnedText(doneCalls[0]), body, 'phải trả nguyên body, không rỗng');
});

// ─── selftest ──────────────────────────────────────────────────────────────

test('selftest: chưa có store -> state=never_ran', () => {
  const done = [];
  vm.runInNewContext(fs.readFileSync(SELFTEST, 'utf8'), {
    $request: { url: 'https://firebaseremoteconfig.googleapis.com/xwuan-selftest' },
    $persistentStore: { read: () => null, write: () => true },
    $done: (r) => done.push(r)
  });
  assert.ok(done[0].url.includes('state=never_ran'));
});

test('selftest: có store -> state=ran kèm key và ví dụ', () => {
  const done = [];
  const rec = { lastAt: Date.now(), lastPhase: 'patched', reason: 'ok', mode: 'capture',
                keyCount: 2, flipped: 0, b64Count: 0, inBytes: 40,
                keys: 'isPremium,other', eg: 'isPremium=false' };
  vm.runInNewContext(fs.readFileSync(SELFTEST, 'utf8'), {
    $request: { url: 'https://firebaseremoteconfig.googleapis.com/xwuan-selftest' },
    $persistentStore: { read: () => JSON.stringify(rec), write: () => true },
    $done: (r) => done.push(r)
  });
  const u = done[0].url;
  assert.ok(u.includes('state=ran'));
  assert.ok(u.includes('n=2'));
  assert.ok(u.includes('isPremium'));
});

// ─── hợp đồng của module gộp ──────────────────────────────────────────────

const MODULE_PATH = path.resolve(__dirname, '../../products/locket/module/locket.module');
const MOD = fs.readFileSync(MODULE_PATH, 'utf8');
const activeLines = (src) => src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const declLine = (src, prefix) => src.split('\n').find((l) => l.trim().startsWith(prefix)) || '';

test('module: là MỘT file duy nhất cho Shadowrocket', () => {
  const dir = path.resolve(__dirname, '../../products/locket/module');
  assert.deepStrictEqual(fs.readdirSync(dir), ['locket.module']);
});

test('module: có đủ 3 hook response (RevenueCat + fetch + realtime)', () => {
  // Chỉ đếm dòng khai báo (comment ở đầu file cũng nhắc `type=http-response`).
  const lines = MOD.split('\n').filter((l) => l.includes('= type=http-response'));
  assert.strictEqual(lines.length, 3);
  for (const l of lines) {
    assert.ok(l.includes('requires-body=1'), `thiếu requires-body: ${l.slice(0, 50)}`);
    assert.ok(l.includes('max-size=-1'), `thiếu max-size: ${l.slice(0, 50)}`);
  }
});

test('module: RevenueCat mặc định report (không tự patch), Remote Config mặc định flags', () => {
  assert.ok(declLine(MOD, 'locket-rc-response').includes('argument=report'));
  assert.ok(declLine(MOD, 'locket-rc-fetch').includes('argument=flags'));
  assert.ok(declLine(MOD, 'locket-rc-realtime').includes('argument=flags'));
});

test('module: hook request xoá cache đứng TRƯỚC hook response', () => {
  const lines = MOD.split('\n');
  const idx = (prefix) => lines.findIndex((l) => l.trim().startsWith(prefix));
  assert.ok(idx('locket-rc-req ') > 0);
  assert.ok(idx('locket-rc-response ') > idx('locket-rc-req '));
});

test('module: MITM có đủ 3 host, dùng %APPEND% và h2', () => {
  const lines = MOD.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === '[MITM]');
  const scriptIdx = lines.findIndex((l) => l.trim() === '[Script]');
  assert.ok(startIdx > 0 && scriptIdx > startIdx, 'phải có section [MITM] trước [Script]');
  const mitm = lines.slice(startIdx, scriptIdx).join('\n');
  for (const h of ['api.revenuecat.com', 'firebaseremoteconfig.googleapis.com',
                   'firebaseremoteconfigrealtime.googleapis.com']) {
    assert.ok(mitm.includes(h), `thiếu host: ${h}`);
  }
  assert.ok(mitm.includes('%APPEND%'));
  assert.ok(mitm.includes('h2 = true'));
});

test('module: chỉ có 1 hook self-test, và pattern phủ cả hai host', () => {
  const selfTests = MOD.split('\n').filter((l) => l.startsWith('locket-selftest'));
  assert.strictEqual(selfTests.length, 1, 'chỉ được có một self-test');
  assert.ok(selfTests[0].includes('firebaseremoteconfig'));
  assert.ok(selfTests[0].includes('revenuecat'));
});

// Người dùng yêu cầu rõ: chỉ Shadowrocket, không port sang client khác.
test('module: không chứa cú pháp riêng của client khác', () => {
  const active = activeLines(MOD).toLowerCase();
  for (const other of ['quantumult', '[general]', '[filter]', '[rewrite_local]',
                       '[mitm] = ', 'script-update-interval', 'enabled = true']) {
    assert.ok(!active.includes(other), `có cú pháp của client khác: ${other}`);
  }
});

test('module: có ghi rõ chỉ dành cho Shadowrocket', () => {
  assert.ok(MOD.toLowerCase().includes('chỉ dành cho shadowrocket'));
});
