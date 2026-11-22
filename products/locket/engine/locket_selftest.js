/**
 * @file locket_selftest.js
 * Đọc kết quả chẩn đoán của CẢ HAI engine (Remote Config + RevenueCat) và xuất
 * ra một báo cáo duy nhất.
 *
 * VÌ SAO GỘP
 * ----------
 * Trước đây có hai file self-test và hai URL phải nhớ. Module giờ là một, nên
 * báo cáo cũng một: một chỗ đọc trả lời được cả "cờ có lật không" và "endpoint
 * RevenueCat có bị ký không".
 *
 * CÁCH DÙNG
 * ---------
 * Script này là `type=http-request`. Mở Safari trên máy đã bật proxy:
 *
 *     https://firebaseremoteconfig.googleapis.com/xwuan-selftest
 *
 * (hoặc host bất kỳ trong [MITM] của module — cùng một báo cáo.)
 *
 * Rồi mở `数据 > 代理`, tìm dòng `?xwuan-report=...`. Đọc hai phần:
 *
 *   rc.*   — Firebase Remote Config (engine locket_remoteconfig.js)
 *     rc.state=never_ran | ran
 *     rc.reason=<ok|no_entries|no_template|parse_fail|gzip_body|empty_body>
 *     rc.n=      số key trong Remote Config
 *     rc.fl=     số cờ đã lật
 *     rc.keys=   tên key (lấy từ đây để biết cờ nào cần lật)
 *     rc.eg=     ví dụ key=value thật (chạy `capture` rồi đọc cái này)
 *
 *   pay.*  — RevenueCat (engine locket_revenuecat.js)
 *     pay.state=never_ran | ran
 *     pay.st=    reason: report | ok | already_present | need_ek_pid |
 *                not_modified | parse_fail | gzip_body | empty_body
 *     pay.sig=   n = KHÔNG có header chữ ký (patch sẽ sạch)
 *                <tên header> = CÓ ký (patch có thể failed)
 *     pay.etag=  y | n
 *     pay.entn=  số entitlement hiện có
 *     pay.ent=   tên entitlement (dùng cho ek=)
 *     pay.sub=   product id (dùng cho pid=)
 *
 * Đây là nơi lấy ba tham số: `ek=`, `pid=`, và câu trả lời "có nên patch không".
 */

var RC_STORE = 'XwuanLocketDiag';       /* locket_remoteconfig.js */
var PAY_STORE = 'XwuanLocketRCDiag';    /* locket_revenuecat.js */
var REQ_STORE = 'XwuanLocketReqDiag';   /* locket_rc_request.js */

function readStore(key) {
    try {
        if (typeof $persistentStore === 'undefined' || !$persistentStore.read) return null;
        var raw = $persistentStore.read(key);
        if (!raw) return null;
        return (typeof raw === 'string') ? JSON.parse(raw) : raw;
    } catch (e) {
        return null;
    }
}

function fmt(v) {
    if (v === undefined || v === null || v === '') return '-';
    return String(v);
}

function ageOf(rec) {
    if (!rec || !rec.lastAt) return '-';
    return Math.round((Date.now() - rec.lastAt) / 1000) + 's';
}

function rcPart(url) {
    var d = readStore(RC_STORE);
    var base = url.split('?')[0];
    if (!d) {
        return 'rc.state=never_ran;rc.hint=' + encodeURIComponent('check_mitm_ca_and_route');
    }
    var out = 'rc.state=ran'
        + ';rc.phase=' + encodeURIComponent(fmt(d.lastPhase))
        + ';rc.reason=' + encodeURIComponent(fmt(d.reason))
        + ';rc.mode=' + encodeURIComponent(fmt(d.mode))
        + ';rc.n=' + encodeURIComponent(fmt(d.keyCount))
        + ';rc.fl=' + encodeURIComponent(fmt(d.flipped))
        + ';rc.b64=' + encodeURIComponent(fmt(d.b64Count))
        + ';rc.age=' + encodeURIComponent(ageOf(d))
        + ';rc.keys=' + encodeURIComponent(fmt(d.keys))
        + ';rc.eg=' + encodeURIComponent(fmt(d.eg)).slice(0, 300);
    return out;
}

function payPart() {
    var d = readStore(PAY_STORE);
    var req = readStore(REQ_STORE);

    var parts = [];
    if (!d) {
        parts.push('pay.state=never_ran');
    } else {
        parts.push('pay.state=ran');
        parts.push('pay.st=' + encodeURIComponent(fmt(d.reason)));
        parts.push('pay.sig=' + encodeURIComponent(fmt(d.hasSigHeader)));
        parts.push('pay.etag=' + encodeURIComponent(fmt(d.hasEtag)));
        parts.push('pay.entn=' + encodeURIComponent(fmt(d.entCount)));
        parts.push('pay.ent=' + encodeURIComponent(fmt(d.entKeys)));
        parts.push('pay.sub=' + encodeURIComponent(fmt(d.subKeys)));
        parts.push('pay.age=' + encodeURIComponent(ageOf(d)));
    }
    /* Hook request có chạy không — nếu không, mọi kết quả 304 là do thiếu nó. */
    parts.push('req=' + encodeURIComponent(req ? fmt(req.dropped) : 'never_ran'));
    return parts.join(';');
}

function main() {
    var url = (typeof $request !== 'undefined' && $request && $request.url) ? $request.url : '';
    var report = 'v1;' + rcPart(url) + ';' + payPart();

    /* Thay URL của chính request này bằng bản báo cáo. Vì đây là http-request,
     * Shadowrocket ghi URL mới vào log kết nối — đó là chỗ duy nhất đọc được. */
    var base = url.split('?')[0];
    var out = base + '?xwuan-report=' + report;

    try {
        $done({ url: out });
    } catch (e) {
        try { $done({}); } catch (_) {}
    }
}

try {
    main();
} catch (e) {
    try { $done({}); } catch (_) {}
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readStore: readStore, RC_STORE: RC_STORE, PAY_STORE: PAY_STORE, REQ_STORE: REQ_STORE };
}
