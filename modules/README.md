# `modules/` — module chính thức cho app proxy

File cấu hình cài thẳng vào app proxy trên máy user. Đây là **hướng A** (per-user);
hướng B (không cần app) nằm ở `proxy/` + `admin/` + `nextdns/`.

## Locket

| File | App | Cài thế nào |
|---|---|---|
| `Locket_VIP.module` | Shadowrocket | 配置 > 模块 > ➕ > dán raw URL |
| `Locket_RemoteConfig.sgmodule` | Surge | 安装模块 |
| `Locket_RemoteConfig.plugin` | Loon | 插件 |
| `Locket_RemoteConfig.snippet` | Quantumult X | 重写 > 引用 |
| `Locket_RemoteConfig.stoverride` | Stash | Override |

`Locket_VIP.module` là bản **all-in-one** (6 hook script + rule + rewrite);
4 file `RemoteConfig` là cùng logic nhưng viết lại theo cú pháp từng app.

Link cài đặt đầy đủ: xem bảng ở [README gốc](../README.md).

## YouTube

**Không nằm ở đây.** Cùng lý do với Spotify — có module + engine riêng:

```
products/youtube/module/youtube-adblock.module
products/youtube/engine/youtube_adblock.js
```

Xem [products/youtube/README.md](../products/youtube/README.md).

## Spotify

**Không nằm ở đây.** Spotify là sản phẩm nhiều phần nên tách riêng:

```
products/spotify/on-device/module/spotify-premium-ucs.module
```

Lý do tách: Spotify có cả hướng on-device và hướng server, mỗi hướng có README riêng,
dùng chung dữ liệu `products/spotify/data/`. Xem [products/spotify/README.md](../products/spotify/README.md).

## Quy ước khi sửa

- **`script-path` phải là raw URL tuyệt đối**, trỏ về `main`:
  `https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/scripts/<file>.js?v=<ngày>`
- **Tăng `?v=` mỗi lần sửa script.** Shadowrocket cache theo URL đầy đủ; không tăng thì
  user vẫn chạy code cũ dù bạn đã push.
- **[MITM] phải có `%APPEND%`** nếu không sẽ ghi đè danh sách host của config user và làm
  hỏng các module khác.
- Sửa xong chạy `node --test tests/*.test.js tests/*/*.test.js` trước khi push.

Cú pháp Shadowrocket đã đối chiếu (và các lỗi cần tránh):
[`products/spotify/audit/shadowrocket-module-syntax.md`](../products/spotify/audit/shadowrocket-module-syntax.md)
