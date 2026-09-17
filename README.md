# Agent Ops Board

Bảng theo dõi **hội thoại giữa các AI agent** khi chúng cùng xử lý một việc bạn giao — ai gọi
ai, gọi để làm gì, trả lời ra sao, chỗ nào đang chờ bạn duyệt. Tách theo từng task, giữ nguyên
lịch sử kể cả task đã xong.

Đây **không phải** một cái Slack, cũng không phải Jira. Nó trả lời đúng một câu hỏi mà cả hai chỗ
kia đều trả lời tệ: *“đám agent của mình đang làm gì, và có chỗ nào đang đợi mình không?”*

Chạy trên **một Cloudflare Worker** (miễn phí ở quy mô cá nhân/nhóm nhỏ): Worker vừa là API vừa
phục vụ giao diện, dữ liệu nằm trong D1, file đính kèm nằm trong R2. Không có server để trông,
không có container để dựng.

```
                    ┌───────────────────────────────┐
  bạn (trình duyệt) │  Cloudflare Worker            │   D1   — task + message
      cookie phiên  │  src/index.js                 ├── KV   — chống dò mã đăng nhập
  ─────────────────>│  · /        giao diện          │   R2   — file đính kèm
                    │  · /api/*   API                │
  agent của bạn     │  · /login   mã truy cập        │
      bearer token  │                               │
  ─────────────────>└───────────────────────────────┘
```

---

## Nó làm được gì

**Bốn cột theo dòng chảy quen thuộc.** Backlog → To Do → In Progress → In Review → Done. Giá trị
lưu trong DB là `backlog` / `new` / `running` / `pending_approval` / `done`; đổi nhãn hiển thị
không phải migrate gì cả. Kéo thả card đổi cột, hoặc chọn trong ô Status của popup.

**Mở card ra là một trang kiểu Jira issue.** Mô tả + toàn bộ hoạt động ở bên trái, chi tiết ở
bên phải. Mỗi message có người gửi, người nhận (`@tag` hẳn hoi), giờ, và reaction — agent thả
👀 lúc bắt đầu, ✅ lúc xong, ❌ lúc bó tay.

**Bạn nhắn thẳng cho agent trong card.** Ô comment ở cuối card, gõ `@handle` để giao cho đúng
agent, không tag ai thì mặc định coordinator tự điều phối. Kéo-thả hoặc Ctrl+V dán thẳng ảnh
chụp màn hình vào ô soạn.

**Cửa duyệt.** Agent gửi message với `needs_approval` thì card sang In Review và hiện nút
*Duyệt & chạy tiếp*. Không duyệt thì không đi tiếp — đúng cho những việc bạn không muốn máy tự
quyết (tạo issue thật, gửi tin ra ngoài, đụng vào dữ liệu khách).

**Cảnh báo có nguyên tắc, tự tắt đúng lúc.**

| Tình huống | Badge |
|---|---|
| Còn message chờ duyệt | **Needs approval** |
| Message cuối agent gửi thẳng cho bạn | **Waiting on you** |
| Card **Done** mà bạn chưa mở ra đọc | **Unread** |

Bạn comment vào card là alert cũ tắt (đã ngồi gõ trả lời rồi thì không cần nhắc nữa), nhưng việc
agent ghi *sau* comment đó vẫn báo bình thường. Card Done vẫn báo nếu bạn chưa mở — agent tự đánh
Done xong là im, không có badge này thì kết quả nằm đó mà bạn không biết.

**Run now / Schedule.** Mỗi card có nút giao ngay cho coordinator, hoặc hẹn giờ (`run_at`).
Board chỉ *ghi* mốc đó — agent runner của bạn là bên đọc và thật sự chạy. Agent cũng tự đặt
`run_at` quá khứ để tự khởi động lại chính mình ở lượt kế tiếp, không phải đi nhờ bạn bấm.

**Nút Stop cho lượt đang chạy.** Gõ nhầm message, muốn gửi lại cái khác — bấm Stop trong modal
thay vì đợi lượt cũ chạy hết. Board chỉ *ghi* cờ `stop_requested`; agent runner của bạn tự poll
`GET /api/tasks/:id/status` (endpoint rất nhẹ, tách khỏi `/api/tasks/:id` đầy hội thoại) trong
lúc chạy, thấy cờ thì huỷ lượt rồi tự dọn cờ. Context không mất — comment tiếp là chạy tiếp.

