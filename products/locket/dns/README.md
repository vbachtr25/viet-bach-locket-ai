# Hướng DNS — profile + server, KHÔNG có RevenueCat

Mục tiêu: mở tính năng **chỉ bằng cách cài một profile** — không cần
Shadowrocket, không cần app thứ hai trên máy.

Điều kiện bắt buộc: **một IPv4 riêng có cổng 443 thô (TCP+UDP)**. Không có
cách nào vòng qua điều kiện này. Vercel/Netlify/Cloudflare/Render đều kết thúc
TLS ở edge và chọn cert từ kho của họ, nên không bao giờ phục vụ được cert cho
hostname của người khác. Vibe Hosting mở port qua NAT dải cao, và DNS không
mang được số port cho kết nối TCP thông thường.

Nếu chưa có máy chủ: hướng này **tạm dừng**, dùng `module/` thay thế. Engine
`engine/locket_remoteconfig.js` dùng lại được cho server (chỉ cần port
`applyFlags` sang Go), nên không có công sức nào bị bỏ.

## Quyết định: bỏ RevenueCat khỏi danh sách hijack

Đây không phải sở thích — đó là hệ quả của cơ chế chữ ký.

| | Trên máy (module) | Qua DNS (server của mình) |
|---|---|---|
| Ai sửa response | Shadowrocket | server của mình |
| `ETag` / header gốc | giữ nguyên được nếu script chỉ trả `body` | không kiểm soát được |
| `304 Not Modified` | hook request xoá `If-None-Match` → buộc 200 | không điều khiển được |
| `payloadSignatureMismatch` | có thể tránh | **gần như chắc chắn** |
| Kết quả | có thể qua được | `signatureVerificationFailed` |

Cùng một lý do khiến "RevenueCat ở module là được" khiến "RevenueCat qua DNS
là không". Nên trong hướng này: **chỉ Remote Config, và các domain không có
chữ ký.**

## Danh sách `SupplementalMatchDomains`

Chỉ những domain dưới đây đi qua DoH của mình. Phần còn lại đi DNS thường —
đây là điểm quan trọng nhất của thiết kế: **hijack ít nhất có thể**.

### Tầng 1 — cần cho tính năng (bắt buộc)

```
firebaseremoteconfig.googleapis.com
firebaseremoteconfigrealtime.googleapis.com
us-central1-locket-4252a.cloudfunctions.net
```

| Domain | Vì sao |
|---|---|
| `firebaseremoteconfig.googleapis.com` | feature flag — JSON phẳng, **không chữ ký**, sửa được sạch |
| `firebaseremoteconfigrealtime.googleapis.com` | cùng dạng, dùng cho cập nhật realtime |
| `us-central1-locket-4252a.cloudfunctions.net` | backend riêng của Locket; cần cho các tính năng mà cờ chỉ mở khoá |

### Tầng 2 — chặn dấu vết (khuyến nghị)

```
firebaselogging.googleapis.com
firebaselogging-pa.googleapis.com
```

Sửa cờ mà để nguyên telemetry thì phía server thấy tập lệnh lạ trong log. Đây
là chi tiết `UpLocket` làm và nó có lý do.

### Tầng 3 — chỉ khi cần thiết

```
amplitude.com
```

Analytics. Không có trong profile của `UpLocket`? Có — họ có. Nhưng họ hijack
12 domain Spotify nữa cùng danh sách, nên đừng suy ra từ đó.

### KHÔNG đưa vào

| Domain | Vì sao không |
|---|---|
| `api.revenuecat.com` | có chữ ký — xem bảng trên |
| `api.locketcamera.com` | API ảnh là lõi sản phẩm; sửa ở đây dễ làm hỏng app. `UpLocket` cũng **không** đưa vào |
| `*.cloudfunctions.net` (wildcard) | quá rộng — bắt cả backend của app khác. Ghi đúng tên |
| `spotify.com`, `spclient.*` | hướng Spotify, sản phẩm khác |

