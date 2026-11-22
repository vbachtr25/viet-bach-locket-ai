// Test cho KÊNH CHẨN ĐOÁN khi không xem được log.
//
// Bối cảnh: Shadowrocket không có trình xem log script. `数据 > 代理` chỉ ghi
// nhận kết nối, `$notification.post` không tồn tại trong runtime của nó. Nếu
// module im lặng thì không có cách nào biết nó có chạy hay không — đây là vấn
// đề thật, không phải khó chịu nhỏ.
//
// File này kiểm hai kênh còn lại:
//   1. $persistentStore  -> youtube_selftest.js đọc ra được
//   2. $httpClient probe -> tạo một dòng trong log kết nối
//
// Chạy: node --test tests/products/youtube_diagnostics.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ENGINE = path.resolve(__dirname, '../../products/youtube/engine/youtube_adblock.js');
const SELFTEST = path.resolve(__dirname, '../../products/youtube/engine/youtube_selftest.js');
const ENGINE_SRC = fs.readFileSync(ENGINE, 'utf8');

// ─── helper dựng protobuf ──────────────────────────────────────────────────

const YT = require(ENGINE);

function varint(n) {
  const out = [];
  YT.writeVarint(n, out);
  return Buffer.from(out);
}
function bytesField(num, payload) {
  return Buffer.concat([varint(num * 8 + 2), varint(payload.length), payload]);
}

/** Dựng runtime giả lập Shadowrocket để chạy engine thật. */
function runEngine({ url, bodyBytes, body, argument, engine = 'jsc' }) {
  const store = {};
  const probes = [];
  const doneCalls = [];
  const sandbox = {
    $request: { url: url },
    $response: {},
    $argument: argument === undefined ? 'ads' : argument,
    $environment: { engine: engine },
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
  return { doneCalls, store, probes };
}

const playerWithAd = () => Buffer.concat([
  bytesField(1, Buffer.from('video-id')),
  bytesField(7, Buffer.from('ad-placement')),
  bytesField(68, Buffer.from('ad-slot')),
  bytesField(4, Buffer.from('streaming'))
]);

const playerClean = () => Buffer.concat([
  bytesField(1, Buffer.from('video-id')),
  bytesField(4, Buffer.from('streaming'))
]);

// ─── đọc body đúng kênh ────────────────────────────────────────────────────

test('đọc $response.bodyBytes (kênh của Shadowrocket) và patch được', () => {
  const body = playerWithAd();
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player?key=x',
    bodyBytes: new Uint8Array(body)
  });
  assert.strictEqual(r.doneCalls.length, 1, 'phải gọi $done đúng 1 lần');
  const out = r.doneCalls[0];
  assert.ok('bodyBytes' in out, 'với binary-body-mode phải trả bodyBytes, không phải body');
  assert.ok(!('body' in out), 'không được trả body khi dùng binary-body-mode');
});

test('bodyBytes được ưu tiên hơn body khi cả hai tồn tại', () => {
  const real = playerWithAd();
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(real),
    body: 'rac-khong-parse-duoc'
  });
  const out = r.doneCalls[0];
  assert.ok('bodyBytes' in out, 'phải dùng bodyBytes');
  // nội dung trả về phải là protobuf đã sửa, không phải chuỗi rác
  const bytes = new Uint8Array(out.bodyBytes);
  const fields = YT.readFields(bytes, 0, bytes.length).map((f) => f.num);
  assert.deepStrictEqual(fields, [1, 4], 'phải còn field 1 và 4, mất 7 và 68');
});

/* Lưu ý: engine chạy trong realm của vm nên `instanceof ArrayBuffer` ở test
 * sẽ luôn false (ArrayBuffer của realm khác). Phân biệt bằng cấu trúc:
 *   ArrayBuffer -> có byteLength, KHÔNG có .length
 *   Uint8Array  -> có byteLength VÀ .length */
const isArrayBufferLike = (v) => v && typeof v.byteLength === 'number' && typeof v.length === 'undefined';
const isTypedArrayLike = (v) => v && typeof v.byteLength === 'number' && typeof v.length === 'number';

