-- Agent Ops Board — schema D1 (SQLite).
--
-- Áp dụng cho database TRỐNG:
--   npx wrangler d1 execute agent-ops-board --remote --file=schema.sql
--
-- CẢNH BÁO: file này DROP rồi tạo lại agents/tasks/messages — chạy trên database đang có dữ
-- liệu là mất sạch. Board đã chạy thật thì đừng chạy lại file này; sửa cấu trúc bằng một file
-- ALTER TABLE riêng rồi `wrangler d1 execute ... --file=<file do>`, và khai lại cột mới ở đây
-- cho những lần dựng sau.

DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS agents;

-- Danh sách agent hiện trên board: tên, handle để @tag, avatar, màu.
CREATE TABLE agents (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  handle     TEXT NOT NULL,
  -- Emoji ("🧭") vẽ thẳng như chữ trên nền màu của agent, HOẶC đường dẫn ảnh ("/avatars/x.png",
  -- file nằm trong public/) vẽ thành ảnh tròn. Trộn lẫn hai kiểu cũng được.
  icon       TEXT NOT NULL,
  color      TEXT NOT NULL,
  role       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  -- backlog | new | pending_approval | running | done
  status       TEXT NOT NULL DEFAULT 'new',
  -- 1 = card ví dụ: mã issue trên card không dựng thành link, để link demo không dẫn đi đâu cả.
  demo         INTEGER NOT NULL DEFAULT 0,
  jira_key     TEXT,
  -- id phiên làm việc của agent xử lý task này, để lượt sau nối lại đúng phiên cũ thay vì bắt
  -- đầu từ đầu. Board chỉ lưu chuỗi này, không hiểu nội dung — agent runner của bạn tự quy ước.
  session_id   TEXT,
  pipeline     TEXT NOT NULL DEFAULT '["coordinator"]',   -- JSON array các agent key
  current_step TEXT NOT NULL DEFAULT 'coordinator',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  slack_url         TEXT,     -- link thread Slack nguồn của task
  run_at            TEXT,     -- hẹn giờ; agent runner tới hạn thì chạy rồi xoá
  alerts_cleared_id INTEGER,  -- PO CHỦ ĐỘNG tắt cảnh báo tới message id này
  seen_upto_id      INTEGER,  -- PO đã MỞ CARD đọc tới message id này (khác alerts_cleared_id)
  -- Tên trình duyệt gán cho card, nếu agent của bạn có điều khiển trình duyệt (xem bảng
  -- `browsers`). Rỗng = card này không được đụng tới trình duyệt nào.
  browser           TEXT,
  -- Dòng trạng thái sống của lượt chạy đang diễn ra ("đang đọc issue…"). MỘT ô ghi đè chứ không
  -- phải message: tiến độ là thứ xem xong thì bỏ, nhét vào hội thoại là rác vĩnh viễn.
  progress          TEXT
);

CREATE INDEX idx_tasks_status ON tasks(status, updated_at DESC);

CREATE TABLE messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  -- request | call | reply | note | comment
  kind           TEXT NOT NULL DEFAULT 'note',
  text           TEXT NOT NULL,
  at             TEXT NOT NULL,
  needs_approval INTEGER NOT NULL DEFAULT 0,
  approved       INTEGER,
  approved_at    TEXT,
  -- JSON array [{agent, emoji, at}] — agent react để PO biết đang làm (👀) hay đã xong (✅)
  reactions      TEXT,
  -- JSON array [{key, name, size, type}] — file thật nằm trong R2 (binding ATTACHMENTS), cột
  -- này chỉ giữ tham chiếu.
  attachments    TEXT
);

CREATE INDEX idx_messages_task ON messages(task_id, id);

/* Bản đồ nhãn -> deviceId của các trình duyệt agent điều khiển được. Chỉ cần khi agent của bạn
   dùng công cụ lái trình duyệt; để trống thì ô "Browser" trên card chỉ là một ô chữ tự do.
   Card lưu NHÃN chứ không lưu deviceId vì deviceId đổi khi cài lại extension, còn nhãn do bạn
   đặt thì bền. */
CREATE TABLE IF NOT EXISTS browsers (
  label      TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  note       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
