/**
 * Cửa trước của Coordinator: nhận event Slack qua Events API rồi xếp vào hàng đợi D1.
 *
 * VÌ SAO (PO chốt): Socket Mode chỉ đẩy event tới client ĐANG kết nối và không phát
 * lại. Laptop PO tắt/ngủ là mention rơi im lặng — người tag không thấy gì, tưởng Coordinator hỏng.
 * Worker luôn sống: nhận event, react 👀 ngay (người tag biết đã nhận kể cả khi máy PO tắt), ghi
 * vào `slack_events`, để listener đến lấy khi máy bật.
 *
 * Endpoint:
 *   POST /slack/events              — Slack gọi (KHÔNG có bearer token; xác thực bằng chữ ký)
 *   GET  /api/mention-queue         — listener lấy việc  (bearer API_TOKEN)
 *   POST /api/mention-queue/ack     — listener báo xong  (bearer API_TOKEN)
 *   POST /api/mention-queue/test    — bơm event giả để test (bearer API_TOKEN)
 *
 * Secret cần thêm: SLACK_SIGNING_SECRET (Slack app → Basic Information → Signing Secret).
 */

const MAX_SKEW_SECONDS = 300;   // Slack khuyến nghị bỏ request cũ hơn 5 phút (chống replay)

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** So sánh không phụ thuộc thời gian — so bằng `===` là rò rỉ từng ký tự qua thời gian chạy. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Xác thực request đúng là của Slack.
 *
 * Endpoint này KHÔNG thể dùng bearer token như `/api/*` (Slack không gửi token của mình), nên
 * chữ ký là hàng rào DUY NHẤT. Thiếu nó thì bất kỳ ai biết URL đều bơm được event giả và sai
 * Coordinator chạy lệnh dưới danh nghĩa PO.
 */
