# `archive/reference/lamdev/` — profile LAMDev (bên thứ ba)

Ba profile của **người khác**, chuyển từ root repo (`main`, commit `976e178`) về đây ngày
2026-11-18. Giữ lại **chỉ để tham chiếu cấu trúc và đối chiếu**. Không phát hành, không cài,
không sửa.

| File | DoH ServerURL | Domain | CA |
|---|---|---|---|
| `LAMDev-LocketGold-VIP01.mobileconfig` | `https://locketlam-free.dalymmo.com/dns/sever-free-v1/` | 10 | `CN=LocketGold` (RSA-2048, `01:EF:F0:14:…`) |
| `LAMDev-LocketGold-VIP02.mobileconfig` | `.../sever-free-v2/` | 11 | `CN=LocketGold Custom Root CA` (RSA-4096, `E9:0D:21:0D:…`) |
| `LAMDev-LocketGold-VIP03.mobileconfig` | `.../sever-free-v3/` | 9 | y hệt VIP02 |

Cả ba: XML plist thuần, **chưa ký CMS**, 3 payload (CA + DNS + WebClip).

## ⚠️ Cảnh báo chính: CA không có Name Constraints

Bóc cert ra kiểm:

```
Basic Constraints : critical, CA:TRUE
Name Constraints  : ❌ không có
Extended Key Usage: ❌ không có
Key Usage         : ❌ không có
```

Không có `Name Constraints` nghĩa là CA này **ký được cert cho mọi tên miền trên
Internet**, không chỉ các domain trong profile. `SupplementalMatchDomains` chỉ giới hạn
*domain nào đi qua DoH*, **không** giới hạn *CA ký được gì* — hai thứ khác nhau.

Ai cài là trao quyền giả danh `google.com`, `vietcombank.com.vn`, `apple.com`… cho người giữ
private key của `LocketGoldFree.cer`. Xem thêm cảnh báo tương tự ở `archive/README.md`.

Đối chiếu: CA của repo này (`ca/root-ca.crt`, `CN=Locket XVIP Root CA`, fingerprint
`BF:0B:37:6A:4F:FF:56:FF:86:13:36:DE:3A:C5:31:85:67:F2:4B:A5:91:13:D8:18:B4:31:53:05:C4:1B:68:43`)
cũng không có Name Constraints — nhưng private key (`ca/root-ca.key`) nằm trong tay chủ repo.

## Lỗi kỹ thuật ghi nhận được

1. **`ServerAddresses` là IP của Cloudflare/Google**, không phải của họ:
   `['172.67.146.35', '104.21.10.172', '1.1.1.1', '8.8.8.8']`. Khi DoH chết, iOS rơi về DNS
   thường → mất luôn tính năng rewrite.
2. **"Máy chủ 01/02/03" thật ra là một máy**: cùng host `locketlam-free.dalymmo.com`, chỉ khác
   path. Lời hứa "đổi máy chủ khác khi bảo trì" trong `PayloadDescription` không có tác dụng.
3. **Xung đột `PayloadIdentifier` + `PayloadUUID`**: cả 3 dùng chung
   `com.dalymmo.locketgoldfree.ca` và UUID `80330486-E9C7-4EBB-83E8-1BCA82B6E780` cho payload
   CA, dù cert khác nhau. Cài bản này rồi bản kia là iOS ghi đè payload CA.
4. **`spclient.spotify.com` thiếu ở VIP01** (chỉ có `spclient.wg.spotify.com` + `spotify.com`).
   VIP01 sẽ không phủ `gae2-` / `gew4-spclient.spotify.com`.
5. **Phủ domain hẹp**: 9–11 domain, so với **39** của `admin/lib/mobileconfig.js`. Thiếu 33–36
   domain, gồm 8 subdomain RevenueCat phụ, `firebaseremoteconfigrealtime`,
   `apresolve.spotify.com`, `audio-ak-spotify-com.akamaized.net`, `crashdump.spotify.com`…
6. **Payload thứ ba là WebClip quảng cáo**: icon 32.934 B nhúng base64, `URL=https://dalymmo.com`,
   `FullScreen=True`, **`IsRemovable=False`** — cài vào là có icon không gỡ được trên màn hình chính.

## Điểm đáng học (duy nhất)

Họ nhét thêm 5 domain Apple vào `SupplementalMatchDomains`:

```
certs.apple.com  crl.apple.com  ocsp.apple.com  valid.apple.com  ppq.apple.com
```

Mục đích: chặn iOS đi kiểm tra thu hồi cert qua DoH của họ. Về kỹ thuật làm profile "trơn"
hơn; về bản chất là **che giấu khỏi cơ chế bảo vệ của Apple**. Repo này **cố ý không** copy
5 domain đó — `admin/lib/mobileconfig.js` không có chúng.

Cấu trúc 2 payload (CA + DNS) đúng chuẩn và giống `admin/lib/mobileconfig.js`. Không có gì mới
về mặt kỹ thuật.

## Bóc lại nếu cần kiểm

File là XML plist thuần (không phải CMS), nên `openssl smime -verify -inform DER` sẽ fail
với `wrong tag` — đó là bình thường, không phải file hỏng.

```bash
F=archive/reference/lamdev/LAMDev-LocketGold-VIP01.mobileconfig

# 1. Liệt kê payload
python3 -c "import plistlib,sys
d=plistlib.load(open(sys.argv[1],'rb'))
for p in d['PayloadContent']: print(p['PayloadType'], p.get('PayloadUUID'))" "$F"

# 2. Bóc cert CA ra DER
python3 -c "import plistlib,sys
d=plistlib.load(open(sys.argv[1],'rb'))
for p in d['PayloadContent']:
    if p['PayloadType']=='com.apple.security.root':
        open('/tmp/ca.der','wb').write(p['PayloadContent'])" "$F"

# 3. Kiểm CA — chú ý Name Constraints / EKU có xuất hiện hay không
openssl x509 -inform DER -in /tmp/ca.der -noout -subject -fingerprint -sha256 -text | \
  grep -E "subject=|Fingerprint|Name Constraints|Extended Key Usage|CA:"
```
