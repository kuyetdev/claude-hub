# Claude Hub

Theo dõi hạn mức tuần của **một tài khoản Claude dùng chung** trên nhiều người, nhiều máy. Hub chỉ cảnh báo, không chặn sử dụng. Toàn bộ giao diện, log và tin nhắn vận hành dùng tiếng Việt.

## Yêu cầu

- Node.js 24 trở lên.
- VPS và các máy client cùng một tailnet Tailscale.
- Hub chỉ phục vụ một tài khoản Claude. Báo cáo của tài khoản khác sẽ bị từ chối.

```bash
npm install
npm run typecheck
npm test
```

## Chạy hub trên VPS

Tạo hai khóa mạnh, ngẫu nhiên và chỉ truyền qua biến môi trường. Không ghi khóa thật vào file trong repo.

```bash
export HUB_HOST=100.x.y.z
export HUB_PORT=4318
export HUB_DB_PATH=/var/lib/claude-hub/hub.db
export HUB_ENROLL_KEY='khóa-dùng-để-đăng-ký-máy'
export HUB_ADMIN_KEY='khóa-quản-trị-dashboard'
export HUB_TZ=Asia/Ho_Chi_Minh

# Không bắt buộc. Thiếu hai biến này thì hub vẫn chạy, chỉ không gửi cảnh báo.
export TELEGRAM_BOT_TOKEN='token-bot'
export TELEGRAM_CHAT_ID='chat-id'

npm start
```

Mở `http://100.x.y.z:4318` từ một máy trong tailnet. `HUB_HOST` nên là IP Tailscale của VPS, không nên dùng `0.0.0.0`. Tailscale mã hóa đường truyền; project không dựng thêm HTTPS.

Repo có sẵn unit systemd user tại `deploy/claude-hub.service`. Unit giả định source được đặt ở `~/apps/claude-hub` và biến môi trường nằm tại `~/.config/claude-hub/env` với quyền `0600`.

### Biến môi trường

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
|---|---:|---|---|
| `HUB_HOST` | Không | `127.0.0.1` | Địa chỉ hub lắng nghe; khi chạy VPS hãy đặt IP Tailscale |
| `HUB_PORT` | Không | `4318` | Cổng HTTP |
| `HUB_DB_PATH` | Không | `./data/hub.db` | File SQLite |
| `HUB_ENROLL_KEY` | Có | Không có | Khóa chung để đăng ký máy |
| `HUB_ADMIN_KEY` | Có | Không có | Khóa sửa quota và gỡ máy |
| `HUB_TZ` | Không | `Asia/Ho_Chi_Minh` | Múi giờ hiển thị và tính ngày nhắc |
| `TELEGRAM_BOT_TOKEN` | Không | Không có | Token bot Telegram |
| `TELEGRAM_CHAT_ID` | Không | Không có | Nơi nhận cảnh báo |
| `HUB_WEIGHT_INPUT` | Không | `1` | Trọng số input token |
| `HUB_WEIGHT_OUTPUT` | Không | `5` | Trọng số output token |
| `HUB_WEIGHT_CACHE_CREATION` | Không | `1.25` | Trọng số cache tạo |
| `HUB_WEIGHT_CACHE_READ` | Không | `0.1` | Trọng số cache đọc |

Các secret không có giá trị mặc định. Hub không ghi token vào SQLite, log, API hoặc giao diện. Token máy chỉ lưu dưới dạng SHA-256.

## Đăng ký từng máy

Trên mỗi máy cần báo usage, chạy từ thư mục project:

```bash
node agent/cli.ts register --hub http://100.x.y.z:4318
```

Agent hỏi username và `HUB_ENROLL_KEY`; khóa đăng ký được nhập ẩn và không lưu. Username giống nhau được xem là cùng một người. Agent tạo UUID riêng, không dùng `machineID` của Claude Code, rồi lưu cấu hình tại `~/.claude-storage-agent.json` với quyền `0600`.

Chạy lại `register` sẽ hỏi xác nhận; nếu đồng ý, hub thu hồi token cũ của máy đó.

## Gửi báo cáo

