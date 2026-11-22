// Bộ test cho products/spotify/on-device/engine/spotify_ucs.js
//
// Không mock "đại khái": mỗi test dựng payload protobuf đúng wire-format của
// Spotify 9.x rồi chạy script trong sandbox giống Shadowrocket ($request,
// $response, $done), sau đó decode lại để khẳng định kết quả.
//
// Chạy: node --test tests/research/spotify_ucs.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.resolve(__dirname, '../../products/spotify/on-device/engine/spotify_ucs.js');
const RULES_PATH = path.resolve(__dirname, '../../products/spotify/data/ucs-rules.json');
const CODE = fs.readFileSync(SCRIPT_PATH, 'utf8');
const RULES_DATA = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));

/* ----------------------------------------------------------- protobuf mini */

function varint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
  out.push(v);
  return Buffer.from(out);
}

function tag(field, wire) { return varint(field * 8 + wire); }

function ld(field, payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}

function vint(field, value) { return Buffer.concat([tag(field, 0), varint(value)]); }

function readVarint(buf, pos) {
  let value = 0, shift = 0, byte;
  do { byte = buf[pos++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return { value, pos };
}

/** Decode thành [{number, wireType, payload}] - đủ để assert. */
function decode(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const t = readVarint(buf, pos); pos = t.pos;
    const number = Math.floor(t.value / 8), wireType = t.value % 8;
    let payload;
    if (wireType === 0) {
      const v = readVarint(buf, pos); pos = v.pos;
      payload = v.value;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos); pos = len.pos;
      payload = buf.subarray(pos, pos + len.value); pos += len.value;
    } else if (wireType === 1) { payload = buf.subarray(pos, pos + 8); pos += 8; }
    else if (wireType === 5) { payload = buf.subarray(pos, pos + 4); pos += 4; }
    else throw new Error('wire type ' + wireType);
    fields.push({ number, wireType, payload });
  }
  return fields;
}

const getField = (buf, n) => decode(buf).find(f => f.number === n);
const getAll = (buf, n) => decode(buf).filter(f => f.number === n);
const str = (b) => Buffer.from(b).toString('utf8');

/* --------------------------------------------------- payload constructors */

/** map<string, AccountAttribute> */
function attributeMapField(entries, fieldNumber = 1) {
  return Buffer.concat(entries.map(([k, v]) => ld(fieldNumber, Buffer.concat([ld(1, k), ld(2, v)]))));
}

const attrBool = (v) => vint(2, v ? 1 : 0);
const attrLong = (v) => vint(3, v);
const attrStr = (s) => ld(4, s);

/** AssignedValue */
function assignedValue(scope, name, value) {
  const id = ld(1, Buffer.concat([ld(1, scope), ld(2, name)]));
  if (typeof value === 'boolean') return Buffer.concat([id, ld(3, vint(1, value ? 1 : 0))]);
  if (typeof value === 'string') return Buffer.concat([id, ld(5, ld(1, value))]);
  return Buffer.concat([id, ld(4, vint(1, value))]);
}

function ucsResponse({ attributes = null, assignedValues = null } = {}) {
  const parts = [];
  if (assignedValues) {
    const config = Buffer.concat([ld(1, 'cfg-id'), ld(2, Buffer.from([0]))].concat([])); // placeholder, replaced below
    void config;
    const cfg = Buffer.concat([
      ld(1, 'configuration-assignment-id'),
      vint(2, 1700000000000),
      ...assignedValues.map(v => ld(3, v))
    ]);
    parts.push(ld(1, ld(1, cfg)));
  }
  if (attributes) parts.push(ld(3, attributeMapField(attributes)));
  return Buffer.concat(parts);
}

const customizeMessage = (ucs) => ld(1, ucs);
const bootstrapMessage = (ucs) =>
  ld(2, ld(1, ld(1, customizeMessage(ucs))));
const ucsWrapper = (ucs) => ld(1, ld(1, ucs));

/* ------------------------------------------------------------------ runner */

