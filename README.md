# Viet Bach Locket AI Studio

Ứng dụng web độc lập gồm Photobooth 4 ô và AI Filter bằng OpenAI Images API.

## Khởi chạy
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```
Trên Windows, dùng `.venv\Scripts\activate`. Mở http://127.0.0.1:8000.

Photobooth hoạt động không cần API key. AI Filter yêu cầu biến môi trường `OPENAI_API_KEY` trên backend; `OPENAI_IMAGE_MODEL` mặc định là `gpt-image-1`. Không đưa khóa vào GitHub hoặc HTML. OpenAI API có thể tính phí.

## API
- `GET /health`: trạng thái backend.
- `POST /api/photobooth`: 1–4 ảnh trong `files`, màu `theme` pink/cream/dark.
- `POST /api/ai-filter`: ảnh `file` và văn bản `prompt`.

## Triển khai
Có Dockerfile để triển khai trên dịch vụ hỗ trợ Docker/Python và HTTPS. Ảnh được lưu trong `generated/`; chưa tự xóa. Trước khi mở công khai cần bổ sung xác thực, giới hạn tốc độ, giới hạn chi phí AI và dọn ảnh.

## Shadowrocket
`shadowrocket/VietBachAI.sgmodule` là module mô tả, không có MITM và không mở khóa quyền Gold. AI/Photobooth chạy trên web độc lập, chưa tích hợp vào ứng dụng Locket.

## Trạng thái
Đã đưa mã nguồn lên GitHub; chưa kiểm thử thực tế trên iPhone hay OpenAI API.
