# YouTube — chặn quảng cáo ở tầng mạng

```
products/youtube/
├── engine/youtube_adblock.js   ← JS chạy trong sandbox Shadowrocket (tự chứa, 0 dependency)
├── module/youtube-adblock.module
└── README.md                    ← file này
```

## Cài đặt

Dán URL này vào Shadowrocket: **配置 > 模块 > ➕**

```
https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/products/youtube/module/youtube-adblock.module
```

Chạy được trên Shadowrocket, Surge, Loon (cùng cú pháp `[Script]` + `binary-body-mode`).

**Ba điều kiện bắt buộc** — thiếu một cái là module im lặng, không báo lỗi:

1. **HTTPS Decrypt bật + CA đã tin cậy.** Config > ⓘ > HTTPS Decrypt > Certificate > Generate new CA > Install Certificate, rồi iOS Settings > General > About > Certificate Trust Settings > bật tin cậy.
2. **UDP đi qua proxy** (Settings > UDP > Enable Forwarding). YouTube chạy HTTP/3 trên QUIC; QUIC lọt ra ngoài thì không đọc được body.
3. **iOS 15+.** Từ iOS 15 giới hạn bộ nhớ Network Extension tăng 15 MB → 50 MB.

## Làm được gì

| Nhóm | Cơ chế | Trạng thái |
|---|---|---|
| Quảng cáo đầu video / giữa video | Xoá field **7** `adPlacements` + field **68** `adSlots` khỏi `/youtubei/v1/player` | ✅ có code + test |
| Như trên nhưng qua `/get_watch` | Player lồng ở field `1 → 2`, dọn tại chỗ | ✅ có code + test |
| Ad card trong feed / tìm kiếm | Xoá `elementRenderer` là ad khỏi `/browse`, `/next`, `/search` | ✅ có code + test |
| Ad reel trong Shorts | Bỏ entry ad khỏi `/reel_watch_sequence` | ✅ có code + test |
| Endpoint quảng cáo / telemetry | `[URL Rewrite]` → `reject-200` | ✅ trong module |

## KHÔNG làm được (và nên biết vì sao)

Đây là giới hạn của kênh HTTP, không phải thiếu code:

| Không làm được | Vì sao | Muốn có thì phải |
|---|---|---|
| SponsorBlock | Cần UI + hook vào player timeline | Tweak Logos + sideload IPA |
| Tua/tắt quảng cáo, PiP, nền tối | Sửa trạng thái player trong app | Như trên |
| Download, chặn Shorts, đổi giao diện | Hook Objective-C vào ViewController | Như trên |
| Video chất lượng cao hơn hạn mức tài khoản | Server quyết định, đã ký trong streaming URL | Như trên |

Nói gọn: **module mạng sửa được "server trả gì", không sửa được "app làm gì với nó".** Các tweak bạn đưa làm cả hai; module này chỉ làm vế thứ nhất.

## Ba nguồn bạn đưa — dùng được bao nhiêu?

