/**
 * POST /api/attach-image — chèn ảnh từ Slack/Crisp vào description của một issue Jira.
 *
 * VÌ SAO NẰM Ở WORKER (PO chốt): một script Python chạy trên máy PO chỉ
 * chạy khi laptop PO bật, vì nó cần JIRA_API_TOKEN + SLACK_BOT_TOKEN trong `.env` local. Đưa
 * secret lên Worker thì phần ảnh chạy được cả khi máy tắt — và quan trọng hơn: đây thành NƠI DUY
 * NHẤT chèn ảnh (bản Python gọi vào đây), nên cái mắt xích media-UUID-qua-redirect-303 chỉ tồn
 * tại một chỗ, không có hai bản lệch nhau sau vài tháng.
 *
 * Secrets cần set (`wrangler secret put <TÊN>`):
 *   JIRA_EMAIL · JIRA_API_TOKEN · SLACK_BOT_TOKEN
 * (JIRA_BASE_URL để trong wrangler.toml vars, không phải secret.)
 *
 * Xác thực: đi qua cùng cửa `/api/*` của Worker — cookie phiên PO hoặc bearer API_TOKEN. KHÔNG
 * có đường vào nào khác.
 */

/* Chỉ cho tải ảnh từ những host được khai báo. Không có allow-list thì endpoint này thành
   proxy tải bất kỳ URL nào (SSRF: dò dịch vụ nội bộ của Cloudflare/Jira), và thành đường để
   người ngoài nhét ảnh tuỳ ý vào Jira của team.

   `files.slack.com` có sẵn vì nguồn ảnh chính là Slack. Host Jira của chính bạn được TỰ ĐỘNG
   thêm vào (suy ra từ JIRA_BASE_URL) để copy media giữa hai issue khi gộp — thiếu nó thì gộp
   xong là mất ảnh trong spec. Ảnh của Jira nằm sau xác thực nên fetchImage() tự kèm Basic auth
   cho host này. Thêm nguồn khác (Crisp, Intercom, CDN nội bộ...) bằng biến IMAGE_HOSTS trong
   wrangler.toml, phân tách bằng dấu phẩy. */