function run({ url, body, status = 200, argument, engine }) {
  let done = null;
  const rawBody = body && Buffer.isBuffer(body) ? body.toString('latin1') : body;
  const sandbox = {
    $request: { url, method: 'POST' },
    $response: { status, body: rawBody },
    $done: (res) => { done = res; },
    $argument: argument,
    console: { log: () => {} },
    Uint8Array, ArrayBuffer, Date, Math, JSON, Object, Array, String, Number, escape, unescape, decodeURIComponent
  };
  if (engine) sandbox.$environment = { engine };
  const logs = [];
  sandbox.console = { log: (m) => logs.push(String(m)) };
  vm.runInNewContext(CODE, sandbox, { timeout: 5000 });
  run.lastLogs = logs;
  run.lastResponseBody = rawBody;
  return done;
}

/** Body trả về là string latin1 -> đưa lại Buffer để decode. */
const asBuffer = (body) => Buffer.from(body, 'latin1');

/**
 * Đọc body mà script trả về, chấp nhận mọi kiểu runtime có thể dùng:
 * string latin1, Uint8Array (webview) hoặc ArrayBuffer (jsc).
 */
function doneBody(done) {
  if (!done || done.body === undefined || done.body === null) return null;
  const b = done.body;
  if (typeof b === 'string') return Buffer.from(b, 'latin1');
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b.buffer, b.byteOffset, b.length);
  if (b instanceof ArrayBuffer) return Buffer.from(new Uint8Array(b));
  throw new Error('kiểu body không hỗ trợ: ' + Object.prototype.toString.call(b));
}

/**
 * Passthrough hợp lệ với binary-body-mode: script PHẢI trả lại nguyên body gốc.
 * `$done({})` là sai vì Shadowrocket hiểu là "body rỗng" -> hỏng response.
 */
function assertPassthrough(done, originalBody) {
  const got = doneBody(done);
  const expected = Buffer.isBuffer(originalBody) ? originalBody : Buffer.from(originalBody || '', 'latin1');
  if (expected.length === 0) {
    assert.deepStrictEqual(Object.keys(done || {}), [], 'body rỗng thì mới được trả {}');
    return;
  }
  assert.ok(got, 'passthrough phải trả body, không được bỏ trống');
  assert.strictEqual(Buffer.compare(got, expected), 0, 'passthrough phải giữ nguyên byte gốc');
}

const BOOTSTRAP_URL = 'https://spclient.wg.spotify.com/bootstrap/v1/bootstrap?abc=1';
const CUSTOMIZE_URL = 'https://spclient.wg.spotify.com/user-customization-service/v1/customize';
const ATTRIBUTES_URL = 'https://spclient.wg.spotify.com/nebula/v1/configuration/attributes';
const REMOTE_CONFIG_URL = 'https://spclient.wg.spotify.com/remote-config-resolver/v3/configuration';

/* ================================ TESTS ================================== */

test('schema đồng bộ đúng số lượng và nội dung từ EeveeSpotifyReincarnated', () => {
  // 260 rule sinh từ upstream + 2 key madprops bổ sung tay (app2smile).
  // Hai key này KHÔNG có trong EeveeSpotify nên chạy sync_ucs_rules.py lần
  // nữa sẽ làm mất — test dưới khẳng định chúng vẫn còn để phát hiện sớm.
  assert.strictEqual(RULES_DATA.rules.length, 262);
  assert.strictEqual(RULES_DATA.counts.setBool, 192);
  assert.strictEqual(RULES_DATA.counts.forceBool, 41);
  assert.strictEqual(RULES_DATA.counts.remove, 28);
  assert.strictEqual(RULES_DATA.counts.setEnum, 1);
  assert.strictEqual(RULES_DATA.server_authoritative_attributes.length, 12);

  // Script nhúng đúng dữ liệu đã sinh.
  assert.ok(CODE.includes('var UCS_RULES = '));
  assert.ok(CODE.includes('"enable_common_capping"'));
  assert.ok(CODE.includes('"premium_gated_start_jam_buttons_enabled"'));
});