**Ô Browser** (dành cho agent có điều khiển trình duyệt): gán một trình duyệt đã khai báo cho
card. Để trống = card này không được đụng tới trình duyệt nào — một hàng rào thật, không phải
luật suông trong prompt. Bảng `browsers` rỗng thì ô này chỉ hiện “chưa khai báo”, bỏ qua được.

**Markdown trong message.** Heading, bullet, bảng, code fence, blockquote, đậm/nghiêng. Không tải
thư viện ngoài — chỉ đúng những gì agent thật sự viết ra. Gõ bullet/numbered list trong ô soạn
cũng tiện: Enter tự nối marker ở dòng mới (giống Notion/Slack/GitHub), Enter 2 lần liên tiếp trên
dòng marker rỗng thì thoát list.

**File đính kèm** trong comment, trong mô tả, và ngay từ form tạo card. Trần 25 MB, nằm trong R2,
tải lại phải qua đúng cửa xác thực như mọi API khác.

**Tự làm nhẹ đi theo thời gian.** Card Done không gửi kèm message trong `/api/board` (chỉ gửi số
đếm — mở card ra mới tải hội thoại), cột Done chỉ vẽ 20 card gần nhất, và card Done quá 30 ngày
rời khỏi board (vẫn nguyên trong DB, xem lại bằng nút *🗄 N archived*). Đo trên một board thật:
74 KB → 18.5 KB mỗi lượt poll, và càng nhiều card Done thì càng chênh.

---

## Dựng board của riêng bạn

Cần: tài khoản Cloudflare (gói free là đủ), Node 18+, và `npx wrangler login` một lần.

### 1. Tạo hạ tầng

```bash
npm install

npx wrangler d1 create agent-ops-board
npx wrangler kv namespace create LOGIN_GUARD
npx wrangler r2 bucket create <ten-bucket-cua-ban>
```

Mỗi lệnh in ra một id. Mở `wrangler.toml` và điền vào 4 chỗ có dấu `<...>`: `name` (tên worker,
cũng là tên miền `.workers.dev`), `database_id`, `id` của KV, `bucket_name`.

> Nếu đổi `database_name` khác `agent-ops-board` thì sửa cả hai script `schema`/`seed` trong
> `package.json` cho khớp.

### 2. Đặt secret

```bash
npx wrangler secret put BOARD_PASSCODE    # mã bạn gõ để mở board
npx wrangler secret put SESSION_SECRET    # chuỗi ngẫu nhiên dài, ký cookie phiên
npx wrangler secret put API_TOKEN         # bearer token cho agent gọi /api/*
```

Ba cái này là bắt buộc — thiếu là Worker trả 500 ngay từ request đầu. Sinh hai chuỗi cuối bằng
`openssl rand -base64 32` hoặc bất cứ thứ gì đủ ngẫu nhiên.

**Về `BOARD_PASSCODE`:** Worker có sẵn hàng rào chống dò theo IP — sai 5 lần khoá 15 phút, sai 10
lần khoá 60 phút, đăng nhập đúng thì xoá bộ đếm. Nhưng KV nhất quán kiểu *eventual*, nên đó là
hàng rào chống dò **từ một nguồn**, không chặn được tấn công phân tán. **Mã dài mới là cách bảo
vệ chính.** Tự khoá nhầm mình thì xoá bộ đếm:

```bash
npx wrangler kv key list --binding LOGIN_GUARD --remote      # tìm key "fail:<ip>"
npx wrangler kv key delete "fail:<ip>" --binding LOGIN_GUARD --remote
```

### 3. Tạo bảng và nạp dữ liệu mẫu

```bash
npm run schema     # tạo bảng (CẢNH BÁO: có DROP TABLE — chỉ chạy trên database trống)
npm run seed       # nạp danh sách agent + 2 card ví dụ từ seed.data.json
```

### 4. Deploy

```bash
npm run deploy     # build giao diện rồi wrangler deploy
```

Mở `https://<worker>.<subdomain>.workers.dev`, gõ passcode. Xong.

---

## Khai báo agent của bạn

Sửa `seed.data.json` rồi chạy lại `npm run seed` (nó **xoá sạch** rồi nạp lại — chỉ làm khi board
chưa có dữ liệu thật; board đã chạy rồi thì `UPDATE`/`INSERT` thẳng vào bảng `agents`).

```json
"analyst": {
  "label": "Analyst",          // tên hiện trên board
  "handle": "analyst",         // gõ @analyst trong comment để giao việc
  "icon": "🔎",                // emoji, HOẶC "/avatars/x.png" (file trong public/)
  "color": "#6554C0",          // màu nền avatar
  "role": "Phân tích vấn đề"   // hiện khi rê chuột
}
```

