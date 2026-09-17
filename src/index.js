/**
 * Agent Ops Board — Cloudflare Worker (API + phục vụ giao diện).
 *
 * Hai đường vào, hai cách xác thực khác nhau:
 *   - PO mở web  -> cookie phiên, lấy được sau khi gõ BOARD_PASSCODE ở trang đăng nhập.
 *   - Agent gọi  -> header `Authorization: Bearer <API_TOKEN>` (token nằm trong .env phía agent).
 * Cả hai đều dùng chung /api/*; UI thì bắt buộc phải có cookie.
 *
 * Secrets (set bằng `wrangler secret put`, không bao giờ nằm trong repo):
 *   BOARD_PASSCODE · SESSION_SECRET · API_TOKEN
 */

import UI_HTML from "./ui.html";

const SESSION_COOKIE = "board_session";
const SESSION_DAYS = 30;

/* ---------- tiện ích ---------- */

// Giờ VN (+07:00) cho khớp quy ước timestamp của repo; Worker chạy ở UTC.
function nowIso() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    "T" + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + "+07:00"
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

// So sánh không phụ thuộc thời gian, tránh rò rỉ qua timing.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeSession(secret) {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  return exp + "." + (await hmac(secret, String(exp)));
}

async function validSession(secret, value) {
  if (!value) return false;
  const i = value.lastIndexOf(".");
  if (i < 1) return false;
  const exp = value.slice(0, i);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(value.slice(i + 1), await hmac(secret, exp));
}

function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/* ---------- chống dò mã đăng nhập ----------
 * PO chốt dùng mã ngắn, nên phải bù bằng khoá tạm theo IP: sai 5 lần khoá 15 phút,
 * sai 10 lần trở lên khoá 60 phút; đăng nhập đúng thì xoá bộ đếm.
 * Giới hạn đã biết: KV nhất quán theo kiểu eventual (có độ trễ giữa các PoP), nên đây là hàng
 * rào chống dò từ một nguồn, KHÔNG chặn được tấn công phân tán quy mô lớn. Mã dài vẫn là cách
 * bảo vệ chính.
 */

const FAIL_LOCK_1 = 5;    // số lần sai bắt đầu khoá
const FAIL_LOCK_2 = 10;   // số lần sai bị khoá lâu hơn
const LOCK_MIN_1 = 15;
const LOCK_MIN_2 = 60;

function guardKey(req) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  return "fail:" + ip;
}

async function readGuard(env, req) {
  if (!env.LOGIN_GUARD) return { n: 0, until: 0 };
  const raw = await env.LOGIN_GUARD.get(guardKey(req));
  if (!raw) return { n: 0, until: 0 };
  try { return JSON.parse(raw); } catch { return { n: 0, until: 0 }; }
}

// Số phút còn bị khoá; 0 nghĩa là đang được phép thử.
function lockedMinutes(guard) {
  const left = (guard.until || 0) - Date.now();
  return left > 0 ? Math.ceil(left / 60000) : 0;
}

async function noteFail(env, req, guard) {
  if (!env.LOGIN_GUARD) return;
  const n = (guard.n || 0) + 1;
  const mins = n >= FAIL_LOCK_2 ? LOCK_MIN_2 : (n >= FAIL_LOCK_1 ? LOCK_MIN_1 : 0);
  const next = { n, until: mins ? Date.now() + mins * 60000 : 0 };
  await env.LOGIN_GUARD.put(guardKey(req), JSON.stringify(next), { expirationTtl: 7200 });
}

async function clearFail(env, req) {
  if (!env.LOGIN_GUARD) return;
  await env.LOGIN_GUARD.delete(guardKey(req));
}

/* ---------- xác thực ---------- */

async function hasSession(req, env) {
  return env.SESSION_SECRET ? validSession(env.SESSION_SECRET, readCookie(req, SESSION_COOKIE)) : false;
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  return m ? m[1].trim() : "";
}

function hasApiToken(req, env) {
  return !!(env.API_TOKEN && safeEqual(bearer(req), env.API_TOKEN));
}

/* ---------- đọc dữ liệu ---------- */

/* Card Done cũ hơn ngần này ngày thì rời khỏi board (vẫn nguyên trong DB, xem lại bằng
   ?archived=1). PO chốt. */