test('2 key madprops bổ sung tay vẫn còn (sync upstream sẽ làm mất)', () => {
  const MADD = [
    'com.spotify.madprops.use.ucs.product.state',
    'com.spotify.madprops.delivered.by.ucs'
  ];
  const names = new Set(RULES_DATA.rules.map((r) => r.name));
  MADD.forEach((k) => {
    assert.ok(names.has(k), `thiếu rule "${k}" trong ucs-rules.json`);
    assert.ok(CODE.includes(`"${k}"`), `thiếu rule "${k}" trong engine spotify_ucs.js`);
  });
  MADD.forEach((k) => {
    const rule = RULES_DATA.rules.find((r) => r.name === k);
    assert.strictEqual(rule.action, 'setBool', `${k} phải là setBool`);
    assert.strictEqual(rule.value, true, `${k} phải = true`);
    assert.strictEqual(rule.scope, null, `${k} phải không có scope`);
  });
});

test('tool sync trỏ đúng đường dẫn products/ (đã chuyển từ research/)', () => {
  const tool = fs.readFileSync(
    path.resolve(__dirname, '../../products/spotify/tools/sync_ucs_rules.py'), 'utf8');
  assert.ok(tool.includes('"products", "spotify", "data", "ucs-rules.json"'),
    'DATA_OUT phải trỏ products/spotify/data/');
  assert.ok(tool.includes('"products", "spotify", "on-device", "engine", "spotify_ucs.js"'),
    'SCRIPT_OUT phải trỏ products/spotify/on-device/engine/');
  assert.ok(!tool.includes('"research", "spotify"'),
    'không được còn đường dẫn research/spotify — thư mục đó đã bị xoá');
});

test('bootstrap: gỡ quảng cáo, đặt attribute Premium, bỏ rule capping', () => {
  const attrs = [
    ['type', attrStr('free')],
    ['ads', attrBool(true)],
    ['player-license', attrStr('free')],
    ['payment-state', attrStr('paid')],
    ['offline', attrBool(false)],
    ['very-high-bitrate', attrBool(false)],
    ['some-unknown-future-key', attrStr('keep-me')]
  ];
  const assigned = [
    assignedValue('ios-feature-queue', 'enable_common_capping', true),
    assignedValue('ios-feature-adsbase', 'enable_ads', true),
    assignedValue('ios-feature-settings', 'crossfade_enabled', false),
    assignedValue('other-scope', 'unrelated_flag', true),
    assignedValue('ios-feature-search', 'enable_search_ad', true)
  ];
  const payload = bootstrapMessage(ucsResponse({ attributes: attrs, assignedValues: assigned }));

  const done = run({ url: BOOTSTRAP_URL, body: payload });
  assert.ok(done && done.body, 'script phải trả body đã patch');

  const out = doneBody(done);

  // Đi đúng 3 lớp wrapper.
  const wrapper = getField(out, 2);
  const oneMore = getField(wrapper.payload, 1);
  const message = getField(oneMore.payload, 1);
  const ucs = getField(message.payload, 1);
  assert.ok(ucs, 'CustomizeMessage.response phải còn nguyên');

  const ucsBuf = ucs.payload;
  const attrField = getField(ucsBuf, 3);
  assert.ok(attrField, 'accountAttributes phải tồn tại');

  // Dựng lại map để assert.
  const map = {};
  for (const entry of getAll(attrField.payload, 1)) {
    const k = getField(entry.payload, 1);
    const v = getField(entry.payload, 2);
    map[str(k.payload)] = v.payload;
  }

  assert.strictEqual(JSON.stringify(map.type), JSON.stringify(attrStr('premium')));
  assert.strictEqual(JSON.stringify(map['player-license']), JSON.stringify(attrStr('premium')));
  assert.strictEqual(JSON.stringify(map.ads), JSON.stringify(attrBool(false)));
  assert.strictEqual(JSON.stringify(map.catalogue), JSON.stringify(attrStr('premium')));
  assert.strictEqual(JSON.stringify(map.name), JSON.stringify(attrStr('Spotify Premium')));
  assert.ok(map['product-expiry'], 'product-expiry phải được set (1 năm)');

  // Attribute server-authoritative không bị spoof: giữ nguyên giá trị gốc.
  assert.strictEqual(JSON.stringify(map.offline), JSON.stringify(attrBool(false)));
  assert.strictEqual(JSON.stringify(map['very-high-bitrate']), JSON.stringify(attrBool(false)));
  // và không bị xoá khỏi payload (server cần thấy giá trị thật).
  assert.ok(map.offline, 'offline không được bị xoá');
  assert.ok(map['very-high-bitrate'], 'very-high-bitrate không được bị xoá');

  // Không xoá field lạ.
  assert.ok(map['some-unknown-future-key'], 'field lạ phải được giữ nguyên');

  // payment-state bị gỡ.
  assert.strictEqual(map['payment-state'], undefined);

  // assignedValues: capping và search ad bị xoá, crossfade bật, flag lạ giữ nguyên.
  const resolve = getField(ucsBuf, 1);
  const cfg = getField(resolve.payload, 1);
  const values = getAll(cfg.payload, 3).map(f => f.payload);
  const names = values.map(v => str(getField(getField(v, 1).payload, 2).payload));

  // rule "remove" thì biến mất; rule "setBool" thì GIỮ LẠI với giá trị mới.
  assert.ok(!names.includes('enable_common_capping'), 'rule remove phải bị xoá');
  assert.ok(names.includes('enable_ads'), 'rule setBool phải giữ lại');
  assert.ok(names.includes('enable_search_ad'), 'rule setBool phải giữ lại');
  assert.ok(names.includes('unrelated_flag'), 'flag không có rule phải giữ nguyên');

  const boolOf = (name) => {
    const v = values.find(x => str(getField(getField(x, 1).payload, 2).payload) === name);
    return getField(getField(v, 3).payload, 1).payload;
  };
  assert.strictEqual(boolOf('enable_ads'), 0, 'enable_ads phải thành false');
  assert.strictEqual(boolOf('enable_search_ad'), 0, 'enable_search_ad phải thành false');

  const crossfade = values.find(v => {
    const id = getField(v, 1);
    return str(getField(id.payload, 2).payload) === 'crossfade_enabled';
  });
  const boolField = getField(crossfade, 3);
  assert.ok(boolField, 'crossfade_enabled phải thành boolValue');
  assert.strictEqual(getField(boolField.payload, 1).payload, 1);
});

