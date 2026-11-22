# Mảng B — server (chưa triển khai)

Mục tiêu: user **chỉ cài một profile DNS**, không cần Shadowrocket.

> **Trạng thái: mới ở giai đoạn quyết định hạ tầng.** Chưa có mã trong thư mục này.
> Chưa chọn được máy chủ thì chưa viết code — xem "Cần quyết" ở cuối.

## Vì sao cần server, và vì sao DNS không đủ

DoH chỉ trả lời *"domain này ở IP nào"*. Muốn mở Premium phải **sửa nội dung response**
(protobuf/JSON). Vì vậy kiến trúc là: DoH dẫn đường → MITM sửa nội dung.

```
Cài .mobileconfig  (1 lần, gồm DNS payload + Root CA payload)
   ↓
DoH resolver  →  trả về IP của chính server mình cho các host đích
   ↓
TLS tới server với SNI = spclient.wg.spotify.com
   ↓
server ký cert lá bằng CA đã tin cậy, đọc body, patch, trả về
```

## Yêu cầu kỹ thuật bắt buộc của máy chủ

| Yêu cầu | Lý do |
|---|---|
| **Nhận TCP 443 với SNI bất kỳ** | Máy gửi TLS với SNI là host của Spotify/RevenueCat, không phải host của bạn. Host nào chỉ định tuyến TLS theo hostname đã đăng ký sẽ từ chối trước khi tới code. |
| **IP công khai + mở inbound 443** | iOS phải gọi tới được. |
| **Process dài hạn, có root** | Chạy một listener duy nhất phân nhánh theo SNI. |
| **Không bị chặn SNI lạ** | Nếu nhà cung cấp lọc SNI thì vô hiệu. |

Hệ quả: **mọi PaaS free đều không dùng được** — Vercel, Netlify, Cloudflare
Workers/Pages, PythonAnywhere, Render, Railway đều terminate TLS bằng cert của họ và
chỉ phục vụ hostname đã đăng ký. Cloudflare Tunnel cũng vậy (Cloudflare terminate TLS).

## So sánh các lựa chọn

| Lựa chọn | SNI lạ | Chi phí | Ghi chú |
|---|---|---|---|
| **Oracle Cloud Free Tier** | ✅ | **$0** | ARM 4 core / 24 GB, IP công khai, mở 443. Đường miễn phí duy nhất khả thi. Rủi ro: instance có thể bị thu hồi, verify thẻ khó, latency VN ~50–80 ms. |
| **RackNerd Singapore** | ✅ | **$11.29/năm** (~$0.94/th) | 1 vCPU / 1 GB / 24 GB SSD / 2 TB. Có DC Singapore → ~30–50 ms. Rẻ nhất có IP riêng + root. |
| Hetzner CX22 | ✅ | ~$4.35–5.22/th | 2 vCPU / 4 GB, mạnh nhất tầm giá, có Singapore. Cần verify danh tính. |
| Vultr Singapore | ✅ | $6/th | Ổn định, billing theo giờ. |
| Fly.io | ⚠️ cần **dedicated IPv4** | ~$4.2/th | `handlers = []` (raw TCP) **bắt buộc** dedicated IPv4: `flyctl ips allocate-v4` (+$2). Shared IPv4 chỉ HTTP/S. Repo đã có `proxy/Dockerfile` nên deploy nhanh, nhưng đắt hơn RackNerd ~5 lần. |

Ngoài PaaS, còn đường **máy nhà** — đã loại: Viettel/VNPT/FPT đều dùng **CGNAT**
(dải `100.64.0.0/10`) cho gói phổ thông và **chặn inbound 80/443**; muốn dùng phải xin
public IP tĩnh + mở port, thường là nâng gói doanh nghiệp (đắt hơn VPS) và máy phải bật 24/7.

## Kiến trúc: một listener, một CA, một profile

Tách DoH và MITM ra hai máy là **không làm được**: profile iOS chỉ chứa **một**
`ServerURL` cho DoH và máy chỉ tin một CA; `ServerURL` cũng không cho chỉ định port.
Nên hai thứ phải chung một process giữ 443, phân nhánh theo SNI.

```
:443  →  process duy nhất
         ├─ SNI = dns.ten-mien.com        → DoH resolver (trả IP của chính máy)
         ├─ SNI = api.revenuecat.com      → MITM, sửa expires_date      (Locket)
         └─ SNI = *.spclient.spotify.com  → MITM, patch protobuf        (Spotify)
```

Điểm hay: `proxy/` trong repo **đã có** phần CA forging + cert cache theo SNI
(`proxy/tls/ca.go`, `proxy/tls/cache.go`, `proxy/main.go` mục `GetConfigForClient`).
Chỉ cần thêm handler DoH và handler Spotify.

## Profile `.mobileconfig`

- `SupplementalMatchDomains` **hỗ trợ wildcard một cấp**: `*.spclient.spotify.com` khớp
  `gae2-spclient.spotify.com`, `gew4-spclient.spotify.com`… (Apple device-management
  `com.apple.dnsSettings.managed`). Tránh được việc liệt kê tay từng host region.
- **Không** đưa `spotify.com` trần vào danh sách — nếu không audio CDN và API nội bộ sẽ
  dồn hết qua server.
- Root CA và DNS payload nằm **cùng một profile** để user chỉ cài một lần (giống
  `admin/lib/mobileconfig.js` đang làm cho Locket).

## Rủi ro phải nói rõ với user

1. User phải tin **Root CA của bạn** → về lý thuyết bạn đọc được mọi traffic của họ.
   Đây là lý do các file `.mobileconfig` nhặt trên mạng (ví dụ trong
   `archive/spotify/reference/profiles/`) là **nguy hiểm**, không phải "miễn phí".
2. Server sập là mọi user mất kết nối Spotify/RevenueCat cùng lúc.
3. IP server có thể bị Spotify chặn.
4. Không chặn được QUIC ở tầng DNS (khác Shadowrocket có `PROTOCOL,UDP → REJECT`),
   nên phải giữ `spotify.com` ra ngoài danh sách rewrite.

## Cần quyết trước khi viết code

- [ ] Nhà cung cấp: Oracle Free / RackNerd / Hetzner / Fly dedicated IPv4
- [ ] Domain dùng cho DoH (ví dụ `dns.ten-mien.com`)
- [ ] OS (khuyến nghị Ubuntu 24.04 LTS)
- [ ] Có làm chung với Locket trên một máy không (khuyến nghị: **có**, xem lý do ở trên)

Trả lời 4 mục trên thì code + script cài đặt (systemd, firewall, profile generator) sẽ
được viết trong thư mục này.
