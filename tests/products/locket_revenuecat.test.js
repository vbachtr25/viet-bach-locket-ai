// Test cho RevenueCat engine (bản module).
//
// Trọng tâm: ba thứ mà nếu sai thì hoặc làm hỏng app, hoặc làm người dùng hiểu
// sai kết quả.
//   1. Chế độ `report` KHÔNG được sửa gì — đó là cơ sở để biết endpoint có
//      được ký hay không.
//   2. Không đoán tên entitlement. Thiếu `ek`/`pid` thì không patch.
//   3. Không được trả `headers` — trả headers là mất ETag gốc, và mất luôn khả
//      năng qua bước kiểm chữ ký.
//
// Chạy: node --test tests/products/locket_revenuecat.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RC = path.resolve(__dirname, '../../products/locket/engine/locket_revenuecat.js');
const REQ = path.resolve(__dirname, '../../products/locket/engine/locket_rc_request.js');
const MODULE = path.resolve(__dirname, '../../products/locket/module/locket.module');

const M = require(RC);
const RC_SRC = fs.readFileSync(RC, 'utf8');

function run({ url, body, bodyBytes, argument, headers, status }) {
  const store = {};
  const probes = [];
  const doneCalls = [];
  const sandbox = {
    $request: { url: url },
    $response: { headers: headers || {}, status: status === undefined ? 200 : status },
    $argument: argument === undefined ? 'report' : argument,
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; return true; }
    },
    $httpClient: { get: (o, cb) => { probes.push(o.url); if (cb) cb(null, {}, ''); } },
    $done: (r) => doneCalls.push(r),
    console: { log: () => {} }
  };
  if (body !== undefined) sandbox.$response.body = body;
  if (bodyBytes !== undefined) sandbox.$response.bodyBytes = new Uint8Array(bodyBytes);
  vm.runInNewContext(RC_SRC, sandbox);
  return { store, probes, doneCalls };
}

function textOf(call) {
  if (!call) return null;
  if (typeof call.body === 'string') return call.body;
  if (call.bodyBytes) {
    const v = new Uint8Array(call.bodyBytes);
    let s = '';
    for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
    return s;
  }
  return null;
}

const URL_SUB = 'https://api.revenuecat.com/v1/subscribers/$RCAnonymousID:abc';

/** Response RevenueCat tối thiểu cho tài khoản chưa mua. */
function emptySubscriber() {
  return {
    request_date: '2026-11-18T00:00:00Z',
    subscriber: { entitlements: {}, subscriptions: {}, original_app_user_id: 'x' }
  };
}

// ── injectEntitlement: lõi ─────────────────────────────────────────────────

test('injectEntitlement: thêm cả entitlement và subscription', () => {
  const obj = emptySubscriber();
  const { obj: out, added } = M.injectEntitlement(obj, { ek: 'Gold', pid: 'com.locket02.premium.yearly' });
  assert.strictEqual(added, 2);
  assert.ok(out.subscriber.entitlements.Gold);
  assert.strictEqual(out.subscriber.entitlements.Gold.product_identifier, 'com.locket02.premium.yearly');
  assert.ok(out.subscriber.subscriptions['com.locket02.premium.yearly']);
});

test('injectEntitlement: tài khoản đã có entitlement thì không đụng', () => {
  const obj = emptySubscriber();
  obj.subscriber.entitlements.Gold = { product_identifier: 'real', expires_date: '2027-01-01T00:00:00Z' };
  const { obj: out, added } = M.injectEntitlement(obj, { ek: 'Gold', pid: 'com.locket02.premium.yearly' });
  assert.strictEqual(out.subscriber.entitlements.Gold.product_identifier, 'real', 'không ghi đè cái đã có');
  assert.strictEqual(added, 1, 'chỉ thêm subscription còn thiếu');
});

test('injectEntitlement: thiếu ek hoặc pid thì không làm gì', () => {
  const a = M.injectEntitlement(emptySubscriber(), { ek: '', pid: 'x' });
  assert.strictEqual(a.added, 0);
  const b = M.injectEntitlement(emptySubscriber(), { ek: 'Gold', pid: '' });
  assert.strictEqual(b.added, 0);
});

