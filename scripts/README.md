# `scripts/` — JS chạy trong app proxy

File ở đây được `modules/*.module` trỏ tới qua raw URL. Đây là phần **thực thi** của
hướng A; phần cấu hình (pattern, MITM, rewrite) nằm trong `modules/`.

## Bản đồ file → module

| File | Loại | Module trỏ tới | Chức năng |
|---|---|---|---|
| `locket_firebase_response.js` | `http-response` | `Locket_VIP.module` | Sửa Remote Config của Locket: mở khoá filter/frame/caption VIP, 60s video, Photobooth |
| `locket_firebase_request.js` | `http-request` | `Locket_RemoteConfig.*` | Xoá cache validator để server trả 200 kèm body |
| `locket_revenuecat_response.js` | `http-response` | `Locket_VIP.module` | Đặt `expires_date` = 9999 cho entitlement |
| `locket_revenuecat_request.js` | `http-request` | `Locket_VIP.module` | Xoá `X-RevenueCat-ETag` để tránh 304 |
| `locket_filter_response.js` | `http-response` | `Locket_VIP.module` | Sửa response `api.locketcamera.com` |
| `locket_pb_req.js` | `http-request` | `Locket_VIP.module` | Xử lý `generateFilteredImage` (AI filter) |

`locket_firebase_response.js` là file lớn nhất (~6.5k dòng) — chứa toàn bộ config filter
nhúng dạng dữ liệu, không phải logic phức tạp.

## Ngoài thư mục này

- `archive/scripts/locket_photobooth.js` — bản cũ, không còn module nào trỏ tới.
- `products/spotify/on-device/engine/` — engine Spotify, tách riêng theo sản phẩm.
- `products/youtube/engine/` — engine chặn quảng cáo YouTube, tách riêng theo sản phẩm.

## Quy ước

- **Không `require`, không `fetch`, không `eval`.** Script chạy trong sandbox của app
  proxy, không có module system và không được gọi mạng ngoài.
- **Chỉ dùng cú pháp ES5** (var, function). JSC/WebView của các app này không đảm bảo
  hỗ trợ arrow function hay `let`/`const` ở mọi phiên bản.
- **Sửa file thì phải tăng `?v=`** trong `modules/` tương ứng, nếu không user vẫn chạy
  bản cache.
- Test hiện có: `tests/scripts/firebase_filters.test.js`. File khác **chưa có test** —
  nếu sửa, nên test tay trên app trước khi push.

Chi tiết về `$done` với body binary và các lỗi cú pháp đã từng gặp:
[`products/spotify/audit/shadowrocket-module-syntax.md`](../products/spotify/audit/shadowrocket-module-syntax.md)
(dùng chung cho cả Locket vì cùng runtime).
