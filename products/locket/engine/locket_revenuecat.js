/**
 * @file locket_revenuecat.js
 * Engine http-response cho RevenueCat — DÙNG ĐƯỢC TRONG MODULE, KHÔNG DÙNG ĐƯỢC QUA DNS.
 *
 * VÌ SAO PHẢI CÓ `report` TRƯỚC KHI `patch`
 * ----------------------------------------
 * RevenueCat ký số response (Trusted Entitlements). SDK từ 4.25 có mã nguồn
 * công khai, và đường kiểm tra của nó là *fail-closed* với các lý do:
 *
 *   missingSignature            -> không có chữ ký
 *   missingSignedPayload        -> không có body/ETag
 *   payloadSignatureMismatch    -> body bị sửa
 *   invalidIntermediateKey      -> chữ ký bịa
 *
 * Nghĩa là: sửa body thì `verification` sẽ là `.failed`. Luôn luôn. Không có
 * cách nào tạo chữ ký đúng vì không có private key của RevenueCat.
 *
 * NHƯNG `.failed` chỉ là THÔNG TIN. Theo docs chính thức: "verification results
 * are informational only — your app must check the verification result and
 * decide how to handle it". Việc từ chối là do code của app, không phải SDK.
 *
 * Vì vậy câu hỏi thật không phải "sửa được không" mà là "SDK có kiểm tra chữ
 * ký trên endpoint này không". Chế độ `report` trả lời đúng câu đó: nó KHÔNG
 * sửa gì, chỉ ghi lại danh sách TÊN header của response. Nếu endpoint này không
 * mang header chữ ký thì verification = notRequested và patch chạy sạch.
 *
 * Chạy:
 *   argument = report        -> chỉ ghi tên header + số entitlement
 *   argument = patch&ek=Gold&pid=com.locket02.premium.yearly
 *                            -> sửa, sau khi report cho biết tên entitlement
 *   argument = off           -> passthrough
 * Thêm `&probe=true` để có một dòng trong 数据 > 代理.
 *
 * GIỚI HẠN CỦA CHÍNH ENGINE NÀY
 * ------------------------------
 * - Không sửa được chữ ký. Không thể. Đừng thử.
 * - Không giữ ETag được hộ bạn: chỉ cần KHÔNG đụng vào headers là Shadowrocket
 *   giữ nguyên chúng. Vì vậy engine chỉ trả `{body}` và không bao giờ trả
 *   `{body, headers}`. Đây là quyết định có chủ đích, đừng "cải tiến" nó.
 * - Không chạy được qua DNS: khi MITM ở server của mình, chuỗi header và
 *   ETag không còn như cũ nên `payloadSignatureMismatch` là chắc chắn.
 */

var STORE_KEY = 'XwuanLocketRCDiag';
var PROBE_URL = 'https://firebaselogging.googleapis.com/v1/xwuan-probe';

/* Tên header mà RevenueCat dùng cho chữ ký, theo mã nguồn công khai.
 * Không cần đúng từng chữ — so khớp theo việc "có header nào chứa chữ
 * signature/sign/key" là đủ để biết endpoint có được ký hay không. */
var SIGNATURE_HEADER_HINTS = ['sign', 'key', 'etag'];

/* ── UTF-8 thủ công: runtime Shadowrocket không có TextDecoder ───────────── */
function utf8Decode(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
        var b = bytes[i] & 0xff;
        var cp;
        if (b < 0x80) { cp = b; i += 1; }
        else if (b >= 0xc0 && b < 0xe0) { cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
        else if (b >= 0xe0 && b < 0xf0) {
            cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3;
        } else if (b >= 0xf0) {
            cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12)
                | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4;
        } else { cp = 0xfffd; i += 1; }
        if (cp > 0xffff) {
            cp -= 0x10000;
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
            out += String.fromCharCode(cp);
        }
    }
    return out;
}

