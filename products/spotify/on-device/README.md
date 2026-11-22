# Mảng A — on-device (Shadowrocket)

Chạy hoàn toàn trên máy user. Không cần máy chủ, không cần hạ tầng.

## Cài đặt

Dán link vào Shadowrocket: **Config > Modules > ➕ > Download**

```
https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/products/spotify/on-device/module/spotify-premium-ucs.module
```

### Ba điều kiện bắt buộc (thiếu 1 là module im lặng)

1. **HTTPS Decrypt + CA tin cậy** — Config > ⓘ > HTTPS Decrypt > Certificate >
   Generate new CA > Install Certificate, rồi iOS **Settings > General > About >
   Certificate Trust Settings** bật cho Shadowrocket. Bước tin cậy này hay bị bỏ qua nhất.
2. **UDP Forwarding** — Settings > UDP > Enable Forwarding. QUIC không bị chặn thì
   script không bao giờ thấy body.
3. **iOS 15+** — từ iOS 15 giới hạn bộ nhớ Network Extension tăng 15 MB → 50 MB.

## Cấu trúc

| File | Vai trò |
|---|---|
| `module/spotify-premium-ucs.module` | 4 hook `[Script]`, 14 pattern chặn ads/upsell, session-protection, `[Header Rewrite]` xoá cache validator, MITM + `h2 = true` |
| `engine/spotify_ucs.js` | Engine patch protobuf tự chứa. Patch 4 payload: `bootstrap`, `customize`, `nebula attributes`, `remote-config-resolver` |

Engine dùng **wire-format thuần, byte-preserving**: field không sửa giữ nguyên byte gốc,
nên field lạ của version Spotify mới vẫn qua được. Không dùng protobufjs, không gọi mạng.

## Chế độ

`argument=` trong 4 dòng `[Script]`:

| Giá trị | Tác dụng |
|---|---|
| `full` (mặc định) | Giả Premium + chặn quảng cáo |
| `ads` | Chỉ chặn quảng cáo, không giả Premium |
| `off` | Tắt patch protobuf, vẫn giữ chặn URL |
| `full&debug=true` | Như `full` + bật log chẩn đoán |

## Test trên điện thoại

Đổi `argument=full` → `argument=full&debug=true` (Config > Module > chạm module >
编辑参数), mở Spotify, xem log Shadowrocket. Bạn cần thấy:

```
[spotify-ucs] hook chạy: attributes | /nebula/v1/configuration/attributes
[spotify-ucs] status=200, body=NNNN bytes, head=0a 0a ...
[spotify-ucs] attributes: X -> Y bytes
```

| Log | Ý nghĩa |
|---|---|
| không thấy `hook chạy` | pattern không khớp, hoặc MITM chưa giải mã host đó |
| `body=none` / `0 bytes` | thiếu `requires-body` hoặc QUIC chưa chặn |
| `decode/patch lỗi` | gửi lại dòng `head=` để soi wire format |
| `không có thay đổi` | body đã đúng Premium từ trước, hoặc rule không khớp |

Xong thì đổi lại `argument=full` để tắt log.

## Lưu ý về Shadowrocket

- `script-path` trỏ `raw.githubusercontent.com` với query `?v=20261118_2`. Sửa script thì
  **phải tăng `?v=`**, Shadowrocket cache theo URL và sẽ không tự tải lại.
- Không đặt `engine=jsc` — mặc định `webview` bridge được `Uint8Array`, `jsc` thì không
  (engine tự nhận biết qua `$environment` và trả `ArrayBuffer` khi cần).
- `max-size=8388608` (8 MiB). Không dùng `0`/`-1` vì hai nguồn cộng đồng hiểu mâu thuẫn.

Cú pháp đầy đủ + nguồn đối chiếu: [../audit/shadowrocket-module-syntax.md](../audit/shadowrocket-module-syntax.md)

## Kiểm thử

```bash
node --test tests/research/spotify_ucs.test.js          # 14 test — engine
node --test tests/research/spotify_module_syntax.test.js # 7 test — cú pháp module
```
