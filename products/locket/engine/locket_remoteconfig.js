/**
 * @file locket_remoteconfig.js
 * Engine cho Shadowrocket: đọc và sửa Firebase Remote Config của Locket.
 *
 * VÌ SAO NHẮM VÀO REMOTE CONFIG (không phải RevenueCat)
 * -----------------------------------------------------
 * RevenueCat trả entitlement có chữ ký (Trusted Entitlements, iOS SDK 4.25+).
 * Sửa response đó có thể bị SDK đánh dấu `verification = .failed` và app từ
 * chối — tức là sửa cũng bằng không, mà còn để lại dấu vết.
 *
 * Firebase Remote Config thì khác hẳn:
 *   POST https://firebaseremoteconfig.googleapis.com
 *        /v1/projects/<project>/namespaces/firebase:fetch?key=<api key>
 *   -> { "entries": { "key": "value", ... }, "state": "UPDATE" }
 * Không chữ ký, không mã hoá, không ràng buộc. Đây là store cờ bật/tắt tính
 * năng mà app đọc lúc khởi động. Feature flag nằm ở đây thì sửa ở đây là đủ.
 *
 * GIỚI HẠN PHẢI BIẾT TRƯỚC
 * -------------------------
 * 1. Nếu tính năng được backend kiểm tra lại (mỗi lần gọi API, server tự xem
 *    tài khoản có quyền không) thì sửa cờ chỉ đổi được GIAO DIỆN. Không có
 *    cách nào vượt qua chuyện đó ở tầng HTTP. Đây là rủi ro thật, không phải
 *    lỗi của module.
 * 2. Nếu app dùng A/B test (mỗi người một nhánh khác nhau) thì key có thể
 *    khác nhau giữa các máy. Vì vậy engine này KHÔNG hard-code tên key của
 *    Locket — nó dựa vào *hình dạng tên key* và chế độ `capture` để bạn thấy
 *    key thật.
 * 3. Cờ boolean chỉ được lật khi giá trị hiện tại đúng là false/0/no/off.
 *    Không bao giờ ghi đè một giá trị khác — thà bỏ sót còn hơn làm hỏng
 *    cấu hình của app.
 *
 * BA CHẾ ĐỘ (argument)
 * --------------------
 *   flags            (mặc định) lật cờ boolean có tên giống cờ tính năng
 *   capture          KHÔNG sửa gì, chỉ ghi lại tên key + giá trị để đọc
 *   off              tắt hoàn toàn, chỉ passthrough
 * Thêm `&probe=true` để gửi chẩn đoán ra log kết nối (xem README).
 *
 * KHÔNG BAO GIỜ gửi body, token, hay URL gốc ra ngoài. Kênh chẩn đoán chỉ
 * gửi số đếm, tên key, và URL do chính engine dựng.
 */

var STORE_KEY = 'XwuanLocketDiag';
/* Host này chỉ dùng để tạo MỘT dòng trong `数据 > 代理`. Nó không được nằm
 * trong danh sách MITM của module, nên request đi thẳng — mục đích duy nhất
 * là để lại dấu vết đọc được, không phải để server nào nhận dữ liệu. */
var PROBE_URL = 'https://firebaselogging.googleapis.com/v1/xwuan-probe';

/* ── Token nhận diện cờ tính năng ──────────────────────────────────────────
 * So khớp theo TOKEN, không theo substring: "pro" phải là một token riêng,
 * nếu không `project`, `product`, `process` đều bị coi là cờ. Đây là lỗi dễ
 * mắc nhất khi viết loại script này. */
var FLAG_TOKENS = [
    'gold', 'premium', 'pro', 'vip', 'plus',
    'subscri', 'subscribed', 'subscription', 'entitle', 'entitled',
    'paywall', 'trial', 'unlock', 'unlimited', 'purchase', 'paid'
];

/* Token mà nếu xuất hiện thì TUYỆT ĐỐI không sửa, kể cả khi cũng có token
 * cờ ở chỗ khác trong cùng tên key (ví dụ `premium_url`). */
var SKIP_TOKENS = [
    'url', 'uri', 'endpoint', 'host', 'domain', 'path', 'token', 'key',
    'secret', 'id', 'uuid', 'version', 'bundle', 'project', 'app', 'env',
    'region', 'locale', 'lang', 'currency', 'price', 'product', 'store',
    'timeout', 'interval', 'delay', 'retry'
];

var FALSE_VALUES = { 'false': 1, '0': 1, 'no': 1, 'off': 1, 'disabled': 1 };

/* ── UTF-8 thủ công ────────────────────────────────────────────────────────
 * Runtime script của Shadowrocket thiếu TextDecoder/TextEncoder (đã có báo
 * cáo: script gốc của module Spotify chết vì `ReferenceError: TextEncoder is
 * not defined`). Không được giả định chúng tồn tại. */