test('customize: payload UcsResponseWrapper chuẩn được patch', () => {
  const payload = ucsWrapper(ucsResponse({
    attributes: [['type', attrStr('free')], ['ads', attrBool(true)]],
    assignedValues: [assignedValue('ios-feature-queue', 'enable_common_capping', true)]
  }));

  const done = run({ url: CUSTOMIZE_URL, body: payload });
  assert.ok(done && done.body);

  const out = doneBody(done);
  const success = getField(out, 1);
  const ucs = getField(success.payload, 1);
  const attrField = getField(ucs.payload, 3);

  const map = {};
  for (const entry of getAll(attrField.payload, 1)) {
    map[str(getField(entry.payload, 1).payload)] = getField(entry.payload, 2).payload;
  }
  assert.strictEqual(JSON.stringify(map.type), JSON.stringify(attrStr('premium')));
  assert.strictEqual(JSON.stringify(map.ads), JSON.stringify(attrBool(false)));
});

test('customize: payload UcsResponse trần (không có wrapper) vẫn patch được', () => {
  const payload = ucsResponse({ attributes: [['type', attrStr('free')]] });
  const done = run({ url: CUSTOMIZE_URL, body: payload });
  assert.ok(done && done.body);
  const out = doneBody(done);
  const attrField = getField(out, 3);
  assert.ok(attrField, 'phải nhận diện được UcsResponse trần');
});