test('trả ArrayBuffer khi engine=jsc (không bridge được Uint8Array)', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(playerWithAd()),
    engine: 'jsc'
  });
  const out = r.doneCalls[0].bodyBytes;
  assert.ok(isArrayBufferLike(out), 'jsc phải nhận ArrayBuffer (có byteLength, không có length)');
});

test('trả Uint8Array khi engine=webview', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(playerWithAd()),
    engine: 'webview'
  });
  const out = r.doneCalls[0].bodyBytes;
  assert.ok(isTypedArrayLike(out), 'webview nhận Uint8Array (có cả byteLength và length)');
});

// ─── $persistentStore: ghi số liệu chẩn đoán ───────────────────────────────

test('ghi bản ghi chẩn đoán vào $persistentStore khi patch thành công', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(playerWithAd())
  });
  const raw = r.store[YT.STORE_KEY];
  assert.ok(raw, 'phải ghi vào $persistentStore — đây là kênh đọc được duy nhất');
  const rec = JSON.parse(raw);
  assert.strictEqual(rec.lastPhase, 'patched');
  assert.strictEqual(rec.reason, 'patched');
  assert.strictEqual(rec.removed, 2);
  assert.strictEqual(rec.hook, 'v1/player');
  assert.strictEqual(rec.source, 'bodyBytes', 'phải ghi lại đã đọc từ bodyBytes');
  assert.ok(rec.inBytes > 0);
  assert.ok(rec.outBytes > 0 && rec.outBytes < rec.inBytes, 'out phải nhỏ hơn in');
  assert.strictEqual(rec.events, 1);
});

test('ghi nhận "no_ad" khi body không có quảng cáo', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(playerClean())
  });
  const rec = JSON.parse(r.store[YT.STORE_KEY]);
  assert.strictEqual(rec.lastPhase, 'no-ad');
  assert.strictEqual(rec.reason, 'no_ad');
  assert.strictEqual(rec.removed, 0);
});

test('ghi nhận "missing_body" khi không có body — chẩn đoán quan trọng nhất', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: undefined,
    body: undefined
  });
  const rec = JSON.parse(r.store[YT.STORE_KEY]);
  assert.strictEqual(rec.lastPhase, 'no-body');
  assert.strictEqual(rec.reason, 'missing_body');
  assert.strictEqual(rec.inBytes, 0);
  // Không có body thì phải $done({}) — không có gì để giữ
  assert.strictEqual(Object.keys(r.doneCalls[0]).length, 0, 'không có body => $done({})');
});

test('đếm số lần hook chạy qua nhiều lần gọi', () => {
  // Gọi 3 lần trên cùng một store: 3 sự kiện
  const store = {};
  const sandboxBase = {
    $argument: 'ads',
    $environment: { engine: 'jsc' },
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; return true; }
    },
    $httpClient: { get: () => {} },
    $done: () => {},
    console: { log: () => {} }
  };
  const run = (url) => {
    const sb = Object.assign({}, sandboxBase, {
      $request: { url },
      $response: { bodyBytes: new Uint8Array(playerClean()) }
    });
    vm.runInNewContext(ENGINE_SRC, sb);
  };
  run('https://youtubei.googleapis.com/youtubei/v1/player');
  run('https://youtubei.googleapis.com/youtubei/v1/browse');
  run('https://youtubei.googleapis.com/youtubei/v1/next');
  const rec = JSON.parse(store[YT.STORE_KEY]);
  assert.strictEqual(rec.events, 3);
  assert.strictEqual(rec.hook, 'v1/next', 'hook cuối phải là lần chạy gần nhất');
});

test('không có $persistentStore thì không crash', () => {
  const sb = {
    $request: { url: 'https://youtubei.googleapis.com/youtubei/v1/player' },
    $response: { bodyBytes: new Uint8Array(playerWithAd()) },
    $argument: 'ads',
    $environment: { engine: 'jsc' },
    $done: () => {},
    console: { log: () => {} }
  };
  assert.doesNotThrow(() => vm.runInNewContext(ENGINE_SRC, sb));
});