test('injectEntitlement: object không phải RevenueCat -> không ném lỗi', () => {
  assert.strictEqual(M.injectEntitlement(null, { ek: 'a', pid: 'b' }).added, 0);
  assert.strictEqual(M.injectEntitlement({}, { ek: 'a', pid: 'b' }).added, 0);
  assert.strictEqual(M.injectEntitlement({ subscriber: 'nope' }, { ek: 'a', pid: 'b' }).added, 0);
});

test('listEntitlements: đọc được tên thật để dùng cho ek=', () => {
  const obj = { subscriber: {
    entitlements: { Pro: {}, Gold: {} },
    subscriptions: { 'com.x.y': {} }
  }};
  const r = M.listEntitlements(obj);
  assert.strictEqual(r.entCount, 2);
  assert.deepStrictEqual(r.entKeys.sort(), ['Gold', 'Pro']);
  assert.deepStrictEqual(r.subKeys, ['com.x.y']);
});

// ── phát hiện header chữ ký ────────────────────────────────────────────────

test('detectSignatureHeader: thấy header chữ ký', () => {
  assert.strictEqual(M.detectSignatureHeader({ 'X-RevenueCat-Signature': 'abc' }), 'x-revenuecat-signature');
  assert.strictEqual(M.detectSignatureHeader({ 'Signature': 'abc' }), 'signature');
});

test('detectSignatureHeader: response không ký -> chuỗi rỗng', () => {
  assert.strictEqual(M.detectSignatureHeader({ 'Content-Type': 'application/json' }), '');
  assert.strictEqual(M.detectSignatureHeader({}), '');
  assert.strictEqual(M.detectSignatureHeader(null), '');
});

test('findHeader: không phân biệt hoa thường', () => {
  assert.strictEqual(M.findHeader({ 'ETag': 'W/"abc"' }, 'etag'), 'W/"abc"');
  assert.strictEqual(M.findHeader({ 'etag': 'x' }, 'ETag'), 'x');
  assert.strictEqual(M.findHeader({}, 'etag'), undefined);
});

// ── parseArgs ──────────────────────────────────────────────────────────────

test('parseArgs: mặc định là report (KHÔNG tự patch)', () => {
  const a = M.parseArgs('');
  assert.strictEqual(a.mode, 'report', 'không có argument thì không được sửa gì');
});

test('parseArgs: đọc patch kèm ek/pid', () => {
  const a = M.parseArgs('patch&ek=Gold&pid=com.locket02.premium.yearly&probe=true');
  assert.strictEqual(a.mode, 'patch');
  assert.strictEqual(a.ek, 'Gold');
  assert.strictEqual(a.pid, 'com.locket02.premium.yearly');
  assert.strictEqual(a.probe, true);
});

test('parseArgs: off tắt hẳn', () => {
  assert.strictEqual(M.parseArgs('off').mode, 'off');
});

// ── entry: report không được sửa ───────────────────────────────────────────

test('entry: mode=report trả NGUYÊN body, không chèn gì', () => {
  const payload = JSON.stringify(emptySubscriber());
  const { doneCalls } = run({ url: URL_SUB, body: payload, argument: 'report' });
  assert.strictEqual(textOf(doneCalls[0]), payload);
});

test('entry: mode=report ghi tên entitlement + tình trạng chữ ký vào store', () => {
  const obj = emptySubscriber();
  obj.subscriber.entitlements = { Pro: {} };
  const { store } = run({
    url: URL_SUB, body: JSON.stringify(obj), argument: 'report',
    headers: { 'X-RevenueCat-Signature': 'sig', 'ETag': 'W/"1"' }
  });
  const rec = JSON.parse(store[M.STORE_KEY]);
  assert.strictEqual(rec.reason, 'report');
  assert.strictEqual(rec.entKeys, 'Pro');
  assert.strictEqual(rec.hasSigHeader, 'x-revenuecat-signature');
  assert.strictEqual(rec.hasEtag, 'y');
});

test('entry: mode=patch thiếu ek/pid -> KHÔNG sửa, báo need_ek_pid', () => {
  const payload = JSON.stringify(emptySubscriber());
  const { doneCalls, store } = run({ url: URL_SUB, body: payload, argument: 'patch' });
  assert.strictEqual(textOf(doneCalls[0]), payload);
  assert.strictEqual(JSON.parse(store[M.STORE_KEY]).reason, 'need_ek_pid');
});

