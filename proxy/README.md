# `proxy/` — Go TLS MITM proxy (hướng B: không cần cài app)

Server gốc của hướng B. Nhận traffic đã được DNS dẫn về, ký cert giả bằng CA mà máy
đã tin cậy, sửa nội dung response, trả về.

## Cách nó chạy

```
Thiết bị (đã cài Xwuan_DNS.mobileconfig)
   │  DNS DoH → NextDNS rewrite 4 domain Locket về IP của proxy này
   ↓
TCP 443 tới proxy
   ↓
GetConfigForClient  → đọc SNI (vd. api.revenuecat.com)
                    → ký cert lá bằng Root CA (ca/root-ca.crt)
   ↓
ModifyResponse      → sửa JSON / protobuf
   ↓
trả về thiết bị
```

## File

| File | Vai trò |
|---|---|
| `main.go` | Listener TLS, SNI routing, cache header stripping, dispatch theo host/path |
| `handler/revenuecat.go` | Sửa `expires_date` + `subscriber` entitlement |
| `handler/firebase.go` | Sửa Remote Config của Locket |
| `handler/locket_api.go` | Sửa response `api.locketcamera.com` |
| `handler/photobooth.go` | Photobooth 4-cut |
| `handler/camera_filter_config.json` | Config filter/sticker nhúng (~4k dòng dữ liệu) |
| `tls/ca.go` | Load Root CA, ký leaf cert |
| `tls/cache.go` | Cache cert theo host (reset map ở 500 entry) |
| `fly.toml` + `Dockerfile` | Deploy Fly.io |

## Deploy

```bash
fly deploy --config proxy/fly.toml
```

**Lưu ý về Fly:** `handlers = []` trong `[[services.ports]]` là raw TCP passthrough, và
theo tài liệu Fly, cấu hình này **bắt buộc dedicated IPv4** (`flyctl ips allocate-v4`,
+$2/tháng). Shared IPv4 chỉ hỗ trợ HTTP/S trên 80/443.

Root CA key đọc từ biến môi trường `ROOT_CA_CRT` / `ROOT_CA_KEY`, nếu không có thì đọc
`ca/root-ca.crt` + `ca/root-ca.key`. **File `.key` không nằm trong git**
(xem `.gitignore`) — phải nạp qua `fly secrets`.

## Test

```bash
go test ./tests/proxy/...
```

⚠️ **Chưa từng chạy trong môi trường này** vì sandbox không có Go toolchain. Cần chạy ở
máy có Go trước khi tin vào phần này.

## Thêm app mới (ví dụ Spotify)

Đã có sẵn 2 thứ cần thiết: SNI routing (`GetConfigForClient`) và cert forging (`tls/*`).
Chỉ cần thêm handler mới và một nhánh trong `ModifyResponse` của `main.go`.

Với Spotify phải patch **protobuf**, không phải JSON. Logic đã có sẵn bản JS:
`products/spotify/on-device/engine/spotify_ucs.js` — port sang Go. Nguyên tắc quan trọng
nhất của bản JS: **encode byte-preserving** (field không sửa giữ nguyên byte gốc) và
**passthrough nguyên body khi có bất kỳ lỗi nào**. Đừng trả body rỗng.

Xem `products/spotify/server/README.md` cho yêu cầu hạ tầng và kiến trúc.