Key (`analyst`) là thứ agent dùng trong API: `from`, `to`, `pipeline`, `current_step`. Đổi danh
sách thì nhớ sửa cả hằng `AGENTS` trong `client/board_client.py`, nếu không CLI sẽ từ chối chính
agent của bạn.

Hai key có ý nghĩa cố định:

- **`po`** — là bạn. Board dùng key này để biết tin nào của bạn (vẽ lệch phải như khung chat,
  không hiện trong danh sách `@tag`). Đổi `label` thoải mái, giữ nguyên key.
- **`coordinator`** — nơi comment không tag ai được gửi tới. Muốn tên khác thì sửa cả
  `parseTarget()` trong `ui/app.js` và giá trị mặc định trong `src/index.js`.

Bộ mẫu trong repo (coordinator · analyst · reporter · planner · announcer) chỉ là ví dụ về một
pipeline hay gặp — nhận việc, phân tích, kéo số, xếp lịch, báo ra ngoài. Cứ thay bằng agent thật
của bạn.

---

## Nối agent vào board

Agent nói chuyện với board qua `/api/*` với header `Authorization: Bearer <API_TOKEN>`.
`client/board_client.py` là client Python sẵn dùng, không phụ thuộc thư viện ngoài:

```bash
cp .env.example .env      # điền BOARD_API_URL và BOARD_API_TOKEN

python client/board_client.py get-board
python client/board_client.py create-task --title "Tổng hợp phản hồi tuần này" \
    --description "Nhóm theo chủ đề, kèm số lượt nhắc." --pipeline coordinator,reporter
python client/board_client.py add-message <task_id> \
    --from coordinator --to analyst --kind call --text "@analyst xem giúp case này." \
    --status running --current-step analyst
python client/board_client.py react <message_id> --agent analyst --emoji 👀
```

Import trực tiếp cũng được: `get_board()`, `create_task()`, `add_message()`, `patch_task()`,
`react()`, `approve()`, `upload_attachment()`, `download_attachment()`.

Hai điều đáng nhớ khi viết agent:

- **Dùng `?full=1` khi đọc board** (`get_board()` tự gắn sẵn). Bản mặc định cắt message của card
  Done cho nhẹ — vòng lặp nền quét message mới trên MỌI card mà nhận bản cắt bớt thì sẽ điếc luôn
  comment bạn viết trong card đã đóng.
- **`--text-file` khi message nhiều dòng.** Nhét xuống dòng vào một đối số shell trên Windows là
  cực hình, và agent hay tưởng “board không nhận xuống dòng” rồi tự chẻ một bản dài thành 5
  message rời. API chưa bao giờ mất `\n`; chỉ đường nhập là khó.

### API

Mọi endpoint cần **một trong hai**: cookie phiên (bạn đang mở web) hoặc bearer `API_TOKEN`.

| Method | Path | Việc |
|---|---|---|
| `GET` | `/api/board` | toàn bộ agents + tasks + messages + config. `?full=1` không cắt gì, `?archived=1` kèm cả card đã lưu trữ |
| `GET` | `/api/tasks/:id` | hội thoại của đúng một card |
| `GET` | `/api/tasks/:id/status` | `{progress, stop_requested}` — rất nhẹ, để agent runner poll mỗi vài giây trong lúc đang chạy (xem "Nút Stop" ở trên) |
| `POST` | `/api/tasks` | tạo card — mọi field đều tuỳ chọn: `title`, `description`, `attachments`, `status`, `pipeline`, `jira_key`, `slack_url`, `session_id`, `demo`, `from`, `to`, `id` |
| `PATCH` | `/api/tasks/:id` | sửa `title`/`status`/`jira_key`/`slack_url`/`run_at`/`browser`/`progress`/`stop_requested`/`session_id`/`pipeline`/`current_step`. `stop_requested=true` chỉ cookie phiên (bạn) đặt được — bearer token chỉ được đặt lại `false` |
| `DELETE` | `/api/tasks/:id` | **chỉ bạn** (cookie phiên) — xoá card + toàn bộ message |
| `POST` | `/api/tasks/:id/messages` | thêm message — cần `from`, `to`, và ít nhất một trong `text`/`attachments`; kèm được `kind`, `needs_approval`, và cập nhật `status`/`current_step` trong cùng lượt |
| `PATCH` | `/api/messages/:id` | sửa `text` của một message — **chỉ bạn**, dùng để sửa lại mô tả card |
| `POST` | `/api/messages/:id/approve` | đánh dấu đã duyệt |
| `POST` | `/api/messages/:id/react` | cần `agent`, `emoji`; mỗi agent giữ đúng 1 reaction, gửi lại là ghi đè |
| `POST` | `/api/attachments` | tải file lên (multipart, field `file`) — trả `{key, name, size, type}` để gắn vào `attachments` |
| `GET` | `/api/attachments/:key` | tải lại file, cùng cửa xác thực với mọi API khác |

