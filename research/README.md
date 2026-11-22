# `research/` — nguyên liệu, không phải bản phát hành

Chỗ chứa thứ đang tìm hiểu. **Không có gì ở đây được module hay code production trỏ tới.**

| Thư mục | Nội dung |
|---|---|
| `reference_nightmarket/` | 3 script tham chiếu của người khác (`forceGold4.3.js`, `header7.js`, `locketfix8.js`) — để so sánh cách họ làm |
| `scanner/` | `index.js` — quét thư mục tìm IP / URL / rule hostname. **Có test** (`tests/scanner.test.js`) nên không phải code chết |

## Khác gì `products/`?

| | `research/` | `products/` |
|---|---|---|
| Mục đích | tìm hiểu, so sánh, thử | phát hành, có link cài đặt |
| Có test | chỉ `scanner/` | có |
| Được trỏ từ module | không | có |

Nếu một thứ trong `research/` trở thành sản phẩm thật, chuyển sang `products/` (nếu là
sản phẩm nhiều phần) hoặc `scripts/` + `modules/` (nếu là module đơn).

Lịch sử: `research/spotify/` đã được chuyển thành `products/spotify/` vì đã thành sản phẩm.
