# `locket/` — Locket: một module Shadowrocket + tài liệu hướng DNS

Mục tiêu: mở tính năng của Locket **ở tầng HTTP**, không jailbreak, không IPA
đã sửa.

- **Một module duy nhất** cho Shadowrocket: RevenueCat + Remote Config.
- Hướng "chỉ cài profile" (DNS) chỉ có Remote Config — xem `dns/README.md`.

## Chỉ Shadowrocket

Module dùng riêng cú pháp Shadowrocket và **không** nhắm tới Surge / Loon /
Quantumult X / Stash / Egern. Ba chỗ khác biệt, và cả ba là lý do không port:

| # | Của Shadowrocket | Client khác |
|---|---|---|
| 1 | `[Script]` + `type=http-response` + `argument=` | Loon khác dạng; Surge không có `argument=` |
| 2 | `binary-body-mode=1` + `$response.bodyBytes` → `{bodyBytes}` | Surge/Loon trả `$response.body` dạng chuỗi |
| 3 | `$persistentStore.write(value, key)` | thứ tự tham số khác nhau giữa client |

Điểm 3 từng làm chết script của module Spotify phổ biến. Một đường code, một
client, ít chỗ sai hơn — nên engine ở đây **không** tự nhận runtime qua
`$environment` như sản phẩm YouTube.

## RevenueCat: được ở module, không được ở DNS

RevenueCat ký số response (Trusted Entitlements, iOS SDK 4.25+). Mã nguồn công
khai cho thấy đường kiểm tra là *fail-closed*:

```
missingSignature  /  missingSignedPayload  /  payloadSignatureMismatch  /
invalidIntermediateKey      ->  verification = .failed
```

Sửa body thì chắc chắn `failed`. Nhưng `.failed` chỉ là **thông tin** — theo
docs chính thức, "verification results are informational only — your app must
check the verification result and decide how to handle it". SDK không tự chặn;
việc từ chối là do code của app.

Vì vậy ở tầng module có ba khả năng, và chế độ `report` phân biệt chúng:

| `sig=` ở bước report | Nghĩa | Kết quả patch |
|---|---|---|
| `n` | endpoint **không** có header chữ ký | sửa sạch, `verification = notRequested` |
| tên header | có ký, app có thể không kiểm tra | có thể chạy, có thể `failed` |
| tên header + app có kiểm tra | — | Gold không hiện |

Qua DNS thì khác hẳn, và đó là lý do `dns/README.md` **bỏ hẳn**
`api.revenuecat.com`:

| | Module (trên máy) | DNS (server của mình) |
|---|---|---|
| Ai sửa | Shadowrocket | server của mình |
| `ETag` gốc | giữ được — engine chỉ trả `body` | không kiểm soát được |
| `304 Not Modified` | hook request xoá `If-None-Match` → buộc 200 | không điều khiển được |
| `payloadSignatureMismatch` | có thể tránh | **gần như chắc chắn** |

Cùng một cơ chế khiến "RevenueCat ở module là được" khiến "RevenueCat qua DNS
là không".

## Cấu trúc

```
locket/
├── engine/
│   ├── locket_remoteconfig.js   # http-response: sửa entries{} (dùng cho cả module và server)
│   ├── locket_revenuecat.js     # http-response: report -> patch entitlement
│   ├── locket_rc_request.js     # http-request: xoá If-None-Match để tránh 304
│   └── locket_selftest.js       # http-request: MỘT báo cáo cho cả hai phần
├── module/
│   └── locket.module            # module duy nhất
├── dns/
│   └── README.md                # hướng profile + server, CHỈ Remote Config
└── README.md
```

Test: **64 test** — `locket_remoteconfig.test.js` (35) + `locket_revenuecat.test.js` (29).

## Dùng

### 1. Cài module

```
https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/products/locket/module/locket.module
```

Bật HTTPS Decrypt + trust CA (Config > ⓘ > HTTPS Decrypt > Generate new CA >
Install Certificate, rồi Cài đặt > Giới thiệu > Tin cậy chứng chỉ).
Module chỉ chạy khi **全局路由 = 配置**.