function utf8Decode(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
        var b = bytes[i] & 0xff;
        var cp;
        if (b < 0x80) {
            cp = b; i += 1;
        } else if (b >= 0xc0 && b < 0xe0) {
            cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2;
        } else if (b >= 0xe0 && b < 0xf0) {
            cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3;
        } else if (b >= 0xf0) {
            cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12)
                | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4;
        } else {
            cp = 0xfffd; i += 1;
        }
        if (cp > 0xffff) {
            cp -= 0x10000;
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
            out += String.fromCharCode(cp);
        }
    }
    return out;
}

function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) {
            out.push(c);
        } else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
            var lo = str.charCodeAt(i + 1);
            var cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
            i += 1;
        } else {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return out;
}

/* ── Base64 (một số giá trị Remote Config được mã hoá base64) ───────────── */
var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64DecodeToBytes(s) {
    var clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    var out = [];
    var buf = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
        var v = B64_CHARS.indexOf(clean[i]);
        if (v < 0) continue;
        buf = (buf << 6) | v; bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 0xff);
        }
    }
    return out;
}

/** Chỉ coi là base64 khi giải ra được chuỗi in được và trông giống chữ. */
function looksLikeBase64Text(value) {
    if (typeof value !== 'string') return null;
    if (value.length < 4 || value.length % 4 !== 0) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
    var bytes = base64DecodeToBytes(value);
    if (!bytes.length) return null;
    var printable = 0;
    for (var i = 0; i < bytes.length; i++) {
        var b = bytes[i];
        if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
        else if (b >= 0xc0) printable++; /* byte đầu của UTF-8 nhiều byte */
        else return null;
    }
    if (printable !== bytes.length) return null;
    return utf8Decode(bytes);
}

/* ── Tách token từ tên key ──────────────────────────────────────────────────
 * `isPremiumUser`, `premium_user`, `PREMIUM-USER` đều phải cho cùng token. */
function tokensOf(key) {
    var spaced = String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/);
    var out = [];
    for (var i = 0; i < spaced.length; i++) {
        if (spaced[i]) out.push(spaced[i]);
    }
    return out;
}

function hasAnyToken(tokens, list) {
    for (var i = 0; i < tokens.length; i++) {
        for (var j = 0; j < list.length; j++) {
            if (tokens[i] === list[j]) return true;
        }
    }
    return false;
}

/** Key này có phải là cờ tính năng nên lật không? */
function isFlagKey(key) {
    var t = tokensOf(key);
    if (!t.length) return false;
    if (hasAnyToken(t, SKIP_TOKENS)) return false;
    return hasAnyToken(t, FLAG_TOKENS);
}

/** Giá trị hiện tại có đúng là "tắt" để được phép lật sang "bật" không? */
function isOffValue(value) {
    if (typeof value !== 'string') return false;
    return FALSE_VALUES[value.trim().toLowerCase()] === 1;
}

/* ── Chẩn đoán (Shadowrocket không xem được console.log) ─────────────────── */
function readDiag() {
    try {
        if (typeof $persistentStore === 'undefined' || !$persistentStore.read) return null;
        var raw = $persistentStore.read(STORE_KEY);
        if (!raw) return null;
        return (typeof raw === 'string') ? JSON.parse(raw) : raw;
    } catch (e) {
        return null;
    }
}

function writeDiag(rec) {
    try {
        if (typeof $persistentStore === 'undefined' || !$persistentStore.write) return;
        $persistentStore.write(JSON.stringify(rec), STORE_KEY);
    } catch (e) {}
}

function diagTick(phase, patch) {
    var rec = readDiag() || {};
    rec.version = '1';
    rec.lastAt = Date.now();
    rec.events = (rec.events || 0) + 1;
    rec.lastPhase = phase;
    if (patch) {
        for (var k in patch) {
            if (Object.prototype.hasOwnProperty.call(patch, k)) rec[k] = patch[k];
        }
    }
    writeDiag(rec);
    return rec;
}

function sendProbe(rec) {
    try {
        if (typeof $httpClient === 'undefined' || !$httpClient.get) return false;
        /* Chỉ số đếm — KHÔNG gửi tên key, giá trị, hay URL gốc. Tên key và ví
         * dụ giá trị nằm trong $persistentStore, đọc ra bằng selftest. Probe
         * chỉ cần trả lời một câu: engine có chạy không, và nó thấy gì. */
        var q = '?xwuan=rc'
            + '&st=' + encodeURIComponent(String(rec.reason || '-'))
            + '&n=' + encodeURIComponent(String(rec.keyCount || 0))
            + '&fl=' + encodeURIComponent(String(rec.flipped || 0))
            + '&b64=' + encodeURIComponent(String(rec.b64Count || 0));
        $httpClient.get({
            url: PROBE_URL + q,
            headers: { 'User-Agent': 'XwuanLocket-Diag/1' }
        }, function () {});
        return true;
    } catch (e) {
        return false;
    }
}