const ARCHIVE_DAYS = 30;

/* opts.full  = trả về y như cũ: đủ message của MỌI card, không lọc lưu trữ. Agent dùng cái này —
                vòng lặp nền của Coordinator quét message mới trên mọi card, kể cả card đã Done, nên cắt
                bớt là nó điếc luôn comment PO viết trong card Done.
   opts.archived = kèm cả card đã lưu trữ (PO bấm "Show archived").

   Mặc định (trình duyệt PO): card Done KHÔNG kèm message, chỉ gửi message_count +
   last_message_id — đủ để vẽ card và tính badge Unread. Đã đo: 7 card = 71 KB mỗi 15
   giây, trong đó 5 card Done chiếm 58 KB (82%). Chi phí đó tăng tuyến tính theo số card Done và
   KHÔNG tự dừng, trong khi hội thoại của card đã đóng thì gần như không ai đọc lại. */
async function loadBoard(env, opts) {
  opts = opts || {};
  const [agentRows, taskRows, msgRows, browserRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM agents ORDER BY sort_order, key").all(),
    env.DB.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all(),
    env.DB.prepare("SELECT * FROM messages ORDER BY task_id, id").all(),
    /* Bản đồ nhãn -> deviceId của các Chrome. PHẢI đi theo board vì card chỉ lưu NHÃN, còn
       select_browser thì đòi deviceId. KHÔNG dùng trường "name" của list_connected_browsers: đo
       đã đo và thấy nó chỉ là nhãn đánh số theo vị trí, tên PO tự đặt lúc kết nối KHÔNG được
       lưu, và thứ tự còn đổi chỗ giữa các lần gọi. deviceId mới là thứ ổn định. */
    env.DB.prepare("SELECT * FROM browsers ORDER BY sort_order, label").all(),
  ]);

  const agents = {};
  for (const a of agentRows.results) {
    agents[a.key] = { label: a.label, handle: a.handle, icon: a.icon, color: a.color, role: a.role };
  }

  const byTask = new Map();
  for (const m of msgRows.results) {
    if (!byTask.has(m.task_id)) byTask.set(m.task_id, []);
    byTask.get(m.task_id).push({
      id: m.id,
      from: m.from_agent,
      to: m.to_agent,
      kind: m.kind,
      text: m.text,
      at: m.at,
      needs_approval: !!m.needs_approval,
      approved: m.approved === null ? undefined : !!m.approved,
      approved_at: m.approved_at || undefined,
      reactions: m.reactions ? JSON.parse(m.reactions) : [],
      attachments: m.attachments ? JSON.parse(m.attachments) : [],
    });
  }

  const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  let archivedCount = 0;

  const tasks = taskRows.results.filter((t) => {
    if (opts.full || opts.archived) return true;
    const old = t.status === "done" && String(t.updated_at).slice(0, 10) < cutoff;
    if (old) archivedCount++;
    return !old;
  }).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    demo: !!t.demo,
    jira_key: t.jira_key,
    slack_url: t.slack_url,
    run_at: t.run_at,
    alerts_cleared_id: t.alerts_cleared_id,
    seen_upto_id: t.seen_upto_id,
    browser: t.browser,
    progress: t.progress,
    stop_requested: !!t.stop_requested,
    session_id: t.session_id,
    pipeline: JSON.parse(t.pipeline),
    current_step: t.current_step,
    created_at: t.created_at,
    updated_at: t.updated_at,
    messages: slim(t) ? [] : (byTask.get(t.id) || []),
    // Chỉ có mặt khi message bị cắt — client thấy field này là biết cần tải hội thoại khi mở card.
    message_count: slim(t) ? (byTask.get(t.id) || []).length : undefined,
    last_message_id: slim(t) ? lastId(byTask.get(t.id)) : undefined,
  }));

  return {
    agents, tasks,
    config: uiConfig(env),
    browsers: browserRows.results.map((b) => ({
      label: b.label, device_id: b.device_id, note: b.note || undefined,
    })),
    archived_count: archivedCount,
    archive_days: ARCHIVE_DAYS,
    updated_at: tasks.length ? tasks[0].updated_at : nowIso(),
  };

  function slim(t) { return !opts.full && t.status === "done"; }
  function lastId(list) { return list && list.length ? list[list.length - 1].id : 0; }
}

