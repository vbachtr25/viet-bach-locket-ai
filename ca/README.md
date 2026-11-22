# `ca/` — Root CA của hướng B

CA dùng để ký cert giả cho các domain bị MITM. Profile DNS do `admin/lib/mobileconfig.js` sinh ra
nhúng **cert** của CA này; thiết bị tin nó thì proxy mới đọc được traffic.

| File | Vào git? | Vai trò |
|---|---|---|
| `root-ca.crt` | ✅ có | Cert công khai, được nhúng vào `.mobileconfig` |
| `root-ca.key` | ❌ **KHÔNG** | Private key. `.gitignore` chặn `*.key` / `ca/*.key` |
| `gen-ca.sh` | ✅ có | Sinh lại CA |

## ⚠️ Cảnh báo bảo mật

Ai có `root-ca.key` thì **ký được cert cho bất kỳ domain nào** và mọi thiết bị đã tin CA
này sẽ chấp nhận. Nếu key lộ:

1. Sinh CA mới bằng `./ca/gen-ca.sh`
2. Sinh lại + ký lại profile (dùng `admin/lib/mobileconfig.js`, rồi ký bằng `openssl smime -sign`)
3. **Mọi user phải cài lại profile** — không có cách thu hồi từ xa
4. Rotate secret trên Fly: `fly secrets set ROOT_CA_KEY=...`

## Cách proxy đọc CA

`proxy/main.go` → `getCAData()`: ưu tiên biến môi trường `ROOT_CA_CRT` / `ROOT_CA_KEY`,
nếu không có thì đọc file trong thư mục này. Trên Fly, key nạp qua `fly secrets`,
không copy file vào image.