## Kiến trúc

```
iPhone
  │ ① DoH (profile) → resolver của mình
  ▼
resolver          ② trả A + AAAA về IP của server
  │
iPhone mở TCP 443 tới IP đó (và UDP 443 → bị REJECT để rơi về TCP)
  ▼
server :443
  │ ③ TLS: cert ký bởi CA riêng, đọc SNI để cấp đúng tên
  │ ④ HTTP: route theo Host
  │       firebaseremoteconfig…  → sửa entries{} (port applyFlags sang Go)
  │       cloudfunctions…        → pass-through hoặc sửa nhẹ
  │       khác                   → pass-through
  ▼
server thật
```

### Bốn thứ dễ quên, theo thứ tự hay quên

| # | Việc | Nếu quên |
|---|---|---|
| 1 | **Ghi cả AAAA** (về `::` hoặc IP của mình) | iOS ưu tiên IPv6, kết nối đi thẳng tới CDN thật — MITM bị bỏ qua hoàn toàn |
| 2 | **`REJECT` UDP 443**, không `DROP` | `DROP` làm client chờ hết timeout 1–3 s mỗi kết nối; `REJECT --reject-with icmp-port-unreachable` rơi về TCP trong vài ms |
| 3 | **Xác minh `hostname` trước khi ghi** | ghi nhầm máy khác |
| 4 | **Cert có SAN + EKU serverAuth + SHA-256** | iOS từ chối handshake với lỗi trust |

## Profile `.mobileconfig`

Hai payload trong một file — đây là điều làm cho "chỉ cài profile" khả thi:

```
PayloadContent[0]  com.apple.security.root
                   → cert CA của MÌNH (chỉ cert công khai; private key ở server)
PayloadContent[1]  com.apple.dnsSettings.managed
                   → ServerURL = https://dns.<domain>/dns-query
                   → SupplementalMatchDomains = danh sách ở trên
```

Sau khi cài: **Cài đặt > Giới thiệu > Tin cậy chứng chỉ** > bật CA. Không bật
thì mọi cert do CA đó ký đều bị từ chối.

`ServerURL` phải dùng cert **công khai** (Let's Encrypt), không dùng CA riêng:
iOS kiểm tra DoH server theo trust store, và dùng CA riêng cho một hostname
công khai là tự tạo vấn đề không cần thiết.

## Giới hạn phải nói trước

1. **Không mở được quyền.** Remote Config là cờ, không phải quyền. Nếu backend
   Locket tự kiểm tra tài khoản thì cờ chỉ đổi giao diện. Không tầng hạ tầng
   nào (kể cả VPS) vượt được điều này.
2. **Không sửa được RevenueCat.** Xem đầu file.
3. **Phụ thuộc nhà cung cấp.** ToS của nhiều VPS cấm "proxy/TLS-terminating
   proxy cho traffic không phát sinh từ ứng dụng bạn chạy". Vibe Hosting ghi rõ
   và phạt tới ban. Đọc ToS trước khi thuê, và biết rằng MITM cho thiết bị của
   chính mình là vùng xám ở hầu hết nhà cung cấp.
4. **Mất DNS là mất mạng.** Nếu resolver của mình chết mà chỉ có nó trong
   profile thì máy không phân giải được gì. Cân nhắc để một resolver dự phòng.

## Khi có máy chủ — thứ tự làm

1. Ghi A + AAAA cho 3 domain tầng 1 → về IP của mình
2. `hostname` xác minh đúng máy
3. Bind 443, cert tự ký bằng CA riêng, xác nhận iPhone tin
4. `REJECT` UDP 443
5. Server trả JSON tĩnh trước — kiểm tra luồng đã thông
6. Chỉ sau đó mới port `applyFlags` sang Go

Bước 5 quan trọng: nếu chưa xác nhận được "request của Locket tới được server
của mình", thì mọi thứ sau đó là đoán.
