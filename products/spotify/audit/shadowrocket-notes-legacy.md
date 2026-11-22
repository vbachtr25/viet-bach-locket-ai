# Ghi chú nghiên cứu: Shadowrocket module cho Spotify DNS rewrite

## 1) Nguồn dữ liệu (raw)
- Repo clone: `../../EeveeSpotifyReborn` (branch `swift`, `whoeevee/EeveeSpotifyReborn`)
- Trích xuất URL/domain: `../raw-data/eevee-repo-extracted.txt`
- Tổng hợp domain Spotify/DNS: `../raw-data/spotify-dns-raw-data.txt` (gồm domain từ `Spotify.mobileconfig`, `UpLocket_xwuan1.mobileconfig` và endpoint tìm thấy trong repo)

Phát hiện trong source EeveeSpotify:
- `spclient.wg.spotify.com`
- `https://spclient.wg.spotify.com/pam-view-service/v1/GetPremiumPlanRow` (`Sources/EeveeSpotify/Premium/Models/Protobuf/PremiumPlanRow.pb.swift`)
- Bootstrap: app hook request có path chứa `v1/bootstrap`
  - `Sources/EeveeSpotify/Shared/Models/Extensions/URL+Extension.swift` → `isBootstrap: path.contains("v1/bootstrap")`
  - `Sources/EeveeSpotify/Premium/DynamicPremium+ModifyBootstrap.x.swift` → bắt bootstrap, deserialize `BootstrapMessage`, sửa `UCSResponse` / `accountAttributes` (remote config, v.v.) rồi trả serialized bytes đã sửa
- Cơ chế gốc: **hook/sửa trong app (client-side)**, không phải DNS trả kết quả đặc biệt.

## 2) Khả năng của Shadowrocket module (liên quan)
- **`[Host]`**: ánh xạ tên miền → IP (DNS rewrite/override tại client). Dùng để trỏ domain Spotify về IP gateway/proxy tự kiểm soát.
  - Ví dụ: `spclient.wg.spotify.com = 203.0.113.10`
- **`[MITM]`**: giải mã HTTPS cho hostname chỉ định. Shadowrocket tự tạo/quản lý Root CA — chỉ cần bật MITM và cài/tin cậy CA của Shadowrocket trên thiết bị (không cần tự tạo CA như hướng DoH/mobileconfig).
  - Gợi ý hostname: `spclient.wg.spotify.com`, `*-spclient.spotify.com`, `spclient.spotify.com`, `apresolve.spotify.com`, `login5.spotify.com` (mở rộng theo `raw-data/spotify-dns-raw-data.txt`)
- **`[Script]`**: can thiệp request/response (vd `type=http-response`, `requires-body=1`, `binary-body-mode=1`, `pattern=...`, `script-path=...`).
  - Phù hợp để hook endpoint và sửa body nếu có logic phù hợp.
- **`[Rule]` / `[URL Rewrite]`**: bổ trợ định tuyến hoặc rewrite URL khi cần.

## 3) Endpoint mục tiêu ưu tiên (từ nghiên cứu repo)
| Mục tiêu | Pattern/URL gợi ý | Ghi chú |
|---|---|---|
| Bootstrap/user attributes | `^https:\/\/[^\/]*spclient[^\/]*\.spotify\.com\/.*\/bootstrap` | Eevee sửa `BootstrapMessage`/`UCSResponse.accountAttributes` (protobuf) |
| Premium plan row | `^https:\/\/spclient\.wg\.spotify\.com\/pam-view-service\/v1\/GetPremiumPlanRow` | Có trong comment protobuf; response protobuf |
| Các domain spclient/apresolve khác | theo `raw-data/spotify-dns-raw-data.txt` | Có thể cần cho routing/MITM tùy chiến lược |

## 4) Hiện trạng demo trong `../shadowrocket/` (đã cập nhật theo mẫu thực tế)
- `EeveeSpotify-DNS-Rewrite.module` (tên nội bộ: Spotify Module Research): tập trung MITM+Rewrite+Script.
  - `[Rule]`: chặn QUIC `AND,((DOMAIN-SUFFIX,spotify.com),(PROTOCOL,QUIC)),REJECT`.
  - `[URL Rewrite]`: reject `pendragon` (reject-dict) và ads/upsell paths (`ads/`, `ad-logic/`, `ad-on-app-open`, `premium-marketing/upsellOffer`).
  - `[Header Rewrite]`: `header-del if-none-match` cho `customize` và `remote-config-resolver`/`nebula` attributes (tránh 304).
  - `[MITM]`: `hostname = %APPEND% spclient.wg.spotify.com, *spclient.spotify.com`.
  - `[Script]`: hook `bootstrap|customize`, `remote-config-resolver|nebula`, và `GetPremiumPlanRow` (binary, `max-size=0`, passthrough). `[Host]` để tuỳ chọn (comment).
- `eevee_spotify.js`: khung `http-response` + `binary-body-mode=1`, hiện **passthrough** (chưa patch protobuf).

Mẫu tham chiếu thực tế: `https://yfamilys.com/module/spotifyVIP.module` (devchristian1337, scripts `spot-proto-eevee.js`/`spot-proto-ev3.js` dùng protobufjs decode-patch-encode; thêm hook ads `browsita/casita/scrollsita`, `gabo-receiver-service`, endpoint `remote-config-resolver/nebula`).

## 5) Hướng hoàn thiện (cần làm thêm)
1. **Xác định đích rewrite**: tự dựng gateway/proxy (hoặc endpoint có sẵn mà bạn kiểm soát) và thay IP trong `[Host]`.
2. **Patch protobuf đúng schema**:
   - Cần mapping protobuf Spotify hiện tại (Bootstrap/AccountAttributes/PlanRow...) và giá trị cần sửa (tương tự logic Eevee: loại tài khoản, thuộc tính premium, flags).
   - Trong Shadowrocket JS: nhị phân/protobuf khó xử lý trực tiếp → cân nhắc (a) script gọi/nhờ gateway sửa, (b) thực hiện sửa tại proxy phía sau, (c) dùng thư viện protobuf tương thích môi trường JS của Shadowrocket (nếu khả thi).
3. **Mở rộng rule/hostname**: bổ sung domain từ `raw-data/spotify-dns-raw-data.txt` (spclient variants, login, audio/ads nếu mục tiêu là chặn) và tinh chỉnh pattern.
4. **Kiểm thử**: bắt log request/response, so sánh trước/sau, xác nhận `script-path` và MITM hoạt động trên thiết bị/iOS + phiên bản Spotify mục tiêu.

## 6) Lưu ý
- "EeveeSpotify" (tweak) ≠ DNS service; không có bảng "DNS trả về X cho domain Y" trong repo. DNS rewrite/Host chỉ là lớp điều hướng; hiệu ứng phụ thuộc vào cách server đích/proxy xử lý response.
- Chỉ thử nghiệm trong môi trường được phép và bạn kiểm soát (MITM/DNS rewrite có rủi ro bảo mật/riêng tư và tương thích).