/**
 * @file locket_rc_request.js
 * Engine http-REQUEST cho RevenueCat. BẮT BUỘC phải có trước engine response.
 *
 * VÌ SAO CẦN FILE NÀY
 * -------------------
 * RevenueCat dùng ETag. Nếu app đã có cache hợp lệ, server trả `304 Not
 * Modified` và **không có body** — engine response không có gì để sửa, và nó
 * trả nguyên 304. Kết quả: module "chạy" mà không làm gì, người dùng không
 * hiểu vì sao.
 *
 * Cách xử lý: xoá header cache trên request để buộc server trả 200 kèm toàn bộ
 * body. Đây đúng là việc `deleteHeader.js` làm trong các module Locket Gold
 * đang lưu hành, và là bước `①` trong quy trình 3 bước của họ.
 *
 * Header bị xoá:
 *   If-None-Match      — ETag condition, nguyên nhân chính của 304
 *   If-Modified-Since  — condition theo thời gian
 *
 * KHÔNG xoá `Authorization`, `X-Platform`, `X-Version` hay bất kỳ header nào
 * khác: SDK kiểm tra chữ ký trên (path + api key + thời gian + body), và tự
 * bản thân request có sai header cũng làm app lỗi. Chỉ xoá đúng hai header
 * gây 304.
 */

var DROP_HEADERS = ['If-None-Match', 'If-Modified-Since'];

/** Xoá header theo tên, không phân biệt hoa thường. Trả về danh sách đã xoá. */
function dropHeaders(headers, names) {
    var removed = [];
    if (!headers || typeof headers !== 'object') return removed;
    var wanted = [];
    for (var i = 0; i < names.length; i++) wanted.push(String(names[i]).toLowerCase());

    for (var key in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
        if (wanted.indexOf(String(key).toLowerCase()) >= 0) {
            removed.push(key);
        }
    }
    for (var r = 0; r < removed.length; r++) {
        try { delete headers[removed[r]]; } catch (e) {}
    }
    return removed;
}

/** Ghi lại việc đã xoá, để biết request script có chạy hay không. */
function markDiag(removed) {
    try {
        if (typeof $persistentStore === 'undefined' || !$persistentStore.write) return;
        var rec = { version: '1', lastAt: Date.now(), lastPhase: 'request',
                    reason: 'request_ok', dropped: removed.join(',') || 'none' };
        $persistentStore.write(JSON.stringify(rec), 'XwuanLocketReqDiag');
    } catch (e) {}
}

function requestMain() {
    var headers = (typeof $request !== 'undefined' && $request && $request.headers)
        ? $request.headers : null;
    var removed = dropHeaders(headers, DROP_HEADERS);
    markDiag(removed);
    /* Trả lại headers đã sửa. Không trả `url` hay `body` — không cần đụng. */
    return { headers: headers || {} };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { dropHeaders: dropHeaders, DROP_HEADERS: DROP_HEADERS };
}

if (typeof $request !== 'undefined' && typeof $response === 'undefined') {
    try {
        $done(requestMain());
    } catch (e) {
        try { $done({}); } catch (_) {}
    }
}