/* ── Đọc body từ mọi dạng runtime có thể đưa vào ─────────────────────────── */
function pickBodySource(response) {
    if (!response) return null;
    if (response.bodyBytes !== undefined && response.bodyBytes !== null) return response.bodyBytes;
    if (response.body !== undefined && response.body !== null) return response.body;
    return null;
}

/** Trả về { text, kind } — kind: json-string | bytes | empty | gzip | unknown */
function bodyToText(source) {
    if (source === null || source === undefined) return { text: '', kind: 'empty' };

    if (typeof source === 'string') {
        if (source.length === 0) return { text: '', kind: 'empty' };
        return { text: source, kind: 'json-string' };
    }

    /* ArrayBuffer hoặc Uint8Array. Không dùng `instanceof` — khi chạy trong
     * sandbox khác realm thì luôn false. Phân biệt bằng hình dạng. */
    var bytes = null;
    if (typeof source.byteLength === 'number' && typeof source.length !== 'number') {
        bytes = [];
        var view = new Uint8Array(source);
        for (var i = 0; i < view.length; i++) bytes.push(view[i]);
    } else if (typeof source.length === 'number') {
        bytes = [];
        for (var j = 0; j < source.length; j++) bytes.push(source[j] & 0xff);
    }
    if (bytes === null) return { text: '', kind: 'unknown' };
    if (bytes.length === 0) return { text: '', kind: 'empty' };
    /* gzip không giải nén được trong runtime này — nhận ra và passthrough. */
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return { text: '', kind: 'gzip', bytes: bytes };
    return { text: utf8Decode(bytes), kind: 'bytes', bytes: bytes };
}

/* ── Lõi: áp cờ lên object JSON của Remote Config ────────────────────────── */
/**
 * @param {object} obj     parsed response
 * @param {string} mode    flags | capture | off
 * @returns {{obj: object, stats: object}}
 */
function applyFlags(obj, mode) {
    var stats = {
        keyCount: 0, flipped: 0, b64Count: 0,
        keyNames: [], examples: [], flagsSeen: [], reason: '-'
    };

    if (!obj || typeof obj !== 'object' || !obj.entries || typeof obj.entries !== 'object') {
        stats.reason = obj && obj.state === 'NO_TEMPLATE' ? 'no_template' : 'no_entries';
        return { obj: obj, stats: stats };
    }

    var keys = [];
    for (var k in obj.entries) {
        if (Object.prototype.hasOwnProperty.call(obj.entries, k)) keys.push(k);
    }
    stats.keyCount = keys.length;
    if (stats.keyCount > 0) stats.reason = 'ok';

    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var raw = obj.entries[key];

        if (stats.keyNames.length < 12) stats.keyNames.push(key);

        var decoded = looksLikeBase64Text(raw);
        if (decoded !== null) stats.b64Count++;

        if (isFlagKey(key)) {
            stats.flagsSeen.push(key);
            if (mode === 'flags' && isOffValue(raw)) {
                obj.entries[key] = 'true';
                stats.flipped++;
            }
        }

        if (stats.examples.length < 4) {
            var shown = decoded !== null ? ('b64:' + decoded.slice(0, 24)) : String(raw).slice(0, 24);
            stats.examples.push(key + '=' + shown);
        }
    }

    return { obj: obj, stats: stats };
}

/* ── Tham số ─────────────────────────────────────────────────────────────── */
function parseArgs(raw) {
    var out = { mode: 'flags', probe: false };
    var text = String(raw === undefined || raw === null ? '' : raw);
    var parts = text.split('&');
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (!p) continue;
        if (p === 'probe') { out.probe = true; continue; }
        var eq = p.indexOf('=');
        if (eq < 0) {
            if (p === 'flags' || p === 'capture' || p === 'off') out.mode = p;
            continue;
        }
        var name = p.slice(0, eq).trim();
        var value = p.slice(eq + 1).trim();
        if (name === 'probe') out.probe = (value === 'true' || value === '1');
        else if (name === 'mode' && value) out.mode = value;
        else if ((name === 'flags' || name === 'capture' || name === 'off') && value !== 'false') out.mode = name;
    }
    return out;
}

