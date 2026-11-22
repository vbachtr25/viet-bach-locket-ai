# Xwuan-Tweaks

Tổng hợp module, script và hạ tầng mở khóa tính năng (hiện tại: **Locket Gold VIP** — quay video 60s có tiếng, Photobooth 4-cut, AI Likeness Filters, Khung Widget & Caption VIP, chặn quảng cáo; **Spotify Premium**; **YouTube AdBlock**) phát triển bởi **Xwuan** ([@Xwuan19](https://github.com/Xwuan19)).

---

## Link Cài Đặt Chính Thức (Raw)

Sao chép trực tiếp link **Raw** tương ứng với ứng dụng bạn đang dùng:

| Tính năng | Ứng dụng | Link Raw cài đặt |
| --- | --- | --- |
| **Locket VIP (All-in-One)** | Shadowrocket | `https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/modules/Locket_VIP.module` |
| **Locket VIP (RemoteConfig)** | Surge | `https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/modules/Locket_RemoteConfig.sgmodule` |
| **Locket VIP (RemoteConfig)** | Loon | `https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/modules/Locket_RemoteConfig.plugin` |
| **Locket VIP (RemoteConfig)** | Quantumult X | `https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/modules/Locket_RemoteConfig.snippet` |
| **Locket VIP (RemoteConfig)** | Stash | `https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/modules/Locket_RemoteConfig.stoverride` |
| **Spotify Premium** | Shadowrocket | `https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/products/spotify/on-device/module/spotify-premium-ucs.module` |
| **YouTube AdBlock** | Shadowrocket | `https://raw.githubusercontent.com/Xwuan19/Xwuan-Tweaks/main/products/youtube/module/youtube-adblock.module` |

> Hướng DNS (cài 1 profile, không cần app) tạm dừng cùng đợt gỡ web — cần có server
> chạy DoH + MITM trước. Xem `products/spotify/server/README.md` và `HANDOFF.md`.

> [!IMPORTANT]
> **2 bước bắt buộc để kích hoạt Locket VIP thành công:**
> 1. Bật **Giải mã HTTPS (HTTPS Decryption / MitM)** và tin cậy chứng chỉ gốc trong `Cài đặt > Cài đặt chung > Giới thiệu > Cài đặt tin cậy chứng nhận`.
> 2. **Xóa app Locket rồi tải lại từ App Store** ở lần cài đầu tiên để xóa cache SQLite của Firebase Remote Config (sau đó dùng bình thường không cần xóa lại).

---

## Cấu Trúc Thư Mục

```text
Xwuan-Tweaks/
│  ── HƯỚNG A: module chạy trên máy user (cần app proxy) ──
├── modules/               # File cấu hình cài thẳng (.module, .sgmodule, .plugin, .snippet, .stoverride)
├── scripts/               # JS chạy trong app proxy, được modules/ trỏ tới qua raw URL
├── assets/                # Ảnh dùng trong response (trỏ qua URL tuyệt đối)
│
│  ── HƯỚNG B: DNS + MITM server (không cần cài app) ──
├── proxy/                 # Go TLS MITM proxy: ký cert theo SNI, sửa response
├── admin/                 # Thư viện DNS: sinh profile DoH + danh sách domain rewrite
├── ca/                    # Root CA: cert trong git, key KHÔNG bao giờ vào git
├── nextdns/               # NextDNS API client + DOMAINS_TO_REWRITE
│
├── products/              # Sản phẩm nhiều phần (spotify/: on-device + server · youtube/: module + engine)
├── research/              # Nguyên liệu, thử nghiệm (reference_nightmarket/, scanner/)
├── archive/               # Bản cũ & tham chiếu người khác — KHÔNG dùng để phát hành
├── tests/                 # Bộ kiểm thử (Node & Go)
│
└── HANDOFF.md             # Trạng thái repo, quyết định đã chốt, việc cần làm
```

> **Web đã tạm gỡ** (`public/`, `api/`, `supabase/`, `vercel.json`). Trọng tâm hiện tại là
> DNS + module. Xem `HANDOFF.md` mục "Đã gỡ web" để biết cách khôi phục từ git history.
>
> Mỗi thư mục đều có `README.md` riêng. Bắt đầu từ [`HANDOFF.md`](HANDOFF.md).

> Mỗi thư mục đều có `README.md` riêng giải thích nội dung và ai trỏ tới nó.
> Bắt đầu từ [`HANDOFF.md`](HANDOFF.md) để biết hiện trạng.

---

## Quy Trình Phát Triển & Kiểm Thử

1. **Nghiên cứu & thử nghiệm**: Lưu tài liệu phân tích, mẫu tham khảo hoặc công cụ quét tại `research/`.
2. **Phát hành chính thức**: Đưa script đã test ổn định vào `scripts/`, gắn link Raw vào file cấu hình trong `modules/` và cập nhật bảng cài đặt ở trên. Chuyển bản cũ hết dùng sang `archive/`.
   - Sản phẩm nhiều phần (như `products/spotify/`) tự quản cấu trúc bên trong: mỗi hướng triển khai một thư mục con có README riêng, dữ liệu dùng chung ở `data/`.
3. **Đồng bộ Go Proxy**: Khi có payload mới, đồng bộ vào `proxy/handler/firebase.go` hoặc `proxy/handler/revenuecat.go`.
4. **Kiểm thử trước khi push**:
   ```bash
   node --test tests/*.test.js tests/*/*.test.js   # 35 test, phải xanh hết
   go test ./tests/proxy/...                        # cần Go toolchain
   ```
5. **Cập nhật `HANDOFF.md`** nếu quyết định thay đổi hoặc phát hiện cạm bẫy mới — file đó
   là nguồn sự thật cho phiên làm việc sau.
