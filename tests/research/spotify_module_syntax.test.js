// Bộ test bảo vệ CÚ PHÁP module Shadowrocket.
//
// Lý do tồn tại: bản module đầu tiên có 4 lỗi cú pháp mà test protobuf không
// bắt được (engine đúng, cú pháp module sai) -> module im lặng không chạy trên
// điện thoại. File này khẳng định module chỉ dùng những dạng đã đối chiếu với
// module Shadowrocket đang chạy thật.
//
// Nguồn chuẩn: products/spotify/audit/shadowrocket-module-syntax.md
//
// Chạy: node --test tests/research/spotify_module_syntax.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '../../products/spotify/on-device/module/spotify-premium-ucs.module');
const RAW = fs.readFileSync(MODULE_PATH, 'utf8');
const LINES = RAW.split('\n');

/** Gom các dòng theo từng section [...] (bỏ comment và dòng trống). */
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

const SEC = sections();

test('module có đủ 5 section và mỗi section có nội dung', () => {
  for (const name of ['Rule', 'URL Rewrite', 'Header Rewrite', 'MITM', 'Script']) {
    assert.ok(SEC[name] && SEC[name].length > 0, `thiếu section [${name}] hoặc section rỗng`);
  }
});

test('[Header Rewrite] KHÔNG có tiền tố http-request/http-response', () => {
  // Cú pháp thật: "<regex URL> header-del <header>".
  // Có tiền tố type thì type bị coi là một phần của regex -> không khớp gì.
  for (const { line, text } of SEC['Header Rewrite']) {
    const parts = text.split(/\s+/);
    assert.ok(
      !['http-request', 'http-response'].includes(parts[0]),
      `dòng ${line}: bỏ tiền tố "${parts[0]}", cú pháp Shadowrocket là "<regex> header-del <header>"`
    );
    assert.strictEqual(parts.length, 3, `dòng ${line}: phải có đúng 3 phần, đang có ${parts.length}`);
    assert.ok(
      ['header-del', 'header-add', 'header-replace', 'header-replace-regex'].includes(parts[1]),
      `dòng ${line}: hành vi "${parts[1]}" không hợp lệ`
    );
    assert.doesNotThrow(() => new RegExp(parts[0]), `dòng ${line}: regex không compile được`);
  }
});

test('[URL Rewrite] dùng "<regex> _ <action>" và chỉ action đã kiểm chứng', () => {
  const seen = new Set();
  for (const { line, text } of SEC['URL Rewrite']) {
    const m = text.match(/^(.+?)\s_\s(\S+)$/);
    assert.ok(m, `dòng ${line}: phải có dấu phân cách " _ " giữa regex và action`);
    const [, regex, action] = m;
    // reject-dict / reject-array chỉ là rule policy, chưa thấy trong [URL Rewrite]
    // của module thật nào -> không dùng.
    assert.ok(
      ['reject', 'reject-200', 'reject-img', 'reject-tinygif', 'reject-video'].includes(action),
      `dòng ${line}: action "${action}" chưa được xác nhận cho [URL Rewrite]`
    );
    assert.ok(!/\s_\s/.test(regex), `dòng ${line}: regex không được chứa " _ "`);
    assert.doesNotThrow(() => new RegExp(regex), `dòng ${line}: regex không compile được`);
    seen.add(action);
  }
  assert.ok(seen.has('reject-200'), 'phải dùng reject-200 (reject trần làm app retry liên tục)');
});

test('[Rule] dùng token đã xác nhận của Shadowrocket', () => {
  const ruleText = SEC['Rule'].map(r => r.text).join('\n');
  assert.ok(!/PROTOCOL\s*,\s*QUIC/.test(ruleText),
    '"QUIC" là token của Clash/sing-box, Shadowrocket dùng PROTOCOL,UDP');
  assert.ok(/AND,\(\(DOMAIN-SUFFIX,spotify\.com\),\(PROTOCOL,UDP\)\),REJECT/.test(ruleText.replace(/\s/g, '')),
    'phải có rule ép Spotify rời QUIC/HTTP3 bằng PROTOCOL,UDP');
});

