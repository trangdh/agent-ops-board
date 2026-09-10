/**
 * POST /api/jira-source-comment — gắn nguồn Crisp + tên supporter vào một issue Jira, dưới dạng
 * COMMENT (không phải description).
 *
 * Body: `{ "issue": "ABC-1234", "channel": "C...", "thread_ts": "...", "customer": "Acme" }`
 * (`customer` tuỳ chọn — chỉ dùng khi thread KHÔNG có link Crisp; xem channelCustomerMap() bên dưới.)
 *
 * VÌ SAO CÓ: issue sinh ra từ một thread support thì mất dấu người báo. Vài tuần sau dev cần
 * hỏi lại "khách nói gì thêm", "case này còn xảy ra không" thì phải lần ngược Slack. Footer
 * trong description chỉ trỏ về thread Slack, không trỏ về hội thoại Crisp và không nêu supporter
 * nào mở thread — mà đó chính là người tag lại được.
 *
 * VÌ SAO LÀ CODE CHỨ KHÔNG PHẢI LUẬT TRONG PROMPT: đây là việc trích xuất thuần (regex trên
 * block của tin gốc), không có chỗ nào cần phán đoán. Luật mềm trong prompt thì agent nói vòng
 * ra được. Đặt ở Worker để agent chạy trên máy bạn LẪN agent chạy trên cloud dùng chung một
 * đường — bên cloud không đọc được `.env` nên không tự làm được việc này.

 * PHỤ THUỘC: endpoint này đọc thread Slack và chỉ nhận diện được link hội thoại Crisp. Nếu team
 * bạn dùng công cụ support khác, sửa hai regex CRISP_* bên dưới cho khớp định dạng link đó.
 *
 * Idempotent: quét comment sẵn có, thấy đúng session Crisp đó rồi thì bỏ qua. Coordinator hay resume
 * phiên và chạy lại trên cùng thread, không chặn thì issue đầy comment trùng.
 */

/* Mã issue được phép ghi vào — xem issueKeyRe() trong attach-image.js, cùng quy ước:
   JIRA_PROJECT_KEY khoá lại đúng một project, bỏ trống thì nhận mọi project. */
