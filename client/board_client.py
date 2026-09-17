#!/usr/bin/env python3
"""Client Python cho Agent Ops Board — mọi thao tác agent cần làm với board đều đi qua đây.

Hai cách dùng:
  - import trực tiếp từ agent runner của bạn (get_board, add_message, react...).
  - gọi qua CLI, dùng khi agent là một phiên LLM chỉ có quyền chạy lệnh shell:
        python client/board_client.py get-board
        python client/board_client.py add-message <task_id>             --from coordinator --to analyst --kind call --text "..."             --status running --current-step analyst
    Đi qua CLI để token KHÔNG bao giờ phải xuất hiện trong prompt hay trong một lệnh curl
    (nó chỉ được đọc từ .env ngay tại đây).

Cấu hình — biến môi trường, hoặc file `.env` cạnh file này / ở thư mục hiện tại:
    BOARD_API_URL     https://<worker>.<subdomain>.workers.dev
    BOARD_API_TOKEN   đúng giá trị đã `wrangler secret put API_TOKEN`
"""
import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Chỗ tìm file .env: cạnh file này, thư mục cha (gốc repo), rồi thư mục đang đứng.
ENV_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"),
    os.path.join(os.getcwd(), ".env"),
]

# Các key agent hợp lệ — PHẢI khớp cột `key` của bảng `agents` trong D1. Sửa danh sách agent
# trong seed.data.json thì sửa cả ở đây, nếu không CLI sẽ từ chối chính agent của bạn.
AGENTS = ["po", "coordinator", "analyst", "reporter", "planner", "announcer"]
STATUSES = ["backlog", "new", "pending_approval", "running", "done"]


def _load_env():
    env = {}
    for path in ENV_CANDIDATES:
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except OSError:
            continue
    return env


def _base():
    base = os.environ.get("BOARD_API_URL") or _load_env().get("BOARD_API_URL")
    if not base:
        raise SystemExit("Thiếu BOARD_API_URL (biến môi trường hoặc .env) — xem .env.example.")
    return base


def _token():
    tok = os.environ.get("BOARD_API_TOKEN") or _load_env().get("BOARD_API_TOKEN")
    if not tok:
        raise SystemExit("Thiếu BOARD_API_TOKEN (biến môi trường hoặc .env) — xem .env.example.")
    return tok


def _call(method, path, payload=None):
    url = _base().rstrip("/") + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + _token())
    req.add_header("content-type", "application/json")
    # Bắt buộc: User-Agent mặc định của urllib ("Python-urllib/3.x") bị Cloudflare chặn
    # bằng bot protection, trả 403 error code 1010 trước khi request tới được Worker.
    req.add_header("User-Agent", "agent-ops-board-client/1.0")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise SystemExit(f"Board API lỗi {e.code}: {body}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Không gọi được board API: {e.reason}")


# ---------- API ----------

def get_board():
    """Toàn bộ board, ĐỦ message của mọi card (`?full=1`).

    Trình duyệt PO thì không: card Done ở đó không kèm message cho nhẹ. Agent PHẢI lấy bản đủ —
    vòng lặp nền của Coordinator quét message mới trên MỌI card, kể cả card đã Done, nên nhận bản cắt
    bớt là điếc luôn comment PO viết trong card đã đóng. Đây cũng là lý do param tên `full` chứ
    không phải `slim`: mặc định của API phải là bản nhẹ, ai cần đủ thì nói rõ."""
    return _call("GET", "/api/board?full=1")


UNTITLED = "(untitled)"   # phải khớp hằng cùng tên trong web/src/index.js


def create_task(title, description, **kw):
    payload = {"title": title, "description": description}
    payload.update({k: v for k, v in kw.items() if v is not None})
    return _call("POST", "/api/tasks", payload)


def add_message(task_id, from_agent, to_agent, text, kind="note",
                needs_approval=False, status=None, current_step=None, attachments=None):
    payload = {"from": from_agent, "to": to_agent, "text": text, "kind": kind,
               "needs_approval": bool(needs_approval)}
    if status:
        payload["status"] = status
    if current_step:
        payload["current_step"] = current_step
    if attachments:
        payload["attachments"] = attachments
    return _call("POST", f"/api/tasks/{task_id}/messages", payload)


