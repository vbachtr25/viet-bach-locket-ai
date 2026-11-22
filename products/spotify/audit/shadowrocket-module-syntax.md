# Cú pháp module Shadowrocket — đã đối chiếu để chạy được trên máy thật

Mục đích của file này: ghi lại **đúng những gì Shadowrocket chấp nhận**, kèm nguồn,
để lần sau sửa module không phải đoán. Mọi kết luận ở đây đều đã đối chiếu với
module đang chạy thật trên App Store, không phải suy luận.

## 1. `[Script]` — các tham số và giá trị hợp lệ

```
<tên> = type=http-response,pattern=<regex>,script-path=<url>,requires-body=1,binary-body-mode=1,max-size=<số>,timeout=30,argument=<chuỗi>
```

| Tham số | Giá trị hợp lệ | Ghi chú |
| --- | --- | --- |
| `type` | `http-request`, `http-response`, `event`, `rule`, `dns`, `cron` | Xác nhận trong manual chính thức |
| `pattern` | regex JS, so với **URL đầy đủ** (có query) | Phải neo `^...$` nếu muốn chính xác |
| `script-path` | URL https, hoặc đường dẫn file | File local đặt trong `Shadowrocket/Script` trên iCloud |
| `requires-body` | `1` / `true` | **Bắt buộc** với mọi script cần đọc body. Thiếu ⇒ body rỗng. |
| `binary-body-mode` | `1` / `true` | Bắt buộc với protobuf/gRPC. Không có ⇒ body bị cắt ở byte NUL hoặc decode sai. |
| `max-size` | số dương (byte), `0`, `-1` | Xem mục 4 |
| `timeout` | giây | Nên đặt, tránh hook treo |
| `argument` | chuỗi tự do | Vào script qua biến `$argument` |
| `engine` | `auto`, `jsc`, `webview` | Xem mục 3 |
| `script-update-interval` | `0`, `-1`, số giờ | Cache script remote |

Nguồn: manual Shadowrocket (LOWERTOP/Shadowrocket, mục 脚本) + module
`iSteal-it/script/shadowrocket.configuration` + `deezertidal` (đang chạy thật).

## 2. `$done` với binary body — chỗ dễ hỏng nhất

Đây là lỗi đã làm bản module trước **im lặng không có tác dụng**.

| Cách trả | Shadowrocket hiểu là | Kết quả |
| --- | --- | --- |
| `$done({})` | "body mới là rỗng" | Response 200 không nội dung → Spotify coi như lỗi, loading mãi |
| `$done({ body: X })` | Chỉ thay body | ✅ Đúng |
| `$done({ status, headers, body })` | Thay cả 3 | ❌ Header gốc còn `content-encoding: gzip` + `content-length` cũ → app giải nén sai |

**Quy tắc:** với `binary-body-mode`, mọi nhánh "không sửa gì" **phải trả lại
nguyên body gốc**, không được `$done({})`.

Trích nguồn (xiaoyinge/Shadowrocket-X-AdBlock, commit 5f983eb):
> "$done({}) 当作「响应体为空」，原 body 被丢弃"
> "$done({ status, headers, body }) … 原 header 带 content-encoding: gzip … App 按 gzip 解明文 → 失败"

### Kiểu dữ liệu của `body` khi trả về

| Engine | Kiểu phải trả |
| --- | --- |
| `webview` (mặc định cho http-response) | `Uint8Array` — bridge được |
| `jsc` | `ArrayBuffer` — `Uint8Array` **không** bridge được qua Objective-C |

Script trong repo tự nhận engine qua `$environment["engine"]` và trả đúng kiểu,
nên chạy được ở cả hai mà không cần sửa module.

## 3. `engine` — nên để mặc định

Manual chính thức:
> "若脚本类型为 `http-request` 或 `http-response`，则在配置 `engine=auto` 参数时，
> 系统将默认调用 `WebView` 引擎，而非 `JSC` 引擎"