test('nebula attributes: patch map và bỏ attribute chặn offline/bitrate', () => {
  const payload = attributeMapField([
    ['type', attrStr('free')],
    ['ads', attrBool(true)],
    ['payment-state', attrStr('paid')],
    ['on-demand', attrBool(false)],
    ['audio-quality', attrStr('0')],
    ['offline', attrBool(false)]
  ]);

  const done = run({ url: ATTRIBUTES_URL, body: payload });
  assert.ok(done && done.body);

  const map = {};
  for (const entry of getAll(doneBody(done), 1)) {
    map[str(getField(entry.payload, 1).payload)] = getField(entry.payload, 2).payload;
  }

  assert.strictEqual(JSON.stringify(map.type), JSON.stringify(attrStr('premium')));
  assert.strictEqual(JSON.stringify(map['on-demand']), JSON.stringify(attrBool(true)));
  assert.strictEqual(JSON.stringify(map.catalogue), JSON.stringify(attrStr('premium')));
  assert.strictEqual(map['payment-state'], undefined);
  // audio-quality thuộc nhóm server-authoritative -> giữ nguyên "0", không giả thành "1".
  assert.strictEqual(JSON.stringify(map['audio-quality']), JSON.stringify(attrStr('0')));
});

test('remote config: bật crossfade/automix và tắt ads theo đúng scope', () => {
  const config = Buffer.concat([
    ld(1, 'assignment'),
    vint(2, 1700000000000),
    ld(3, assignedValue('core-playback-setup', 'crossfade_enabled', false)),
    ld(3, assignedValue('ios-feature-settings', 'crossfade_enabled', false)),
    ld(3, assignedValue('ios-feature-adsbase', 'enable_ads', true)),
    ld(3, assignedValue('something-else', 'enable_ads', true))
  ]);
  const payload = ld(1, config);

  const done = run({ url: REMOTE_CONFIG_URL, body: payload });
  assert.ok(done && done.body);

  const out = doneBody(done);
  const cfg = getField(out, 1).payload;
  const values = getAll(cfg, 3).map(f => f.payload);

  const read = (v) => {
    const id = getField(v, 1).payload;
    return {
      scope: str(getField(id, 1).payload),
      name: str(getField(id, 2).payload),
      bool: getField(v, 3) ? getField(getField(v, 3).payload, 1).payload : null
    };
  };
  const list = values.map(read);

  const coreCrossfade = list.find(v => v.scope === 'core-playback-setup' && v.name === 'crossfade_enabled');
  assert.strictEqual(coreCrossfade.bool, 1, 'crossfade phải bật');

  const adsbase = list.find(v => v.scope === 'ios-feature-adsbase');
  assert.strictEqual(adsbase.bool, 0, 'ads phải tắt');

  // Ngữ nghĩa của Eevee: rule không có scope khớp MỌI scope cùng tên.
  // (rule `enable_ads` không scope => áp cho mọi scope.)
  const other = list.find(v => v.scope === 'something-else');
  assert.strictEqual(other.bool, 0, 'rule không scope phải áp cho mọi scope');

  // Còn rule CÓ scope thì chỉ đụng đúng scope đó.
  const settingsCrossfade = list.filter(v => v.name === 'crossfade_enabled');
  assert.ok(settingsCrossfade.length >= 2);
  assert.ok(settingsCrossfade.every(v => v.bool === 1), 'mọi rule có scope đều phải bật');

  // forceBool thêm mới flag vắng mặt.
  const automix = list.find(v => v.name === 'automix_enabled' && v.scope === 'ios-feature-settings');
  assert.ok(automix, 'forceBool phải thêm automix_enabled khi vắng mặt');
  assert.strictEqual(automix.bool, 1);
});

test('mode=ads chỉ chặn quảng cáo, không giả Premium', () => {
  const payload = attributeMapField([['type', attrStr('free')], ['ads', attrBool(true)]]);
  const done = run({ url: ATTRIBUTES_URL, body: payload, argument: 'ads' });
  assert.ok(done && done.body);

  const map = {};
  for (const entry of getAll(doneBody(done), 1)) {
    map[str(getField(entry.payload, 1).payload)] = getField(entry.payload, 2).payload;
  }
  assert.strictEqual(JSON.stringify(map.ads), JSON.stringify(attrBool(false)));
  assert.strictEqual(JSON.stringify(map.type), JSON.stringify(attrStr('free')), 'không được giả Premium ở mode ads');
});

