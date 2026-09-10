#!/usr/bin/env node
// Sinh seed.generated.sql từ seed.data.json (danh sách agent + card ví dụ) để áp lên D1:
//   npm run seed        (chạy file này rồi wrangler d1 execute luôn)
//
// Chỉ dùng để khởi tạo database lần đầu — nó DELETE sạch 3 bảng trước khi chèn. Sau khi board
// chạy thật, D1 là nguồn dữ liệu duy nhất; seed.data.json KHÔNG đồng bộ ngược.

const fs = require("fs");
const path = require("path");

const here = (...p) => path.join(__dirname, ...p);
const data = JSON.parse(fs.readFileSync(here("seed.data.json"), "utf8"));

const q = (v) => (v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");

const lines = ["-- Sinh tự động bởi seed.js từ seed.data.json — không sửa tay.", "DELETE FROM messages;", "DELETE FROM tasks;", "DELETE FROM agents;", ""];

Object.entries(data.agents).forEach(([key, a], i) => {
  lines.push(
    `INSERT INTO agents (key, label, handle, icon, color, role, sort_order) VALUES (` +
    [q(key), q(a.label), q(a.handle), q(a.icon), q(a.color), q(a.role), i].join(", ") + ");"
  );
});
lines.push("");

for (const t of data.tasks) {
  lines.push(
    `INSERT INTO tasks (id, title, status, demo, jira_key, session_id, pipeline, current_step, created_at, updated_at) VALUES (` +
    [q(t.id), q(t.title), q(t.status), t.demo ? 1 : 0, q(t.jira_key), q(t.session_id),
     q(JSON.stringify(t.pipeline)), q(t.current_step), q(t.created_at), q(t.updated_at)].join(", ") + ");"
  );
  for (const m of t.messages) {
    lines.push(
      `INSERT INTO messages (task_id, from_agent, to_agent, kind, text, at, needs_approval, approved, approved_at) VALUES (` +
      [q(t.id), q(m.from), q(m.to), q(m.kind), q(m.text), q(m.at),
       m.needs_approval ? 1 : 0,
       m.needs_approval ? (m.approved ? 1 : 0) : "NULL",
       q(m.approved_at || null)].join(", ") + ");"
    );
  }
  lines.push("");
}

fs.writeFileSync(here("seed.generated.sql"), lines.join("\n"), "utf8");
console.log(`Đã sinh ${here("seed.generated.sql")} — ${Object.keys(data.agents).length} agent, ${data.tasks.length} task.`);
