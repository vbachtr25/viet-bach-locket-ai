# `nextdns/` — NextDNS API client

Một file: `index.js`. Tạo tài khoản NextDNS tạm, đăng nhập helper, và **rewrite domain**
của Locket về IP của `proxy/`.

## Domain được rewrite

```js
DOMAINS_TO_REWRITE = [
  'firebaseremoteconfig.googleapis.com',   // Remote Config Locket
  'api.revenuecat.com',                    // entitlement
  'us-central1-locket-4252a.cloudfunctions.net',
  'api.locketcamera.com'
]
```

Rewrite trỏ về `DEFAULT_FLY_IP` (`process.env.FLY_PROXY_IP`, mặc định `66.241.124.216`).
Vì vậy **đổi IP proxy thì phải đổi biến này**, nếu không traffic Locket sẽ đi vào hư không.

## Ai dùng

`admin/lib/nextdns.js` re-export file này (giữ `DOMAINS_TO_REWRITE` riêng để test phủ được),
rồi `api/create-account.js`, `api/check-usage.js`, `api/admin/*.js` gọi tiếp.

## Lưu ý

- Đây là client tự viết, không dùng SDK chính thức (NextDNS chưa có SDK JS chính thức).
- Có dùng `api.mail.tm` để lấy email tạm khi đăng ký NextDNS — nếu dịch vụ đó chết thì
  `create-account` hỏng. Đây là điểm dễ vỡ nhất của luồng này.
- Mặc định `Xwuan_DNS.mobileconfig` **không** phụ thuộc luồng tạo tài khoản này (profile
  tĩnh đã ký), nên lỗi ở đây không ảnh hưởng đường cài đặt chính.