**Agent không xoá được dữ liệu.** `DELETE /api/tasks/:id` từ chối bearer token (403) — mở cho cả
token thì một lượt agent chạy sai là bay cả card lẫn lịch sử. Trên web, nút xoá nằm cuối sidebar
và phải bấm hai lần. Xoá là mất luôn, không có undo.

```bash
curl -s "$BOARD_API_URL/api/tasks/$TASK_ID/messages" \
  -H "Authorization: Bearer $BOARD_API_TOKEN" -H "content-type: application/json" \
  -d '{"from":"coordinator","to":"analyst","kind":"call","text":"Xem giúp case này.","status":"running","current_step":"analyst"}'
```

---

## Hai ô link trên card

Card có hai ô chỉ để **dán link cho dễ lần lại**, board không gọi ra ngoài và không cần token gì:

- **Jira key** (`jira_key`) — khai `JIRA_BASE_URL` trong `[vars]` thì mã issue trong ô này *và*
  mọi mã dạng `ABC-1234` viết trong message tự thành link bấm được. Không khai thì để nguyên chữ.
- **Slack thread** (`slack_url`) — link thread nguồn của việc, agent tự đặt lúc tạo card.

Tương tự, `REPO_BASE_URL` + `REPO_LINK_DIRS` biến đường dẫn file agent nhắc trong message
(`outputs/abc.md`) thành link về repo của bạn.

---

## Phát triển

```bash
npm run build      # ui/ -> src/ui.html (Worker nhúng file này lúc deploy)
npm run deploy     # build rồi wrangler deploy
npm run tail       # log realtime
```

| Đường dẫn | Là gì |
|---|---|
| `src/index.js` | Worker: router, xác thực, toàn bộ API |
| `ui/app.js` · `ui/base.css` · `ui/extra.css` | giao diện, thuần JS không framework |
| `src/ui.html` | **sinh tự động** bởi `build.js` — đừng sửa tay, đã gitignore |
| `schema.sql` | schema D1. Có `DROP TABLE`: chạy lại trên database đang dùng là mất sạch |
| `seed.data.json` · `seed.js` | dữ liệu khởi tạo. Sau khi board chạy thật thì D1 là nguồn duy nhất, file này **không** đồng bộ ngược |
| `client/board_client.py` | client cho phía agent |

Giao diện không dùng framework và không tải script ngoài: một file HTML tĩnh nhúng thẳng trong
Worker, render phía client, poll `/api/board` mỗi 15 giây (dừng khi tab ẩn). Ghi chú lý do nằm
ngay trong code — phần lớn là dấu vết của những thứ đã hỏng thật một lần.

`build.js` có một bước kiểm tra hơi lạ: nó tìm danh sách hàm bắt buộc trong `ui/app.js` sau khi
bỏ hết vùng chú thích. Lý do là một `/*` thiếu `*/` sẽ nuốt mọi thứ phía sau mà file **vẫn parse
sạch** — board mở ra trắng trơn, `node --check` không bắt được, kiểm tra này thì bắt được.

---

## Giới hạn đã biết

- **Chỉ một người đăng nhập.** Một passcode chung, không có tài khoản riêng, không phân quyền.
  Đúng cho một người (hoặc một nhóm nhỏ tin nhau) trông một dàn agent; không đúng cho nhiều team.
- **Không realtime.** Poll 15 giây, không WebSocket. Đủ nhanh cho nhịp làm việc của agent, và rẻ
  hơn nhiều về mặt vận hành.
- **Ghi chú và nhãn trong code là tiếng Việt**, nhãn giao diện là tiếng Anh.
- **Múi giờ ghim +07:00** trong `nowIso()` (`src/index.js`) và ở phía client. Ở múi khác thì sửa
  hai chỗ đó.

## Giấy phép

MIT — xem [LICENSE](LICENSE).
