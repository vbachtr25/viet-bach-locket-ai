# `archive/` — bản cũ, giữ để tham chiếu

Không có gì ở đây được code production trỏ tới. Giữ lại để tra cứu lịch sử, **không sửa,
không dùng cho bản phát hành**.

| Thư mục | Nội dung | Vì sao còn |
|---|---|---|
| `scripts/locket_photobooth.js` | Script cũ, không module nào trỏ tới | Tham chiếu logic photobooth |
| `spotify-doh-demo/` | DoH server Node.js demo + mobileconfig mẫu (trỏ IP LAN `192.168.50.100`) | Ví dụ cơ chế DoH rewrite; **không dùng được cho production** (LAN IP, chạy Node) |
| `spotify/reference/scripts/` | 7 script Spotify của người khác (`spot-proto-eevee.js` 1268 dòng, `spot-No*Ad.js`, …) | Audit §4 ghi rõ chúng có lỗi (thiếu 46 rule, spoof attribute server-authoritative) |
| `spotify/reference/modules/` | 3 module Spotify của tác giả khác | Tham chiếu cú pháp |
| `spotify/reference/profiles/Spotify.mobileconfig` | Profile nhặt trên mạng | ⚠️ **Cài Root CA của người khác.** Đừng cài lại — xem cảnh báo dưới |
| `spotify/reference/raw-data/` | Domain/endpoint thô | Nguyên liệu audit |
| `reference/lamdev/` | 3 profile `LAMDev-LocketGold-VIP0{1,2,3}.mobileconfig` của bên thứ ba | Tham chiếu cấu trúc + đối chiếu. ⚠️ **Cài Root CA không có Name Constraints** — xem README riêng |

## ⚠️ Về `profiles/Spotify.mobileconfig`

File này nhúng một Root CA tự ký (`CN=Spotify Gateway CA`) và trỏ DoH về
`103.101.161.228` — **server của người khác**. Ai cài profile đó thì người đó về lý thuyết
đọc được toàn bộ traffic các domain trong danh sách.

Giữ file lại **chỉ để tham chiếu cấu trúc** (cách gộp CA + DNS payload trong 1 profile).
Không cài, không phát hành.