def patch_task(task_id, **fields):
    payload = {k: v for k, v in fields.items() if v is not None}
    return _call("PATCH", f"/api/tasks/{task_id}", payload)


def get_task_status(task_id):
    """Trạng thái RẤT NHẸ — {progress, stop_requested} — dùng để poll mỗi ~2s TRONG LÚC một lượt
    claude -p đang chạy, để biết PO có vừa bấm nút Stop trên card không (đặt stop_requested=true
    -> agent runner của bạn nên terminate() lượt đang chạy rồi patch_task(task_id,
    stop_requested=False) để dọn cờ). KHÔNG dùng get_board() cho việc này — quá nặng để gọi lặp
    lại suốt một lượt chạy có thể dài hàng chục phút."""
    return _call("GET", f"/api/tasks/{task_id}/status")


def approve(message_id):
    return _call("POST", f"/api/messages/{message_id}/approve")


# Quy ước reaction: 👀 = đã nhận, đang làm · ✅ = xong · ❌ = không làm được/bỏ.
# Mỗi agent giữ ĐÚNG 1 reaction trên 1 message: react sau ghi đè react trước, nên đặt 👀 lúc
# bắt đầu rồi ✅ lúc xong sẽ không để đọng cả hai gây hiểu nhầm là còn đang chạy.
WORKING, DONE, FAILED = "👀", "✅", "❌"
EYES = WORKING  # tên cũ, giữ lại cho code đã viết trước đây
# ⏳ = vẫn đang làm nhưng đã lâu hơn bình thường. Đặt tự động khi một lượt chạy vượt
# BOARD_LONG_RUN_SECONDS, để PO nhìn cái là biết "đang chạy lâu" chứ không phải "treo".
SLOW = "⏳"


def react(message_id, agent, emoji):
    return _call("POST", f"/api/messages/{message_id}/react",
                 {"agent": agent, "emoji": emoji})


def download_attachment(key, dest_path):
    """Tải 1 file đính kèm (ảnh/PDF...) về `dest_path` — nhị phân, KHÔNG qua `_call()` vì
    hàm đó luôn ép `json.loads()` lên response. Dùng khi agent chạy qua `claude -p` (CLI, không
    có trình duyệt/network tool) cần XEM nội dung ảnh đính kèm trên card: link
    `/api/attachments/<key>` đòi Bearer token, Read tool không tự gắn header đó được — phải tải
    sẵn ra file cục bộ rồi đưa đường dẫn cho agent đọc."""
    url = _base().rstrip("/") + "/api/attachments/" + key
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", "Bearer " + _token())
    req.add_header("User-Agent", "agent-ops-board-client/1.0")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Board API lỗi {e.code} khi tải attachment {key}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Không tải được attachment {key}: {e.reason}")
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with open(dest_path, "wb") as fh:
        fh.write(data)
    return dest_path


def upload_attachment(file_path):
    """Tải 1 file cục bộ (agent tự tạo — banner PNG, screenshot...) lên R2 qua
    `POST /api/attachments`, trả về `{key, name, size, type}` để nhét vào field `attachments`
    của `add_message`/`create_task`. Dùng khi PO muốn TẢI TRỰC TIẾP từ card thay vì phải tự tìm
    đường dẫn file cục bộ trên máy chạy agent (trước đó agent chỉ báo path, PO phải tự mở file
    explorer đi tìm).

    KHÔNG qua `_call()` — đây là multipart/form-data, không phải JSON. Tự dựng body multipart
    bằng tay (không phụ thuộc thư viện ngoài `requests`, giữ đúng phong cách urllib của file này,
    xem `_call`/`download_attachment`)."""
    filename = os.path.basename(file_path)
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with open(file_path, "rb") as fh:
        file_bytes = fh.read()
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    url = _base().rstrip("/") + "/api/attachments"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", "Bearer " + _token())
    req.add_header("content-type", f"multipart/form-data; boundary={boundary}")
    req.add_header("User-Agent", "agent-ops-board-client/1.0")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace")
        raise SystemExit(f"Board API lỗi {e.code} khi tải lên {file_path}: {err_body}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Không tải lên được {file_path}: {e.reason}")


