/**
 * @file youtube_selftest.js
 * Đọc kết quả chẩn đoán của engine YouTube và xuất ra một chỗ đọc được.
 *
 * VÌ SAO CẦN FILE NÀY
 * -------------------
 * Shadowrocket không có trình xem log script:
 *   - `数据 > 代理` chỉ liệt kê kết nối (URL / rule / protocol / MITM), không
 *     có `console.log` của script.
 *   - `$notification.post` không tồn tại trong runtime Shadowrocket.
 * Nên engine ghi số liệu vào `$persistentStore`, còn file này đọc ra.
 *
 * CÁCH DÙNG
 * ---------
 * Script này là `type=http-request` (loại Shadowrocket chạy được). Mở Safari
 * trên máy đã bật proxy, gõ URL bất kỳ vào một host được MITM, ví dụ:
 *
 *     https://www.youtube.com/xwuan-selftest
 *
 * Rồi mở `数据 > 代理` — URL vừa gọi sẽ hiện thành:
 *
 *     https://www.youtube.com/xwuan-selftest?xwuan-report=v1;hook=player;in=8842;...
 *
 * Đọc query đó là biết engine có chạy hay không.
 *
 * Nếu Safari không hiện (vì request bị script của module khác xử lý), vẫn còn
 * cách thứ hai: xem `数据 > 代理` sau khi mở vài video YouTube với
 * `argument=ads&probe=true` — mỗi lần hook chạy sẽ có một dòng
 * `youtubei.googleapis.com/youtubei/v1/keepalive?xwuan=probe&hook=...`.
 */

function readDiag() {
    try {
        if (typeof $persistentStore === 'undefined' || !$persistentStore.read) return null;
        var raw = $persistentStore.read('XwuanYTDiag');
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

function main() {
    var url = (typeof $request !== 'undefined' && $request && $request.url) ? $request.url : '';
    var d = readDiag();

    var report;
    if (!d) {
        /* Không có bản ghi = engine chưa từng chạy qua hook nào. Đây là kết
         * quả chẩn đoán quan trọng nhất, không phải lỗi. */
        report = 'v1;state=never_ran;hint=check_mitm_and_ca';
    } else {
        var ageSec = Math.round((Date.now() - (d.lastAt || 0)) / 1000);
        report = 'v1'
            + ';state=ran'
            + ';events=' + fmt(d.events)
            + ';phase=' + fmt(d.lastPhase)
            + ';reason=' + fmt(d.reason)
            + ';hook=' + fmt(d.hook)
            + ';src=' + fmt(d.source)
            + ';in=' + fmt(d.inBytes)
            + ';out=' + fmt(d.outBytes)
            + ';rm=' + fmt(d.removed)
            + ';age=' + ageSec + 's';
    }

    /* Thay URL của chính request này bằng bản báo cáo. Vì đây là
     * http-request, Shadowrocket sẽ ghi URL mới vào log kết nối — đó là chỗ
     * duy nhất người dùng đọc được. */
    var base = url.split('?')[0];
    var out = base + '?xwuan-report=' + report;

    try {
        $done({ url: out });
    } catch (e) {
        $done({});
    }
}

try {
    main();
} catch (e) {
    $done({});
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readDiag: readDiag };
}
