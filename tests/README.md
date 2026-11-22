# `tests/` — bộ kiểm thử

```bash
node --test $(find tests -name '*.test.js')   # 83 test
go test ./tests/proxy/...                        # cần Go
```

## Phân bố

| Thư mục | Phủ gì | Số test |
|---|---|---|
| `admin/` | nextdns, mobileconfig (sinh profile DoH), camera_filter_config | 7 |
| `research/` | engine protobuf Spotify + cú pháp module Shadowrocket | 23 |
| `products/` | engine YouTube: protobuf + cú pháp module + kênh chẩn đoán | 50 |
| `scripts/` | filter trong `locket_firebase_response.js` | 1 |
| `proxy/` | Go handler (chưa từng chạy trong môi trường này — không có Go) | ? |

## Nguyên tắc

- **Test phải kiểm tra hành vi thật, không phải mock hình thức.** Ví dụ
  `tests/research/spotify_ucs.test.js` dựng payload protobuf đúng wire-format rồi decode
  lại để khẳng định kết quả.
- Test đường dẫn **tương đối từ `__dirname`**, không dùng `process.cwd()` — để chạy được
  từ mọi thư mục.
- Đặt tên theo thư mục nguồn: test cho `admin/lib/x.js` → `tests/admin/x.test.js`.

## Khoảng trống đã biết

- **`tests/proxy/` chưa từng chạy** ở đây vì sandbox không có Go toolchain. Đừng coi
  "test xanh" là bằng chứng proxy đúng.
- Phần web (auth, Supabase, landing page) **đã gỡ cùng đợt dọn web** — test tương ứng
  cũng đã xoá. Khôi phục bằng `git checkout fcb2d39 -- tests/admin`.
- **5/6 script trong `scripts/` không có test** (chỉ `locket_firebase_response.js` được phủ).
- Chưa có test end-to-end nào chạy trên thiết bị thật. Mọi xác nhận "chạy được trên máy
  thật" phải do người dùng test và gửi log lại.