Ngay sau khi cài, module **chỉ sửa Remote Config**. Phần RevenueCat mặc định là
`argument=report` — nó không sửa gì cho tới khi bạn tự đổi. Đây là chủ ý, xem
mục "RevenueCat" bên dưới.

### 2. Chạy `capture` TRƯỚC — không được bỏ qua

Đổi `argument=flags` thành `argument=capture` trong module (2 dòng hook).

Kill hẳn Locket rồi mở lại. Mở Safari:

```
https://firebaseremoteconfig.googleapis.com/xwuan-selftest
```

Vào `数据 > 代理`, tìm dòng có `?xwuan-report=...`. Đọc `eg=` — đó là **tên
key thật và giá trị thật** của app.

Lý do bắt buộc: tên key do Locket đặt, không ai đoán được. `capture` không sửa
gì cả, nó chỉ cho bạn thấy cái gì đang ở đó. Đoán tên key là cách chắc chắn
nhất để module "không làm gì mà cũng không báo lỗi".

### 3. Bật `flags`

Đổi argument về `flags` (hoặc `flags&probe=true` để có dòng chẩn đoán). Kill
Locket, mở lại.

Engine lật cờ **chỉ khi** thoả cả ba điều kiện:

- tên key có token giống cờ (`gold`, `premium`, `pro`, `vip`, `subscri`,
  `entitle`, `paywall`, `unlock`, …)
- tên key **không** có token loại trừ (`url`, `price`, `product`, `id`,
  `endpoint`, …)
- giá trị hiện tại đúng là `false` / `0` / `no` / `off` / `disabled`

Không thoả thì để nguyên. **Thà bỏ sót còn hơn ghi đè cấu hình thật của app.**

### 4. Phần RevenueCat: chạy `report` trước, rồi mới `patch`

Hook `locket-rc-response` **mặc định là `argument=report`** — nó không sửa gì.
Đây là chủ ý: bạn phải biết endpoint có được ký hay không trước khi quyết định.

```
① argument=report&probe=true
   → 数据 > 代理, tìm ?xwuan=rcpay&st=report&n=0&sig=?&etag=?
   → sig=n       endpoint KHÔNG có header chữ ký  → patch sẽ sạch
   → sig=<tên>   CÓ ký → patch có thể failed, cân nhắc
   → mở Safari: https://api.revenuecat.com/v1/xwuan-selftest
     đọc ent= (tên entitlement) và sub= (product id)

② argument=patch&ek=<ent>&pid=<sub>&probe=true
   → st=ok            đã chèn
   → st=already_present   đã có sẵn
   → st=need_ek_pid   thiếu tham số
   → st=not_modified  hook request chưa chạy — module vô dụng ở trạng thái này

③ Mở Locket, đọc kết quả. Chỉ có ba khả năng:
   Gold hiện + chạy được        → xong
   Gold hiện + không chạy       → backend Locket tự kiểm tra quyền
   Không có gì đổi              → app kiểm tra chữ ký
```

Không đoán tên entitlement. `ek=` và `pid=` phải lấy từ bước ①. Đoán là cách
chắc chắn nhất để module "chạy mà không làm gì".

## Đọc kết quả khi không xem được log

Shadowrocket không có trình xem log script. Một kênh, hai phần:

Mở Safari:

```
https://firebaseremoteconfig.googleapis.com/xwuan-selftest
```

Rồi vào `数据 > 代理`, tìm dòng `?xwuan-report=...`. Một dòng trả lời cả hai:

### `rc.*` — Remote Config

| Trường | Nghĩa |
|---|---|
| `rc.state=never_ran` | engine chưa chạy — kiểm tra MITM/CA/route |
| `rc.reason=ok` | thấy `entries` |
| `rc.reason=no_entries` | response không có `entries` (khác namespace? khác host?) |
| `rc.reason=no_template` | `state: NO_TEMPLATE` — app chưa cấu hình Remote Config |
| `rc.reason=gzip_body` | body nén, engine passthrough |
| `rc.n=` | số key |
| `rc.fl=` | số cờ đã lật |
| `rc.keys=` | tên key — **đọc cái này để biết cờ nào cần lật** |
| `rc.eg=` | ví dụ `key=value` thật (chạy `capture` rồi đọc) |