Nghĩa là với `http-response`, không đặt `engine` ⇒ chạy WebView. WebView:
- bridge `Uint8Array` được (JSC thì không)
- không ăn vào giới hạn bộ nhớ JSC
- đã thấy `engine=jsc` trong vài module (duyvinh09, iSteal-it) nhưng đó là cho
  script dạng JSON text, không phải protobuf binary

⇒ Bản module này **không** đặt `engine`, để mặc định WebView.

## 4. `max-size` — đừng dùng `0`

Cộng đồng hiểu `0` theo hai cách mâu thuẫn:
- `max-size=0` = không giới hạn (module app2smile, batqwq)
- `max-size=0` "响应体可能拿不到/被截断" → khuyến nghị `-1`
  (xiaoyinge/Shadowrocket-X-AdBlock)

Vì hai nguồn mâu thuẫn, chọn cách an toàn thứ ba: **số dương lớn**.
Payload UCS/bootstrap thực đo ~60 KB ⇒ `max-size=8388608` (8 MiB) là dư.
Script còn tự kiểm tra và passthrough nếu body vượt ngưỡng, nên không bao giờ
làm hỏng response.

## 5. `[Header Rewrite]` — cú pháp KHÔNG có tiền tố type

Đã đối chiếu với module thật:

```
^https?:\/\/api\.revenuecat\.com\/.+\/receipts$ header-del x-revenuecat-etag
```

**3 phần, phân cách bằng space:** `<regex URL> header-del <tên header>`

Không có `http-request`/`http-response` ở đầu dòng (mặc dù UI hiển thị 2 loại
đó). Bản module trước viết `http-request ^https?... header-del If-None-Match` —
phần `http-request` sẽ bị coi là một phần của regex ⇒ **không khớp gì cả** ⇒
không xoá được cache validator ⇒ server trả 304 ⇒ không có body để patch.

Hành vi hỗ trợ: `header-del`, `header-add`, `header-replace`, `header-replace-regex`.
Header name **không phân biệt hoa thường**? Chưa kiểm chứng ⇒ khai cả hai biến thể
nếu cần chắc chắn (bản module này chỉ khai dạng chuẩn `If-None-Match`).

## 6. `[URL Rewrite]` — dùng `reject-200`, và `_` là dấu phân cách

Cú pháp trong module thật:

```
^https?:\/\/[\w-]+\.googlevideo\.com\/(?!(dclk_video_ads|videoplayback\?)).+&oad _ reject-200
```

**`<regex> _ <action>`** — dấu `_` (gạch dưới, có space hai bên) phân cách regex
với action. Không có `_` thì cả chuỗi bị coi là regex.

Các action hợp lệ (theo manual + module thật):

| Action | Trả về | Dùng khi |
| --- | --- | --- |
| `reject` | rớt kết nối, HTTP 404 rỗng | telemetry thuần tuý (không retry) |
| `reject-200` | 200, nội dung rỗng | **mặc định an toàn** cho API quảng cáo |
| `reject-img` | 200, GIF 1×1 | ảnh/banner |
| `reject-tinygif` | 200, GIF 1×1 | như trên |
| `reject-video` | 200, MP4 rỗng | video ad |
| `reject-dict` | 200, `{}` | ⚠️ chỉ thấy trong tài liệu **rule policy**, chưa thấy dùng trong `[URL Rewrite]` của module thật nào ⇒ tránh |

Vì sao `reject-200` chứ không `reject`: `reject` làm app không nhận response,
app retry liên tục (đã đo: một số endpoint retry 12 lần) ⇒ nóng máy, tốn pin.
`reject-200` trả 200 rỗng để app tin là "không có dữ liệu" và thôi gọi.

## 7. `[MITM]` — cần `%APPEND%` và `h2 = true`

```
[MITM]
hostname = %APPEND% spclient.wg.spotify.com, *-spclient.spotify.com
h2 = true
```

- `%APPEND%`: không có nó thì hostname trong module **ghi đè** danh sách hostname
  của config, làm hỏng các module khác.