// ─── probe qua mạng: kênh đọc được trong 数据 > 代理 ────────────────────────

test('probe=true gửi GET tới đúng host InnerTube kèm chẩn đoán', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(playerWithAd()),
    argument: 'ads&probe=true'
  });
  assert.strictEqual(r.probes.length, 1, 'phải gửi đúng 1 probe');
  const u = r.probes[0];
  assert.ok(u.startsWith('https://youtubei.googleapis.com/'), 'probe phải đi vào host đã MITM');
  assert.match(u, /xwuan=probe/);
  assert.match(u, /hook=v1%2Fplayer/, 'phải có tên hook');
  assert.match(u, /rm=2/, 'phải có số field đã xoá');
  assert.match(u, /st=patched/);
});

test('probe KHÔNG gửi khi không bật argument — tránh thêm request', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(playerWithAd()),
    argument: 'ads'
  });
  assert.strictEqual(r.probes.length, 0, 'mặc định không được thêm traffic');
});

test('probe gửi cả khi không có ad — để phân biệt "không chạy" với "không có ad"', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(playerClean()),
    argument: 'ads&probe=true'
  });
  assert.strictEqual(r.probes.length, 1);
  assert.match(r.probes[0], /st=no_ad|st=no%5Fad/);
});

test('probe gửi cả khi thiếu body — trường hợp cần biết nhất', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: undefined,
    body: undefined,
    argument: 'ads&probe=true'
  });
  assert.strictEqual(r.probes.length, 1);
  assert.match(r.probes[0], /st=missing_body|st=missing%5Fbody/);
});

test('probe không chứa URL gốc, cookie hay body — không rò dữ liệu', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player?key=SECRET_KEY_123&prettyPrint=false',
    bodyBytes: new Uint8Array(playerWithAd()),
    argument: 'ads&probe=true'
  });
  const u = r.probes[0];
  assert.ok(!u.includes('SECRET_KEY_123'), 'không được làm rò key trong query');
  assert.ok(!u.includes('prettyPrint'), 'không được chuyển tiếp query gốc');
  assert.ok(u.length < 300, 'probe phải ngắn');
});

// ─── youtube_selftest.js ───────────────────────────────────────────────────

const SELFTEST_SRC = fs.readFileSync(SELFTEST, 'utf8');

function runSelftest(store) {
  const doneCalls = [];
  const sb = {
    $request: { url: 'https://www.youtube.com/xwuan-selftest' },
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: () => true
    },
    $done: (r) => doneCalls.push(r)
  };
  vm.runInNewContext(SELFTEST_SRC, sb);
  return doneCalls[0];
}

test('selftest: chưa từng chạy -> state=never_ran', () => {
  const out = runSelftest({});
  assert.ok(out.url.includes('xwuan-report='), 'phải thay URL bằng báo cáo');
  assert.match(out.url, /state=never_ran/);
});

test('selftest: đọc đúng bản ghi do engine ghi', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player',
    bodyBytes: new Uint8Array(playerWithAd())
  });
  const out = runSelftest(r.store);
  const report = decodeURIComponent(out.url.split('xwuan-report=')[1]);
  assert.match(report, /state=ran/);
  assert.match(report, /phase=patched/);
  assert.match(report, /hook=v1\/player/);
  assert.match(report, /rm=2/);
  assert.match(report, /src=bodyBytes/);
});

test('selftest: bản ghi hỏng không làm crash', () => {
  const out = runSelftest({ [YT.STORE_KEY]: '{khong-phai-json' });
  assert.match(out.url, /state=never_ran/);
});

test('selftest: URL gốc không bị rò vào báo cáo', () => {
  const r = runEngine({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player?key=SECRET',
    bodyBytes: new Uint8Array(playerWithAd())
  });
  const out = runSelftest(r.store);
  assert.ok(!out.url.includes('SECRET'), 'báo cáo không được chứa query gốc');
});