def active_tasks(board=None):
    """Task chưa xong — dùng để Coordinator biết PO đang có thể nhắc tới cái nào."""
    board = board or get_board()
    return [t for t in board["tasks"] if t["status"] != "done"]


# ---------- CLI ----------

def _read_text(inline, path):
    """Nội dung message: hoặc `--text` trên dòng lệnh, hoặc `--text-file` (`-` = stdin).

    Có `--text-file` vì nhét xuống dòng vào một đối số shell trên Windows là cực hình — agent
    tưởng "board không nhận xuống dòng" rồi tự chẻ một bản review thành 5 message rời (sự cố
    một lần thật). API chưa bao giờ mất `
`; chỉ đường nhập là khó.

    Viết markdown bình thường: heading, bullet, bảng, code fence... board tự render."""
    if path:
        if path == "-":
            data = sys.stdin.buffer.read().decode("utf-8")
        else:
            data = open(path, encoding="utf-8").read()
        return data.rstrip("\n")
    return inline



def main():
    p = argparse.ArgumentParser(description="Client Agent Ops Board")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("get-board", help="in toàn bộ board dạng JSON")
    sub.add_parser("active", help="in các task chưa xong (gọn) dạng JSON")

    c = sub.add_parser("create-task", help="tạo task mới")
    # Title không bắt buộc: PO tạo card chỉ với mô tả, Coordinator đọc xong tự tóm tắt rồi patch-task
    # --title. Bỏ trống thì Worker đặt "(untitled)" — đó là dấu hiệu Coordinator dò để biết cần đặt tên.
    c.add_argument("--title")
    # Description cũng không bắt buộc: bỏ trống thì tạo message rỗng, PO
    # bấm Edit trên card điền sau — dùng khi PO chỉ muốn thả một cái tên vào board rồi tính tiếp.
    c.add_argument("--description")
    c.add_argument("--description-file",
                   help="đọc description từ file (`-` = stdin) — cách duy nhất giữ được xuống dòng")
    c.add_argument("--status", choices=STATUSES)
    c.add_argument("--pipeline", help="danh sách agent key, phân tách bởi dấu phẩy")
    c.add_argument("--current-step", choices=AGENTS)
    c.add_argument("--session-id")
    c.add_argument("--jira-key")
    c.add_argument("--slack-url", help="link thread Slack nguồn của task")
    c.add_argument("--browser", help="TÊN trình duyệt Chrome dùng cho card này (rỗng = không dùng)")
    # Tự đặt id thay vì để Worker sinh ngẫu nhiên. Dùng cho job định kỳ: lượt chạy sau (retry
    # hôm sau, hay phần tự kiểm cuối script) tìm lại đúng card cũ mà không phải lưu id ở đâu.
    c.add_argument("--id", help="id cố định cho card, vd bao-cao-thang-2026-01")

    m = sub.add_parser("add-message", help="thêm 1 message vào task")
    m.add_argument("task_id")
    m.add_argument("--from", dest="from_agent", required=True, choices=AGENTS)
    m.add_argument("--to", dest="to_agent", required=True, choices=AGENTS)
    m.add_argument("--text")
    m.add_argument("--text-file",
                   help="đọc text từ file (`-` = stdin) — cách duy nhất giữ được xuống dòng")
    # "comment" = PO gõ thẳng trong card trên web (Coordinator lọc đúng kind này để biết có việc mới).
    m.add_argument("--kind", default="note", choices=["request", "call", "reply", "note", "comment"])
    m.add_argument("--needs-approval", action="store_true")
    m.add_argument("--status", choices=STATUSES)
    m.add_argument("--current-step", choices=AGENTS)
    # File agent tự tạo (banner PNG...) — mỗi --attach 1 đường dẫn cục bộ, lặp lại nếu nhiều file.
    # Tự upload lên R2 trước rồi gắn key vào message, PO bấm là tải trực tiếp từ card, không phải
    # tự đi tìm file trên máy chạy agent.
    m.add_argument("--attach", action="append", default=[],
                   help="đường dẫn file cục bộ để đính kèm — lặp lại cho nhiều file")

    t = sub.add_parser("patch-task", help="sửa thuộc tính task")
    t.add_argument("task_id")
    t.add_argument("--title", help="đổi tên card — dùng để đặt tên card '(untitled)'")
    t.add_argument("--status", choices=STATUSES)
    t.add_argument("--jira-key")
    t.add_argument("--slack-url")
    t.add_argument("--browser", help="TÊN trình duyệt Chrome cho card này; chuỗi rỗng = gỡ bỏ")
    # Hẹn giờ chạy. Đặt giờ QUÁ KHỨ/hiện tại = bảo vòng lặp board chạy card này ngay lượt tới.
    # Đây là cách agent TỰ khởi động lại card mình đang làm dở (vd vừa gán trình duyệt xong và
    # cần một lượt CÓ --chrome), không phải đi nhờ PO bấm Run now.
    t.add_argument("--run-at", help="ISO +07:00, vd 2026-08-27T15:30:00+07:00; rỗng = huỷ hẹn")
    t.add_argument("--session-id")
    t.add_argument("--current-step", choices=AGENTS)
    t.add_argument("--pipeline", help="danh sách agent key, phân tách bởi dấu phẩy")

    a = sub.add_parser("approve", help="đánh dấu 1 message đã được PO duyệt")
    a.add_argument("message_id")

    rc = sub.add_parser("react", help="react vào 1 message (👀 đang làm, ✅ xong, ❌ không làm được)")
    rc.add_argument("message_id")
    rc.add_argument("--agent", required=True, choices=AGENTS)
    rc.add_argument("--emoji", required=True)

    da = sub.add_parser("download-attachment",
                        help="tải 1 file đính kèm (key trong field attachments của message) về máy — "
                             "cần khi chạy qua `claude -p` không có trình duyệt/network tool để tự xem ảnh")
    da.add_argument("key")
    da.add_argument("dest_path")

    ua = sub.add_parser("upload-attachment",
                        help="tải 1 file cục bộ lên, in ra {key,name,size,type} để tự ghép vào "
                             "add-message/create-task sau — thường dùng --attach của add-message "
                             "thay vì gọi lệnh này riêng, trừ khi cần key trước để dùng nhiều lần")
    ua.add_argument("file_path")

    args = p.parse_args()

    if args.cmd == "add-message" and not (args.text or args.text_file):
        p.error("add-message cần --text hoặc --text-file")

    if args.cmd == "get-board":
        out = get_board()
    elif args.cmd == "active":
        out = [{"id": t["id"], "title": t["title"], "status": t["status"],
                "jira_key": t["jira_key"], "current_step": t["current_step"],
                "session_id": t["session_id"]} for t in active_tasks()]
    elif args.cmd == "create-task":
        out = create_task(
            args.title or "", _read_text(args.description, args.description_file) or "", status=args.status,
            pipeline=args.pipeline.split(",") if args.pipeline else None,
            current_step=args.current_step, session_id=args.session_id,
            jira_key=args.jira_key, slack_url=args.slack_url, browser=args.browser,
            id=args.id,
        )
    elif args.cmd == "add-message":
        attachments = [upload_attachment(fp) for fp in args.attach]
        out = add_message(args.task_id, args.from_agent, args.to_agent,
                          _read_text(args.text, args.text_file),
                          kind=args.kind, needs_approval=args.needs_approval,
                          status=args.status, current_step=args.current_step,
                          attachments=attachments)
    elif args.cmd == "patch-task":
        out = patch_task(args.task_id, title=args.title, status=args.status, jira_key=args.jira_key,
                         slack_url=args.slack_url,
                         browser=args.browser, run_at=args.run_at,
                         session_id=args.session_id, current_step=args.current_step,
                         pipeline=args.pipeline.split(",") if args.pipeline else None)
    elif args.cmd == "approve":
        out = approve(args.message_id)
    elif args.cmd == "react":
        out = react(args.message_id, args.agent, args.emoji)
    elif args.cmd == "download-attachment":
        out = {"saved_to": download_attachment(args.key, args.dest_path)}
    elif args.cmd == "upload-attachment":
        out = upload_attachment(args.file_path)
    else:
        p.error("lệnh không hợp lệ")

    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
