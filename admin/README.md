# `admin/` — thư viện DNS + sinh profile (phần còn lại sau khi dọn web)

> **Tên `admin/` là di sản lịch sử.** Trước đây đây là backend của web quản trị
> (auth, Supabase, session). Toàn bộ phần web đã bị xoá — xem mục "Đã xoá" bên dưới.
> Nay chỉ còn 2 thư viện dùng cho **hướng DNS**.

## Còn lại gì

| File | Vai trò | Ai dùng |
|---|---|---|
| `lib/mobileconfig.js` | Sinh XML profile DNS (DoH payload + Root CA payload), đọc profile đã ký, lấy CA base64 | `tests/admin/profile.test.js` |
| `lib/nextdns.js` | Re-export `../nextdns/index.js` + giữ `DOMAINS_TO_REWRITE` riêng | `tests/admin/nextdns.test.js` |
| `package.json` | Chỉ để `npm test` trỏ về `../tests/admin/` | — |

## Đã xoá (hướng web)

| Xoá | Lý do |
|---|---|
| `admin/public/` | 122 file, 5.3 MB — mirror 1:1 của `public/` (site landing). Không code nào trong repo đọc |
| `admin/api/generate-profile.js` | Handler của Vercel route. Web tạm dừng nên không cần |
| `admin/lib/auth.js` | JWT admin, so mật khẩu — chỉ dùng cho đăng nhập web |
| `admin/lib/db.js` | Supabase client — chỉ dùng để lưu tài khoản NextDNS của web |
| `admin/README.md` (bản cũ) | Mô tả cấu trúc web đã không còn |

Cùng đợt đó ở root cũng xoá: `public/`, `api/`, `supabase/`, `vercel.json`,
`.vercelignore`.

## Vì sao giữ `mobileconfig.js` và `nextdns.js`

Chúng **không thuộc web**, chúng thuộc DNS:

- `mobileconfig.js` sinh ra chính cái profile mà user cài để dùng DNS. Đây là công cụ
  trung tâm của hướng B. Sinh lại profile sau khi đổi IP proxy / đổi DoH server đều
  phải qua file này.
- `nextdns.js` chứa `DOMAINS_TO_REWRITE` — danh sách 4 domain Locket được rewrite về
  IP proxy. Đây là **cấu hình DNS**, không phải cấu hình web.

## Chạy lại khi cần sinh profile

```js
const { generateMobileconfig } = require('./lib/mobileconfig');
console.log(generateMobileconfig());            // profile mặc định (Xwuan_DNS)
console.log(generateMobileconfig('nextdns-id')); // đổi DoH sang dns.nextdns.io/<id>
```

Profile sinh ra là **XML chưa ký**. iOS vẫn cài được nhưng sẽ hiện cảnh báo "chưa xác
minh". Muốn có bản đã ký (như `Xwuan_DNS.mobileconfig` phát hành trước đây) thì phải ký
bằng `openssl smime -sign` với một cert — quy trình này **chưa được script hoá**, làm tay.
Đây là việc cần làm khi web hoạt động lại hoặc khi cần phát hành profile mới.

## Test

```bash
node --test tests/admin/*.test.js
```

Còn 3 file: `nextdns`, `profile`, `proxy_filters`.