/* ── Entry ───────────────────────────────────────────────────────────────── */
function locketMain() {
    var args = parseArgs(typeof $argument !== 'undefined' ? $argument : '');
    var url = (typeof $request !== 'undefined' && $request && $request.url) ? $request.url : '';
    var source = pickBodySource(typeof $response !== 'undefined' ? $response : null);
    var parsed = bodyToText(source);

    /* Chính request chẩn đoán của mình không được đi qua engine — tránh vòng
     * lặp và tránh ghi đè số liệu vừa tạo. */
    if (url.indexOf('xwuan=rc') >= 0) {
        return { done: { body: parsed.text } };
    }

    if (parsed.kind === 'empty') {
        var recEmpty = diagTick('empty-body', {
            reason: 'empty_body', inBytes: 0, keyCount: 0, flipped: 0
        });
        if (args.probe) sendProbe(recEmpty);
        return { done: { body: '' } };
    }

    if (parsed.kind === 'gzip') {
        /* Không giải nén được: passthrough NGUYÊN BYTE, không được trả body
         * rỗng — trả rỗng là làm hỏng request của app. */
        var recZip = diagTick('gzip', { reason: 'gzip_body', inBytes: parsed.bytes.length });
        if (args.probe) sendProbe(recZip);
        return { doneBytes: parsed.bytes };
    }

    var obj = null;
    try {
        obj = JSON.parse(parsed.text);
    } catch (e) {
        var recBad = diagTick('parse-fail', {
            reason: 'parse_fail', inBytes: parsed.text.length
        });
        if (args.probe) sendProbe(recBad);
        return { done: { body: parsed.text } };
    }

    var result = applyFlags(obj, args.mode);
    var stats = result.stats;

    var rec = diagTick(stats.reason === 'ok' ? 'patched' : stats.reason, {
        reason: stats.reason,
        mode: args.mode,
        inBytes: parsed.text.length,
        keyCount: stats.keyCount,
        flipped: stats.flipped,
        b64Count: stats.b64Count,
        keys: stats.keyNames.join(','),
        eg: stats.examples.join('|')
    });
    if (args.probe) sendProbe(rec);

    if (args.mode === 'off' || stats.reason !== 'ok' || stats.flipped === 0) {
        /* Không có gì đổi -> trả nguyên body gốc. */
        return { done: { body: parsed.text } };
    }

    return { done: { body: JSON.stringify(result.obj) } };
}

/* Dựng payload cho $done. KHÔNG bắt lỗi ở đây — để ngoại lệ nổi lên cho
 * entry xử lý, vì chỗ này không biết body gốc là gì nên không cứu được.
 * (Bản trước bắt lỗi và gọi $done({}) — đúng cái lỗi body-rỗng cần tránh.) */
function buildDonePayload(outcome) {
    if (outcome.doneBytes) {
        var buf = new ArrayBuffer(outcome.doneBytes.length);
        var view = new Uint8Array(buf);
        for (var i = 0; i < outcome.doneBytes.length; i++) view[i] = outcome.doneBytes[i];
        return { bodyBytes: buf };
    }
    return outcome.done || {};
}

/* Export cho test Node. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        utf8Decode: utf8Decode,
        utf8Encode: utf8Encode,
        base64DecodeToBytes: base64DecodeToBytes,
        looksLikeBase64Text: looksLikeBase64Text,
        tokensOf: tokensOf,
        isFlagKey: isFlagKey,
        isOffValue: isOffValue,
        bodyToText: bodyToText,
        applyFlags: applyFlags,
        parseArgs: parseArgs,
        STORE_KEY: STORE_KEY,
        PROBE_URL: PROBE_URL,
        FLAG_TOKENS: FLAG_TOKENS,
        SKIP_TOKENS: SKIP_TOKENS
    };
}

/* Entry: try/catch để MỌI nhánh đều trả body. Thiếu bước này thì một
 * exception sẽ làm request treo tới timeout và app chờ vô ích.
 *
 * `safeDone` chỉ cho $done chạy một lần THÀNH CÔNG. Nếu $done ném lỗi, cờ
 * chưa bật, nên nhánh cứu còn được gọi lại với body gốc. */
if (typeof $request !== 'undefined' && typeof $response !== 'undefined') {
    var __doneOk = false;
    function safeDone(payload) {
        if (__doneOk) return false;
        $done(payload);
        __doneOk = true;
        return true;
    }

    try {
        safeDone(buildDonePayload(locketMain()));
    } catch (e) {
        try { diagTick('exception', { reason: 'exception' }); } catch (_) {}
        /* KHÔNG trả `$done({})` ở đây: đó là body RỖNG, app sẽ hỏng response.
         * Cố trả lại đúng những gì nhận được, dù chỉ là chuỗi đã đọc. */
        try {
            var salvage = bodyToText(pickBodySource($response));
            if (salvage.bytes) {
                safeDone(buildDonePayload({ doneBytes: salvage.bytes }));
            } else if (salvage.text) {
                safeDone({ body: salvage.text });
            } else {
                safeDone({});
            }
        } catch (e2) {
            try { $done({}); } catch (_) {}
        }
    }
}