function allowedHosts(env) {
  const hosts = new Set(["files.slack.com"]);
  try { hosts.add(new URL(jiraBase(env)).host); } catch { /* JIRA_BASE_URL chưa khai */ }
  for (const h of String(env.IMAGE_HOSTS || "").split(",")) {
    const host = h.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}
// Ảnh case thật ~150KB, nhưng endpoint này còn chép VIDEO khi gộp hai issue (attachment có thể
// là mp4), nên trần phải rộng hơn hẳn.
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 5;                 // chặn một lượt lỗi kéo theo hàng chục attachment

/* Mã issue được phép ghi vào. Mặc định là MỌI project trên Jira đã khai; đặt JIRA_PROJECT_KEY
   (vd "ENG") để khoá lại đúng một project — nên làm, vì token Jira thường có quyền rộng hơn
   nhiều so với việc endpoint này cần. */
function issueKeyRe(env) {
  const key = String(env.JIRA_PROJECT_KEY || "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*$/.test(key) ? new RegExp("^" + key + "-\\d+$") : /^[A-Z][A-Z0-9]*-\d+$/;
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

function jiraHeaders(env) {
  return { authorization: "Basic " + b64(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`) };
}

function jiraBase(env) {
  return String(env.JIRA_BASE_URL || "").replace(/\/+$/, "");
}

/** Kích thước gốc đọc thẳng từ header file. Thiếu cặp width/height trên node media thì Jira
 *  render bằng URL thumbnail nên ảnh hiện bé tí (lỗi PO bắt). */
function imageSize(buf) {
  const v = new DataView(buf);
  const b = new Uint8Array(buf);
  try {
    if (b[0] === 0x89 && b[1] === 0x50 && v.getUint32(12) === 0x49484452) {
      return [v.getUint32(16), v.getUint32(20)];           // PNG: IHDR
    }
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return [v.getUint16(6, true), v.getUint16(8, true)]; // GIF: little-endian
    }
    if (b[0] === 0xff && b[1] === 0xd8) {                  // JPEG: quét segment tìm SOF
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1], seglen = v.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return [v.getUint16(i + 7), v.getUint16(i + 5)];
        }
        i += 2 + seglen;
      }
    }
  } catch { /* header lạ thì thôi, chạy tiếp không có kích thước */ }
  return null;
}

const nodeText = (n) =>
  (n.content || []).map((c) => (typeof c.text === "string" ? c.text : "")).join("").trim();

/** Ảnh phải nằm trong phần mô tả case, KHÔNG rơi xuống cuối sau footer Slack. Thứ tự ưu tiên,
 *  dừng ở cái đầu tiên khớp: sau block `Case` -> sau đoạn `Currently:` -> ngay TRƯỚC footer
 *  Slack -> cuối cùng. (Giữ đồng bộ với insert_index() bản Python.) */
function insertIndex(content) {
  const blockEnd = (start) => {
    for (let j = start + 1; j < content.length; j++) {
      if (content[j].type === "heading") return j;
    }
    return content.length;
  };
  for (let i = 0; i < content.length; i++) {
    const t = nodeText(content[i]).toLowerCase();
    if (content[i].type === "heading" && t.startsWith("case")) return blockEnd(i);
    if (content[i].type === "paragraph" && t.startsWith("case:")) return i + 1;
  }
  for (let i = 0; i < content.length; i++) {
    if (content[i].type === "paragraph" && nodeText(content[i]).toLowerCase().startsWith("currently:")) {
      return i + 1;
    }
  }
  for (let i = 0; i < content.length; i++) {
    if (nodeText(content[i]).toLowerCase().includes("issue created in slack")) return i;
  }
  return content.length;
}

function mediaNode(mediaId, collection, size, displayWidth) {
  const attrs = { id: mediaId, type: "file", collection };
  if (size) { attrs.width = size[0]; attrs.height = size[1]; }
  const single = { layout: "center" };
  if (displayWidth) { single.width = displayWidth; single.widthType = "pixel"; }
  return { type: "mediaSingle", attrs: single, content: [{ type: "media", attrs }] };
}

/** File id Slack -> URL tải. Slack MCP trả về id chứ không trả URL, nên khi nguyên liệu nằm ở
 *  một thread khác thì bên gọi chỉ có id trong tay. */
async function slackFileUrl(env, fileId) {
  if (!env.SLACK_BOT_TOKEN) throw new Error("Worker chưa có secret SLACK_BOT_TOKEN");
  const r = await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const d = await r.json();
  if (!d.ok) {
    const hint = d.error === "missing_scope" ? " — bot thiếu scope files:read" : "";
    throw new Error(`files.info lỗi: ${d.error}${hint}`);
  }
  const url = d.file?.url_private_download || d.file?.url_private;
  if (!url) throw new Error("files.info không trả url_private_download");
  return url;
}

/** File đính kèm đã nằm sẵn trên chính board Coordinator (R2, upload qua POST /api/attachments) — đọc
 *  thẳng bằng binding `env.ATTACHMENTS`, không đi vòng qua HTTP + allow-list như nguồn ngoài.
 *  Đơn giản hơn hẳn Slack/Crisp: cùng Worker, cùng env, không cần token/allow-list riêng. */
async function fetchBoardAttachment(env, key, wantName) {
  const obj = await env.ATTACHMENTS.get(key);
  if (!obj) throw new Error(`board attachment không tồn tại: ${key}`);
  const buf = await obj.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`file ${Math.round(buf.byteLength / 1024)}KB vượt trần ${MAX_BYTES / 1024 / 1024}MB`);
  }
  const ctype = obj.httpMetadata?.contentType || "application/octet-stream";
  // Key dạng `<uuid>-<tên gốc>` (xem POST /api/attachments trong index.js) — bỏ tiền tố UUID để
  // giữ tên gốc hiện trong Jira, không phải chuỗi UUID vô nghĩa.
  const name = wantName || key.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "") || key;
  return { buf, name, ctype };
}

async function fetchImage(env, rawUrl, wantName) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error(`URL không hợp lệ: ${rawUrl}`); }
  if (u.protocol !== "https:") throw new Error("chỉ nhận https");
  const hosts = allowedHosts(env);
  if (!hosts.has(u.hostname.toLowerCase())) {
    throw new Error(`host ${u.hostname} không nằm trong allow-list (${[...hosts].join(", ")})`);
  }
  const headers = {};
  if (u.hostname.endsWith("slack.com")) {
    if (!env.SLACK_BOT_TOKEN) throw new Error("Worker chưa có secret SLACK_BOT_TOKEN");
    headers.authorization = `Bearer ${env.SLACK_BOT_TOKEN}`;
  } else if (jiraBase(env) && u.hostname === new URL(jiraBase(env)).hostname) {
    // Anh dinh kem cua Jira nam sau xac thuc. Dung Basic auth nhu moi loi goi Jira khac.
    Object.assign(headers, jiraHeaders(env));
  }
  const r = await fetch(u.toString(), { headers, redirect: "follow" });
  if (!r.ok) throw new Error(`tải file HTTP ${r.status}`);
  const ctype = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  // Slack tra TRANG HTML dang nhap kem HTTP 200 khi thieu quyen — khong tin status code. Chi
  // chan text/html: tu mot ban sau endpoint nay nhan ca video va file dinh kem (combine phai chep
  // media sang issue giu lai), nen khong con doi image/* nua.
  if (ctype.startsWith("text/html")) {
    throw new Error("nguồn trả về HTML chứ không phải file" +
      (u.hostname.endsWith("slack.com") ? " — bot thiếu scope files:read hoặc chưa reinstall app" : ""));
  }
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`ảnh ${Math.round(buf.byteLength / 1024)}KB vượt trần ${MAX_BYTES / 1024 / 1024}MB`);
  }
  // Ten do BEN GOI dat neu co (`{url, filename}`). Doan tu URL la phuong an cuoi: copy media giua
  // hai issue Jira thi URL chi la /attachment/content/52071, ten hoa ra "52071.mp4" — mat ten goc.
  let name = wantName || u.pathname.split("/").filter(Boolean).pop() || "file";
  if (!name.includes(".")) name += "." + (ctype.split("/")[1] || "bin");
  return { buf, name, ctype };
}

async function uploadAttachment(env, issue, { buf, name, ctype }) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: ctype }), name);
  // KHÔNG tự đặt content-type: FormData phải tự sinh boundary.
  const r = await fetch(`${jiraBase(env)}/rest/api/3/issue/${issue}/attachments`, {
    method: "POST",
    headers: { ...jiraHeaders(env), "x-atlassian-token": "no-check" },
    body: form,
  });
  if (!r.ok) throw new Error(`upload attachment HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return Array.isArray(data) ? data[0] : data;
}

/** UUID để gắn vào attrs.id của node media.
 *
 *  MẮT XÍCH KHÔNG CÓ TÀI LIỆU, đừng đoán lại (đã đo): response upload attachment KHÔNG
 *  chứa UUID nào, chỉ có `id` dạng số; nhét id số vào node media thì Jira trả
 *  400 ATTACHMENT_VALIDATION_ERROR. UUID nằm ở header Location của
 *  GET /rest/api/3/attachment/content/{id} (303 -> api.media.atlassian.com/file/<UUID>/binary).
 *  BẮT BUỘC redirect:"manual" — để fetch tự đi theo thì tải nguyên file ảnh về và mất Location. */
async function mediaIdForAttachment(env, attachmentId) {
  const r = await fetch(`${jiraBase(env)}/rest/api/3/attachment/content/${attachmentId}`, {
    headers: jiraHeaders(env), redirect: "manual",
  });
  const loc = r.headers.get("location") || "";
  const parts = new URL(loc || "https://x/").pathname.split("/").filter(Boolean);
  const i = parts.indexOf("file");
  if (i < 0 || !parts[i + 1]) {
    throw new Error(`không lấy được media UUID (HTTP ${r.status}, location=${loc.slice(0, 80)})`);
  }
  return parts[i + 1];
}

export async function handleAttachImage(req, env) {
  for (const k of ["JIRA_EMAIL", "JIRA_API_TOKEN"]) {
    if (!env[k]) return { status: 500, body: { error: `Worker chưa có secret ${k}` } };
  }
  const body = await req.json().catch(() => null);
  if (!body) return { status: 400, body: { error: "body phải là JSON" } };

  if (!jiraBase(env)) {
    return { status: 500, body: { error: "Worker chưa khai JIRA_BASE_URL trong wrangler.toml" } };
  }
  const issue = String(body.issue || "").trim().toUpperCase();
  if (!issueKeyRe(env).test(issue)) {
    return { status: 400, body: { error: `issue phải dạng ABC-1234, nhận được: ${issue || "(rỗng)"}` } };
  }
  const maxWidth = Number(body.max_width) > 0 ? Math.floor(Number(body.max_width)) : 760;

  // Moi phan tu cua `urls` la chuoi URL, hoac {url, filename} de giu ten goc.
  let urls = (body.urls || []).map((x) => (typeof x === "string" ? { url: x } : x));
  try {
    for (const fid of body.slack_files || []) urls.push({ url: await slackFileUrl(env, fid) });
  } catch (e) {
    return { status: 400, body: { error: String(e.message || e) } };
  }
  // File dinh kem da nam san tren board (R2 key tu POST /api/attachments) — nguon rieng, khong
  // qua fetchImage()/allow-list vi khong phai HTTP ra ngoai.
  const boardKeys = (body.board_keys || []).map((x) => (typeof x === "string" ? { key: x } : x));
  if (!urls.length && !boardKeys.length) {
    return { status: 400, body: { error: "cần `urls`, `slack_files` hoặc `board_keys`" } };
  }
  if (urls.length + boardKeys.length > MAX_IMAGES) {
    return { status: 400, body: { error: `tối đa ${MAX_IMAGES} file một lượt, nhận ${urls.length + boardKeys.length}` } };
  }

  // Tải + upload từng file. Lỗi một file thì DỪNG: chèn nửa vời rồi báo ok là kiểu hỏng khó thấy
  // nhất — issue trông như đã có đủ, thực ra thiếu.
  const uploads = [];
  try {
    for (const item of boardKeys) {
      const img = await fetchBoardAttachment(env, item.key, item.filename);
      const raw = await uploadAttachment(env, issue, img);
      uploads.push({
        url: `board:${item.key}`, filename: raw.filename, size: raw.size,
        mime: img.ctype,
        size_px: img.ctype.startsWith("image/") ? imageSize(img.buf) : null,
        attachment_id: raw.id, media_id: await mediaIdForAttachment(env, raw.id),
      });
    }
    for (const item of urls) {
      const url = item.url;
      const img = await fetchImage(env, url, item.filename);
      const raw = await uploadAttachment(env, issue, img);
      uploads.push({
        url, filename: raw.filename, size: raw.size,
        // `mime` PHAI co: node ADF chon theo no (anh/video -> mediaSingle, con lai ->
        // mediaInline). Thieu truong nay thi moi file deu roi vao nhanh mac dinh — dinh that
        // video mp4 chen vao issue ra mot the <img> rong 7px.
        mime: img.ctype,
        // Chi doc kich thuoc voi ANH. imageSize() quet header kieu JPEG tren byte cua mp4 co the
        // khop bay va tra ve kich thuoc rac.
        size_px: img.ctype.startsWith("image/") ? imageSize(img.buf) : null,
        attachment_id: raw.id, media_id: await mediaIdForAttachment(env, raw.id),
      });
    }
  } catch (e) {
    return { status: 502, body: { error: String(e.message || e), uploaded: uploads.length } };
  }

  // Đọc/ghi description bằng ADF, KHÔNG qua markdown: markdown nói dối (video bị vẽ thành cú
  // pháp ảnh, file đính kèm inline biến mất hẳn), đọc markdown rồi ghi đè là xoá mất nội dung.
  const issueRes = await fetch(`${jiraBase(env)}/rest/api/3/issue/${issue}`, { headers: jiraHeaders(env) });
  if (!issueRes.ok) {
    return { status: 502, body: { error: `đọc issue HTTP ${issueRes.status}` } };
  }
  const data = await issueRes.json();
  const doc = data.fields.description || { type: "doc", version: 1, content: [] };
  doc.content = doc.content || [];
  const collection = `contentId-${data.id}`;
  const at = insertIndex(doc.content);
  uploads.forEach((up, k) => {
    const kind = (up.mime || "").split("/")[0];
    let node;
    if (kind === "image" || kind === "video") {
      // Anh va video mp4 deu la mediaSingle > media type "file" (video KHONG can node rieng —
      // xem .claude/skills/jira-issue/SKILL.md).
      //
      // Video khong doc duoc kich thuoc goc, nhung KHONG duoc de trong `width` cua mediaSingle:
      // luc do Jira tu dien 480x380 (kich thuoc poster mac dinh) va video hien be hon han anh
      // ben canh — PO bat loi, hai .mp4/.mov ra 480px trong khi hai
      // anh cung muc Case ra 760px. Khong biet be ngang goc thi ep thang maxWidth, giong het
      // cach lam cua cac client cuc bo von dung tu dau.
      const display = up.size_px ? Math.min(up.size_px[0], maxWidth) : maxWidth;
      node = mediaNode(up.media_id, collection, up.size_px, display);
    } else {
      // File dinh kem khac (zip, psd, pdf...): mediaInline dat trong mot paragraph.
      node = { type: "paragraph", content: [{ type: "mediaInline",
        attrs: { id: up.media_id, type: "file", collection } }] };
    }
    doc.content.splice(at + k, 0, node);
  });

  const put = await fetch(`${jiraBase(env)}/rest/api/3/issue/${issue}`, {
    method: "PUT",
    headers: { ...jiraHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({ fields: { description: doc } }),
  });
  if (!put.ok) {
    return { status: 502, body: { error: `ghi description HTTP ${put.status}: ${(await put.text()).slice(0, 200)}` } };
  }

  // Đừng tin echo của lệnh ghi — đọc lại HTML render và đếm ảnh thật.
  const check = await fetch(`${jiraBase(env)}/rest/api/3/issue/${issue}?expand=renderedFields`,
    { headers: jiraHeaders(env) });
  let verify = null;
  if (check.ok) {
    const html = (await check.json()).renderedFields?.description || "";
    const imgs = html.match(/<img[^>]*>/g) || [];
    verify = {
      img_tags: imgs.length,
      thumbnails: imgs.filter((i) => i.includes("attachment/thumbnail")).length,
      widths: [...html.matchAll(/<img[^>]*\swidth="(\d+)"/g)].map((m) => Number(m[1])),
      // Video render thanh <object type="video/mp4">, file dinh kem inline thanh the <a> —
      // dem rieng, neu khong thi chep video sang xong `img_tags` van 0 va trong nhu that bai.
      videos: (html.match(/<object[^>]+type="video/g) || []).length,
    };
  }
  return { status: 200, body: { ok: true, issue, inserted_at: at, uploads, verify } };
}
