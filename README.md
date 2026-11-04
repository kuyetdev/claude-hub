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
export HUB_TZ=Asia/Ho_Chi_Minh

# Không bắt buộc. Thiếu hai biến này thì hub vẫn chạy, chỉ không gửi cảnh báo.
export TELEGRAM_BOT_TOKEN='token-bot'
export TELEGRAM_CHAT_ID='chat-id'

npm start
```

Mở `http://100.x.y.z:4318` từ một máy trong tailnet. `HUB_HOST` nên là IP Tailscale của VPS, không nên dùng `0.0.0.0`. Tailscale mã hóa đường truyền; project không dựng thêm HTTPS.

Repo có sẵn unit systemd user tại `deploy/claude-hub.service`. Unit giả định source được đặt ở `~/apps/claude-hub` và biến môi trường nằm tại `~/.config/claude-hub/env` với quyền `0600`.

Nếu server không cài Node, có thể build image bằng `Dockerfile` và chạy `deploy/compose.yaml`. Compose dùng host network để hub bind trực tiếp IP Tailscale, lưu SQLite trong thư mục `data/` cạnh file Compose và tự khởi động lại sau reboot.

### Biến môi trường

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
|---|---:|---|---|
| `HUB_HOST` | Không | `127.0.0.1` | Địa chỉ hub lắng nghe; khi chạy VPS hãy đặt IP Tailscale |
| `HUB_PORT` | Không | `4318` | Cổng HTTP |
| `HUB_DB_PATH` | Không | `./data/hub.db` | File SQLite |
| `HUB_ENROLL_KEY` | Có | Không có | Khóa chung để đăng ký máy |
| `HUB_TZ` | Không | `Asia/Ho_Chi_Minh` | Múi giờ hiển thị và tính ngày nhắc |
| `TELEGRAM_BOT_TOKEN` | Không | Không có | Token bot Telegram |
| `TELEGRAM_CHAT_ID` | Không | Không có | Nơi nhận cảnh báo |
| `HUB_WEIGHT_INPUT` | Không | `1` | Trọng số input token |
| `HUB_WEIGHT_OUTPUT` | Không | `5` | Trọng số output token |
| `HUB_WEIGHT_CACHE_CREATION` | Không | `1.25` | Trọng số cache tạo |
| `HUB_WEIGHT_CACHE_READ` | Không | `0.1` | Trọng số cache đọc |

Enroll key không có giá trị mặc định. Hub không ghi token vào log, API hoặc giao diện. Token máy chỉ lưu dưới dạng SHA-256. Các API quản trị không có khóa riêng vì dashboard chỉ được phục vụ trong tailnet.

## Đăng ký từng máy

Trên mỗi máy cần báo usage, chạy từ thư mục project:

```bash
node agent/cli.ts register --hub http://100.x.y.z:4318
```

Agent hỏi username và `HUB_ENROLL_KEY`; khóa đăng ký được nhập ẩn và không lưu. Username giống nhau được xem là cùng một người. Agent tạo UUID riêng, không dùng `machineID` của Claude Code, rồi lưu cấu hình tại `~/.claude-storage-agent.json` với quyền `0600`.

Dashboard có mục **Cài máy mới** để tạo lệnh cài một dòng cho Ubuntu hoặc macOS. Script cài Node.js 24 qua NVM nếu máy chưa có, đặt agent tại `~/.local/share/claude-hub-agent`, tạo lệnh `~/.local/bin/claude-hub-agent`, rồi mở bước đăng ký tương tác. Script không chứa enroll key. Sau khi đăng ký, script thêm bộ thu quota `statusLine` và hook `Stop` vào `~/.claude/settings.json`, đồng thời tạo backup `settings.json.claude-hub.bak`; status line, settings và hook có sẵn vẫn được giữ và chạy tiếp.

Chạy lại `register` sẽ hỏi xác nhận; nếu đồng ý, hub thu hồi token cũ của máy đó.

## Gửi báo cáo

```bash
node agent/cli.ts report
```

Agent lấy `rate_limits` trực tiếp từ dữ liệu `statusLine` mà Claude CLI cung cấp sau API response (cùng hướng với Orca), dùng cache usage trong `~/.claude.json` làm fallback, và cộng token tổng hợp từ `~/.claude/projects/**/*.jsonl`. Agent không đọc `~/.claude/sessions/*.key`, prompt hay nội dung message để gửi đi. Mỗi hook chỉ gửi số liệu tổng hợp; cache `statusLine` quá 24 giờ không được dùng.

Agent quét tăng dần và giữ offset trong `~/.claude-storage-agent.state.json` (quyền `0600`). Khi tuần đổi, tổng cũ được xóa.

### Hook Claude Code

In JSON hook để tự dán vào cấu hình Claude Code:

```bash
node agent/cli.ts print-hook
```

Installer tự thêm hook `Stop`; mỗi lượt chat Claude hoàn tất mới gọi `report` một lần. Lúc đó quota từ response mới nhất và token của câu trả lời đã sẵn sàng. Agent quét tăng dần và khử trùng nên message đã thấy không bị cộng lại.

## Quota và dashboard

- Khi chưa chỉnh tay, quota được chia đều cho tất cả người.
- Sau khi admin đã chỉnh quota, người mới nhận `0%`; dashboard báo tổng quota khác `100%` cho đến khi admin phân bổ lại.
- Form quota bắt buộc đủ mọi người và tổng bằng `100%` (sai số tối đa `0,01`).
- Máy không báo quá 30 phút được đánh dấu offline. Usage tài khoản quá 30 phút được đánh dấu dữ liệu cũ.
- Admin có thể chọn ngày trong tuần và giờ reset token tổng. Lịch dùng múi giờ `HUB_TZ`; agent lấy lịch trước mỗi lần quét và tự mở kỳ token mới. Giờ reset hạn mức Claude vẫn hiển thị riêng và không bị thay đổi.

Mức dùng người được ước lượng bằng:

```text
weighted = input × 1 + output × 5 + cacheCreation × 1,25 + cacheRead × 0,1
used_user = accountPercent × weighted_user / tổng weighted
used_machine = accountPercent × weighted_machine / tổng weighted
```

Dashboard hiển thị “ước tính đóng góp” cho từng máy. Đây chỉ là phép **quy đổi xấp xỉ để chia tương quan**, không phải công thức tính phí hay hạn mức của Anthropic. Khi chưa cài đủ máy, phần trăm của các máy đã quan sát có thể bị cao hơn thực tế; cách này cũng không xác định được phần dùng từ web/điện thoại.

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
| `PUT` | `/api/quota` | Không; dựa vào tailnet |
| `PUT` | `/api/reset-schedule` | Không; dựa vào tailnet |
| `GET` | `/api/agent-settings` | Bearer token máy |
| `DELETE` | `/api/machines/:id` | Không; dựa vào tailnet |

Body bị giới hạn 64 KB. Báo cáo vẫn phải dùng Bearer token riêng của máy.

## Cấu trúc

```text
agent/   CLI register, report, statusline, print-hook; quét usage tăng dần
hub/     HTTP API, SQLite, quota, phép quy đổi, cảnh báo Telegram
server/  che secret trước khi chuỗi ra UI hoặc log
shared/  kiểu dữ liệu dùng chung
web/     dashboard React + Vite
test/    auth, validation, scan, quota, usage, Telegram dedupe
```

## Giới hạn

Project không chặn usage, không ép hạn mức, không tách được usage từ web/điện thoại, không hỗ trợ nhiều tài khoản và không chia quota theo cửa sổ 5 giờ.