/* ── Chẩn đoán ───────────────────────────────────────────────────────────── */
function readDiag() {
    try {
        if (typeof $persistentStore === 'undefined' || !$persistentStore.read) return null;
        var raw = $persistentStore.read(STORE_KEY);
        if (!raw) return null;
        return (typeof raw === 'string') ? JSON.parse(raw) : raw;
    } catch (e) { return null; }
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
        var q = '?xwuan=rcpay'
            + '&st=' + encodeURIComponent(String(rec.reason || '-'))
            + '&n=' + encodeURIComponent(String(rec.entCount || 0))
            + '&sig=' + encodeURIComponent(String(rec.hasSigHeader || '-'))
            + '&etag=' + encodeURIComponent(String(rec.hasEtag || '-'));
        $httpClient.get({
            url: PROBE_URL + q,
            headers: { 'User-Agent': 'XwuanLocket-Diag/1' }
        }, function () {});
        return true;
    } catch (e) { return false; }
}

/* ── Header helpers ──────────────────────────────────────────────────────── */
function headerNames(headers) {
    var names = [];
    if (!headers || typeof headers !== 'object') return names;
    for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k)) names.push(String(k).toLowerCase());
    }
    return names;
}

function findHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return undefined;
    var want = name.toLowerCase();
    for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k) && String(k).toLowerCase() === want) {
            return headers[k];
        }
    }
    return undefined;
}

/** Có header nào trông như chữ ký không? Đây là câu hỏi quyết định. */
function detectSignatureHeader(headers) {
    var names = headerNames(headers);
    for (var i = 0; i < names.length; i++) {
        for (var j = 0; j < SIGNATURE_HEADER_HINTS.length; j++) {
            if (names[i].indexOf(SIGNATURE_HEADER_HINTS[j]) >= 0) return names[i];
        }
    }
    return '';
}

/* ── Body ────────────────────────────────────────────────────────────────── */
function bodyToText(source) {
    if (source === null || source === undefined) return { text: '', kind: 'empty' };
    if (typeof source === 'string') {
        return source.length ? { text: source, kind: 'json-string' } : { text: '', kind: 'empty' };
    }
    var bytes = null;
    if (typeof source.byteLength === 'number' && typeof source.length !== 'number') {
        var view = new Uint8Array(source);
        bytes = [];
        for (var i = 0; i < view.length; i++) bytes.push(view[i]);
    } else if (typeof source.length === 'number') {
        bytes = [];
        for (var j = 0; j < source.length; j++) bytes.push(source[j] & 0xff);
    }
    if (bytes === null) return { text: '', kind: 'unknown' };
    if (bytes.length === 0) return { text: '', kind: 'empty' };
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return { text: '', kind: 'gzip', bytes: bytes };
    return { text: utf8Decode(bytes), kind: 'bytes', bytes: bytes };
}

/* ── Tham số ─────────────────────────────────────────────────────────────── */
function parseArgs(raw) {
    var out = { mode: 'report', probe: false, ek: '', pid: '', expires: '2099-12-31T23:59:59Z' };
    var text = String(raw === undefined || raw === null ? '' : raw);
    var parts = text.split('&');
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (!p) continue;
        if (p === 'probe') { out.probe = true; continue; }
        var eq = p.indexOf('=');
        if (eq < 0) {
            if (p === 'patch' || p === 'report' || p === 'off') out.mode = p;
            continue;
        }
        var name = p.slice(0, eq).trim();
        var value = p.slice(eq + 1).trim();
        if (name === 'probe') out.probe = (value === 'true' || value === '1');
        else if (name === 'mode' && value) out.mode = value;
        else if (name === 'ek') out.ek = value;
        else if (name === 'pid') out.pid = value;
        else if (name === 'expires') out.expires = value;
        else if ((name === 'patch' || name === 'report' || name === 'off') && value !== 'false') out.mode = name;
    }
    return out;
}

/* ── Lõi: chèn entitlement ───────────────────────────────────────────────── */
/**
 * Không đoán tên entitlement. `ek` và `pid` phải do người dùng cung cấp, vì
 * lấy từ chế độ `report` (hoặc từ remote config đã capture).
 *
 * Trả về { obj, added } — added = 0 nghĩa là không đổi gì.
 */