```bash
node agent/cli.ts report
```

Lệnh tự bỏ qua nếu lần gửi thành công trước đó chưa đủ 60 giây. Agent chỉ đọc các trường usage cần thiết trong `~/.claude.json` và token tổng hợp từ `~/.claude/projects/**/*.jsonl`; không đọc `~/.claude/sessions/*.key`, `settings.json`, prompt, nội dung message, tên file hay đường dẫn project để gửi đi.

Agent quét tăng dần và giữ offset trong `~/.claude-storage-agent.state.json` (quyền `0600`). Khi tuần đổi, tổng cũ được xóa.

### Hook Claude Code

In JSON hook để tự dán vào cấu hình Claude Code:

```bash
node agent/cli.ts print-hook
```

Agent **không tự sửa** `settings.json`. Có thể dùng hook `Stop`, cron hoặc launchd mỗi 5 phút.

## Quota và dashboard

- Khi chưa chỉnh tay, quota được chia đều cho tất cả người.
- Sau khi admin đã chỉnh quota, người mới nhận `0%`; dashboard báo tổng quota khác `100%` cho đến khi admin phân bổ lại.
- Form quota bắt buộc đủ mọi người và tổng bằng `100%` (sai số tối đa `0,01`). `HUB_ADMIN_KEY` chỉ giữ trong state của tab, không lưu vào `localStorage`.
- Máy không báo quá 30 phút được đánh dấu offline. Usage tài khoản quá 30 phút được đánh dấu dữ liệu cũ.
- Admin có thể chọn ngày trong tuần và giờ reset token tổng. Lịch dùng múi giờ `HUB_TZ`; agent lấy lịch trước mỗi lần quét và tự mở kỳ token mới. Giờ reset hạn mức Claude vẫn hiển thị riêng và không bị thay đổi.

Mức dùng người được ước lượng bằng:

```text
weighted = input × 1 + output × 5 + cacheCreation × 1,25 + cacheRead × 0,1
used_user = accountPercent × weighted_user / tổng weighted
```

Đây chỉ là phép **quy đổi xấp xỉ để chia tương quan**, không phải công thức tính phí hay hạn mức của Anthropic. Cách này không xác định được phần dùng từ web/điện thoại.

## Cảnh báo Telegram

- Theo người: 80%, 100%, rồi 110%, 120%… quota của người đó.
- Toàn tài khoản: 80% và 100% hạn mức tuần.
- Khi còn vượt 100%, nhắc lại tối đa một lần mỗi ngày theo `HUB_TZ`.
- Mỗi mốc chỉ được ghi nhận sau khi Telegram trả HTTP 200. Gửi lỗi sẽ thử lại ở báo cáo kế tiếp.
- Sang tuần mới, mốc cảnh báo được tính lại từ đầu.

## API

| Method | Đường dẫn | Xác thực |
|---|---|---|
| `POST` | `/api/register` | `x-enroll-key` |
| `POST` | `/api/report` | `Authorization: Bearer <machineToken>` |
| `GET` | `/api/state` | Không; dựa vào tailnet |
| `PUT` | `/api/quota` | `x-admin-key` |
| `PUT` | `/api/reset-schedule` | `x-admin-key` |
| `GET` | `/api/agent-settings` | Bearer token máy |
| `DELETE` | `/api/machines/:id` | `x-admin-key` |

Body bị giới hạn 64 KB. Báo cáo theo token máy bị giới hạn tối đa một lần mỗi 30 giây ở hub.

## Cấu trúc

```text
agent/   CLI register, report, print-hook; quét usage tăng dần
hub/     HTTP API, SQLite, quota, phép quy đổi, cảnh báo Telegram
server/  che secret trước khi chuỗi ra UI hoặc log
shared/  kiểu dữ liệu dùng chung
web/     dashboard React + Vite
test/    auth, validation, scan, quota, usage, Telegram dedupe
```

## Giới hạn

Project không chặn usage, không ép hạn mức, không tách được usage từ web/điện thoại, không hỗ trợ nhiều tài khoản và không chia quota theo cửa sổ 5 giờ.