| Repo | Loại | Giấy phép | Dùng được gì |
|---|---|---|---|
| [YTLite](https://github.com/dayanch96/YTLite) ★5673 | Tweak Logos | không rõ (repo không có LICENSE) | **Chỉ để tham khảo danh sách tính năng.** Không copy code. |
| [YouMod](https://github.com/Tonwalter888/YouMod) ★820 | Tweak Logos | **GPL-3.0** | Danh sách hook (`Ads.x` 400 dòng) để đối chiếu. Copy là dính GPL cho toàn repo. |
| [ytkace](https://github.com/itzzace/ytkace) ★1170 | Tweak ObjC++ | **MIT** | Tương đối an toàn về pháp lý, nhưng vẫn là code inject — không port sang mạng được. |

Cả ba đều **inject vào app** nên không chạy nếu không sideload IPA. Chúng sửa được nhiều hơn hẳn — nhưng đổi lại user phải cài IPA đã patch, mất cập nhật App Store, và chấp nhận rủi ro tài khoản.

**Nguồn thật sự dùng được cho module mạng:**

| Repo | Giấy phép | Đóng góp |
|---|---|---|
| [hmxxgit/shadowrocket-youtube-adblock](https://github.com/hmxxgit/shadowrocket-youtube-adblock) | **Apache-2.0** | ⭐ Bản **tương thích Shadowrocket đầy đủ nhất**. Có `DIAGNOSTICS.md`, bộ test A/B/C/D/E (baseline / no-feed / no-udp / no-rewrite / no-script), và bộ tham số đã chạy thật: `engine=jsc` + `bodyBytes` + `{bodyBytes}`. Cũng là nguồn của luật `&oad` và khái niệm probe. |
| [Maasea/sgmodule](https://github.com/Maasea/sgmodule) (bản lưu: [YanbingJiang](https://github.com/YanbingJiang/Shadowrocket_diy_rules) ★149) | — | Module YouTube lâu đời nhất và phổ biến nhất. Nguồn của `[Url Rewrite]` `&oad` + `ctier` 302 + `api/stats/ads`. |
| [app2smile/rules](https://github.com/app2smile/rules) ★4153 | MIT | `youtube.sgmodule` — khung tối thiểu, chỉ `browse` + `next` |

**Nguồn cho số field protobuf** là hai MITM server viết bằng Go, đều công khai và có code đọc được:

| Repo | Giấy phép | Đóng góp |
|---|---|---|
| [pass-with-high-score/blockads-android](https://github.com/pass-with-high-score/blockads-android) ★2767 | GPL-3.0 | `tunnel/internal/mitm/youtube_proto.go` — thuật toán prune `elementRenderer`, pattern Shorts |
| [xxdondi/imitm](https://github.com/xxdondi/imitm) | **MIT** | `internal/modules/youtube/player_ads.go` — xác nhận field 7/68 và cách bảo vệ để không xoá nhầm |

Từ hai nguồn đó mới chốt được **số field chính xác** (7 và 68). Không có bước này thì mọi module protobuf đều phải đoán, và đoán sai thì hoặc không chặn được gì, hoặc xoá mất nội dung thật.

Giấy phép của repo này là gì thì xem `README.md` gốc — nhưng lưu ý: ý tưởng/số field protobuf **không** thuộc phạm vi bảo hộ giống như code. Phần engine ở đây viết lại từ đầu, không dán dòng nào của GPL-3.0.

## So với bản của hmxxgit

Bản của họ dùng lại (vendor) engine của Maasea — hơn 300 KB JS, kèm cả `youtube.ump.js` và bộ giải mã base64/TextDecoder. Module này viết lại từ đầu, chỉ đụng wire format:

| | hmxxgit | Module này |
|---|---|---|
| Kích thước engine | ~310 KB (vendor Maasea) | **18 KB** |
| Phụ thuộc | vendor + build step | 0 |
| Số field protobuf có nguồn | vendor | đối chiếu 2 MITM Go |
| Chẩn đoán | `DIAGNOSTICS.md` + module riêng | `probe=true` + `youtube_selftest.js` |
| SponsorBlock, PiP, download | ❌ không (vẫn cần tweak) | ❌ không |
| GPL-3.0 | không (Apache-2.0) | **không dính GPL** |

Đổi lại họ làm nhiều hơn: `guide`, `account/get_setting`, UMP (mã hoá initplayback), caption translation, chặn upload/immersive. Nếu cần những thứ đó thì dùng bản của họ — nó đã được test trên máy thật nhiều hơn.

## Kiến trúc

Không dùng `protobufjs` (105 KB). Engine chỉ đọc/ghi **wire format ở mức field**:

```
tag (varint)  = field_number << 3 | wire_type
wire 0 = varint · wire 2 = length-delimited · wire 1/5 = fixed64/32
```

Vì sao chọn cách này:

- **Giữ nguyên byte field lạ.** Field YouTube thêm sau này không bị mất, vì engine chỉ copy `buf[start..end]` nguyên vẹn.
- **Không phụ thuộc schema.** Không cần `.proto` cập nhật mỗi lần YouTube đổi.
- **Không tốn bộ nhớ.** Không dựng object tree; chỉ mảng con trỏ vào buffer gốc. Network Extension chỉ có 50 MB.

Quy tắc an toàn:

| Tình huống | Hành vi |
|---|---|
| Cấu trúc protobuf hỏng | `readFields` trả `null` → passthrough nguyên body |
| Không tìm thấy ad | `removed === 0` → passthrough nguyên body |
| Exception bất kỳ | `try/catch` bao ngoài → passthrough nguyên body |
| Body rỗng (304) | `$done({})` — trường hợp duy nhất được phép |

**Không bao giờ** trả `body` rỗng cho một hook `binary-body-mode`: trong Shadowrocket, `$done({})` nghĩa là "thay body bằng rỗng", không phải "giữ nguyên". Đây là lỗi đã làm bản Spotify đầu tiên im lặng hoàn toàn.

## Chẩn đoán trên điện thoại — Shadowrocket KHÔNG có log script

Đây là điểm nhiều module làm sai và người dùng tưởng module hỏng. Thực tế:

| Kênh | Có trên Shadowrocket? |
|---|---|
| `console.log` → trình xem log script | ❌ **không có**. `数据 > 代理` chỉ ghi kết nối (URL / rule / protocol / MITM), không có output của script |
| `$notification.post` | ❌ **không tồn tại** — đây là API của Surge/Loon/QuanX |
| `$persistentStore` | ✅ có |
| `$httpClient` | ✅ có |
| URL rewrite của script `http-request` | ✅ có — và URL đó **hiện trong log kết nối** |

Nên module có 2 kênh đọc được, cả hai đều dùng thứ Shadowrocket thật sự có.

### Cách 1 — probe: đọc trực tiếp trong `数据 > 代理`

Sửa `argument` của module thành:

```
ads&probe=true
```

Mở vài video (có quảng cáo), rồi vào **数据 > 代理**, tìm dòng:

```
youtubei.googleapis.com/youtubei/v1/keepalive?xwuan=probe&hook=v1%2Fplayer&in=8842&out=6103&rm=2&st=patched
```

| Tham số | Nghĩa |
|---|---|
| `hook=` | Hook đã chạy ở endpoint nào. **Không có dòng nào = hook không chạy.** |
| `in=` | Số byte body nhận được. `0` = không có body (thiếu `requires-body`, hoặc QUIC chưa chặn) |
| `out=` | Số byte sau khi sửa |
| `rm=` | Số field quảng cáo đã xoá. `0` = response này không có quảng cáo (bình thường) |
| `st=` | `patched` · `no_ad` · `missing_body` · `parse_fail` |

Xong đổi `argument` về `ads` để tắt probe.

### Cách 2 — báo cáo gộp

Mở **Safari**, gõ:

```
https://www.youtube.com/xwuan-selftest
```

Rồi vào **数据 > 代理**, tìm URL có `?xwuan-report=v1;...`:

| Báo cáo | Nghĩa |
|---|---|
| `state=never_ran` | Engine **chưa từng chạy** → sai ở MITM / CA / global routing, không phải sai ở engine |
| `state=ran;phase=patched;rm=2` | ✅ Đã chạy và đã xoá quảng cáo |
| `state=ran;phase=no-body` | Chạy nhưng không nhận được body → `requires-body` hoặc QUIC |
| `state=ran;phase=parse-fail` | Nhận body nhưng không parse được → gửi mình `src=` và `in=` |

Cả hai kênh **không bao giờ** gửi body, cookie, hay URL gốc ra ngoài. Probe chỉ chứa tên endpoint và các con số.

### Bảng đối chiếu nhanh

| Triệu chứng | Nguyên nhân | Xử lý |
|---|---|---|
| Không có dòng probe nào | Hook không chạy | Bật HTTPS Decrypt + tin cậy CA; kiểm 全局路由 = 配置 |
| `st=missing_body`, `in=0` | Không đọc được body | Kiểm `requires-body=1`, `binary-body-mode=1`, UDP forwarding |
| `st=parse_fail` | Body không phải protobuf | Gửi mình `in=` và vài byte đầu |
| `st=no_ad` nhưng vẫn thấy quảng cáo | Quảng cáo đến từ endpoint khác | Xem log có `hook=` nào khác không; có thể là `initplayback` |
| `st=patched` nhưng vẫn thấy quảng cáo | Field ad nằm ở vị trí khác | Gửi mình `rm=` và `hook=` để mình soi |

## Đã kiểm chứng gì

| Kiểm chứng | Cách làm | Kết quả |
|---|---|---|
| Wire format đọc/ghi đúng | Dựng protobuf thật bằng tay, round-trip qua engine | ✅ 14 test |
| Không mất byte field lạ | Test với field 9999 giả định YouTube thêm sau | ✅ |
| Không xoá nhầm nội dung | Test element < 200 B và ad shelf có element con | ✅ |
| Số field đúng | Đối chiếu 2 repo MITM độc lập | ✅ 7 và 68 |
| Cú pháp module chạy được | 18 test theo checklist đã dùng cho Spotify | ✅ |
| Kênh chẩn đoán hoạt động | 18 test chạy engine + selftest trong runtime giả lập | ✅ |
| Cấu hình khớp bản tương thích Shadowrocket | Đối chiếu hmxxgit (Apache-2.0) | ✅ |
| **Trên máy thật** | **Chưa ai chạy** | ❌ **cần bạn test** |

Dòng cuối là quan trọng: mọi thứ ở trên là test Node. Chưa có ai cài module này lên iPhone và mở YouTube. Trước khi phát cho ai, hãy tự chạy với `debug=true` và đối chiếu 4 dòng log ở trên.

## Việc còn có thể làm

1. **`/youtubei/v1/log_event` có thể chặn nhầm** — endpoint này cũng dùng cho watch-time tracking. Nếu lịch sử xem hoặc "tiếp tục xem" có vấn đề, bỏ dòng `reject-200` tương ứng trong `[URL Rewrite]` trước tiên.
2. **Chặn `imasdk.googleapis.com`** có thể làm hỏng video nhúng từ web khác. Nếu gặp, thêm ngoại lệ.
3. **Field 68 chưa chắc có ở mọi phiên bản app** — engine chỉ xoá khi thấy, không bắt buộc. Không có cũng không sao.
4. **Danh sách pattern feed dựa trên quan sát**, không phải hằng số giao thức. YouTube đổi tên nhãn là phải cập nhật. Cách phát hiện: feed không sạch nhưng `/player` sạch.