/* Cấu hình hiển thị cho UI, lấy từ biến môi trường Worker ([vars] trong wrangler.toml). Để mỗi
   người dựng board tự trỏ về Jira/repo của mình mà không phải sửa code. Không khai báo thì UI tự
   bỏ qua: thiếu JIRA_BASE_URL thì mã issue chỉ là chữ thường chứ không thành link. */
function uiConfig(env) {
  const jira = String(env.JIRA_BASE_URL || "").replace(/\/+$/, "");
  return {
    board_title: env.BOARD_TITLE || "Agent Ops Board",
    jira_base: jira ? jira + "/browse/" : "",
    repo_base: String(env.REPO_BASE_URL || "").replace(/\/+$/, ""),
    // Thư mục trong repo mà agent hay nhắc tới trong message ("outputs/abc.md") — board biến
    // chúng thành link về REPO_BASE_URL. Danh sách rỗng = không tự link đường dẫn nào.
    repo_dirs: String(env.REPO_LINK_DIRS || "")
      .split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._-]+$/.test(s)),
  };
}

/* ---------- API ---------- */

const VALID_STATUS = ["backlog", "new", "pending_approval", "running", "done"];
// Tên tạm khi PO tạo card mà không đặt tên. Agent thấy đúng chuỗi này thì tự tóm tắt mô tả rồi
// đổi tên (PATCH /api/tasks/:id). Đổi giá trị ở đây là phải đổi cả trong client/board_client.py.
const UNTITLED = "(untitled)";
// Trần cho một file đính kèm. Cũng là trần R2 nhận trong POST /api/attachments.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Dùng chung cho POST /api/tasks (description) và POST /api/tasks/:id/messages (comment) — chỉ
// giữ đúng field cần, không tin nguyên xi những gì client gửi lên.
function parseAttachments(raw) {
  return Array.isArray(raw)
    ? raw
        .filter((a) => a && typeof a.key === "string" && typeof a.name === "string")
        .map((a) => ({ key: a.key, name: a.name, size: Number(a.size) || 0, type: String(a.type || "") }))
    : [];
}

