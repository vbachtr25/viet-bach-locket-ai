# `assets/` — ảnh dùng trong response của Locket

Không có code nào trong repo đọc thư mục này bằng đường dẫn tương đối. Nó được phục vụ
qua **URL tuyệt đối** trỏ về GitHub, nên vẫn hoạt động dù repo đổi cấu trúc — miễn là
đường dẫn `assets/...` giữ nguyên.

| File | Ai trỏ tới |
|---|---|
| `frames/frame_royal_gold.png` | `scripts/locket_firebase_response.js` → `cdn.jsdelivr.net/gh/Xwuan19/Xwuan-Tweaks@main/assets/frames/...` |
| `frames/frame_kitty_shinchan.png` | như trên |
| `frames/frame_lowg_l2k.png` | như trên |
| `frames/frame_citopia_y2k.png` | như trên |
| `locket_gold.jpg` | `scripts/locket_firebase_response.js` → `raw.githubusercontent.com/.../assets/locket_gold.jpg` |

## Lưu ý

- **Đổi tên hoặc di chuyển file trong `assets/` sẽ làm hỏng ảnh trong app user**, vì URL
  đã nhúng trong script đang phát hành. Nếu buộc phải đổi, phải sửa script + tăng `?v=`
  trong module, và chấp nhận user cũ vẫn gọi URL cũ.
- Sticker và frame của Photobooth nằm ở CDN bên ngoài (`locket-vip.mhiep20077.workers.dev`),
  **không** nằm trong thư mục này.