const issueKeyRe = (env) => {
  const key = String(env.JIRA_PROJECT_KEY || "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*$/.test(key) ? new RegExp("^" + key + "-\\d+$") : /^[A-Z][A-Z0-9]*-\d+$/;
};
// Link hội thoại Crisp trong tin của bot escalation. Chỉ nhận `/inbox/session_...` — link
// helpdesk (`/helpdesk/articles/...`) cũng nằm ở host này nhưng là bài KB, không phải nguồn case.
const CRISP_SESSION = /https:\/\/app\.crisp\.chat\/website\/[0-9a-f-]+\/inbox\/session_[0-9a-f-]+/i;
const CRISP_LABELLED = /<(https:\/\/app\.crisp\.chat\/website\/[0-9a-f-]+\/inbox\/session_[0-9a-f-]+)\|([^>]+)>/i;
const MENTION = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/;

/* Khách lớn thường có channel Slack riêng, nên chỉ cần biết channel là biết khách — không phải
   đoán từ chữ trong thread. Khai bằng biến SLACK_CHANNEL_CUSTOMERS trong wrangler.toml, dạng
   "ten-channel:Tên khách" phân tách bằng dấu phẩy:

     SLACK_CHANNEL_CUSTOMERS = "acme-support:Acme, globex-vip:Globex"

   Bỏ trống thì bỏ qua bước này và chỉ dựa vào link Crisp / tên khách agent truyền vào. */
function channelCustomerMap(env) {
  const map = {};
  for (const pair of String(env.SLACK_CHANNEL_CUSTOMERS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    const name = pair.slice(0, i).trim().replace(/^#/, "");
    const customer = pair.slice(i + 1).trim();
    if (name && customer) map[name] = customer;
  }
  return map;
}
// Tên khách do agent đọc từ thread rồi truyền vào — tức là NỘI DUNG NGƯỜI KHÁC VIẾT đi vào một
// comment Jira. Giữ nó là chữ trần, ngắn, một dòng: không link, không markup, không xuống dòng.
const CUSTOMER_MAX = 60;
function cleanCustomer(x) {
  const t = String(x || "").replace(/\s+/g, " ").replace(/[<>|*_`[\]]/g, "").trim();
  return t ? t.slice(0, CUSTOMER_MAX) : null;
}

/** Nối mọi `text` trong một cây ADF (comment Jira) thành một chuỗi phẳng, giữ nguyên thứ tự —
 *  để so được cả những chuỗi bị chia nhỏ qua nhiều node vì khác định dạng. */
function adfText(node) {
  if (Array.isArray(node)) return node.map(adfText).join("");
  if (!node || typeof node !== "object") return "";
  return (node.text || "") + adfText(node.content || node.body || []);
}

async function channelCustomer(env, channel) {
  try {
    const d = await slack(env, "conversations.info", { channel });
    return channelCustomerMap(env)[d.channel?.name] || null;
  } catch (e) { return null; }
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const jiraHeaders = (env) => ({
  authorization: "Basic " + b64(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`),
});
const jiraBase = (env) => String(env.JIRA_BASE_URL || "").replace(/\/+$/, "");

async function slack(env, method, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`${method} lỗi: ${d.error}`);
  return d;
}

/** Gom text của tin gốc: `text` + text của mọi block. Link Crisp và mention supporter nằm trong
 *  block `section`, KHÔNG nằm trong `text` (tin bot escalation để `text` là mỗi cái tiêu đề). */
function rootText(msg) {
  const parts = [msg.text || ""];
  for (const b of msg.blocks || []) {
    if (b.text && b.text.text) parts.push(b.text.text);
    for (const f of b.fields || []) if (f.text) parts.push(f.text);
  }
  return parts.join("\n");
}

/** Người mở thread — hai loại tin gốc, hai cách tìm KHÁC HẲN NHAU.
 *
 * 1. Post của bot escalation (tin có `bot_id`, kèm link session Crisp): bot post HỘ supporter,
 *    đặt `username` của tin đúng bằng handle Slack của người đó VÀ mention chính người đó ở cuối
 *    dòng header — đã đo trên 4 thread, hai nguồn khớp tuyệt đối. Lấy mention trước vì nó là
 *    user id thật nên tra ra handle chuẩn; `username` chỉ là chuỗi bot tự đặt nên có thể lệch
 *    dấu chấm.
 *
 * 2. Thread người thật mở: tác giả tin gốc (`msg.user`) CHÍNH LÀ người cần tìm. TUYỆT ĐỐI không
 *    dùng mention ở đây — mention đầu tiên trong tin người thật là người ĐƯỢC TAG, không phải
 *    tác giả; thử trên một thread thật ra "Reported by <người được tag>", đúng kiểu sai âm thầm
 *    mà vẫn trông như chạy được. */
async function supporterOf(env, msg) {
  const uid = msg.bot_id ? (MENTION.exec(rootText(msg)) || [])[1] : msg.user;
  if (uid) {
    try {
      const d = await slack(env, "users.info", { user: uid });
      return d.user.name || d.user.profile?.display_name || d.user.real_name || null;
    } catch (e) { /* mất scope hoặc user bị xoá — rơi xuống username bên dưới */ }
  }
  return msg.bot_id ? msg.username || null : null;
}

export async function handleSourceComment(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return { status: 400, body: { error: "body phải là JSON" } };

  if (!jiraBase(env)) {
    return { status: 500, body: { error: "Worker chưa khai JIRA_BASE_URL trong wrangler.toml" } };
  }
  const issue = String(body.issue || "").trim().toUpperCase();
  if (!issueKeyRe(env).test(issue)) {
    return { status: 400, body: { error: `issue phải dạng ABC-1234, nhận được: ${issue || "(rỗng)"}` } };
  }
  const channel = String(body.channel || "").trim();
  const ts = String(body.thread_ts || "").trim();
  if (!channel || !ts) return { status: 400, body: { error: "cần `channel` và `thread_ts`" } };

  let msg;
  try {
    const d = await slack(env, "conversations.replies", { channel, ts, limit: 1 });
    msg = (d.messages || [])[0];
  } catch (e) {
    return { status: 502, body: { error: String(e.message || e) } };
  }
  if (!msg) return { status: 200, body: { ok: true, skipped: "không đọc được tin gốc của thread" } };

  const text = rootText(msg);
  const labelled = CRISP_LABELLED.exec(text);
  const crisp = labelled ? labelled[1] : (CRISP_SESSION.exec(text) || [])[0] || null;
  const customer = labelled ? labelled[2].trim() : null;

  // Không có link Crisp thì vẫn ghi được, MIỄN LÀ biết case này của khách nào: rất nhiều case
  // tới thẳng qua channel riêng của khách lớn hoặc qua một câu nhắc tên khách trong thread,
  // không đi đường Crisp — mà mục đích của comment này là dò lại được về sau, nên tên khách cũng
  // đủ dùng.
  //
  // Hai nguồn tên khách, theo thứ tự tin cậy:
  //   1. channel riêng của khách — dữ kiện cứng, không phải suy đoán;
  //   2. `customer` do bên gọi truyền vào (agent đọc được tên khách trong thread).
  const customerName = (await channelCustomer(env, channel)) || cleanCustomer(body.customer);

  // Không biết khách nào, cũng không có Crisp -> không có gì đáng ghi. Phần lớn thread nội bộ rơi
  // vào đây và đó là bình thường: footer Slack trong description đã trỏ về đúng thread rồi.
  if (!crisp && !customerName) {
    return { status: 200, body: { ok: true, skipped: "thread không có link Crisp lẫn tên khách" } };
  }
  const supporter = await supporterOf(env, msg);

  // Định danh để không comment trùng: link session khi có (chắc nhất), không thì tên khách.
  const marker = crisp || `Customer: ${customerName}`;
  const listed = await fetch(
    `${jiraBase(env)}/rest/api/3/issue/${issue}/comment?maxResults=50`,
    { headers: { ...jiraHeaders(env), accept: "application/json" } },
  );
  if (!listed.ok) return { status: 502, body: { error: `đọc comment HTTP ${listed.status}` } };
  const existing = await listed.json();
  // So trên CẢ HAI dạng, vì hai loại marker nằm ở hai chỗ khác nhau trong ADF:
  //   - link Crisp nằm trong `marks.attrs.href` -> chỉ thấy khi soi JSON thô;
  //   - "Customer: <tên>" bị CẮT LÀM ĐÔI thành hai text node ("Customer: " + tên in đậm) nên
  //     không bao giờ khớp trên JSON thô — phải nối text lại mới thấy.
  // Bỏ vế thứ hai thì mỗi lần gọi lại là một comment trùng (đã đo).
  const raw = JSON.stringify(existing.comments || []);
  if (raw.includes(marker) || adfText(existing.comments || []).includes(marker)) {
    return { status: 200, body: { ok: true, skipped: "đã có comment nguồn cho case này", issue } };
  }

  // ADF: một đoạn. Có Crisp thì link thật (nhãn = tên khách trên Crisp) để click thẳng từ Jira;
  // không thì chỉ tên khách in đậm.
  const line = [];
  if (crisp) {
    line.push({ type: "text", text: "Crisp: " });
    line.push({
      type: "text", text: customer || crisp,
      marks: [{ type: "link", attrs: { href: crisp } }],
    });
  } else {
    line.push({ type: "text", text: "Customer: " });
    line.push({ type: "text", text: customerName, marks: [{ type: "strong" }] });
  }
  if (supporter) {
    if (line.length) line.push({ type: "text", text: " · " });
    line.push({ type: "text", text: "Reported by " });
    line.push({ type: "text", text: supporter, marks: [{ type: "strong" }] });
  }

  const put = await fetch(`${jiraBase(env)}/rest/api/3/issue/${issue}/comment`, {
    method: "POST",
    headers: { ...jiraHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: line }] },
    }),
  });
  if (!put.ok) {
    return { status: 502, body: { error: `ghi comment HTTP ${put.status}: ${(await put.text()).slice(0, 200)}` } };
  }
  return { status: 200, body: { ok: true, issue, crisp, customer: customer || customerName, supporter } };
}