function injectEntitlement(obj, opts) {
    var added = 0;
    if (!obj || typeof obj !== 'object') return { obj: obj, added: 0 };
    if (!obj.subscriber || typeof obj.subscriber !== 'object') return { obj: obj, added: 0 };
    if (!opts.ek || !opts.pid) return { obj: obj, added: 0 };

    var sub = obj.subscriber;
    if (!sub.entitlements || typeof sub.entitlements !== 'object') sub.entitlements = {};
    if (!sub.subscriptions || typeof sub.subscriptions !== 'object') sub.subscriptions = {};

    if (!sub.entitlements[opts.ek]) {
        sub.entitlements[opts.ek] = {
            grace_period_expires_date: null,
            purchase_date: '2024-01-01T00:00:00Z',
            product_identifier: opts.pid,
            expires_date: opts.expires
        };
        added++;
    }

    if (!sub.subscriptions[opts.pid]) {
        sub.subscriptions[opts.pid] = {
            is_sandbox: false,
            ownership_type: 'PURCHASED',
            billing_issues_detected_at: null,
            period_type: 'normal',
            expires_date: opts.expires,
            grace_period_expires_date: null,
            unsubscribe_detected_at: null,
            original_purchase_date: '2024-01-01T00:00:00Z',
            purchase_date: '2024-01-01T00:00:00Z',
            store: 'app_store'
        };
        added++;
    }

    return { obj: obj, added: added };
}

/** Liệt kê entitlement đang có — để biết tên thật mà dùng cho `ek=`. */
function listEntitlements(obj) {
    var out = { entKeys: [], subKeys: [], entCount: 0 };
    if (!obj || typeof obj !== 'object' || !obj.subscriber) return out;
    var sub = obj.subscriber;
    if (sub.entitlements && typeof sub.entitlements === 'object') {
        for (var k in sub.entitlements) {
            if (Object.prototype.hasOwnProperty.call(sub.entitlements, k)) out.entKeys.push(k);
        }
    }
    if (sub.subscriptions && typeof sub.subscriptions === 'object') {
        for (var s in sub.subscriptions) {
            if (Object.prototype.hasOwnProperty.call(sub.subscriptions, s)) out.subKeys.push(s);
        }
    }
    out.entCount = out.entKeys.length;
    return out;
}