test('entry: mode=patch đủ tham số -> chèn entitlement', () => {
  const { doneCalls, store } = run({
    url: URL_SUB, body: JSON.stringify(emptySubscriber()),
    argument: 'patch&ek=Gold&pid=com.locket02.premium.yearly'
  });
  const out = JSON.parse(textOf(doneCalls[0]));
  assert.ok(out.subscriber.entitlements.Gold);
  assert.strictEqual(JSON.parse(store[M.STORE_KEY]).reason, 'ok');
});

// Đây là test hợp đồng quan trọng nhất: trả headers = mất ETag = mất chữ ký.
test('entry: KHÔNG BAO GIỜ trả headers (để giữ ETag gốc)', () => {
  const { doneCalls } = run({
    url: URL_SUB, body: JSON.stringify(emptySubscriber()),
    argument: 'patch&ek=Gold&pid=p',
    headers: { 'ETag': 'W/"orig"', 'Content-Type': 'application/json' }
  });
  assert.strictEqual(doneCalls.length, 1);
  assert.strictEqual(doneCalls[0].headers, undefined,
    'trả headers sẽ xoá ETag gốc của server — đừng làm');
});

// ── entry: các nhánh không sửa được ────────────────────────────────────────

test('entry: 304 -> không đụng gì, báo not_modified', () => {
  const { doneCalls, store } = run({ url: URL_SUB, argument: 'patch&ek=a&pid=b', status: 304 });
  // 304 không có body, nên trả body rỗng không làm mất gì: app dùng cache của nó.
  assert.strictEqual(doneCalls[0].body, undefined);
  assert.strictEqual(doneCalls[0].bodyBytes, undefined);
  assert.strictEqual(JSON.parse(store[M.STORE_KEY]).reason, 'not_modified');
});

test('entry: JSON hỏng -> trả nguyên body', () => {
  const payload = '<html>err</html>';
  const { doneCalls } = run({ url: URL_SUB, body: payload, argument: 'patch&ek=a&pid=b' });
  assert.strictEqual(textOf(doneCalls[0]), payload);
});

test('entry: gzip -> trả nguyên byte qua bodyBytes', () => {
  const raw = [0x1f, 0x8b, 0x08, 0x00];
  const { doneCalls } = run({ url: URL_SUB, bodyBytes: raw, argument: 'patch&ek=a&pid=b' });
  assert.ok(doneCalls[0].bodyBytes);
  const v = new Uint8Array(doneCalls[0].bodyBytes);
  assert.strictEqual(v.length, raw.length);
});

test('entry: status 304 qua statusCode cũng nhận ra', () => {
  const store = {};
  const done = [];
  const sandbox = {
    $request: { url: URL_SUB },
    $response: { statusCode: 304, headers: {} },
    $argument: 'patch&ek=a&pid=b',
    $persistentStore: { read: (k) => store[k], write: (v, k) => { store[k] = v; } },
    $httpClient: { get: () => {} },
    $done: (r) => done.push(r),
    console: { log: () => {} }
  };
  vm.runInNewContext(RC_SRC, sandbox);
  assert.strictEqual(JSON.parse(store[M.STORE_KEY]).reason, 'not_modified');
});

test('entry: probe không rò body, token hay tên entitlement', () => {
  const { probes } = run({
    url: URL_SUB, body: JSON.stringify(emptySubscriber()),
    argument: 'patch&ek=SecretName&pid=com.secret&probe=true'
  });
  assert.strictEqual(probes.length, 1);
  const u = probes[0];
  assert.ok(u.includes('xwuan=rcpay'));
  assert.ok(!u.includes('SecretName'), 'không rò tên entitlement');
  assert.ok(!u.includes('com.secret'), 'không rò product id');
});

// ── request engine: xoá cache header ───────────────────────────────────────

test('dropHeaders: xoá If-None-Match và If-Modified-Since', () => {
  const R = require(REQ);
  const headers = { 'If-None-Match': 'W/"abc"', 'IF-MODIFIED-SINCE': 'date', 'Authorization': 'Bearer x' };
  const removed = R.dropHeaders(headers, R.DROP_HEADERS);
  assert.strictEqual(removed.length, 2);
  assert.strictEqual(headers['Authorization'], 'Bearer x', 'KHÔNG xoá auth');
});

