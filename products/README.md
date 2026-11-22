# `products/` — sản phẩm nhiều phần

Dành cho sản phẩm **không gói gọn trong một file module** — tức là có nhiều hướng triển
khai, có dữ liệu dùng chung, hoặc có tài liệu riêng theo từng hướng.

| Sản phẩm | Trạng thái |
|---|---|
| `spotify/` | Hướng on-device chạy được; hướng server mới có tài liệu |
| `youtube/` | Module Shadowrocket: chặn quảng cáo ở tầng protobuf. 83 test |
| `locket/` | Một module Shadowrocket: Remote Config + RevenueCat. 64 test |

## Khi nào dùng `products/`, khi nào dùng `modules/` + `scripts/`

| | `modules/` + `scripts/` | `products/<tên>/` |
|---|---|---|
| Bản chất | một module + một vài script JS | nhiều phần, nhiều hướng |
| Cấu trúc | phẳng | có `README.md` riêng + thư mục con theo hướng |
| Ví dụ | một ads-blocker nhỏ | Spotify, YouTube, Locket |

Sản phẩm đơn giản thì **đừng** tạo `products/` — chỉ tạo khi có nhiều hướng hoặc
nhiều phần cần tài liệu riêng.

Xem [spotify/README.md](spotify/README.md), [youtube/README.md](youtube/README.md),
[locket/README.md](locket/README.md).