/* ── Entry ───────────────────────────────────────────────────────────────── */
function revenuecatMain() {
    var args = parseArgs(typeof $argument !== 'undefined' ? $argument : '');
    var url = (typeof $request !== 'undefined' && $request && $request.url) ? $request.url : '';
    var response = (typeof $response !== 'undefined') ? $response : null;
    var status = response && response.status !== undefined ? response.status
        : (response && response.statusCode !== undefined ? response.statusCode : 200);
    var headers = response && response.headers ? response.headers : null;

    if (url.indexOf('xwuan=rcpay') >= 0) return { done: { body: '' } };

    var hasEtag = findHeader(headers, 'etag') !== undefined ? 'y' : 'n';
    var sigHeader = detectSignatureHeader(headers);

    /* 304: request-side script không xoá được cache header. Không có body để
     * sửa, và đây là dấu hiệu `locket_rc_request.js` chưa chạy. */
    if (status === 304) {
        var rec304 = diagTick('not-modified', {
            reason: 'not_modified', hasEtag: hasEtag, hasSigHeader: sigHeader || 'n'
        });
        if (args.probe) sendProbe(rec304);
        return { done: {} };
    }

    var parsed = bodyToText(response ? (response.bodyBytes !== undefined && response.bodyBytes !== null
        ? response.bodyBytes : response.body) : null);

    if (parsed.kind === 'empty') {
        var recEmpty = diagTick('empty-body', { reason: 'empty_body', hasEtag: hasEtag });
        if (args.probe) sendProbe(recEmpty);
        return { done: { body: '' } };
    }
    if (parsed.kind === 'gzip') {
        var recZip = diagTick('gzip', { reason: 'gzip_body', hasEtag: hasEtag });
        if (args.probe) sendProbe(recZip);
        return { doneBytes: parsed.bytes };
    }

    var obj = null;
    try {
        obj = JSON.parse(parsed.text);
    } catch (e) {
        var recBad = diagTick('parse-fail', { reason: 'parse_fail', hasEtag: hasEtag });
        if (args.probe) sendProbe(recBad);
        return { done: { body: parsed.text } };
    }

    var listed = listEntitlements(obj);

    if (args.mode === 'report' || args.mode === 'off') {
        var recRep = diagTick(args.mode === 'off' ? 'off' : 'report', {
            reason: args.mode === 'off' ? 'off' : 'report',
            entCount: listed.entCount,
            entKeys: listed.entKeys.join(','),
            subKeys: listed.subKeys.slice(0, 6).join(','),
            hasEtag: hasEtag,
            hasSigHeader: sigHeader || 'n'
        });
        if (args.probe) sendProbe(recRep);
        return { done: { body: parsed.text } };
    }

    /* mode = patch */
    if (!args.ek || !args.pid) {
        var recNoKey = diagTick('need-ek-pid', {
            reason: 'need_ek_pid', entCount: listed.entCount,
            entKeys: listed.entKeys.join(','), hasEtag: hasEtag
        });
        if (args.probe) sendProbe(recNoKey);
        return { done: { body: parsed.text } };
    }

    var applied = injectEntitlement(obj, args);
    var rec = diagTick(applied.added > 0 ? 'patched' : 'already', {
        reason: applied.added > 0 ? 'ok' : 'already_present',
        entCount: listed.entCount,
        entKeys: listed.entKeys.join(','),
        added: applied.added,
        ek: args.ek,
        pid: args.pid,
        hasEtag: hasEtag,
        hasSigHeader: sigHeader || 'n'
    });
    if (args.probe) sendProbe(rec);

    if (applied.added === 0) return { done: { body: parsed.text } };

    /* CHỈ trả body. Không trả headers — như vậy Shadowrocket giữ nguyên ETag và
     * các header khác của response gốc, là điều kiện duy nhất để chuyện này có
     * thể qua được bước kiểm tra chữ ký. Đừng "cải tiến" thành {body, headers}. */
    return { done: { body: JSON.stringify(obj) } };
}

function buildDonePayload(outcome) {
    if (outcome.doneBytes) {
        var buf = new ArrayBuffer(outcome.doneBytes.length);
        var view = new Uint8Array(buf);
        for (var i = 0; i < outcome.doneBytes.length; i++) view[i] = outcome.doneBytes[i];
        return { bodyBytes: buf };
    }
    return outcome.done || {};
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        utf8Decode: utf8Decode,
        bodyToText: bodyToText,
        parseArgs: parseArgs,
        injectEntitlement: injectEntitlement,
        listEntitlements: listEntitlements,
        detectSignatureHeader: detectSignatureHeader,
        findHeader: findHeader,
        STORE_KEY: STORE_KEY,
        PROBE_URL: PROBE_URL
    };
}

if (typeof $request !== 'undefined' && typeof $response !== 'undefined') {
    var __doneOk = false;
    function safeDone(payload) {
        if (__doneOk) return false;
        $done(payload);
        __doneOk = true;
        return true;
    }

    try {
        safeDone(buildDonePayload(revenuecatMain()));
    } catch (e) {
        try { diagTick('exception', { reason: 'exception' }); } catch (_) {}
        try {
            var salvage = bodyToText($response ? ($response.bodyBytes !== undefined && $response.bodyBytes !== null
                ? $response.bodyBytes : $response.body) : null);
            if (salvage.bytes) safeDone(buildDonePayload({ doneBytes: salvage.bytes }));
            else if (salvage.text) safeDone({ body: salvage.text });
            else safeDone({});
        } catch (e2) {
            try { $done({}); } catch (_) {}
        }
    }
}