test('request engine: trả headers đã xoá, giữ Authorization', () => {
  const done = [];
  const store = {};
  vm.runInNewContext(fs.readFileSync(REQ, 'utf8'), {
    $request: { url: URL_SUB, headers: { 'If-None-Match': 'x', 'Authorization': 'Bearer t' } },
    $argument: '',
    $persistentStore: { read: () => null, write: (v, k) => { store[k] = v; } },
    $done: (r) => done.push(r),
    console: { log: () => {} }
  });
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].headers['If-None-Match'], undefined);
  assert.strictEqual(done[0].headers['Authorization'], 'Bearer t');
  assert.ok(done[0].url === undefined, 'không đụng url');
});

// ── selftest gộp: đọc cả hai phần ──────────────────────────────────────────

const SELFTEST_NEW = path.resolve(__dirname, '../../products/locket/engine/locket_selftest.js');

function runSelftest(stores) {
  const done = [];
  vm.runInNewContext(fs.readFileSync(SELFTEST_NEW, 'utf8'), {
    $request: { url: 'https://firebaseremoteconfig.googleapis.com/xwuan-selftest' },
    $persistentStore: { read: (k) => (k in stores ? stores[k] : null) },
    $done: (r) => done.push(r)
  });
  return done[0].url;
}

test('selftest gộp: chưa chạy gì -> cả hai phần never_ran', () => {
  const u = runSelftest({});
  assert.ok(u.includes('rc.state=never_ran'));
  assert.ok(u.includes('pay.state=never_ran'));
  assert.ok(u.includes('req=never_ran'));
});

test('selftest gộp: báo cáo một dòng có đủ rc.* và pay.*', () => {
  const rc = { lastAt: Date.now(), lastPhase: 'patched', reason: 'ok',
               mode: 'capture', keyCount: 3, flipped: 1, b64Count: 0, inBytes: 50,
               keys: 'isPremium,other', eg: 'isPremium=false' };
  const pay = { lastAt: Date.now(), lastPhase: 'report', reason: 'report',
                entCount: 1, entKeys: 'Gold', subKeys: 'com.x.y',
                hasSigHeader: 'n', hasEtag: 'y' };
  const req = { dropped: 'If-None-Match' };
  const u = runSelftest({
    XwuanLocketDiag: JSON.stringify(rc),
    XwuanLocketRCDiag: JSON.stringify(pay),
    XwuanLocketReqDiag: JSON.stringify(req)
  });
  assert.ok(u.includes('rc.n=3'));
  assert.ok(u.includes('rc.fl=1'));
  assert.ok(u.includes('isPremium'));
  assert.ok(u.includes('pay.sig=n'));
  assert.ok(u.includes('pay.etag=y'));
  assert.ok(u.includes('pay.ent=Gold'));
  assert.ok(u.includes('pay.sub=com.x.y'));
  assert.ok(u.includes('req=If-None-Match'));
});

test('selftest gộp: chỉ có rc, chưa có pay -> vẫn trả cả hai phần', () => {
  const rc = { lastAt: Date.now(), reason: 'ok', keyCount: 2, keys: 'a,b' };
  const u = runSelftest({ XwuanLocketDiag: JSON.stringify(rc) });
  assert.ok(u.includes('rc.n=2'));
  assert.ok(u.includes('pay.state=never_ran'), 'phải nói rõ RevenueCat chưa chạy');
});

// ── module: hợp đồng ───────────────────────────────────────────────────────

test('module full: hook request xoá cache đứng TRƯỚC hook response', () => {
  const mod = fs.readFileSync(MODULE, 'utf8');
  // Tìm dòng khai báo, không tìm trong comment (comment có nhắc tên hook).
  const lineOf = (prefix) => {
    const lines = mod.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith(prefix)) return i;
    }
    return -1;
  };
  const reqIdx = lineOf('locket-rc-req ');
  const resIdx = lineOf('locket-rc-response ');
  assert.ok(reqIdx > 0, 'phải có hook request');
  assert.ok(resIdx > reqIdx, 'hook request phải đứng trước hook response');
});

test('module full: response hook mặc định là report (không tự patch)', () => {
  const mod = fs.readFileSync(MODULE, 'utf8');
  const line = mod.split('\n').find((l) => l.startsWith('locket-rc-response'));
  assert.ok(line.includes('argument=report'), 'mặc định phải là report để không sửa gì');
});

test('module full: không có domain nào của Spotify', () => {
  const mod = fs.readFileSync(MODULE, 'utf8');
  const active = mod.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!active.includes('spotify'));
});