### `pay.*` — RevenueCat

| Trường | Nghĩa |
|---|---|
| `pay.state=never_ran` | engine chưa chạy ở host này |
| `pay.st=report` | chế độ report (không sửa) |
| `pay.st=ok` | đã chèn entitlement |
| `pay.st=already_present` | đã có sẵn, không làm gì |
| `pay.st=need_ek_pid` | thiếu `ek=`/`pid=` — chưa patch gì |
| `pay.st=not_modified` | vẫn nhận 304 → hook request chưa chạy |
| `pay.sig=n` | **KHÔNG** có header chữ ký → patch sẽ sạch |
| `pay.sig=<tên>` | có ký → patch có thể `failed` |
| `pay.ent=` | entitlement hiện có — **đọc để lấy `ek=`** |
| `pay.sub=` | product id — **đọc để lấy `pid=`** |

### `req=`

Tên header mà hook request đã xoá. `req=never_ran` nghĩa là hook request chưa
chạy — mọi kết quả `not_modified` là do thiếu nó, không phải do app.

### Kênh dự phòng: `&probe=true`

Thêm vào bất kỳ hook nào để có một dòng ngắn trong `数据 > 代理`:

```
firebaselogging.googleapis.com/v1/xwuan-probe?xwuan=rc&st=ok&n=42&fl=3
firebaselogging.googleapis.com/v1/xwuan-probe?xwuan=rcpay&st=report&sig=n&etag=y
```

Probe **không** gửi body, token, tên entitlement, hay URL gốc. Chỉ số đếm.

## Giới hạn đã biết

| Tình huống | Hành vi | Vì sao |
|---|---|---|
| Body gzip | passthrough nguyên byte, `st=gzip_body` | runtime Shadowrocket không có `DecompressionStream` |
| Response base64 chứa JSON lồng | **không** sửa bên trong | sẽ cần parser thật; hiện chỉ giải mã để đọc |
| Locket dùng A/B test | key khác nhau giữa các máy | `capture` là cách xử lý, không hard-code |
| Backend kiểm tra lại quyền | chỉ đổi giao diện | giới hạn của tầng HTTP |
| Realtime namespace | dùng cùng engine | cùng dạng `entries{}` |
| Client khác Shadowrocket | không hỗ trợ | cú pháp + runtime khác, xem mục đầu |

## Về các module Locket Gold đang lưu hành

(`vanhytt/locket_pro`, `nghieee/modules-shadowrocket`) đều sửa
`api.revenuecat.com` + `api.locketcamera.com`. Cấu trúc của họ đúng — 3 bước
[xoá cache header] → [patch response] — và `locket.module` học đúng cấu
trúc đó.

Ba chỗ trong code của họ nên tránh:

- `$done({})` ở nhánh fallback — **body rỗng, không phải passthrough**. Mọi
  response không khớp pattern đều bị làm hỏng.
- Giả định body là JSON thuần, không xử lý gzip; `JSON.parse` lỗi thì rơi vào
  nhánh `$done({})` ở trên.
- `api.locketcamera.com` bị sửa — đó là API ảnh, lõi sản phẩm. `UpLocket`
  không đụng vào nó. Sửa ở đó dễ làm hỏng app mà không liên quan gì tới Gold.

Có một điều hữu ích: nếu một module như vậy chạy được trên máy bạn, nghĩa là
**app đó không kiểm tra `verification`** — bằng chứng thực nghiệm, đáng tin hơn
mọi suy luận từ docs.

## Hướng đã loại

| Hướng | Vì sao loại |
|---|---|
| Server MITM giữ cổng 443 | cần IPv4 riêng có 443 thô; Vercel/Netlify/Cloudflare/Render gia hạn (terminate) TLS ở edge, không phục vụ được cert cho hostname của người khác |
| `api.revenuecat.com` | chữ ký Trusted Entitlements, xem đầu file |
| Sửa qua NextDNS Rewrites | DNS chỉ trả IP; tầng sửa body vẫn phải có máy chủ giữ 443 |

Nếu sau này có VPS: engine này dùng lại được, chỉ cần port `applyFlags` sang Go
và thay phần runtime `$request/$response`.