test('mode=off, status 304 và endpoint lạ đều passthrough NGUYÊN body gốc', () => {
  // Khác biệt cốt lõi so với bản trước: binary-body-mode thì $done({}) là
  // "body rỗng" chứ không phải "giữ nguyên" -> phải trả lại byte gốc.
  const payload = attributeMapField([['type', attrStr('free')]]);

  assertPassthrough(run({ url: ATTRIBUTES_URL, body: payload, argument: 'off' }), payload);
  assertPassthrough(
    run({ url: 'https://spclient.wg.spotify.com/collection/v1/library', body: payload }),
    payload
  );

  // 304 / body rỗng: không có gì để giữ nên {} là đúng.
  const notModified = run({ url: ATTRIBUTES_URL, body: Buffer.alloc(0), status: 304 });
  assert.deepStrictEqual(Object.keys(notModified), []);
});

test('$done trả Uint8Array với engine webview, ArrayBuffer với engine jsc', () => {
  // webview (mặc định của Shadowrocket cho http-response): Uint8Array bridge được.
  const webview = run({
    url: ATTRIBUTES_URL,
    body: attributeMapField([['type', attrStr('free')]]),
    engine: 'webview'
  });
  assert.ok(webview.body instanceof Uint8Array, 'webview phải nhận Uint8Array');

  // jsc: Uint8Array không bridge được qua Objective-C -> phải là ArrayBuffer.
  const jsc = run({
    url: ATTRIBUTES_URL,
    body: attributeMapField([['type', attrStr('free')]]),
    engine: 'jsc'
  });
  assert.ok(jsc.body instanceof ArrayBuffer, 'jsc phải nhận ArrayBuffer');

  // Cả hai phải decode ra cùng một attribute map đã patch. Không so sánh byte
  // tuyệt đối: payload có timestamp nên hai lần chạy khác nhau vài byte.
  for (const res of [webview, jsc]) {
    const map = {};
    for (const entry of getAll(doneBody(res), 1)) {
      map[str(getField(entry.payload, 1).payload)] = getField(entry.payload, 2).payload;
    }
    assert.strictEqual(JSON.stringify(map.type), JSON.stringify(attrStr('premium')));
  }
});

test('không bao giờ kèm status/headers khi trả body (tránh lệch content-encoding)', () => {
  const done = run({ url: ATTRIBUTES_URL, body: attributeMapField([['type', attrStr('free')]]) });
  assert.deepStrictEqual(Object.keys(done).sort(), ['body'],
    'chỉ được trả body; kèm headers gốc (gzip/content-length cũ) sẽ làm app giải nén sai');
});

test('argument=debug bật log chẩn đoán ngay trên máy thật', () => {
  run({ url: ATTRIBUTES_URL, body: attributeMapField([['type', attrStr('free')]]), argument: 'debug' });
  const logs = run.lastLogs.join('\n');
  assert.match(logs, /hook chạy/, 'phải log hook có chạy - đây là thứ cần khi test trên điện thoại');
  assert.match(logs, /head=/, 'phải log vài byte đầu để biết body có đúng protobuf không');
});

test('payload JSON (nếu server trả JSON) vẫn patch được', () => {
  const json = JSON.stringify({
    accountAttributes: {
      type: { stringValue: 'free' },
      ads: { boolValue: true }
    }
  });
  const done = run({ url: ATTRIBUTES_URL, body: Buffer.from(json, 'utf8').toString('latin1') });
  assert.ok(done && done.body);
  const parsed = JSON.parse(done.body);
  assert.deepStrictEqual(parsed.accountAttributes.type, { stringValue: 'premium' });
  assert.deepStrictEqual(parsed.accountAttributes.ads, { boolValue: false });
});

test('payload rác không làm script crash và trả lại nguyên body gốc', () => {
  const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x07]);
  assertPassthrough(run({ url: ATTRIBUTES_URL, body: garbage }), garbage);

  const truncated = Buffer.from([0x0a, 0x7f, 0x00]);
  assertPassthrough(run({ url: BOOTSTRAP_URL, body: truncated }), truncated);
});

test('script không chứa mã độc/không gọi mạng ngoài', () => {
  assert.ok(!/require\(/.test(CODE), 'không được require thư viện ngoài');
  assert.ok(!/\bfetch\(|XMLHttpRequest/.test(CODE), 'script không được gọi mạng');
  assert.ok(!/eval\(/.test(CODE), 'không dùng eval');
});