async function handleApi(req, env, url, isPo) {
  const path = url.pathname;

  // XOÁ CARD — chỉ PO (cookie phiên) được gọi, agent (bearer token) thì KHÔNG.
  // Cố ý giữ nguyên tính chất "agent không xoá được dữ liệu" của API: PO cần quyền xoá thì cho
  // PO, chứ mở cho cả token thì một lượt agent chạy sai là bay cả card lẫn lịch sử hội thoại.
  let del = /^\/api\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
  if (req.method === "DELETE" && del) {
    if (!isPo) {
      return json({ error: "Only the signed-in PO can delete a card." }, 403);
    }
    const task = await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(del[1]).first();
    if (!task) return json({ error: "Task not found." }, 404);
    // Xoá message tường minh, không dựa vào ON DELETE CASCADE (D1 không bật foreign_keys
    // mặc định — dựa vào cascade sẽ để lại message mồ côi).
    await env.DB.batch([
      env.DB.prepare("DELETE FROM messages WHERE task_id = ?").bind(del[1]),
      env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(del[1]),
    ]);
    return json({ ok: true, deleted: del[1] });
  }

  if (req.method === "GET" && path === "/api/board") {
    return json(await loadBoard(env, {
      full: url.searchParams.get("full") === "1",
      archived: url.searchParams.get("archived") === "1",
    }));
  }

  /* Hội thoại của MỘT card. Sinh ra vì card Done không còn kèm message trong /api/board — mở
     card ra thì tải riêng đúng card đó. */
  let one = /^\/api\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
  if (req.method === "GET" && one) {
    const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(one[1]).first();
    if (!row) return json({ error: "Task not found." }, 404);
    const msgs = await env.DB.prepare(
      "SELECT * FROM messages WHERE task_id = ? ORDER BY id"
    ).bind(one[1]).all();
    return json({
      id: row.id,
      messages: msgs.results.map((m) => ({
        id: m.id, from: m.from_agent, to: m.to_agent, kind: m.kind, text: m.text, at: m.at,
        needs_approval: !!m.needs_approval,
        approved: m.approved === null ? undefined : !!m.approved,
        approved_at: m.approved_at || undefined,
        reactions: m.reactions ? JSON.parse(m.reactions) : [],
        attachments: m.attachments ? JSON.parse(m.attachments) : [],
      })),
    });
  }

  /* Trạng thái sống RẤT NHẸ của một task — riêng cho agent runner poll mỗi ~2 giây TRONG LÚC
     một lượt chạy đang diễn ra, để biết PO có vừa bấm nút Stop không (xem PATCH ở dưới, field
     stop_requested). Cố ý tách khỏi GET /api/tasks/:id ở trên: endpoint đó kéo cả hội thoại đầy
     đủ, quá nặng để gọi lặp lại mỗi vài giây suốt một lượt chạy có thể dài hàng chục phút. */
  let statusMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/status$/.exec(path);
  if (req.method === "GET" && statusMatch) {
    const row = await env.DB.prepare(
      "SELECT progress, stop_requested FROM tasks WHERE id = ?"
    ).bind(statusMatch[1]).first();
    if (!row) return json({ error: "Task not found." }, 404);
    return json({ progress: row.progress || null, stop_requested: !!row.stop_requested });
  }

  if (req.method === "POST" && path === "/api/tasks") {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Body must be JSON." }, 400);
    // Title không bắt buộc (PO chốt): PO gõ mô tả rồi bấm tạo, đặt tên là việc của
    // Coordinator — nó đọc mô tả xong tóm lại một dòng và patch-task --title. Sentinel phải là chuỗi
    // NHÌN THẤY ĐƯỢC chứ không phải rỗng: title rỗng thì card trên board thành một khoảng trắng
    // không bấm vào đâu được, và Coordinator cũng không có dấu hiệu nào để biết cần đặt tên.
    const title = String(body.title || "").trim() || UNTITLED;
    // Description cũng không bắt buộc (PO chốt): PO có thể chỉ thả một cái tên vào
    // board rồi điền description sau bằng nút Edit — message[0] rỗng vẫn tạo bình thường, cột
    // `text` NOT NULL nên vẫn phải là chuỗi (rỗng), không phải null/undefined.
    const description = typeof body.description === "string" ? body.description : "";
    // File đính kèm ngay từ lúc tạo task (PO chốt) — cùng field/shape với comment,
    // xem parseAttachments(). Task chưa tồn tại lúc PO chọn file nên POST /api/attachments
    // không đòi taskId nữa (đổi từ /api/tasks/:id/attachments — xem README mục "File đính kèm").
    const attachments = parseAttachments(body.attachments);
    const at = nowIso();
    const id = body.id || "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    const pipeline = Array.isArray(body.pipeline) && body.pipeline.length ? body.pipeline : ["coordinator"];
    const status = VALID_STATUS.includes(body.status) ? body.status : "new";

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tasks (id, title, status, demo, jira_key, slack_url, session_id, pipeline, current_step, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, title, status, body.demo ? 1 : 0, body.jira_key || null, body.slack_url || null,
        body.session_id || null, JSON.stringify(pipeline), body.current_step || pipeline[0], at, at
      ),
      env.DB.prepare(
        `INSERT INTO messages (task_id, from_agent, to_agent, kind, text, at, needs_approval, attachments)
         VALUES (?, ?, ?, 'request', ?, ?, 0, ?)`
      ).bind(
        id, body.from || "po", body.to || "coordinator", description, at,
        attachments.length ? JSON.stringify(attachments) : null
      ),
    ]);

    return json({ ok: true, id }, 201);
  }

  let m = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/messages$/.exec(path);
  if (req.method === "POST" && m) {
    const taskId = m[1];
    const body = await req.json().catch(() => null);
    if (!body || !body.from || !body.to || typeof body.text !== "string") {
      return json({ error: "`from`, `to`, `text` are required." }, 400);
    }
    const task = await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(taskId).first();
    if (!task) return json({ error: "Task not found." }, 404);

    // File đính kèm (PO chốt) — tham chiếu R2 do POST /api/attachments trả về trước
    // đó, KHÔNG nhận file thật ở đây (endpoint này vẫn nhận JSON như cũ).
    const attachments = parseAttachments(body.attachments);
    // Chỉ chữ HOẶC chỉ file đều được — không đủ cả hai thì mới chặn (chat có file kèm caption
    // rỗng là bình thường, giống Slack/GitHub).
    if (!body.text.trim() && !attachments.length) {
      return json({ error: "Message needs text or at least one attachment." }, 400);
    }

    const at = nowIso();
    const stmts = [
      env.DB.prepare(
        `INSERT INTO messages (task_id, from_agent, to_agent, kind, text, at, needs_approval, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        taskId, body.from, body.to, body.kind || "note", body.text, at, body.needs_approval ? 1 : 0,
        attachments.length ? JSON.stringify(attachments) : null
      ),
    ];
    // Cho phép cập nhật kèm trạng thái/bước hiện tại trong cùng lượt ghi.
    const sets = [], vals = [];
    if (VALID_STATUS.includes(body.status)) { sets.push("status = ?"); vals.push(body.status); }
    if (body.current_step) { sets.push("current_step = ?"); vals.push(body.current_step); }
    sets.push("updated_at = ?"); vals.push(at);
    stmts.push(env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, taskId));

    await env.DB.batch(stmts);
    return json({ ok: true, at }, 201);
  }

  // Tải file lên TRƯỚC, lấy `key` gắn vào message/description sau (field `attachments` của
  // POST /api/tasks hoặc POST .../messages) — không gộp làm một lượt vì đó là JSON, còn đây
  // phải là multipart. KHÔNG đòi taskId: form "New task" chưa có task nào tồn tại lúc PO chọn
  // file (PO báo — trước đó gắn vào path /api/tasks/:id/attachments nên New task
  // không tải lên được). Key tự đủ duy nhất nhờ UUID, không cần tiền tố taskId để phân biệt.
  // PO chốt, xem README mục "File đính kèm".
  if (req.method === "POST" && path === "/api/attachments") {
    const form = await req.formData().catch(() => null);
    const file = form && form.get("file");
    if (!file || typeof file === "string") {
      return json({ error: "`file` (multipart form field) is required." }, 400);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return json({ error: `File too large — max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.` }, 413);
    }
    // Tên gốc giữ nguyên để hiện cho PO, nhưng KEY lưu trong R2 phải an toàn — bỏ ký tự lạ,
    // cắt bớt nếu quá dài. UUID đứng trước để không đụng key dù hai lần tải cùng tên file.
    const safeName = (file.name || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
    const key = `${crypto.randomUUID()}-${safeName}`;
    await env.ATTACHMENTS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
    return json({ key, name: file.name || safeName, size: file.size, type: file.type || "" }, 201);
  }

  // Phục vụ lại file đã tải — đi qua CÙNG cửa xác thực với mọi /api/* khác (cookie phiên hoặc
  // bearer token), KHÔNG public: có thể chứa ảnh chụp nội bộ nhạy cảm. `(.+)` (không phải
  // `[^/]+`) để chịu được cả key kiểu cũ còn "/" (taskId/uuid-tên file, trước khi bỏ tiền tố).
  m = /^\/api\/attachments\/(.+)$/.exec(path);
  if (req.method === "GET" && m) {
    const obj = await env.ATTACHMENTS.get(m[1]);
    if (!obj) return json({ error: "Attachment not found." }, 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    // Key có UUID riêng mỗi lần tải nên nội dung ứng với 1 key không bao giờ đổi — cache dài,
    // thoải mái vì trình duyệt vẫn phải có cookie hợp lệ mới xin lại được key đó lần đầu.
    headers.set("cache-control", "private, max-age=31536000, immutable");
    return new Response(obj.body, { headers });
  }

  m = /^\/api\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
  if (req.method === "PATCH" && m) {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Body must be JSON." }, 400);

    const sets = [], vals = [];
    if (body.title) { sets.push("title = ?"); vals.push(body.title); }
    if (VALID_STATUS.includes(body.status)) { sets.push("status = ?"); vals.push(body.status); }
    if ("jira_key" in body) { sets.push("jira_key = ?"); vals.push(body.jira_key || null); }
    if ("slack_url" in body) { sets.push("slack_url = ?"); vals.push(body.slack_url || null); }
    if ("run_at" in body) { sets.push("run_at = ?"); vals.push(body.run_at || null); }
    // Việc cần trình duyệt: Coordinator (chạy CLI, không có Chrome) đặt cờ này; phiên app có Chrome
    // đi lấy về làm. Giá trị là mô tả việc cần làm, rỗng = không còn chờ.
    /* TÊN trình duyệt Chrome dùng cho card này (PO có nhiều Chrome, việc khác nhau cần cái khác
       nhau). Lưu TÊN chứ không lưu deviceId: deviceId đổi khi cài lại extension, còn tên do PO
       đặt thì bền. Rỗng = card này KHÔNG được đụng tới trình duyệt nào cả. */
    if ("browser" in body) { sets.push("browser = ?"); vals.push(body.browser || null); }
    /* Dòng trạng thái sống của lượt chạy đang diễn ra ("đang đọc issue", "đang giao @analyst…").
       agent runner dịch từ luồng sự kiện của claude -p rồi ghi vào đây mỗi vài giây; rỗng = không
       có lượt nào đang chạy. Cố ý là MỘT ô ghi đè chứ không phải message: tiến độ là thứ xem
       xong thì bỏ, nhét vào hội thoại là rác vĩnh viễn. */
    if ("progress" in body) { sets.push("progress = ?"); vals.push(body.progress || null); }
    /* Nút "Stop": PO gõ nhầm/muốn gửi lại message mới trong lúc claude -p đang chạy cho task
       này — đặt cờ, agent runner của bạn poll GET /api/tasks/:id/status mỗi ~2s thấy true thì
       terminate() lượt đang chạy rồi TỰ đặt lại false (dọn cờ sau khi đã dừng). CHỈ PO đặt được
       true (chỉ PO mới được quyết định "dừng" — agent tự dừng mình không có nghĩa gì); agent
       (bearer token) được đặt false để dọn cờ sau khi đã xử lý xong yêu cầu dừng, không bị chặn
       như set true. */
    if ("stop_requested" in body) {
      if (body.stop_requested && !isPo) {
        return json({ error: "Only the signed-in PO can request a stop." }, 403);
      }
      sets.push("stop_requested = ?"); vals.push(body.stop_requested ? 1 : 0);
    }
    // Mốc "PO đã xem tới message này" — badge chỉ hiện lại khi có message MỚI hơn mốc đó.
    if ("alerts_cleared_id" in body) {
      sets.push("alerts_cleared_id = ?");
      vals.push(body.alerts_cleared_id === null ? null : Number(body.alerts_cleared_id) || 0);
    }
    // Mốc "PO đã MỞ CARD ra đọc tới message này". Khác hẳn alerts_cleared_id: cái kia là PO chủ
    // động tắt cảnh báo, cái này tự ghi khi PO mở card. Dùng để biết card agent tự đánh Done mà
    // PO chưa đọc — chỉ agent ghi Done thì PO không hề hay biết là đã có kết quả.
    // CHỈ PO ghi được: agent mà tự đánh dấu "PO đã đọc rồi" thì cảnh báo thành vô nghĩa.
    if ("seen_upto_id" in body) {
      if (!isPo) return json({ error: "Only the signed-in PO can mark a card as read." }, 403);
      sets.push("seen_upto_id = ?");
      vals.push(body.seen_upto_id === null ? null : Number(body.seen_upto_id) || 0);
    }
    if ("session_id" in body) { sets.push("session_id = ?"); vals.push(body.session_id || null); }
    if (Array.isArray(body.pipeline)) { sets.push("pipeline = ?"); vals.push(JSON.stringify(body.pipeline)); }
    if (body.current_step) { sets.push("current_step = ?"); vals.push(body.current_step); }
    if (!sets.length) return json({ error: "No valid field to update." }, 400);

    // Đọc card / tắt cảnh báo KHÔNG phải là "có việc mới xảy ra" — chỉ là PO liếc qua. Bump
    // updated_at ở đây thì card nhảy lên đầu cột (cột sắp theo updated_at DESC) và giờ hiện
    // trên card đổi theo, làm PO tưởng agent vừa làm gì đó.
    // progress cũng vào đây: nó nhảy vài giây một lần, bump updated_at là card nhảy loạn lên đầu
    // cột và giờ trên card đổi liên tục dù chẳng có việc gì mới xong.
    const readOnlyMarks = ["seen_upto_id", "alerts_cleared_id", "progress", "stop_requested"];
    const onlyMarks = Object.keys(body).every((k) => readOnlyMarks.includes(k));
    if (!onlyMarks) { sets.push("updated_at = ?"); vals.push(nowIso()); }
    const res = await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...vals, m[1]).run();
    if (!res.meta.changes) return json({ error: "Task not found." }, 404);
    return json({ ok: true });
  }

  // Sửa nội dung 1 message — dùng cho PO sửa lại description của task ngay trên board (vd gõ
  // nhầm, hoặc muốn bổ sung khi task đã tạo). CHỈ PO (cookie phiên): agent sửa lại lời PO giao
  // là tự viết lại yêu cầu của chính PO, không phải việc của agent — agent cần sửa gì thì ghi
  // message mới, không đè lên message cũ.
  m = /^\/api\/messages\/(\d+)$/.exec(path);
  if (req.method === "PATCH" && m) {
    if (!isPo) return json({ error: "Only the signed-in PO can edit a message." }, 403);
    const body = await req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return json({ error: "`text` is required." }, 400);
    }
    const row = await env.DB.prepare("SELECT task_id FROM messages WHERE id = ?").bind(m[1]).first();
    if (!row) return json({ error: "Message not found." }, 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET text = ? WHERE id = ?").bind(body.text, m[1]),
      env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(nowIso(), row.task_id),
    ]);
    return json({ ok: true });
  }

  m = /^\/api\/messages\/(\d+)\/react$/.exec(path);
  if (req.method === "POST" && m) {
    const body = await req.json().catch(() => null);
    if (!body || !body.agent || !body.emoji) {
      return json({ error: "`agent` and `emoji` are required." }, 400);
    }
    const row = await env.DB.prepare("SELECT task_id, reactions FROM messages WHERE id = ?").bind(m[1]).first();
    if (!row) return json({ error: "Message not found." }, 404);

    let list = [];
    try { list = row.reactions ? JSON.parse(row.reactions) : []; } catch { list = []; }
    // Mỗi agent giữ MỘT reaction trên một message: react 👀 lúc bắt đầu rồi ✅ lúc xong thì
    // cái sau thay cái trước, không để đọng cả hai gây hiểu nhầm là còn đang chạy.
    list = list.filter((r) => r.agent !== body.agent);
    list.push({ agent: body.agent, emoji: body.emoji, at: nowIso() });

    // Bump updated_at của TASK: react không tạo message mới nên last_message_id đứng yên,
    // nhưng board vẫn cần một tín hiệu "vừa đổi" — thiếu nó thì card Done (bản rút gọn trên
    // /api/board) không có gì khác biệt trước/sau react, client bỏ qua luôn, và reaction thật
    // trên server không bao giờ hiện ra cho tới khi có message mới khác (sự cố thật,
    // xem keepLoadedMessages() trong ui/app.js).
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET reactions = ? WHERE id = ?").bind(JSON.stringify(list), m[1]),
      env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(nowIso(), row.task_id),
    ]);
    return json({ ok: true, reactions: list });
  }

  m = /^\/api\/messages\/(\d+)\/approve$/.exec(path);
  if (req.method === "POST" && m) {
    const row = await env.DB.prepare(
      "SELECT task_id FROM messages WHERE id = ? AND needs_approval = 1"
    ).bind(m[1]).first();
    if (!row) return json({ error: "No message awaiting approval with that id." }, 404);
    const at = nowIso();
    // Cùng lý do bump updated_at như /react ở trên — approve cũng chỉ sửa field trên message
    // có sẵn, không tạo message mới.
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET approved = 1, approved_at = ? WHERE id = ?").bind(at, m[1]),
      env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(at, row.task_id),
    ]);
    return json({ ok: true, approved_at: at });
  }

  return json({ error: "Unknown endpoint." }, 404);
}

/* ---------- trang đăng nhập ---------- */

// Tên board hiện trên tab trình duyệt và trang đăng nhập, đặt bằng biến BOARD_TITLE trong
// [vars] của wrangler.toml. Escape vì chuỗi này được nhúng thẳng vào HTML.
function boardTitle(env) {
  return String(env.BOARD_TITLE || "Agent Ops Board").replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

function loginPage(error, title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<link rel="icon" type="image/png" href="/avatars/analyst.png">
<style>
:root{color-scheme:light dark;--bg:#F4F5F7;--card:#fff;--text:#172B4D;--sub:#5E6C84;--border:#DFE1E6;--blue:#0C66E4;--err:#BF2600;--errbg:#FFEBE6}
@media(prefers-color-scheme:dark){:root{--bg:#161A1D;--card:#1D2125;--text:#DEE4EA;--sub:#9FADBC;--border:#454F59;--blue:#579DFF;--err:#FD9891;--errbg:#42221F}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px}
.box{background:var(--card);border-radius:8px;padding:28px;width:min(380px,100%);box-shadow:0 1px 1px rgba(9,30,66,.25),0 0 1px rgba(9,30,66,.31)}
h1{font-size:18px;margin:0 0 4px}p.sub{margin:0 0 20px;color:var(--sub);font-size:13px}
label{display:block;font-size:12px;font-weight:600;color:var(--sub);margin-bottom:4px}
input{width:100%;padding:9px 11px;border-radius:3px;border:2px solid transparent;box-shadow:inset 0 0 0 1px var(--border);
background:var(--card);color:var(--text);font-size:14px;font-family:inherit}
input:focus-visible{outline:none;border-color:var(--blue)}
button{margin-top:16px;width:100%;padding:9px;border:none;border-radius:3px;background:var(--blue);color:#fff;
font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.err{margin:0 0 14px;padding:7px 10px;border-radius:3px;background:var(--errbg);color:var(--err);font-size:13px}
</style></head><body>
<form class="box" method="POST" action="/login">
<h1>${title}</h1><p class="sub">Enter the passcode to open the board.</p>
${error ? `<p class="err">${error}</p>` : ""}
<label for="p">Passcode</label>
<input id="p" name="passcode" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Open board</button>
</form></body></html>`;
}

/* ---------- router ---------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (!env.SESSION_SECRET || !env.BOARD_PASSCODE || !env.API_TOKEN) {
      return new Response("Worker is missing required secrets (BOARD_PASSCODE, SESSION_SECRET, API_TOKEN).", { status: 500 });
    }

    // Đăng nhập / đăng xuất
    if (url.pathname === "/login") {
      if (req.method === "GET") {
        return new Response(loginPage(null, boardTitle(env)), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "POST") {
        const guard = await readGuard(env, req);
        const locked = lockedMinutes(guard);
        if (locked) {
          return new Response(
            loginPage(`Too many failed attempts. Try again in ${locked} minute(s).`, boardTitle(env)),
            { status: 429, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }

        const form = await req.formData().catch(() => null);
        const passcode = form ? String(form.get("passcode") || "") : "";
        if (!safeEqual(passcode, env.BOARD_PASSCODE)) {
          await noteFail(env, req, guard);
          // Chậm lại một nhịp để đoán mò tốn thời gian hơn.
          await new Promise((r) => setTimeout(r, 900));
          const left = FAIL_LOCK_1 - (guard.n + 1);
          return new Response(
            loginPage(left > 0 && left <= 2 ? `Wrong passcode. ${left} attempt(s) left.` : "Wrong passcode.", boardTitle(env)),
            { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }

        await clearFail(env, req);
        const value = await makeSession(env.SESSION_SECRET);
        return new Response(null, {
          status: 302,
          headers: {
            location: "/",
            "set-cookie": `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
          },
        });
      }
    }

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: { location: "/login", "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` },
      });
    }

    // API: cookie phiên (PO đang mở web) HOẶC bearer token (agent)
    if (url.pathname.startsWith("/api/")) {
      const isPo = await hasSession(req, env);
      if (!isPo && !hasApiToken(req, env)) {
        return json({ error: "Not authenticated." }, 401);
      }
      try {
        return await handleApi(req, env, url, isPo);
      } catch (err) {
        return json({ error: "Server error", detail: String(err && err.message || err) }, 500);
      }
    }

    // Giao diện: bắt buộc có cookie phiên
    if (url.pathname === "/") {
      if (!(await hasSession(req, env))) {
        return new Response(null, { status: 302, headers: { location: "/login" } });
      }
      return new Response(UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    return new Response("Not found.", { status: 404 });
  },
};