- `h2 = true`: từ bản `2.2.81 (3096)`. Spotify 9.x đi HTTP/2 — không bật thì
  phần lớn request không giải mã được, hook không thấy body. (Bài học từ
  `xiaoyinge`: "X 走 HTTP/2, 不开 h2 时解密拿不到 body")

## 8. `[Rule]` — token `PROTOCOL,UDP`, không phải `PROTOCOL,QUIC`

```
AND,((DOMAIN-SUFFIX,spotify.com),(PROTOCOL,UDP)),REJECT
```

`QUIC` là token của Clash/sing-box, **không** có trong Shadowrocket. Module thật
dùng `PROTOCOL,UDP` (đôi khi kèm `DST-PORT,443`).

Mục đích: ép Spotify rời HTTP/3 về TCP để MITM đọc được body. Nhưng đây là
**chặn UDP của Spotify**, và với `[Rule]` thì `REJECT` nghĩa là rớt luôn.
Nếu sau này thấy tính năng mạng của Spotify trục trặc, thử bỏ dòng này trước.

## 9. Ba điều kiện bắt buộc trước khi module chạy được

Không phải lỗi cú pháp, nhưng thiếu là module im lặng:

1. **HTTPS Decrypt bật + CA đã tin cậy.** Config > ⓘ > HTTPS Decrypt >
   Certificate > Generate new CA > Install Certificate, rồi
   iOS Settings > General > About > Certificate Trust Settings > bật tin cậy.
2. **UDP đi qua proxy** (Settings > UDP > Enable Forwarding). UDP đi direct hoặc
   reject ⇒ script không bao giờ thấy body. (xiaoyinge: "UDP 如果不走代理，脚本拿不到 body")
3. **iOS 15+**. Từ iOS 15, giới hạn bộ nhớ Network Extension tăng 15 MB → 50 MB.
   iOS cũ hơn có thể làm module im lặng hoặc rớt VPN.

## 10. Cảnh báo: `binary-body-mode` không được upstream hỗ trợ chính thức

Từ `NADYuk0314/shadowrocket-adblock`:
> "协议级改写（binary-body-mode=1，gRPC / protobuf 二进制）：要解二进制协议再
> 重新编码，上游 app2smile 只声明支持 Surge / Loon / QuantumultX，**并未声明
> 支持 Shadowrocket**。一旦小火箭侧的解码/回写与脚本预期不一致，返回体就会损坏。"

Đối sách trong repo này:
- Engine protobuf **tự viết**, không dùng protobufjs ⇒ kiểm soát được cả decode
  và encode, không phụ thuộc runtime.
- Encode theo kiểu **byte-preserving**: field không sửa được giữ nguyên byte gốc,
  nên field lạ của version mới vẫn qua được.
- Mọi exception/nhánh lạ ⇒ passthrough nguyên body gốc, không trả body rỗng.
- Có `argument=debug` để xác nhận hook chạy **trước khi** tin vào kết quả.

## 11. Checklist test trên điện thoại

1. Cài module, bật HTTPS Decrypt, tin cậy CA.
2. Sửa `argument` thành `full&debug=true` (Config > 模块 > module > 编辑参数).
3. Mở Spotify, xem log của Shadowrocket (dạng `[spotify-ucs] ...`).
4. Đối chiếu log:
   - `hook chạy: attributes | /nebula/v1/configuration/attributes` ⇒ hook đã khớp ✅
   - `body=NNNN bytes, head=0a ...` ⇒ body là protobuf ✅ (head bắt đầu `0a`)
   - `attributes: X -> Y bytes` ⇒ patch có thay đổi ✅
   - `hook chạy` không xuất hiện ⇒ **pattern không khớp** hoặc MITM chưa giải mã host đó ⇒ xem mục 9
   - `body=none` / `body=0 bytes` ⇒ `requires-body` thiếu hoặc QUIC chưa chặn ⇒ mục 9
   - `decode/patch lỗi` ⇒ gửi log lại kèm `head=` để soi wire format
5. Xong thì đổi về `argument=full` để tắt log.
