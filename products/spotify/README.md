# Spotify — hai mảng, hai cách tiếp cận

Module Spotify được tổ chức theo **hai hướng triển khai độc lập**, cùng chia sẻ luật
protobuf và kiến thức audit:

```
products/spotify/
├── on-device/     ← MẢNG A: chạy trên máy user, cần cài app (Shadowrocket)
│   ├── module/    ← file .module để import
│   └── engine/    ← JS patch protobuf (chạy trong sandbox của Shadowrocket)
├── server/        ← MẢNG B: máy chủ, KHÔNG cần cài app (chỉ cài profile DNS)
├── audit/         ← tài liệu: đối chiếu upstream, cú pháp, ghi chú cũ
├── data/          ← dữ liệu chia sẻ: 260 luật UCS, danh sách attribute
└── tools/         ← script đồng bộ từ upstream
```

## Chọn mảng nào?

| | **A — on-device** | **B — server** |
|---|---|---|
| User cần cài gì | Shadowrocket (app trả phí) | Chỉ 1 profile `.mobileconfig` |
| Cần máy chủ riêng | **Không** | **Có** (VPS có IP công khai, mở 443) |
| Trạng thái | ✅ Chạy được, đã test | 🚧 Chưa có code — mới ở giai đoạn quyết định hạ tầng |
| Ai vận hành | Từng user tự lo | Bạn phải chạy 24/7 |
| Rủi ro | Thấp | Cao: server sập là mọi user mất kết nối; user phải tin CA của bạn |
| Cần Root CA tin cậy trên máy | CA của Shadowrocket (cục bộ) | **CA của bạn** (nghiêm trọng hơn nhiều) |

Hai mảng **không loại trừ nhau** — có thể phát hành cả hai, dùng chung `data/` và `audit/`.

## Mảng A — on-device (đang chạy)

```bash
# Cài module (dán vào Shadowrocket: Config > Modules > + > Download)
https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/products/spotify/on-device/module/spotify-premium-ucs.module
```

Bắt buộc: bật HTTPS Decrypt + tin cậy CA, bật UDP Forwarding, iOS 15+.
Debug trên máy thật: đổi `argument=full` → `argument=full&debug=true`.

Chi tiết: **[on-device/README.md](on-device/README.md)** ·
Cú pháp & checklist test: **[audit/shadowrocket-module-syntax.md](audit/shadowrocket-module-syntax.md)**

## Mảng B — server (chưa triển khai)

Mục tiêu: user chỉ cài một profile DNS là xong, không cần Shadowrocket.

Kiến trúc bắt buộc (một process giữ 443, phân nhánh theo SNI):

```
:443  →  process duy nhất
         ├─ SNI = dns.ten-mien.com        → DoH resolver
         ├─ SNI = api.revenuecat.com      → MITM, sửa expires_date      (Locket)
         └─ SNI = *.spclient.spotify.com  → MITM, patch protobuf        (Spotify)
```

Quyết định hạ tầng và lý do: **[server/README.md](server/README.md)**

> ⚠️ `server/` hiện **chỉ có tài liệu**, chưa có mã. Chưa chọn được máy chủ thì chưa
> viết code — xem phần "Cần quyết" trong README của mảng B.

## Dữ liệu chia sẻ — `data/`

- `ucs-rules.json` — 260 luật UCS đồng bộ từ EeveeSpotifyReincarnated 7.5.0
  (190 `setBool`, 41 `forceBool`, 28 `remove`, 1 `setEnum`) + 12 attribute
  server-authoritative không được spoof.
- Sinh lại bằng `tools/sync_ucs_rules.py` (xem dưới). Cả mảng A và B đều dùng file này.

## Đồng bộ khi upstream cập nhật

```bash
git clone --depth 1 https://github.com/SideloadLabs/EeveeSpotifyReincarnated /tmp/eevee
python3 products/spotify/tools/sync_ucs_rules.py /tmp/eevee
node --test tests/research/*.test.js
git diff products/spotify/data/ucs-rules.json   # xem luật mới
```

Tool ghi đè cả `data/ucs-rules.json` **và** khối GENERATED trong
`on-device/engine/spotify_ucs.js` (giữa marker `// BEGIN GENERATED RULES`).

## Giới hạn chung của cả hai mảng

EeveeSpotifyReincarnated là tweak nhúng trong app: nó vá protobuf qua network hook
**và** vá ObjC runtime (117 hook group), UI layer, state cục bộ. Cả hai mảng ở đây chỉ
chạm được **lớp HTTP**, nên không đạt parity:

| Tính năng | A on-device | B server | Ghi chú |
|---|---|---|---|
| Chặn quảng cáo | ✅ phần lớn | 🚧 | luật UCS + rewrite |
| UI Premium (`type`, `player-license`…) | ✅ | 🚧 | nếu patch được body |
| Play on-demand, crossfade, automix | ✅ phần lớn | 🚧 | 9.2 dùng `nebula` + `remote-config-resolver` |
| Chống logout | ⚠️ một phần | 🚧 | A: chặn `logout`/`revoke` bằng URL Rewrite |
| Offline / Very High / Jam / Connect | ❌ | ❌ | server quyết định, không vượt được ở tầng mạng |

## Giấy phép / nguồn

Luật và giá trị attribute trích từ EeveeSpotifyReincarnated (**GPL-3.0**). Không có mã
Swift/protobuf nào của upstream được copy — chỉ danh sách cấu hình dạng dữ liệu + logic
viết lại độc lập. Xem §8 trong [audit/eevee-reincarnated-audit.md](audit/eevee-reincarnated-audit.md).

Bản tham chiếu cũ (module của người khác, script protobuf cũ, profile nhặt trên mạng)
đã chuyển sang `archive/spotify/reference/` — **không dùng cho bản phát hành**.
