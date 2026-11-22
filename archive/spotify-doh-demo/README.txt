Eevee Spotify DNS Rewrite - Demo (local)
========================================

Mục tiêu: demo DoH server + Root CA + .mobileconfig để làm DNS rewrite/block cho domain Spotify trên thiết bị iOS/iPadOS (cùng mạng với máy chạy server).

Lưu ý quan trọng
- "EeveeSpotify" thực chất là tweak/mod iOS (vá phía app), KHÔNG phải dịch vụ DNS. Không thể "lấy hoàn toàn của Eevee Spotify" đưa vào DNS. Demo này chỉ minh họa cơ chế DNS rewrite/block (giống kiểu profile gateway: DNS + CA), KHÔNG biến Spotify thành Premium như tweak.
- DNS chỉ ảnh hưởng phân giải tên miền; chặn/quảng cáo phụ thuộc server-side của Spotify nên hiệu quả hạn chế.

Nội dung
- doh-server.js                      : DoH server (Node.js, stdlib). Nhận /dns-query, rewrite/block theo RULES hoặc forward lên upstream DNS.
- server.pfx                         : cert+key cho server HTTPS (passphrase: eevee-demo), SAN gồm 192.168.50.100, localhost.
- root-ca.cer                        : Root CA (DER) dùng để nhúng vào mobileconfig.
- make-mobileconfig.py               : tạo lại file .mobileconfig (sửa SERVER_URL/domain nếu cần).
- Eevee-Spotify-DNS-Demo.mobileconfig: profile gồm Root CA + DNSSettings (DoH) trỏ tới https://192.168.50.100:8443/dns-query.

Cách chạy
1) Chạy DoH server trên máy này:
   cd eevee-doh-demo
   node doh-server.js
   (tuỳ chọn env: PORT=8443 UPSTREAM=8.8.8.8)

2) Cài profile lên iPhone/iPad (cùng mạng LAN):
   - Chép Eevee-Spotify-DNS-Demo.mobileconfig sang thiết bị và cài.
   - Cài xong vào Cài đặt > Cài đặt chung > Giới thiệu/VPN & Quản lý thiết bị (tuỳ iOS) để bật tin cậy chứng chỉ "Eevee Demo Root CA" (Certificate Trust Settings).

3) Kiểm tra: mở Safari truy cập https://192.168.50.100:8443/dns-query sẽ không như web thường, nhưng DoH client sẽ dùng được nếu tin cậy CA; xem log trên console server khi app truy vấn.

Tuỳ chỉnh rewrite
- Mở doh-server.js, sửa mảng RULES:
  - { domain: '...', action: 'nxdomain' }  -> chặn
  - { domain: '...', action: 'zero' }      -> trả 0.0.0.0/:: 
  - { domain: '...', action: 'ip:1.2.3.4'} -> trả A record tới IP chỉ định (demo rewrite)
  - { domain: '...', action: 'passthrough'} hoặc xoá rule -> forward upstream
- Nếu IP máy đổi, sửa SERVER_URL trong make-mobileconfig.py rồi chạy: python make-mobileconfig.py (và cần tạo lại cert server có SAN đúng IP nếu muốn hết cảnh báo/tin cậy TLS).

Giới hạn demo
- Chỉ parse/handle DNS cơ bản (A/AAAA cho rule rewrite), còn lại forward nguyên gói lên upstream.
- Không có proxy/MITM để sửa nội dung API Spotify; chỉ rewrite DNS.
- server.crt.pem không kèm private key (server dùng server.pfx). PFX passphrase: eevee-demo.