async function verifySlack(req, env, rawBody) {
  if (!env.SLACK_SIGNING_SECRET) return "Worker chưa có secret SLACK_SIGNING_SECRET";
  const ts = req.headers.get("x-slack-request-timestamp") || "";
  const sig = req.headers.get("x-slack-signature") || "";
  if (!ts || !sig) return "thiếu header chữ ký";
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) return "timestamp quá cũ";

  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${rawBody}`));
  return safeEqual(`v0=${hex(mac)}`, sig) ? null : "chữ ký không khớp";
}

/** React ngay khi nhận (emoji đặt bằng SLACK_ACK_EMOJI, mặc định 👀). Đây là điểm khác lớn nhất
 *  so với Socket Mode: kể cả máy PO đang tắt, người tag vẫn thấy bot đã nhận việc thay vì im
 *  lặng hoàn toàn. */
async function reactReceived(env, channel, ts) {
  if (!env.SLACK_BOT_TOKEN) return;
  try {
    await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, timestamp: ts, name: env.SLACK_ACK_EMOJI || "eyes" }),
    });
  } catch { /* reaction hỏng không được chặn việc xếp hàng đợi */ }
}

async function enqueue(env, ev, eventId, kind) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO slack_events
       (event_id, kind, channel, thread_ts, msg_ts, user_id, text, files, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    eventId, kind, ev.channel, ev.thread_ts || null, ev.ts, ev.user,
    ev.text || "", ev.files ? JSON.stringify(ev.files) : null, new Date().toISOString(),
  ).run();
}

export async function handleSlackEvents(req, env) {
  const raw = await req.text();
  const bad = await verifySlack(req, env, raw);
  if (bad) return new Response(bad, { status: 401 });

  let body;
  try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  // Slack gọi 1 lần lúc PO dán Request URL vào app.
  if (body.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: body.challenge }),
      { headers: { "content-type": "application/json" } });
  }

  if (body.type !== "event_callback" || !body.event) return new Response("ok");

  const ev = body.event;
  const isBot = !!ev.bot_id || ev.subtype;
  const isDm = typeof ev.channel === "string" && ev.channel.startsWith("D");
  let kind = null;
  if (ev.type === "app_mention" && !isBot && !isDm) kind = "app_mention";
  // DM cũng phải đi qua đây: bật Events API là Socket Mode tắt, nên nếu bỏ message.im thì toàn
  // bộ lệnh DM (inbox digest, KB watchlist, board) chết theo.
  else if (ev.type === "message" && isDm && !isBot) kind = "message_im";
  if (!kind || !ev.user || !ev.ts) return new Response("ok");

  // Trả 200 NHANH là bắt buộc: quá 3 giây Slack coi như hỏng và gửi lại. Việc nặng đã đẩy sang
  // listener, ở đây chỉ ghi 1 dòng + 1 lời gọi reactions.add.
  await enqueue(env, ev, body.event_id || `${ev.channel}:${ev.ts}`, kind);
  await reactReceived(env, ev.channel, ev.ts);
  return new Response("ok");
}

/* ---------- API cho listener (bearer API_TOKEN, đi qua cửa /api/* sẵn có) ---------- */

export async function handleMentionQueue(req, env, url) {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/mention-queue") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);
    // `older_than_minutes`: chỉ lấy việc đã nằm chờ quá lâu. Dành cho bên tiêu thụ THỨ HAI (cron
    // cloud): listener local poll mỗi 20 giây nên việc gì còn nằm đó sau 30 phút nghĩa là máy PO
    // đang tắt. Không có mốc này thì cloud và local giành nhau từng việc, mà local luôn tốt hơn
    // (nhanh hơn, có .env, có ảnh).
    const olderThan = Number(url.searchParams.get("older_than_minutes") || 0);
    const cutoff = olderThan > 0
      ? new Date(Date.now() - olderThan * 60000).toISOString()
      : "9999-12-31T23:59:59Z";
    // `kind` và `only_user`: hai bộ lọc dành riêng cho cron cloud, và là HÀNG RÀO chứ không phải
    // tiện ích. Cloud KHÔNG được nhận:
    //   - lệnh DM (`message_im`): miền inbox digest/KB/board cần `.env` local và API_TOKEN đầy
    //     đủ, cloud không có, làm dở dang còn tệ hơn để đó chờ máy bật.
    //   - lệnh của member thường: cửa cứng chống lạm quyền (`guest_command_ok`) nằm trong code
    //     listener, cloud không có bản sao — nên cloud chỉ nhận việc của đúng PO.
    // Lọc ở Worker chứ không nhờ prompt tự giữ kỷ luật: prompt thì lái được, câu SQL thì không.
    const kind = url.searchParams.get("kind") || "";
    const onlyUser = url.searchParams.get("only_user") || "";
    const rows = await env.DB.prepare(
      `SELECT * FROM slack_events
        WHERE done_at IS NULL AND claimed_at IS NULL AND received_at < ?
          AND (? = '' OR kind = ?) AND (? = '' OR user_id = ?)
        ORDER BY received_at LIMIT ?`
    ).bind(cutoff, kind, kind, onlyUser, onlyUser, limit).all();
    const items = rows.results.map((r) => ({
      event_id: r.event_id, kind: r.kind, channel: r.channel,
      thread_ts: r.thread_ts || undefined, msg_ts: r.msg_ts, user: r.user_id,
      text: r.text || "", files: r.files ? JSON.parse(r.files) : undefined,
      received_at: r.received_at,
    }));
    // claim=1: đánh dấu đã nhận NGAY trong cùng lượt gọi, để hai lần poll liên tiếp không lấy
    // trùng một việc. Cố ý KHÔNG tự trả lại việc đã claim khi listener chết giữa chừng: chạy lại
    // một mention đã chạy dở nghĩa là có thể tạo issue thứ hai. Việc kẹt thì `mention-pending`
    // của listener đã báo người tag "tag lại đi", rẻ hơn nhiều so với issue trùng.
    if (url.searchParams.get("claim") === "1" && items.length) {
      const at = new Date().toISOString();
      // Claim phải ATOMIC: `WHERE claimed_at IS NULL` ngay trong câu UPDATE, rồi chỉ giữ lại
      // những dòng thật sự đổi được. Từ mảnh 3 có HAI bên tiêu thụ (listener local + cron cloud),
      // nên kiểu SELECT-rồi-UPDATE cũ có cửa sổ đua: cả hai đọc thấy cùng một việc trước khi bên
      // nào kịp ghi, và cùng tạo một issue hai lần.
      const claimed = await env.DB.batch(items.map((i) =>
        env.DB.prepare(
          "UPDATE slack_events SET claimed_at = ? WHERE event_id = ? AND claimed_at IS NULL"
        ).bind(at, i.event_id)));
      const mine = items.filter((_, k) => (claimed[k]?.meta?.changes || 0) > 0);
      return { status: 200, body: { items: mine } };
    }
    return { status: 200, body: { items } };
  }

  if (req.method === "POST" && path === "/api/mention-queue/ack") {
    const body = await req.json().catch(() => null);
    const ids = (body && body.event_ids) || [];
    if (!ids.length) return { status: 400, body: { error: "cần event_ids" } };
    const at = new Date().toISOString();
    await env.DB.batch(ids.map((id) =>
      env.DB.prepare("UPDATE slack_events SET done_at = ? WHERE event_id = ?").bind(at, id)));
    return { status: 200, body: { ok: true, acked: ids.length } };
  }

  // Gửi tin Slack BẰNG DANH NGHĨA BOT của board.
  //
  // Vì sao phải có: agent chạy trên cloud gửi Slack qua connector thì tin đứng tên chính bạn
  // ("<tên người dùng> · Sent using ..."). Chỉ bot token mới ra đúng tên app, mà bot token thì
  // nằm ở Worker — nên bên cloud ghi kết quả qua đây.
  if (req.method === "POST" && path === "/api/slack-post") {
    if (!env.SLACK_BOT_TOKEN) return { status: 500, body: { error: "thiếu SLACK_BOT_TOKEN" } };
    const b = await req.json().catch(() => null);
    if (!b || !b.channel || !b.text) {
      return { status: 400, body: { error: "cần `channel` và `text`" } };
    }
    const ephemeralTo = b.only_for || null;
    const api = ephemeralTo ? "chat.postEphemeral" : "chat.postMessage";
    const payload = {
      channel: b.channel, text: String(b.text).slice(0, 3800),
      unfurl_links: false, unfurl_media: false,
    };
    if (b.thread_ts) payload.thread_ts = b.thread_ts;
    if (ephemeralTo) payload.user = ephemeralTo;
    const r = await fetch(`https://slack.com/api/${api}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    return d.ok
      ? { status: 200, body: { ok: true, ts: d.ts || d.message_ts } }
      : { status: 502, body: { error: `slack ${api}: ${d.error}` } };
  }

  // Đổi reaction trên tin gốc (👀 -> ✅/❌) — cloud không có bot token nên cũng phải nhờ Worker.
  if (req.method === "POST" && path === "/api/slack-react") {
    if (!env.SLACK_BOT_TOKEN) return { status: 500, body: { error: "thiếu SLACK_BOT_TOKEN" } };
    const b = await req.json().catch(() => null);
    if (!b || !b.channel || !b.timestamp || !b.name) {
      return { status: 400, body: { error: "cần `channel`, `timestamp`, `name`" } };
    }
    const call = async (api, name) => {
      const r = await fetch(`https://slack.com/api/${api}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel: b.channel, timestamp: b.timestamp, name }),
      });
      return r.json();
    };
    for (const gone of (b.remove || [])) await call("reactions.remove", gone);
    const d = await call("reactions.add", b.name);
    // already_reacted = đúng trạng thái mong muốn, không phải lỗi.
    return (d.ok || d.error === "already_reacted")
      ? { status: 200, body: { ok: true } }
      : { status: 502, body: { error: `reactions.add: ${d.error}` } };
  }

  // Bơm event giả để thử toàn tuyến mà không cần đụng cấu hình Slack app. Chỉ bearer token gọi
  // được (cùng cửa /api/*), và không react gì lên Slack.
  if (req.method === "POST" && path === "/api/mention-queue/test") {
    const b = await req.json().catch(() => ({}));
    const id = "test-" + Date.now().toString(36);
    await enqueue(env, {
      channel: b.channel, thread_ts: b.thread_ts, ts: b.msg_ts || String(Date.now() / 1000),
      user: b.user, text: b.text || "", files: b.files,
    }, id, b.kind === "message_im" ? "message_im" : "app_mention");
    return { status: 200, body: { ok: true, event_id: id } };
  }

  return null;
}