test('[Script] có đủ tham số bắt buộc cho protobuf binary', () => {
  const scripts = SEC['Script'];
  assert.strictEqual(scripts.length, 4, 'phải có 4 hook: bootstrap/customize/nebula/remote-config');

  const URLS = {
    bootstrap: 'https://spclient.wg.spotify.com/bootstrap/v1/bootstrap?time=1',
    customize: 'https://spclient.wg.spotify.com/user-customization-service/v1/customize',
    nebula: 'https://spclient.wg.spotify.com/nebula/v1/configuration/attributes',
    'remote-config': 'https://spclient.wg.spotify.com/remote-config-resolver/v3/configuration'
  };

  for (const { line, text } of scripts) {
    const name = text.split('=')[0].trim();
    const kv = {};
    // Bỏ "<tên> =" ở đầu rồi mới tách tham số theo dấu phẩy đứng trước "key=",
    // để không cắt phải dấu phẩy nằm trong regex.
    const params = text.slice(text.indexOf('=') + 1);
    for (const part of params.split(/,\s*(?=[a-z-]+=)/)) {
      const i = part.indexOf('=');
      if (i > 0) kv[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }

    assert.strictEqual(kv.type, 'http-response', `${name}: phải là http-response`);
    assert.strictEqual(kv['requires-body'], '1',
      `${name}: requires-body=1 là bắt buộc, thiếu là body rỗng`);
    assert.strictEqual(kv['binary-body-mode'], '1',
      `${name}: binary-body-mode=1 là bắt buộc cho protobuf`);
    assert.ok(kv['script-path'] && /^https:\/\//.test(kv['script-path']), `${name}: script-path phải là https URL`);
    assert.ok(kv.timeout, `${name}: nên đặt timeout để hook không treo`);
    assert.ok(kv.argument, `${name}: nên đặt argument (full|ads|off)`);

    // max-size: tránh 0 và -1 vì hai nguồn cộng đồng hiểu mâu thuẫn.
    // Dùng số dương đủ lớn (payload USC thực đo ~60 KB).
    const maxSize = Number(kv['max-size']);
    assert.ok(Number.isFinite(maxSize) && maxSize >= 1024 * 1024,
      `${name}: max-size phải là số dương >= 1 MiB, không dùng 0/-1 (đang là ${kv['max-size']})`);

    // Không đặt engine=jsc: mặc định webview bridge được Uint8Array, jsc thì không.
    assert.ok(!kv.engine, `${name}: không đặt engine, để mặc định webview (jsc chỉ nhận ArrayBuffer)`);

    // Pattern phải khớp URL thật của endpoint tương ứng.
    assert.ok(kv.pattern, `${name}: thiếu pattern`);
    const re = new RegExp(kv.pattern);
    const key = Object.keys(URLS).find(k => name.includes(k));
    assert.ok(key, `${name}: tên hook phải chứa endpoint (bootstrap/customize/nebula/remote-config)`);
    assert.ok(re.test(URLS[key]), `${name}: pattern không khớp URL thật ${URLS[key]}`);
  }
});

test('[MITM] dùng %APPEND% và bật h2', () => {
  const text = SEC['MITM'].map(r => r.text.replace(/\s*=\s*/, '=')).join('\n');
  assert.ok(/hostname=%APPEND%/.test(text),
    'thiếu %APPEND% thì module ghi đè hostname của config và làm hỏng module khác');
  assert.ok(/h2\s*=\s*true/.test(text),
    'Spotify 9.x đi HTTP/2; không bật h2 thì phần lớn body không giải mã được');
  for (const host of ['spclient.wg.spotify.com', '*-spclient.spotify.com']) {
    assert.ok(text.includes(host), `MITM thiếu host ${host}`);
  }
});

test('module khai báo đủ 3 điều kiện bắt buộc trong phần đầu', () => {
  const head = LINES.slice(0, 40).join('\n');
  assert.match(head, /HTTPS Decrypt|HTTPS 解密|MITM/i, 'phải nhắc bật HTTPS Decrypt');
  assert.match(head, /UDP/i, 'phải nhắc UDP phải đi qua proxy');
  assert.match(head, /iOS 15/, 'phải nhắc iOS 15+ (giới hạn bộ nhớ NE 50 MB)');
});
