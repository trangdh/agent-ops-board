/* Agent Ops Board — bản web (Cloudflare Worker + D1).
 *
 * Khác bản artifact: dữ liệu lấy từ /api/board thay vì nhúng sẵn trong trang, và mọi thay đổi
 * đều POST lên API thay vì trang tự publish lại chính nó. Nhờ vậy PO và agent ghi cùng lúc
 * không đè lên nhau — đúng chỗ mà bản artifact còn thô.
 */
(function () {
  "use strict";

  /* Nhãn hiển thị dùng đúng bộ status chuẩn của Jira (Backlog → To Do → In Progress → In Review
     → Done), và cột xếp theo đúng dòng chảy đó. Backlog (PO chốt): việc cập nhật
     thêm cho từng agent, biết trước sẽ làm nhưng chưa làm ngay — tách khỏi To Do (việc sẵn sàng
     làm bất kỳ lúc nào) để cột To Do không lẫn việc "chưa tới lượt". Card mới do agent tạo vẫn
     rơi thẳng vào "new"/To Do như cũ (xem VALID_STATUS default trong index.js) — chỉ PO tự kéo/
     đổi dropdown mới đưa card vào Backlog. */
  var STATUS_ORDER = ["backlog", "new", "running", "pending_approval", "done"];
  /* Backlog KHÔNG nằm chung lưới 4 cột chính — xem backlogRail() và render(). */
  var MAIN_STATUS_ORDER = STATUS_ORDER.slice(1);
  var STATUS_META = {
    "backlog": { label: "Backlog", lozenge: "new", empty: "Backlog trống." },
    "new": { label: "To Do", lozenge: "new", empty: "Nothing queued up." },
    "running": { label: "In Progress", lozenge: "inprogress", empty: "No task running." },
    "pending_approval": { label: "In Review", lozenge: "waiting", empty: "Nothing waiting for your review." },
    "done": { label: "Done", lozenge: "success", empty: "No task completed yet." }
  };

  var POLL_MS = 15000;
  /* Vé thứ tự cho refresh() — chặn race PO báo: gửi comment xong tự gọi refresh()
     đúng lúc poll định kỳ (setInterval) cũng đang có 1 lượt fetch bay giữa chừng; lượt poll đó
     đọc board TRƯỚC khi comment kịp ghi, nên khi nó resolve SAU (mạng không đảm bảo thứ tự) sẽ
     đè data mới bằng bản cũ thiếu đúng comment vừa gửi — PO thấy comment "biến mất", phải chờ
     tới lượt poll kế (~15s) mới hiện lại. Mỗi lần gọi refresh() lấy 1 số tăng dần; response chỉ
     được áp dụng nếu KHÔNG có lượt refresh nào mới hơn đã được GỌI (dù resolve trước hay sau). */
  var refreshSeq = 0;
  /* Card Done quá 30 ngày rời khỏi board (Worker lọc, xem ARCHIVE_DAYS). Vẫn nguyên trong DB —
     bật cái này là hỏi lại API kèm ?archived=1. Không có nút "xoá hàng loạt": xoá là mất luôn
     hội thoại, và đó phải là việc PO làm từng cái một. */
  var showArchived = false;
  var data = null;
  var openTaskId = null;   // giữ popup đang mở qua các lần render lại
  /* Vừa kéo-thả xong 1 card bằng Pointer Events (xem wire()) — click bắn theo ngay sau pointerup
     trên cùng phần tử KHÔNG phải bấm mở card, phải bỏ qua đúng 1 lần. */
  var cardDragJustHappened = false;
  var editingDescTask = null; // id task đang sửa description (null = không sửa gì)
  var editingTitleTask = null; // id task đang sửa title (null = không sửa gì)
  // PO tự bấm mở/gấp Details trên mobile — nhớ theo từng task để không bị bung/gấp lại mỗi lần
  // render() dựng lại DOM (poll 15s, hoặc bất kỳ thay đổi nào trên board). Không set = dùng mặc
  // định theo bề rộng màn hình (gấp trên mobile, luôn mở trên desktop).
  var sidebarExpanded = {};
  // File đã tải lên (POST /api/attachments) nhưng comment/description CHƯA gửi —
  // taskId -> [{key,name,size,type}]. Sống ngoài DOM vì render() dựng lại toàn bộ form mỗi lần
  // poll; mất khoảng giữa chọn file và bấm gửi thì PO phải chọn lại, khó chịu hơn hẳn so với
  // các state khác ở trên. Form "New task" dùng key cố định này vì lúc PO chọn file thì task
  // CHƯA tồn tại, chưa có id thật để làm key.
  var NEW_TASK_ATTACH_KEY = "__new_task__";
  var pendingAttachments = {};
  var filterText = "";
  var pollTimer = null;
  var lastSnapshot = null; // JSON của lần tải trước, để bỏ qua render khi không có gì đổi
  var keptScroll = 0;      // vị trí scroll trong popup, giữ qua lần render lại
  var wasAtBottom = false; // đang đứng đúng đáy comment lúc chép keptScroll? → bám đáy mới sau render
  /* Comment đang gõ dở trong popup — PHẢI giữ qua lần render lại giống keptScroll, không thì
     poll 15s cứ đập lại DOM là textarea bị thay bằng cái mới rỗng, mất chữ + mất focus (PO báo
     một lần thật). Chỉ cần 1 chỗ vì tại một thời điểm chỉ có 1 popup mở (giống openTaskId). */
  var keptDraft = null;    // {text, selStart, selEnd, focused} hoặc null nếu không có gì để giữ
  var lastMsgCount = null; // tổng số message lần trước, để biết có gì mới
  var unseen = 0;          // số message mới tới lúc tab đang ẩn
  /* Ba giá trị dưới đây do Worker gửi xuống trong `config` của /api/board, đặt bằng [vars]
     trong wrangler.toml. Không phải hằng số cứng vì mỗi người dựng board trỏ về Jira/repo khác
     nhau — xem uiConfig() trong src/index.js. Giá trị ở đây chỉ là mặc định lúc chưa tải xong. */
  var BASE_TITLE = "Agent Ops Board";
  var JIRA_BASE = "";      // "" = không biến mã issue thành link
  var REPO_BASE = "";      // "" = không biến đường dẫn file thành link
  var REPO_DIRS = [];      // các thư mục đầu đường dẫn được phép link, vd ["outputs", "docs"]

  /* ---------- tiện ích ---------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtTime(iso) {
    var t = /T(\d{2}):(\d{2})/.exec(iso || "");
    var d = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    if (!t || !d) return "";
    return d[3] + "/" + d[2] + " " + t[1] + ":" + t[2];
  }

  /* Regex nhận đường dẫn file trong repo ("outputs/abc.md") dựng từ REPO_DIRS. Dựng lại mỗi
     lần config đổi chứ không viết cứng danh sách thư mục: repo của mỗi người một khác. */
  var repoPathRe = null, repoMdLinkRe = null;
  // Regex không bao giờ khớp — dùng làm chỗ trám cho .replace() khi board chưa khai repo, để
  // chuỗi .replace() nối nhau không phải tách ra thành nhánh if riêng.
  var NEVER = /(?!)/g;

  function applyConfig(cfg) {
    cfg = cfg || {};
    BASE_TITLE = cfg.board_title || BASE_TITLE;
    JIRA_BASE = cfg.jira_base || "";
    REPO_BASE = cfg.repo_base ? cfg.repo_base.replace(/\/+$/, "") + "/" : "";
    REPO_DIRS = cfg.repo_dirs || [];
    var dirs = REPO_DIRS.filter(function (d) { return /^[A-Za-z0-9._-]+$/.test(d); });
    if (REPO_BASE && dirs.length) {
      var body = "(?:" + dirs.join("|") + ")/[A-Za-z0-9._/-]*[.][A-Za-z0-9]+";
      repoPathRe = new RegExp("(" + body + ")", "g");
      repoMdLinkRe = new RegExp("\\[([^\\]\\n]+)\\]\\((" + body + ")\\)", "g");
    } else {
      repoPathRe = repoMdLinkRe = null;
    }
    if (!document.title || document.title === "Agent Ops Board") document.title = BASE_TITLE;
  }

  /* ---------- markdown rút gọn cho nội dung message ----------
     Agent viết message bằng markdown (nó viết mọi thứ khác bằng markdown), nhưng trước
     đây board nhét thẳng vào <p> nên HTML nuốt sạch xuống dòng — mọi thứ dính thành một
     khối. Có agent đã phải tự chẻ một bản review dài ra 5 message rời chỉ vì tưởng "board không
     nhận xuống dòng". API chưa bao giờ mất \n; chỉ khâu vẽ là mất.

     Cố ý KHÔNG dùng thư viện markdown: board không tải được script ngoài, và ở đây chỉ cần đúng
     những gì agent thật sự viết — heading, bullet, số thứ tự, bảng, code, đậm/nghiêng, gạch ngang. */

  /* Định dạng trong MỘT dòng. Thứ tự bắt buộc:
     1. rút code span ra trước — nội dung trong `` ` `` phải nguyên xi, không bị linkify/@chip đụng vào;
     2. linkify (đã tự esc + gắn @chip + link Jira/repo);
     3. đậm/nghiêng CHỈ chạy sau khi mọi thẻ <a> đã dựng xong — chạy trước thì dấu _ trong URL
        biến thành <em> và làm hỏng href. */
  function inline(raw) {
    var held = [];
    function hold(html) {
      held.push(html);
      return "\u0000" + (held.length - 1) + "\u0000";   // ký tự này không bao giờ có trong text thật
    }
    var s = String(raw == null ? "" : raw)
      .replace(/`([^`\n]+)`/g, function (_, c) {
        return hold('<code class="md-code">' + esc(c) + "</code>");
      })
      // [nhãn](url) — chỉ nhận http(s)/mailto. Scheme khác (javascript:, data:) rơi xuống dưới
      // và hiện nguyên văn chứ KHÔNG thành link.
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, function (_, label, url) {
        return hold(extLink(url, label));
      })
      // [nhãn](outputs/abc.md) — đường dẫn trong repo. enrich() vốn tự link path trần rồi, nhưng
      // dạng markdown thì không: bỏ qua ở đây thì PO nhìn thấy nguyên cặp ngoặc thừa quanh link.
      // Chỉ chạy khi board được cấu hình REPO_BASE_URL + REPO_LINK_DIRS (xem applyConfig).
      .replace(repoMdLinkRe || NEVER, function (whole, label, path) {
        return repoMdLinkRe ? hold(extLink(REPO_BASE + path, label)) : whole;
      });
    s = linkify(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    // _nghiêng_ phải có khoảng trắng/đầu dòng ở trước và dấu câu/hết dòng ở sau — nếu không thì
    // snake_case (form_label, run_at...) sẽ bị hiểu nhầm thành nghiêng.
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return held[i]; });
  }

  /* Khối. `lead` là mẩu HTML chèn vào đầu (chip người nhận) — nhét vào trong đoạn đầu tiên để nó
     nằm cùng dòng với chữ, chứ không rơi xuống một dòng riêng. */
  function richText(raw, lead) {
    var lines = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").split("\n");
    var out = [], para = [], list = null, fence = null, table = null, quoteBuf = null;
    var pending = lead || "";

    function take() { var l = pending; pending = ""; return l ? l + " " : ""; }

    /* Khối code/blockquote (kiểu prompt PO dán thẳng vào Claude/Jira) đủ dài là PO cần copy
       nguyên xi ra ngoài — bọc nút Copy dùng lại cơ chế [data-copy] chung cả app (wire(), khoảng
       dòng 1290) thay vì tự viết clipboard logic riêng. PO chốt. */
    function copyBtn(rawText) {
      return '<button type="button" class="btn btn--subtle btn--tiny md-copy-btn" data-copy="' +
        esc(rawText) + '">Copy</button>';
    }
    function codeBlock(text) {
      return '<div class="md-block"><pre class="md-pre"><code>' + esc(text) + "</code></pre>" +
        copyBtn(text) + "</div>";
    }

    /* Mỗi mục là {html, sub}. Giữ mục con trong `sub` thay vì nối chuỗi HTML dở dang: nối chuỗi
       thì phải nhớ đóng </ul> ở đúng chỗ, và chỉ cần một nhánh quên đóng là hỏng cả cây. */
    function closeList() {
      if (!list) return;
      out.push("<" + list.tag + ' class="md-list">' + list.items.map(function (it) {
        return "<li>" + it.html +
          (it.sub ? "<" + it.sub.tag + ' class="md-list md-sub">' +
            it.sub.items.map(function (x) { return "<li>" + x + "</li>"; }).join("") +
            "</" + it.sub.tag + ">" : "") + "</li>";
      }).join("") + "</" + list.tag + ">");
      list = null;
    }
    function closeTable() {
      if (!table) return;
      out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
        table.head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") +
        "</tr></thead><tbody>" + table.rows.map(function (r) {
          return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
        }).join("") + "</tbody></table></div>");
      table = null;
    }
    function closePara() {
      if (!para.length) return;
      // Xuống dòng đơn trong cùng một đoạn giữ nguyên thành <br> — agent hay xuống dòng để
      // ngắt ý chứ không phải để mở đoạn mới.
      out.push('<p class="md-p">' + take() +
        para.map(function (l) { return inline(l); }).join("<br>") + "</p>");
      para = [];
    }
    // Nhiều dòng `>` liên tiếp = MỘT blockquote (agent hay bẻ câu dài thành nhiều dòng `>` khi
    // soạn, đúng quy ước markdown thường — trước đây mỗi dòng `>` ra một <blockquote> riêng nên
    // một câu bị chẻ vụn giữa chừng thành nhiều khối cách nhau).
    function closeQuote() {
      if (!quoteBuf) return;
      out.push('<div class="md-block"><blockquote class="md-quote">' + take() +
        quoteBuf.map(function (l) { return inline(l); }).join("<br>") + "</blockquote>" +
        copyBtn(quoteBuf.join("\n")) + "</div>");
      quoteBuf = null;
    }
    function closeAll() { closePara(); closeList(); closeTable(); closeQuote(); }

    function cells(line) {
      return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|")
        .map(function (c) { return c.trim(); });
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // ``` code block — nuốt nguyên xi cho tới ``` đóng, không diễn giải gì bên trong
      var fenceMark = /^\s*```(.*)$/.exec(line);
      if (fence) {
        if (fenceMark) { out.push(codeBlock(fence.join("\n"))); fence = null; }
        else fence.push(line);
        continue;
      }
      if (fenceMark) { closeAll(); fence = []; continue; }

      if (!line.trim()) { closeAll(); continue; }

      // | bảng | — dòng gạch ngăn (|---|---|) chỉ là trang trí, bỏ qua
      if (/^\s*\|.*\|\s*$/.test(line)) {
        closePara(); closeList(); closeQuote();
        if (!table) { table = { head: cells(line), rows: [] }; continue; }
        if (/^[\s|:-]+$/.test(line)) continue;
        table.rows.push(cells(line));
        continue;
      }
      closeTable();

      var head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        closeAll();
        var lvl = Math.min(head[1].length, 3);
        out.push('<h4 class="md-h md-h' + lvl + '">' + take() + inline(head[2]) + "</h4>");
        continue;
      }

      if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) { closeAll(); out.push('<hr class="md-hr">'); continue; }

      var quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        closePara(); closeList();
        if (!quoteBuf) quoteBuf = [];
        quoteBuf.push(quote[1]);
        continue;
      }
      closeQuote();

      var bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
      var number = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
      if (bullet || number) {
        closePara();
        var tag = bullet ? "ul" : "ol";
        var body = bullet ? bullet[2] : number[3];
        var indent = (bullet ? bullet[1] : number[1]).length;
        // Thụt lề sâu hơn mục trước = mục con. Chỉ đỡ MỘT tầng lồng — sâu hơn nữa thì gộp vào
        // tầng 2, vì message trên board không phải chỗ để dựng cây mục lục.
        if (list && indent > list.indent && list.items.length) {
          var last = list.items[list.items.length - 1];
          if (!last.sub) last.sub = { tag: tag, items: [] };
          last.sub.items.push(inline(body));
          continue;
        }
        if (list && list.tag !== tag) closeList();
        if (!list) list = { tag: tag, items: [], indent: indent };
        list.items.push({ html: take() + inline(body), sub: null });
        continue;
      }

      // Dòng thường ngay sau một mục list (không có dòng trống ở giữa) = phần nối tiếp của
      // CHÍNH mục đó, không phải đoạn văn mới — agent hay bẻ câu dài trong một bullet xuống
      // dòng tiếp theo (thụt lề hoặc không), giống hệt kiểu "lazy continuation" của markdown
      // chuẩn. Thiếu chỗ này thì câu bị cắt cụt giữa chừng và phần còn lại rơi ra ngoài list
      // thành một đoạn mồ côi (chung gốc với bug blockquote).
      if (list && list.items.length) {
        var lastItem = list.items[list.items.length - 1];
        if (lastItem.sub && lastItem.sub.items.length) {
          var subI = lastItem.sub.items.length - 1;
          lastItem.sub.items[subI] += " " + inline(line.trim());
        } else {
          lastItem.html += " " + inline(line.trim());
        }
        continue;
      }
      closeList();
      para.push(line.trim());
    }
    if (fence) out.push(codeBlock(fence.join("\n")));
    closeAll();

    // Message rỗng vẫn phải nuốt được chip người nhận, nếu không nó biến mất không dấu vết.
    if (!out.length && pending) out.push('<p class="md-p">' + take() + "</p>");
    return out.join("");
  }

  function extLink(href, label) {
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>";
  }

  /* Biến mã Jira và đường dẫn file trong repo thành link — chạy trên chuỗi ĐÃ escape.
     Thứ tự cố ý: Jira trước, đường dẫn sau (đường dẫn draft hay chứa mã issue viết thường
     nên không đụng regex Jira vốn đòi CHỮ HOA). */
  function enrich(escaped) {
    // @handle -> chip, để tag PO gõ trong comment nhìn giống chip do hệ sinh ra.
    escaped = escaped.replace(/@([a-zA-Z0-9_-]+)/g, function (whole, h) {
      var key = agentByHandle(h);
      if (!key) return whole;
      return '<span class="mention" title="' + esc(agent(key).role) + '">@' + esc(h) + "</span>";
    });
    // Mã issue -> link Jira. Board chưa khai JIRA_BASE_URL thì để nguyên chữ: đoán một domain
    // Jira nào đó rồi dựng link chết còn tệ hơn không link.
    if (JIRA_BASE) {
      escaped = escaped.replace(/\b([A-Z][A-Z0-9]+-\d+)\b/g, function (_, k) {
        return '<a href="' + JIRA_BASE + k + '" target="_blank" rel="noopener noreferrer">' + k + "</a>";
      });
    }
    if (!repoPathRe) return escaped;
    return escaped.replace(repoPathRe, function (_, p) {
      return '<a href="' + REPO_BASE + p + '" target="_blank" rel="noopener noreferrer">' + p + "</a>";
    });
  }

  /* Tách URL ra TRƯỚC khi escape để dấu & trong query không bị biến thành &amp; trong href. */
  function linkify(raw) {
    var out = "", re = /(https?:\/\/[^\s<>"')\]]+)/g, last = 0, m;
    while ((m = re.exec(raw)) !== null) {
      out += enrich(esc(raw.slice(last, m.index)));
      var url = m[1].replace(/[.,;:!?]+$/, "");     // dấu câu dính đuôi không thuộc URL
      var tail = m[1].slice(url.length);
      var label = url.length > 60 ? url.slice(0, 57) + "…" : url;
      out += extLink(url, label) + esc(tail);
      last = m.index + m[1].length;
    }
    return out + enrich(esc(raw.slice(last)));
  }

  function nowLocalIso() {
    return new Date(Date.now() + 7 * 3600e3).toISOString().replace("Z", "+07:00");
  }

  function taskUrl(id) {
    return location.origin + location.pathname + "?task=" + encodeURIComponent(id);
  }

  function agent(key) {
    return (data && data.agents[key]) || { label: key, handle: key, icon: "❔", color: "#6B778C", role: key };
  }

  /* Cột `icon` trong bảng agents nhận HAI dạng:
       - emoji  ("👀")                 -> vẽ thẳng như chữ, nền là màu của agent
       - đường dẫn ảnh ("/avatars/analyst.png") -> vẽ <img> phủ kín hình tròn
     Nhờ vậy đổi avatar từng agent một được, agent nào chưa có ảnh vẫn giữ emoji.
     Ảnh dùng object-fit: cover nên ảnh không vuông vẫn tròn đẹp, chỉ bị cắt bớt hai bên. */
  function avatar(key, size) {
    var a = agent(key);
    var isImg = /^(\/|https?:)/.test(String(a.icon || ""));
    // KHÔNG dùng title: tooltip mặc định của hệ điều hành sẽ bật lên đè ngay trên thẻ hồ sơ.
    // aria-label giữ lại cho trình đọc màn hình.
    return '<span class="avatar' + (isImg ? " avatar--img" : "") + '" style="--avatar-size:' +
      size + 'px;--avatar-color:' + esc(a.color) + '" data-agent="' + esc(key) +
      '" aria-label="' + esc(a.label) + " · " + esc(a.role) + '">' +
      (isImg
        // draggable="false": <img> mặc định draggable=true trong mọi trình duyệt — nằm trong
        // stepTracker() ở đáy MỌI card, đúng chỗ tay hay đặt xuống để bắt đầu kéo cả card. Không
        // tắt cờ này thì trình duyệt bắt ảnh làm nguồn kéo (kéo-thả ảnh ra ngoài trang) thay vì
        // nổi bọt lên pointerdown của .card cha — kéo-thả đổi status coi như chết ngay từ điểm
        // chạm phổ biến nhất trên card.
        ? '<img src="' + esc(a.icon) + '" alt="' + esc(a.label) + '" loading="lazy" draggable="false">'
        : a.icon) +
      "</span>";
  }

  function mentionChip(key) {
    var a = agent(key);
    return '<span class="mention" title="' + esc(a.role) + '">@' + esc(a.handle) + "</span>";
  }

  function statusLozenge(status) {
    var meta = STATUS_META[status] || STATUS_META["new"];
    return '<span class="lozenge lozenge--' + meta.lozenge + '">' + meta.label.toUpperCase() + "</span>";
  }

  /* Doi trang thai card ngay trong popup — dat o dung cho Jira dat no (canh tieu de), va la
     duong DUY NHAT de PO tu keo mot card sang Done. Truoc do chi agent moi doi duoc trang thai
     (patch_task), nen viec nao agent quen danh dau xong se nam lai In Progress mai mai. */
  function statusSelect(task) {
    var meta = STATUS_META[task.status] || STATUS_META["new"];
    return '<select class="status-select status-select--' + meta.lozenge +
      '" data-setstatus="' + esc(task.id) + '" aria-label="Change status">' +
      STATUS_ORDER.map(function (k) {
        return '<option value="' + k + '"' + (k === task.status ? " selected" : "") + ">" +
          esc(STATUS_META[k].label.toUpperCase()) + "</option>";
      }).join("") + "</select>";
  }

  function stepTracker(task, size) {
    var currentIdx = task.pipeline.indexOf(task.current_step);
    return task.pipeline.map(function (stepKey, i) {
      var state = stepKey === task.current_step ? "current" : (i < currentIdx ? "done" : "pending");
      return '<span class="tracker-step tracker-step--' + state + '">' + avatar(stepKey, size) + "</span>";
    }).join('<span class="tracker-sep" aria-hidden="true"></span>');
  }

  /* ---------- báo hiệu trên tab trình duyệt ---------- */

  /* Favicon vẽ tại chỗ bằng SVG data URI — có chấm đỏ khi đang có việc mới, để nhận ra ngay
     cả khi tab bị thu nhỏ chỉ còn icon. */
  function setFavicon(alert) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="14" fill="#0C66E4"/>' +
      '<rect x="14" y="16" width="10" height="32" rx="3" fill="#fff" opacity=".95"/>' +
      '<rect x="27" y="16" width="10" height="22" rx="3" fill="#fff" opacity=".75"/>' +
      '<rect x="40" y="16" width="10" height="27" rx="3" fill="#fff" opacity=".55"/>' +
      (alert ? '<circle cx="50" cy="16" r="13" fill="#E34935" stroke="#fff" stroke-width="3"/>' : "") +
      "</svg>";
    var link = document.getElementById("favicon");
    if (!link) {
      link = document.createElement("link");
      link.id = "favicon";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function setAttention(n) {
    unseen = n;
    document.title = n > 0 ? "(" + n + ") " + BASE_TITLE : BASE_TITLE;
    setFavicon(n > 0);
  }

  // Phải dùng msgCount chứ không phải messages.length: card Done về rỗng, chỉ có message_count.
  // Đếm messages.length thì agent ghi thêm vào card Done sẽ không bao giờ báo lên tab.
  function countMessages(board) {
    return board.tasks.reduce(function (sum, t) { return sum + msgCount(t); }, 0);
  }

  /* ---------- gọi API ---------- */

  function setSync(state, text) {
    var el = document.getElementById("sync-dot");
    if (!el) return;
    el.dataset.state = state;
    el.textContent = text;
  }

  async function api(path, options) {
    options = options || {};
    // Upload file (FormData): KHÔNG tự ép content-type json — trình duyệt phải tự đặt
    // multipart/form-data kèm boundary đúng, ép tay là hỏng ngay phần parse phía Worker.
    var headers = options.body instanceof FormData ? {} : { "content-type": "application/json" };
    var res = await fetch(path, Object.assign({ headers: headers }, options));
    if (res.status === 401) { window.location.href = "/login"; throw new Error("not signed in"); }
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }

  /* Bản board mới trả về card Done với messages RỖNG (xem loadBoard). Gán thẳng `data = next` là
     hội thoại vừa tải xong biến mất ngay trước mắt — đang đọc card Done thì sau ~15 giây nó
     nhảy về "Đang tải hội thoại…" và nằm im ở đó, vì ensureMessages chỉ chạy lúc MỞ card.
     Nên: chép lại phần đã tải, nhưng CHỈ KHI cả id message cuối LẪN updated_at của task vẫn
     khớp — lệch cái nào cũng phải để rỗng cho ensureMessages tải bản mới.
     (PO báo.)

     ⚠️ Riêng so `last_message_id` KHÔNG đủ (sự cố thật): react()/approve() sửa
     message CÓ SẴN chứ không tạo message mới, nên last_message_id đứng yên dù server đã đổi
     thật — PO comment vào card Done, Coordinator react 👀 xong mà board không hiện gì, vì bản đã cache
     vẫn qua được phép so sánh cũ. Phải so thêm `updated_at` — API `/react` và `/approve` giờ
     bump cả nó, đúng như mọi thay đổi thật khác. */
  function keepLoadedMessages(next) {
    if (!data) return;
    var cu = {};
    data.tasks.forEach(function (t) {
      if (t.messages.length) cu[t.id] = { msgs: t.messages, updatedAt: t.updated_at };
    });
    next.tasks.forEach(function (t) {
      if (t.messages.length) return;                       // bản mới đã có sẵn, không đụng
      var truoc = cu[t.id];
      if (!truoc) return;
      if (truoc.msgs[truoc.msgs.length - 1].id !== (t.last_message_id || 0)) return;
      if (truoc.updatedAt !== t.updated_at) return;
      t.messages = truoc.msgs;
    });
  }

  async function refresh(showSpinner) {
    if (showSpinner) setSync("loading", "loading…");
    var mySeq = ++refreshSeq;
    try {
      var next = await api("/api/board" + (showArchived ? "?archived=1" : ""));
      // Đã có lượt refresh MỚI HƠN được gọi trong lúc mình đang chờ mạng — bỏ kết quả này, đừng
      // để bản cũ đè lên bản mới hơn (xem giải thích ở khai báo refreshSeq).
      if (mySeq !== refreshSeq) return;
      var snapshot = JSON.stringify(next);
      // Không có gì đổi thì TUYỆT ĐỐI không render lại. Trước đây cứ 15s là dựng lại toàn bộ DOM,
      // popup bị tạo mới nên đang đọc comment dài thì bị giật về đầu trang (PO báo).
      if (snapshot === lastSnapshot) {
        setSync("ok", "updated " + fmtTime(nowLocalIso()));
        return;
      }
      lastSnapshot = snapshot;

      // Có message mới trong lúc tab ẩn -> cộng dồn vào chỉ báo trên tab.
      var count = countMessages(next);
      if (lastMsgCount !== null && count > lastMsgCount && document.hidden) {
        setAttention(unseen + (count - lastMsgCount));
      }
      lastMsgCount = count;

      keepLoadedMessages(next);
      data = next;
      // Cấu hình đi kèm mỗi lượt tải board (thay vì nhúng lúc build) để đổi BOARD_TITLE /
      // JIRA_BASE_URL trong wrangler.toml là có hiệu lực ngay, không phải build lại UI.
      applyConfig(next.config);
      render();
      // Card đang mở mà hội thoại chưa có (agent vừa ghi thêm nên bản cũ hết hạn) -> tải lại.
      if (openTaskId) ensureMessages(openTaskId);
      setSync("ok", "updated " + fmtTime(nowLocalIso()));
    } catch (err) {
      setSync("error", "failed to load");
      if (!data) {
        document.getElementById("root").innerHTML =
          '<p class="page-error">Could not load data: ' + esc(err.message) + "</p>";
      }
    }
  }

  /* ---------- render ---------- */

  function fmtBytes(n) {
    if (!n) return "0 B";
    var units = ["B", "KB", "MB", "GB"];
    var i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    var v = n / Math.pow(1024, i);
    return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + " " + units[i];
  }

  // Key có dạng "taskId/uuid-tên file" — encode từng đoạn riêng, không encode cả chuỗi (nếu
  // không dấu "/" phân tách sẽ bị mã hoá luôn thành %2F, route server không khớp được nữa).
  function attachmentUrl(key) {
    return "/api/attachments/" + key.split("/").map(encodeURIComponent).join("/");
  }

  /* File ĐÃ GỬI kèm 1 message — ảnh hiện thumbnail bấm mở tab mới xem gốc, loại khác là chip
     tải về. Khác hẳn ô "chưa gửi" trong comment-form (cái đó còn nút xoá, còn cái này thì
     không — message đã gửi rồi thì không sửa lại được). */
  function attachmentsBlock(list) {
    if (!list || !list.length) return "";
    return '<div class="attachments">' + list.map(function (a) {
      var url = attachmentUrl(a.key);
      if (/^image\//.test(a.type)) {
        return '<a class="attach-img" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
          '<img src="' + esc(url) + '" alt="' + esc(a.name) + '" loading="lazy"></a>';
      }
      return '<a class="attach-chip" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
        "📎 " + esc(a.name) + '<span class="attach-size">' + fmtBytes(a.size) + "</span></a>";
    }).join("") + "</div>";
  }

  /* File "chưa gửi" — chip trong ô soạn, có nút xoá tay. Dùng chung `key` trong
     pendingAttachments để cả New task lẫn comment (mỗi task 1 key riêng, New task dùng
     NEW_TASK_ATTACH_KEY) đều thao tác đúng đúng một chỗ. */
  /* `uploading` (PO chốt) — danh sách file đang tải lên dở, hiện chip riêng có
     spinner để PO biết máy đang làm việc, không tưởng nút 📎 không phản hồi. Chỉ là state
     TRONG BỘ NHỚ của lượt chọn/thả file hiện tại (mảng do wireAttachControls() giữ qua closure),
     không lưu vào pendingAttachments — khác hẳn file đã tải xong (có key/size thật). */
  function renderPendingAttachments(pendingBox, key, uploading) {
    var list = pendingAttachments[key] || [];
    uploading = uploading || [];
    pendingBox.hidden = !list.length && !uploading.length;
    var doneHtml = list.map(function (a, i) {
      return '<span class="attach-chip attach-chip--pending">📎 ' + esc(a.name) +
        '<span class="attach-size">' + fmtBytes(a.size) + "</span>" +
        '<button type="button" class="attach-chip-remove" data-remove-attach="' + i +
        '" aria-label="Remove ' + esc(a.name) + '">✕</button></span>';
    }).join("");
    var uploadingHtml = uploading.map(function (f) {
      return '<span class="attach-chip attach-chip--uploading">' +
        '<span class="attach-spinner" aria-hidden="true"></span>' + esc(f.name) +
        '<span class="attach-size">uploading…</span></span>';
    }).join("");
    pendingBox.innerHTML = doneHtml + uploadingHtml;
  }

  /* Gắn nút 📎 + input file ẩn + danh sách chip "chưa gửi" cho MỘT ô soạn — dùng chung giữa
     comment-form (key = taskId) và form New task (key = NEW_TASK_ATTACH_KEY, vì lúc PO chọn
     file thì task CHƯA tồn tại). Tải lên NGAY lúc chọn (không đợi bấm Send/Run now) để PO thấy
     rõ file nào đã lên thành công trước khi gửi cả message. */
  function wireAttachControls(container, key) {
    var attachBtn = container.querySelector(".comment-attach-btn");
    var attachInput = container.querySelector(".comment-attach-input");
    var pendingBox = container.querySelector(".comment-pending-attachments");
    if (!attachBtn || !attachInput || !pendingBox) return;

    var uploading = [];   // file đang tải dở của RIÊNG lượt chọn/thả này — xem renderPendingAttachments()
    renderPendingAttachments(pendingBox, key);   // giữ hiện lại nếu render() vừa chạy lại giữa chừng

    // Dùng chung cho cả chọn qua nút 📎 lẫn kéo-thả — một chỗ, không lặp logic tải lên.
    async function uploadFiles(files) {
      if (!files.length) return;
      attachBtn.disabled = true;
      files.forEach(function (f) { uploading.push({ name: f.name }); });
      renderPendingAttachments(pendingBox, key, uploading);
      for (var i = 0; i < files.length; i++) {
        var fd = new FormData();
        fd.append("file", files[i]);
        try {
          var meta = await api("/api/attachments", { method: "POST", body: fd });
          if (!pendingAttachments[key]) pendingAttachments[key] = [];
          pendingAttachments[key].push(meta);
        } catch (err) {
          setSync("error", "attach \"" + files[i].name + "\" failed: " + err.message);
        }
        uploading.shift();   // xong (dù thành hay bại) thì bớt 1 khỏi hàng chờ, đúng thứ tự đã gửi
        renderPendingAttachments(pendingBox, key, uploading);
      }
      attachBtn.disabled = false;
    }

    attachBtn.addEventListener("click", function () { attachInput.click(); });

    attachInput.addEventListener("change", function () {
      var files = Array.prototype.slice.call(attachInput.files || []);
      attachInput.value = "";   // cho chọn lại đúng file đó lần sau nếu cần (vd lỡ bấm xoá)
      uploadFiles(files);
    });

    pendingBox.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-remove-attach]");
      if (!btn) return;
      (pendingAttachments[key] || []).splice(Number(btn.dataset.removeAttach), 1);
      renderPendingAttachments(pendingBox, key, uploading);
    });

    // Kéo-thả ảnh/file thẳng vào ô soạn (PO chốt) — nghe trên chính ô nhập chữ, không
    // phải cả form, để không bắt nhầm lúc PO kéo qua nút Send/Run now. `.comment-editor` là ô
    // reply trong card; New task chỉ có `.field--chat` (không có lớp highlight mirror của reply).
    var dropZone = container.querySelector(".comment-editor") || container.querySelector(".field--chat");
    if (dropZone) {
      ["dragenter", "dragover"].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) {
          e.preventDefault();
          dropZone.classList.add("is-dragover");
        });
      });
      ["dragleave", "dragend"].forEach(function (evt) {
        dropZone.addEventListener(evt, function () { dropZone.classList.remove("is-dragover"); });
      });
      dropZone.addEventListener("drop", function (e) {
        e.preventDefault();
        dropZone.classList.remove("is-dragover");
        uploadFiles(Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []));
      });

      // Ctrl+V dán ảnh chụp màn hình thẳng vào ô soạn (PO yêu cầu) — nghe "paste" trên
      // cùng dropZone vì event này nổi bọt lên từ textarea. Chỉ preventDefault khi thật sự có file
      // đính kèm trong clipboard, để dán TEXT bình thường (copy code, link...) không bị chặn.
      dropZone.addEventListener("paste", function (e) {
        var items = (e.clipboardData && e.clipboardData.items) || [];
        var files = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file") {
            var f = items[i].getAsFile();
            if (f) files.push(f);
          }
        }
        if (!files.length) return;
        e.preventDefault();
        uploadFiles(files);
      });
    }
  }

  function approvalBlock(msg, taskId) {
    if (!msg.needs_approval) return "";
    if (msg.approved) {
      return '<span class="lozenge lozenge--success lozenge--sm">✓ Approved · ' + fmtTime(msg.approved_at) + "</span>";
    }
    return '<div class="approve-row"><span class="lozenge lozenge--waiting lozenge--sm">Needs review</span>' +
      '<button class="btn btn--approve" data-approve="' + msg.id + '" data-task="' + esc(taskId) +
      '">Approve &amp; continue</button></div>';
  }

  function commentCard(msg, taskId) {
    // Tin của PO lệch phải, giống khung chat — PO chốt. Agent (Coordinator/Analyst/...) giữ
    // nguyên bên trái để nhìn cái biết ngay ai đang nói, không phải đọc tên mới rõ.
    var mine = msg.from === "po";
    return '<li class="comment' + (mine ? " comment--mine" : "") + '">' + avatar(msg.from, 32) +
      '<div class="comment-body"><div class="comment-head">' +
      '<span class="comment-author">' + esc(agent(msg.from).label) + "</span>" +
      '<time class="comment-time" datetime="' + esc(msg.at) + '">' + fmtTime(msg.at) + "</time>" +
      "</div>" +
      // PO tự gõ @tag trong text rồi thì không lặp thêm chip người nhận ở đầu nữa.
      '<div class="comment-text md">' +
      richText(msg.text, /^\s*@[a-zA-Z0-9_-]+/.test(msg.text) ? "" : mentionChip(msg.to)) +
      "</div>" +
      attachmentsBlock(msg.attachments) +
      reactionRow(msg) + approvalBlock(msg, taskId) +
      // Reply nằm DƯỚI comment, không phải trên đầu cạnh giờ (PO chốt) — tag sẵn
      // @handle của agent này, không hiện ở tin của chính PO vì tự trả lời mình không có nghĩa.
      (mine ? "" : '<div class="comment-actions">' +
        '<button type="button" class="btn btn--subtle btn--tiny comment-reply" ' +
        'data-reply="' + esc(msg.from) + '">↩ Reply</button></div>') +
      "</div></li>";
  }

  /* Link thread Slack nguồn. Ưu tiên field slack_url do agent đặt; chưa có thì tự dò URL Slack
     đầu tiên trong nội dung message — nhờ vậy task cũ (PO dán link vào lời nhắn) vẫn có link
     mà không phải backfill dữ liệu. */
  function slackLink(task) {
    var url = task.slack_url;
    if (!url) {
      for (var i = 0; i < task.messages.length && !url; i++) {
        var m = /https:\/\/[a-z0-9-]+\.slack\.com\/[^\s<>"')\]]+/i.exec(task.messages[i].text || "");
        if (m) url = m[0];
      }
    }
    return url ? extLink(url, "Open thread") : "—";
  }

  function sidebarField(label, valueHtml) {
    return '<div class="detail-field"><span class="detail-label">' + esc(label) +
      '</span><div class="detail-value">' + valueHtml + "</div></div>";
  }

  /* Tắt/bật lại cảnh báo "cần PO" cho task này. Tắt = ghi mốc message hiện tại; bật lại = xoá
     mốc. Không có nút "tắt vĩnh viễn" — cố ý, vì task nào cũng có thể phát sinh việc mới. */
  function alertToggle(task) {
    var id = esc(task.id);
    // Card Done không còn alert để mà tắt/bật — nút này chỉ là nhiễu.
    if (task.status === "done") return "";
    if (needsPo(task)) {
      return '<button class="btn btn--subtle btn--tiny alert-toggle" data-mute="' + id +
        '" data-upto="' + lastMsgId(task) + '" title="Ẩn cảnh báo cho tới khi có việc mới">' +
        "🔕 Dismiss alert</button>";
    }
    if (task.alerts_cleared_id) {
      return '<button class="btn btn--subtle btn--tiny alert-toggle" data-unmute="' + id +
        '" title="Hiện lại cảnh báo">🔔 Alert dismissed</button>';
    }
    return "";
  }

  /* Giao/hẹn giờ cho card ĐÃ TẠO — cùng 2 lựa chọn như lúc tạo mới, nhưng dùng được về sau
     (vd card nằm To Do mấy hôm rồi giờ mới muốn chạy). */
  /* Trình duyệt Chrome dành cho card này. Lưu TÊN chứ không phải deviceId — deviceId đổi khi
     cài lại extension, tên do PO đặt thì bền. Để TRỐNG là card KHÔNG được cấp Claude in Chrome:
     agent runner chỉ truyền cờ --chrome khi ô này có giá trị, nên đó là hàng rào thật chứ không
     phải luật suông trong file skill. */
  function browserField(task) {
    var list = (data.browsers || []);
    if (!list.length) {
      return '<span class="detail-none">chưa khai báo trình duyệt nào</span>';
    }
    var co = list.some(function (b) { return b.label === task.browser; });
    return '<select class="browser-select" data-browser="' + esc(task.id) + '">' +
      '<option value=""' + (task.browser ? "" : " selected") + ">none — no browser access</option>" +
      list.map(function (b) {
        // Ghi chú (vd "Việc changelog LUÔN dùng cái này") hiện ngay trong dropdown — quy tắc
        // nằm ở chỗ phải quyết định thì mới có tác dụng.
        return '<option value="' + esc(b.label) + '"' +
          (b.label === task.browser ? " selected" : "") + ">" + esc(b.label) +
          (b.note ? " — " + esc(b.note) : "") + "</option>";
      }).join("") +
      // Nhãn cũ không còn trong bảng (PO đổi tên/gỡ máy) vẫn phải hiện, nếu không nó biến mất
      // im lặng và card tưởng như chưa gán trình duyệt.
      (task.browser && !co
        ? '<option value="' + esc(task.browser) + '" selected>' + esc(task.browser) +
          " (không còn trong danh sách)</option>"
        : "") +
      "</select>";
  }

  function runZone(task) {
    var id = esc(task.id);
    return '<div class="run-zone"><span class="detail-label">Run</span>' +
      (task.run_at
        ? '<p class="run-scheduled">⏰ Scheduled for <strong>' + fmtTime(task.run_at) + "</strong>" +
          ' <button class="btn btn--subtle btn--tiny" data-unschedule="' + id + '">Cancel</button></p>'
        : "") +
      // Hai hàng riêng: "Run now" là một hành động trọn vẹn, còn ô ngày chỉ thuộc về "Schedule".
      // Để chung một hàng thì ô ngày trông như cũng áp cho Run now (PO báo).
      '<div class="run-row">' +
      '<button class="btn btn--primary btn--tiny" data-runnow="' + id + '">Run now</button>' +
      '<span class="run-row-note">hand it to Coordinator right away</span></div>' +
      '<div class="run-row run-row--schedule">' +
      '<input type="datetime-local" class="run-at run-at-existing" aria-label="Schedule this card">' +
      '<button class="btn btn--tiny" data-schedule="' + id + '">Schedule</button>' +
      "</div>" +
      "</div>";
  }

  /* PO sửa lại description ngay trên card — gõ nhầm hoặc muốn bổ sung sau khi tạo, khỏi phải
     xoá card làm lại. Sửa message[0] (kind="request") qua PATCH /api/messages/:id, endpoint
     đó CHỈ nhận cookie phiên PO nên agent (bearer token) không tự đè lên yêu cầu gốc được. */
  function descriptionEditForm(taskId, description) {
    return '<form class="desc-edit-form" data-descedit="' + esc(taskId) +
      '" data-msgid="' + esc(description.id) + '">' +
      '<div class="field"><textarea class="desc-edit-input" rows="8" required>' +
      esc(description.text) + "</textarea></div>" +
      '<div class="desc-edit-actions">' +
      '<button type="submit" class="btn btn--primary btn--tiny">Save</button>' +
      '<button type="button" class="btn btn--subtle btn--tiny" data-canceledit>Cancel</button>' +
      "</div></form>";
  }

  /* PO sửa lại title ngay trên card — dùng để tự đổi tên, hoặc sửa tên Coordinator đặt hộ chưa ưng.
     PATCH /api/tasks/:id đã nhận `title` từ trước (dùng chung với patch-task --title), không
     cần thêm gì phía server. */
  function titleEditForm(task) {
    return '<form class="title-edit-form" data-titleedit="' + esc(task.id) + '">' +
      '<input type="text" class="title-edit-input" maxlength="160" value="' + esc(task.title) +
      '" required>' +
      '<button type="submit" class="btn btn--primary btn--tiny">Save</button>' +
      '<button type="button" class="btn btn--subtle btn--tiny" data-canceltitleedit>Cancel</button>' +
      "</form>";
  }

  /* Dòng trạng thái sống của lượt chạy đang diễn ra. agent runner dịch từ luồng sự kiện của
     claude -p rồi ghi vào task.progress mỗi vài giây; rỗng = không có lượt nào đang chạy.
     Đã đo: trung vị một lượt là 193 giây, 12/14 lượt trên 60 giây — suốt từng ấy thời
     gian tín hiệu duy nhất là reaction 👀, nên không cách nào biết nó đang làm gì hay đã treo. */
  function progressBar(task) {
    if (!task.progress) return "";
    return '<div class="progress-live"><span class="progress-dot"></span>' +
      '<span class="progress-text">' + esc(task.progress) + "</span></div>";
  }

  function taskModal(task) {
    // Card Done: message chưa về (ensureMessages đang tải). Phải nói rõ ĐANG TẢI — để nguyên
    // "chưa agent nào làm gì" thì PO tưởng card rỗng thật.
    var pending = !task.messages.length && msgCount(task) > 0;
    var description = task.messages[0];
    var comments = task.messages.slice(1);
    var current = task.status === "done"
      ? '<span class="detail-done">Completed</span>'
      : avatar(task.current_step, 22) + " " + esc(agent(task.current_step).label);

    return '<dialog id="modal-' + esc(task.id) + '" class="modal" aria-labelledby="mt-' + esc(task.id) + '">' +
      '<div class="modal-panel"><header class="modal-header"><div class="modal-header-top">' +
      '<span class="issue-key">' + (task.demo ? "🧪 " : "") +
      '<code class="task-code">' + esc(task.id) + "</code>" +
      '<button class="btn btn--subtle btn--copy" data-copy="' + esc(taskUrl(task.id)) +
      '" title="Copy link to this card">🔗 Copy link</button></span>' +
      '<button class="modal-close" data-close aria-label="Close">✕</button></div>' +
      '<div class="modal-title-row">' +
      (editingTitleTask === task.id
        ? titleEditForm(task)
        : '<h2 id="mt-' + esc(task.id) + '" class="modal-title">' + esc(task.title) + "</h2>" +
          '<button type="button" class="btn btn--subtle btn--tiny" data-edittitle="' +
          esc(task.id) + '">✏️ Edit</button>') +
      "</div>" +
      progressBar(task) + "</header>" +
      '<div class="modal-body"><div class="modal-main">' +
      '<section class="section"><h3 class="section-title">Description' +
      (description && editingDescTask !== task.id
        ? '<button type="button" class="btn btn--subtle btn--tiny" data-editdesc="' +
          esc(task.id) + '">✏️ Edit</button>'
        : "") +
      "</h3>" +
      (description && editingDescTask === task.id
        ? descriptionEditForm(task.id, description)
        : description
        ? '<p class="description-meta">Reported by ' + avatar(description.from, 22) + " <strong>" +
          esc(agent(description.from).label) + "</strong> · " + fmtTime(description.at) + "</p>" +
          '<div class="description-text md">' +
          (description.text.trim()
            ? richText(description.text)
            : '<p class="md-p description-empty">No description yet — click Edit to add one.</p>') +
          "</div>" +
          // Message ĐẦU TIÊN vẽ ở đây chứ không qua commentCard, nên phải tự gọi
          // attachmentsBlock/reactionRow riêng — thiếu dòng reaction thì reaction Coordinator đặt lên
          // chính tin PO giao việc là vô hình (PO báo "không thấy reaction").
          attachmentsBlock(description.attachments) +
          reactionRow(description)
        : '<div class="description-text md"><p class="md-p">' +
          (pending ? "Đang tải hội thoại…" : "—") + "</p></div>") +
      "</section>" +
      (function () {
        // Comment cũ gấp lại khi quá dài — giữ lại COMMENTS_SHOWN cái GẦN NHẤT (đúng phần PO
        // hay cần đọc/scroll-to-bottom tới), phần cũ hơn phía trên ẩn sau nút bấm.
        var totalComments = comments.length;
        var hiddenComments = 0;
        var shown = comments;
        if (!expandedComments[task.id] && totalComments > COMMENTS_SHOWN) {
          hiddenComments = totalComments - COMMENTS_SHOWN;
          shown = comments.slice(hiddenComments);
        }
        return '<section class="section"><h3 class="section-title">Activity <span class="count-pill">' +
          (pending ? Math.max(msgCount(task) - 1, 0) : totalComments) +
          '</span></h3>' +
          (hiddenComments
            ? '<button type="button" class="btn btn--subtle btn--tiny comment-more" data-showmore-comments="' +
              esc(task.id) + '">Show ' + hiddenComments + ' earlier</button>'
            : "") +
          '<ul class="comment-list">' +
          (shown.length ? shown.map(function (m) { return commentCard(m, task.id); }).join("")
            : '<li class="empty-state">' +
              (pending ? "Đang tải hội thoại…" : "No agent has worked on this yet.") + "</li>") +
          "</ul></section>";
      })() + commentForm(task) + "</div>" +
      '<aside class="modal-sidebar">' +
      detailsOpenTag(task.id) + '<summary class="section-title">Details</summary>' +
      sidebarField("Status", statusSelect(task) + alertToggle(task)) +
      sidebarField("Assignee", current) +
      sidebarField("Slack thread", slackLink(task)) +
      sidebarField("Jira key", task.jira_key
        ? (task.demo || !JIRA_BASE
            ? '<span class="jira-link">' + esc(task.jira_key) + "</span>"
            : extLink(JIRA_BASE + task.jira_key, task.jira_key))
        : "—") +
      sidebarField("Browser", browserField(task)) +
      sidebarField("Created", fmtTime(task.created_at)) +
      sidebarField("Updated", fmtTime(task.updated_at)) +
      sidebarField("Pipeline", '<div class="tracker tracker--sidebar">' + stepTracker(task, 22) + "</div>") +
      runZone(task) +
      '<div class="danger-zone">' +
      '<button class="btn btn--danger" data-delete="' + esc(task.id) + '">Delete card</button>' +
      '<p class="danger-note" hidden>Deletes the card and its whole conversation. <strong>Cannot be undone.</strong></p>' +
      "</div>" +
      "</details></aside></div></div></dialog>";
  }

  /* Mở tag <details> cho sidebar — gấp lại được trên mobile (PO chốt: 2 cột dồn còn
     1 dưới 640px thì Details dài lòi ra trước khi PO chạm tới Description/Activity). PO đã bấm
     mở/gấp tay thì theo đúng ý đó (sidebarExpanded); chưa bấm gì thì mặc định gấp trên mobile,
     mở trên desktop — desktop còn bị khoá click qua CSS (@media trong extra.css) nên coi như
     luôn mở, không ai cần gấp ở đó. */
  function detailsOpenTag(taskId) {
    var open = sidebarExpanded.hasOwnProperty(taskId)
      ? sidebarExpanded[taskId]
      : !(window.matchMedia && window.matchMedia("(max-width: 640px)").matches);
    return '<details class="sidebar-details" data-task="' + esc(taskId) + '"' + (open ? " open" : "") + ">";
  }

  /* Ô comment: PO nhắn thẳng cho agent ngay trong card, không phải mở Slack.
     Gửi lên với kind="comment" — Coordinator lọc đúng kind này để biết đây là việc PO vừa giao qua
     board (khác "request" vốn do chính Coordinator ghi lúc tạo task, nếu không sẽ bị xử lý 2 lần). */
  /* Handle -> agent key, để đọc được @analyst / @reporter / @planner... PO gõ trong comment. */
  function agentByHandle(handle) {
    var want = String(handle || "").toLowerCase();
    var found = null;
    Object.keys(data.agents).forEach(function (k) {
      if (!found && String(data.agents[k].handle).toLowerCase() === want) found = k;
    });
    return found;
  }

  /* @tag đầu tiên trong comment quyết định ai nhận; không tag ai thì mặc định Coordinator điều phối. */
  function parseTarget(text) {
    var m = /@([a-zA-Z0-9_-]+)/.exec(text || "");
    return (m && agentByHandle(m[1])) || "coordinator";
  }

  function commentForm(task) {
    var handles = Object.keys(data.agents)
      .filter(function (k) { return k !== "po"; })
      .map(function (k) { return "@" + data.agents[k].handle; }).join(" · ");

    // Cặp nút cuộn nhanh nằm TRONG form: form đã sticky sẵn nên hai nút bám theo mà không tốn
    // thêm dòng chiều cao nào của vùng đọc. Đặt tuyệt đối so với form, nhô lên phía trên nó.
    return '<form class="comment-form" data-task="' + esc(task.id) + '">' +
      '<div class="scroll-nav" hidden>' +
      '<button type="button" class="scroll-btn" data-scroll="top" title="Lên đầu" aria-label="Scroll to top">↑</button>' +
      '<button type="button" class="scroll-btn" data-scroll="bottom" title="Xuống cuối" aria-label="Scroll to bottom">↓</button>' +
      "</div>" +
      // Textarea trong suốt nằm ĐÈ lên một lớp "gương" cùng font/cùng padding: lớp gương vẽ ô
      // nền cho @tag hợp lệ, textarea giữ nguyên caret/undo/bàn phím ảo của trình duyệt.
      '<div class="comment-editor">' +
      '<div class="comment-highlight" aria-hidden="true"></div>' +
      // Không "required" nữa (PO chốt): chỉ gửi kèm file, không chữ, là hợp lệ —
      // JS tự kiểm ở submit (text rỗng NHƯNG có attachment vẫn cho gửi).
      '<textarea class="comment-input" rows="2" ' +
      'placeholder="Message an agent… type @ to tag one directly, or leave untagged for Coordinator to route."></textarea>' +
      '<ul class="mention-menu" hidden></ul>' +
      "</div>" +
      // File đã tải lên nhưng chưa gửi kèm comment — trống/ẩn tới khi PO chọn file, JS tự đổ
      // nội dung (renderPendingAttachments() trong wire()), không dựng sẵn ở đây vì đây là state
      // thuần client (PO chọn rồi bỏ tuỳ ý trước khi bấm gửi).
      '<div class="comment-pending-attachments" hidden></div>' +
      '<div class="comment-form-actions">' +
      '<span class="comment-form-hint">' + esc(handles) + "</span>" +
      '<span class="comment-form-msg"></span>' +
      '<button type="button" class="btn btn--subtle comment-attach-btn" title="Attach file">📎</button>' +
      '<input type="file" class="comment-attach-input" multiple hidden>' +
      '<button type="submit" class="btn btn--primary comment-send">Send</button></div></form>';
  }

  /* ---------- ô soạn comment: gợi ý @ + highlight tag hợp lệ ---------- */

  // Chỉ tô những @tag khớp handle thật — tag sai chính tả KHÔNG được tô, đó là tín hiệu cho PO
  // biết ngay là chưa gán đúng ai.
  function highlightHtml(text) {
    return esc(text).replace(/@([a-zA-Z0-9_-]+)/g, function (whole, h) {
      return agentByHandle(h) ? '<mark class="mention-hit">' + whole + "</mark>" : whole;
    }) + " ";   // khoảng trắng đuôi giữ chiều cao khi text kết thúc bằng xuống dòng
  }

  // @tag đang gõ dở ngay tại vị trí con trỏ (nếu có).
  function activeMention(box) {
    var before = box.value.slice(0, box.selectionStart);
    var m = /@([a-zA-Z0-9_-]*)$/.exec(before);
    return m ? { start: before.length - m[0].length, query: m[1].toLowerCase() } : null;
  }

  function matchAgents(query) {
    return Object.keys(data.agents).filter(function (k) {
      if (k === "po") return false;
      var a = data.agents[k];
      return !query || a.handle.toLowerCase().indexOf(query) === 0 ||
        a.label.toLowerCase().indexOf(query) === 0;
    });
  }

  function wireCommentEditor(form) {
    var box = form.querySelector(".comment-input");
    var mirror = form.querySelector(".comment-highlight");
    var menu = form.querySelector(".mention-menu");
    var keys = [], sel = 0;

    function paint() {
      mirror.innerHTML = highlightHtml(box.value);
      mirror.scrollTop = box.scrollTop;
    }

    function closeMenu() { menu.hidden = true; keys = []; sel = 0; }

    function openMenu() {
      var mention = activeMention(box);
      if (!mention) return closeMenu();
      keys = matchAgents(mention.query);
      if (!keys.length) return closeMenu();
      sel = Math.min(sel, keys.length - 1);
      menu.innerHTML = keys.map(function (k, i) {
        var a = data.agents[k];
        return '<li class="mention-item' + (i === sel ? " is-sel" : "") + '" data-key="' + esc(k) + '">' +
          avatar(k, 20) + '<span class="mention-item-handle">@' + esc(a.handle) + "</span>" +
          '<span class="mention-item-label">' + esc(a.label) + "</span></li>";
      }).join("");
      menu.hidden = false;
    }

    function pick(key) {
      var mention = activeMention(box);
      if (!mention) return closeMenu();
      var insert = "@" + data.agents[key].handle + " ";
      var after = box.value.slice(box.selectionStart);
      box.value = box.value.slice(0, mention.start) + insert + after;
      var caret = mention.start + insert.length;
      box.setSelectionRange(caret, caret);
      closeMenu();
      paint();
      box.focus();
    }

    // Cao 2 dòng lúc rỗng, tự giãn khi gõ dài, chặn trần để không nuốt mất vùng đọc.
    function autoGrow() {
      box.style.height = "auto";
      box.style.height = Math.min(box.scrollHeight, 150) + "px";
    }
    box.addEventListener("input", function () { paint(); openMenu(); autoGrow(); });
    box.addEventListener("scroll", function () { mirror.scrollTop = box.scrollTop; });
    box.addEventListener("blur", function () { setTimeout(closeMenu, 150); }); // kịp bắt cú click
    box.addEventListener("click", openMenu);

    box.addEventListener("keydown", function (e) {
      // Menu @mention đang mở: Enter/Tab CHỌN agent, không gửi, không xuống dòng — phải xét
      // TRƯỚC nhánh gửi bên dưới, nếu không Enter sẽ gửi luôn giữa lúc PO đang gõ dở @tag.
      if (!menu.hidden && keys.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          sel = (sel + (e.key === "ArrowDown" ? 1 : keys.length - 1)) % keys.length;
          openMenu();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          pick(keys[sel]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMenu();
          return;
        }
      }
      // Enter gửi, Shift+Enter xuống dòng — đổi từ Ctrl+Enter (PO chốt, giống khung
      // chat thường gặp thay vì phải nhớ thêm phím Ctrl).
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        closeMenu();
        form.requestSubmit ? form.requestSubmit()
          : form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }
    });

    menu.addEventListener("mousedown", function (e) {   // mousedown: chạy trước blur
      var li = e.target.closest(".mention-item");
      if (!li) return;
      e.preventDefault();
      pick(li.dataset.key);
    });

    paint();
    return { paint: paint, closeMenu: closeMenu };
  }

  function reactionRow(msg) {
    if (!msg.reactions || !msg.reactions.length) return "";
    return '<div class="reaction-row">' + msg.reactions.map(function (r) {
      var a = agent(r.agent);
      return '<span class="reaction" title="' + esc(a.label) + " · " + fmtTime(r.at) + '">' +
        r.emoji + '<span class="reaction-who">' + esc(a.label) + "</span></span>";
    }).join("") + "</div>";
  }

  /* Ghi mốc "PO đã mở card này ra đọc". Gọi khi PO BẤM MỞ card, không gọi ở mỗi lần render —
     card để mở trong tab nền thì không tính là đã đọc mọi thứ agent ghi thêm vào sau đó.
     Không có message mới hơn mốc cũ thì không gọi API, khỏi ghi thừa. */
  function markRead(taskId) {
    var task = null;
    (data && data.tasks ? data.tasks : []).forEach(function (t) { if (t.id === taskId) task = t; });
    if (!task) return;
    var last = lastMsgId(task);
    if (!last || (task.seen_upto_id || 0) >= last) return;
    task.seen_upto_id = last;   // cập nhật tại chỗ; vòng refresh kế tiếp sẽ vẽ lại không còn badge
    lastSnapshot = null;
    api("/api/tasks/" + taskId, {
      method: "PATCH", body: JSON.stringify({ seen_upto_id: last }),
    }).catch(function (err) { setSync("error", "mark read failed: " + err.message); });
  }

  /* Message MỚI NHẤT do chính PO viết. Coi như PO đã thấy hết mọi thứ trước đó — đã ngồi gõ trả
     lời rồi thì không cần cái badge nhắc "có việc chờ bạn" nữa (PO chốt). */
  function lastPoMsgId(task) {
    var id = 0;
    task.messages.forEach(function (m) { if (m.from === "po" && m.id > id) id = m.id; });
    return id;
  }

  /* Card có cần PO ra tay không. Ba tín hiệu:
     - còn message chờ duyệt (kể cả không phải message cuối — đừng để nó trôi mất khi agent
       ghi thêm note phía sau),
     - message CUỐI gửi thẳng cho PO (agent hỏi/báo và đang đợi PO trả lời),
     - card Done mà PO chưa mở ra đọc. */
  function needsPo(task) {
    var lastId = lastMsgId(task);

    /* Card Done: alert nếu PO CHƯA MỞ RA ĐỌC. Agent tự đánh Done xong là im — không có dòng này
       thì kết quả nằm đó mà PO không hề biết. Mở card ra là tự tắt (markRead), không cần bấm gì.
       PO tự tay kéo sang Done thì cũng chính là lúc đang mở card, nên không bị báo oan. */
    if (task.status === "done") {
      return lastId > (task.seen_upto_id || 0) ? "Unread" : null;
    }

    // Mốc "PO đã xem tới đây" lấy giá trị MUỘN HƠN trong hai: lần bấm tắt cảnh báo, và comment
    // gần nhất của chính PO. Chỉ bỏ qua những gì CŨ hơn mốc đó — việc mới tới sau vẫn báo.
    var cleared = Math.max(task.alerts_cleared_id || 0, lastPoMsgId(task));
    if (task.messages.some(function (m) {
      return m.needs_approval && !m.approved && m.id > cleared;
    })) return "Needs approval";

    var last = task.messages[task.messages.length - 1];
    if (last && last.to === "po" && last.from !== "po" && last.id > cleared) return "Waiting on you";
    return null;
  }

  /* Card Done về từ /api/board KHÔNG kèm message (xem loadBoard trong Worker) — nó gửi
     last_message_id thay thế. Không đọc field đó thì mọi card Done đều ra 0 và badge "Unread"
     tắt vĩnh viễn. */
  function lastMsgId(task) {
    if (task.messages.length) return task.messages[task.messages.length - 1].id;
    return task.last_message_id || 0;
  }

  function msgCount(task) {
    return task.messages.length ? task.messages.length : (task.message_count || 0);
  }

  /* Hội thoại của card Done tải riêng lúc mở. Nhét thẳng vào data rồi vẽ lại — cố ý KHÔNG giữ
     cache riêng: vòng refresh kế tiếp ghi đè data, và một cache lệch với nó là nguồn cơn của
     loại bug rất khó lần. */
  var loadingDetail = {};
  async function ensureMessages(taskId) {
    var task = null;
    (data && data.tasks ? data.tasks : []).forEach(function (t) { if (t.id === taskId) task = t; });
    if (!task || task.messages.length || !task.message_count) return;
    if (loadingDetail[taskId]) return;
    loadingDetail[taskId] = true;
    try {
      var detail = await api("/api/tasks/" + taskId);
      task.messages = detail.messages || [];
      lastSnapshot = null;
      render();
    } catch (err) {
      setSync("error", "could not load the conversation: " + err.message);
    } finally {
      delete loadingDetail[taskId];
    }
  }

  function taskCard(task) {
    var flag = needsPo(task);
    // Kéo thả đổi status — gắn pointerdown qua khối "Kéo thả card" ở wire()/module scope.
    //
    // KHÔNG dùng thẻ <button> làm nguồn kéo: hạn chế THẬT của nhiều trình duyệt với form
    // control — <button draggable="true"> tự xử lý mousedown cho trạng thái pressed/click TRƯỚC
    // khi trình duyệt kịp nhận diện cử chỉ kéo, nên hầu hết thao tác kéo chỉ ra một cú click.
    // Dùng <div role="button" tabindex="0"> — vẫn bấm mở card + điều hướng bàn phím được
    // (Enter/Space, xem keydown ở wire()), nhưng không còn là form control nên kéo hoạt động
    // đúng như div thường (cách Trello/Jira board vẫn làm). Bản thân drag cũng KHÔNG dùng HTML5
    // native draggable/dragstart nữa — tự quản lý bằng Pointer Events (pointerdown/move/up), vì
    // một số trình duyệt có bug khiến bất kỳ cách chặn "chọn chữ thay vì kéo" nào (CSS
    // user-select, JS mousedown/selectstart preventDefault) cũng làm dragstart chết hẳn, còn
    // không chặn gì thì chập chờn ăn/không. Xem chi tiết ở khối "Kéo thả card" phía trên wire().
    return '<div class="card' + (flag ? " card--needs-po" : "") + '" role="button" tabindex="0" data-open="' + esc(task.id) +
      '" data-title="' + esc(task.title.toLowerCase()) + '"><div class="card-top">' +
      (flag ? '<span class="needs-po">' + esc(flag) + "</span>" : "") +
      (task.demo ? '<span class="demo-tag">🧪 demo</span>' : "") +
      (task.jira_key ? '<span class="jira-link">' + esc(task.jira_key) + "</span>" : "") +
      '<time class="card-time" datetime="' + esc(task.updated_at) + '">' + fmtTime(task.updated_at) + "</time>" +
      '</div><h3 class="card-title">' + esc(task.title) + "</h3>" +
      progressBar(task) +
      '<div class="card-bottom"><div class="tracker">' + stepTracker(task, 22) + "</div>" +
      statusLozenge(task.status) + "</div></div>";
  }

  /* Cột Done chỉ vẽ 20 card gần nhất. Cột đã sắp theo updated_at giảm dần từ Worker nên 20 cái
     đầu đúng là mới nhất. Ba cột kia không giới hạn — việc chưa xong thì phải thấy hết. */
  var DONE_SHOWN = 20;
  var showAllDone = false;
  /* Card có hội thoại quá dài (PO chốt) — mặc định chỉ vẽ COMMENTS_SHOWN comment GẦN
     NHẤT (phần cũ hơn gấp lại phía trên, nút "Show N earlier" bung ra khi bấm), khác cột Done
     (giới hạn theo card, đây giới hạn theo message TRONG một card). Nhớ theo từng task vì PO có
     thể đang mở nhiều card, mở rộng card này không nên ảnh hưởng card khác. */
  var COMMENTS_SHOWN = 20;
  var expandedComments = {};
  /* Gấp/mở Backlog — nhớ qua các lần render lại, giống openTaskId/editingDescTask. Mặc định gấp
     (PO chốt): 43 card To Do cũ dồn vào đây, mở mặc định sẽ chiếm hết trang. Gấp lại
     KHÔNG chỉ ẩn nội dung như 4 cột kia — nó rút hẳn khỏi lưới, chỉ còn dải hẹp bên trái, để
     trang quay về đúng 4 cột To Do→Done như trước khi có Backlog (PO chốt). Xem
     backlogRail() + board-row trong render(). */
  var collapsedColumns = { backlog: true };

  /* Dải hẹp thay cho cột Backlog khi đang gấp — bấm để mở lại thành cột đầy đủ trong lưới.
     `data-status="backlog"` để cùng nhận kéo-thả như 5 cột kia — thiếu thuộc tính đó thì thả
     card vào Backlog lúc đang GẤP (mặc định) không có tác dụng gì, phải mở rộng cột ra trước. */
  function backlogRail() {
    var count = data.tasks.filter(function (t) { return t.status === "backlog"; }).length;
    return '<button type="button" class="backlog-rail" data-toggle-col="backlog" ' +
      'data-status="backlog" aria-expanded="false">' +
      '<span class="backlog-rail-arrow">▸</span>' +
      '<span class="backlog-rail-label">Backlog</span>' +
      '<span class="column-count">' + count + "</span></button>";
  }

  function column(statusKey) {
    var meta = STATUS_META[statusKey];
    var tasks = data.tasks.filter(function (t) { return t.status === statusKey; });
    var hidden = 0;
    if (statusKey === "done" && !showAllDone && tasks.length > DONE_SHOWN) {
      hidden = tasks.length - DONE_SHOWN;
      tasks = tasks.slice(0, DONE_SHOWN);
    }
    // Chỉ Backlog gấp được (thành backlogRail ở render()) — 4 cột kia luôn mở, không cần toggle.
    var toggle = statusKey === "backlog"
      ? '<button type="button" class="column-toggle" data-toggle-col="backlog" aria-expanded="true">▾</button>'
      : "";
    return '<section class="column" data-status="' + statusKey + '">' +
      '<header class="column-head">' + toggle +
      '<h2>' + meta.label + '</h2><span class="column-count">' +
      (hidden ? tasks.length + hidden : tasks.length) + "</span></header>" +
      '<div class="column-body">' +
      (tasks.length ? tasks.map(taskCard).join("") : '<p class="empty-state">' + meta.empty + "</p>") +
      (hidden
        ? '<button class="btn btn--subtle column-more" data-showall>Show ' + hidden + ' more</button>'
        : "") +
      (statusKey === "done" && showAllDone && data.tasks.filter(function (t) { return t.status === "done"; }).length > DONE_SHOWN
        ? '<button class="btn btn--subtle column-more" data-showless>Show fewer</button>'
        : "") +
      "</div></section>";
  }

  function formModalHtml() {
    return '<dialog id="new-task-modal" class="modal form-modal" aria-labelledby="new-task-title">' +
      '<div class="modal-panel"><header class="modal-header"><div class="modal-header-top">' +
      '<span class="issue-key">NEW TASK</span>' +
      '<button class="modal-close" data-close aria-label="Close">✕</button></div>' +
      '<h2 id="new-task-title" class="modal-title">Create a task</h2></header>' +
      '<form id="new-task-form">' +
      '<div class="form-body">' +
      // Một ô duy nhất, kiểu ô chat với AI — không hỏi Title (PO chốt). Coordinator đọc
      // xong tự tóm tắt tên card, dưới 10 từ (đã có sẵn trong board-pipeline SKILL.md), nên
      // bắt PO nghĩ tên trước khi kịp gõ mô tả là thừa một bước.
      '<div class="field field--chat">' +
      '<textarea id="nt-desc" name="description" rows="6" placeholder="Message Coordinator the way you would message a teammate…"></textarea>' +
      "</div>" +
      // File đính kèm ngay lúc tạo task (PO chốt) — cùng cơ chế với comment-form,
      // xem wireAttachControls(). Key riêng NEW_TASK_ATTACH_KEY vì task chưa tồn tại lúc chọn.
      '<div class="comment-pending-attachments" hidden></div>' +
      '<p class="hint" id="nt-error"></p>' +
      "</div>" +
      // Bỏ radio "When to run" (PO chốt): Run now/Later giờ LÀ hành động bấm, không
      // phải chọn rồi bấm Create riêng — Later còn kèm dropdown nhỏ (nút mũi tên bên cạnh) cho
      // ai muốn hẹn giờ thay vì tạo ngay.
      '<div class="form-actions">' +
      '<button type="button" class="btn btn--subtle comment-attach-btn" title="Attach file">📎</button>' +
      '<input type="file" class="comment-attach-input" multiple hidden>' +
      '<div class="run-split">' +
      '<button type="button" class="btn btn--subtle" id="nt-later">Later</button>' +
      '<button type="button" class="btn btn--subtle run-split-caret" id="nt-schedule-toggle" ' +
      'aria-haspopup="true" aria-expanded="false" aria-label="Schedule for later">▾</button>' +
      '<div class="run-schedule-menu" id="nt-schedule-menu" hidden>' +
      '<label class="run-schedule-label">Schedule for<input type="datetime-local" id="nt-run-at" class="run-at"></label>' +
      '<button type="button" class="btn btn--primary btn--tiny" id="nt-schedule-submit">Schedule</button>' +
      "</div>" +
      "</div>" +
      '<button type="button" class="btn btn--primary" id="nt-submit">Run now</button>' +
      "</div></form></div></dialog>";
  }

  /* Ẩn/hiện cặp nút cuộn nhanh — CHỈ đo được sau khi dialog đã showModal() (đóng thì
     scrollHeight/clientHeight luôn 0/0). Dùng chung cho 2 chỗ: render() (sau khi dựng lại DOM)
     và click mở card trong wire() (PO bấm mở card không đi qua render() ngay, showModal() chạy
     thẳng — thiếu bước đo này thì nút chỉ hiện đúng ở lần render() KẾ TIẾP, tức phải đợi tới
     poll 15s sau hoặc ensureMessages() tải xong, PO thấy nút "phải một lúc mới hiện". PO báo
     xem thêm ghi chú cũ ở chỗ gọi trong wire().) */
  function updateScrollNav(main) {
    var nav = main && main.querySelector(".scroll-nav");
    if (nav) nav.hidden = main.scrollHeight <= main.clientHeight + 8;
  }

  /* Vị trí cuộn (tuyệt đối, tính từ đỉnh khung .modal-main) của ĐẦU comment cuối cùng — dùng
     chung cho nút "↓ Scroll to bottom" LẪN việc tự bám đáy khi có comment mới (xem render()).
     getBoundingClientRect() trừ nhau ra toạ độ không phụ thuộc scrollTop hiện tại, nên gọi lúc
     nào cũng ra đúng vị trí tuyệt đối trong nội dung, không lệch theo đang cuộn tới đâu.
     PHẢI dùng combinator "> li" (con trực tiếp), không phải "li" (mọi cháu chắt) — comment nào có
     markdown dạng bullet list thì richText() cũng đẻ ra <li> lồng bên trong nó, và querySelector()
     luôn trả về khớp ĐẦU TIÊN theo thứ tự tài liệu, không phải khớp cuối cùng. PO báo:
     card sprint-cycle-178 scroll-to-bottom chỉ tới comment 07/09 19:46 — vì đó là <li> lồng trong
     nội dung markdown của một comment sớm hơn nhiều, không liên quan gì tới comment thật sự cuối. */
  function lastCommentTop(main) {
    var lastLi = main && main.querySelector(".comment-list > li:last-child");
    if (!lastLi) return main ? main.scrollHeight : 0;
    return lastLi.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 8;
  }

  /* scrollTop THẬT SỰ đạt được khi cuộn tới "đầu comment cuối" — khi đuôi thread ngắn hơn
     khung .modal-main (ít comment, hoặc mới mở task), lastCommentTop() có thể ra một số VƯỢT
     quá scrollTop tối đa cho phép, trình duyệt tự kẹp lại ở đáy thật. Không kẹp số này trước khi
     so sánh thì wasAtBottom ở render() luôn ra false trong đúng trường hợp hay gặp nhất — task
     mới mở, ít comment, còn dư khoảng trắng phía dưới. */
  function scrollBottomTarget(main) {
    var max = main.scrollHeight - main.clientHeight;
    return Math.min(lastCommentTop(main), max);
  }

  function render() {
    // Ghi lại vị trí đang đọc trong popup TRƯỚC khi đập DOM đi dựng lại.
    if (openTaskId) {
      var openMain = document.querySelector("#modal-" + CSS.escape(openTaskId) + " .modal-main");
      keptScroll = openMain ? openMain.scrollTop : 0;
      // Đang xem ĐÚNG đáy (đã ăn theo comment cuối, kể cả sát đáy vài px) thì bám đáy tiếp khi
      // có comment mới — như chat UI thường làm. Ngược lại (đang đọc giữa chừng) giữ nguyên
      // keptScroll cũ. Không dùng "gần đáy" chung chung vì còn lẫn TH đang đọc gần cuối thread dài.
      wasAtBottom = !!openMain && Math.abs(keptScroll - scrollBottomTarget(openMain)) < 4;
      // Comment đang gõ dở cũng phải chép lại TRƯỚC khi mất DOM, y hệt lý do trên.
      var openBox = document.querySelector("#modal-" + CSS.escape(openTaskId) + " .comment-input");
      if (openBox && openBox.value) {
        keptDraft = {
          text: openBox.value, selStart: openBox.selectionStart, selEnd: openBox.selectionEnd,
          focused: document.activeElement === openBox
        };
      }
    }

    var legend = Object.keys(data.agents).map(function (key) {
      return '<span class="legend-item">' + avatar(key, 20) + " " + esc(data.agents[key].label) + "</span>";
    }).join("");

    document.getElementById("root").innerHTML =
      '<div class="wrap"><div class="topbar">' +
      '<div class="topbar-left"><div>' +
      "<h1>" + esc(BASE_TITLE) + "</h1>" +
      '<p class="sub">Coordinator orchestrating agents, step by step</p></div>' +
      '<div class="legend">' + legend + "</div></div>" +
      '<span class="topbar-actions"><span class="sync-dot" id="sync-dot" data-state="ok"></span>' +
      '<a class="logout-link" href="/logout">Sign out</a></span>' +
      "</div>" +
      '<div class="toolbar">' +
      '<button class="btn btn--primary" id="new-task-btn">+ New task</button>' +
      '<input type="search" id="filter" placeholder="Filter by title or Jira key…" aria-label="Filter tasks" value="' + esc(filterText) + '">' +
      (data.archived_count
        ? '<button class="btn btn--subtle" id="archived-btn">🗄 ' + data.archived_count +
          ' archived</button>'
        : "") +
      (showArchived
        ? '<button class="btn btn--subtle" id="archived-btn">🗄 Hide archived</button>'
        : "") +
      "</div>" +
      (function () {
        var backlogCollapsed = !!collapsedColumns.backlog;
        var gridOrder = backlogCollapsed ? MAIN_STATUS_ORDER : STATUS_ORDER;
        return '<div class="board-row">' +
          (backlogCollapsed ? backlogRail() : "") +
          '<div class="board' + (backlogCollapsed ? "" : " board--5col") + '">' +
          gridOrder.map(column).join("") + "</div></div>";
      })() +
      "</div>" +
      data.tasks.map(taskModal).join("") +
      formModalHtml();

    wire();
    applyFilter();
    if (openTaskId) {
      var dlg = document.getElementById("modal-" + openTaskId);
      if (dlg) {
        dlg.showModal();
        // Có message mới mà popup đang mở: trả lại đúng chỗ PO đang đọc, đừng quăng về đầu.
        // Nhưng nếu đang ĐỨNG ĐÁY thì bám theo đáy MỚI (comment vừa thêm vào), không đứng yên
        // tại pixel cũ — pixel cũ giờ nằm giữa chừng vì scrollHeight đã phình ra do comment mới.
        var main = dlg.querySelector(".modal-main");
        if (main) {
          if (wasAtBottom) main.scrollTop = scrollBottomTarget(main);
          else if (keptScroll) main.scrollTop = keptScroll;
        }
        // Đo TẠI ĐÂY, sau showModal() — dialog đóng thì scrollHeight/clientHeight luôn là 0/0,
        // đo ở wire() (chạy TRƯỚC showModal()) nên trước giờ nút không bao giờ hiện.
        if (main) updateScrollNav(main);
        // Trả lại đúng chữ đang gõ dở (xem keptDraft ở đầu hàm) — cùng cách "input" giả lập
        // dùng cho nút Reply ở wire(), để highlight + auto-grow ăn theo luôn, không phải chép
        // lại logic paint()/autoGrow() đang nằm riêng trong wireCommentEditor().
        var box = dlg.querySelector(".comment-input");
        if (box && keptDraft) {
          box.value = keptDraft.text;
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.setSelectionRange(keptDraft.selStart, keptDraft.selEnd);
          if (keptDraft.focused) box.focus();
        }
      } else {
        openTaskId = null;
      }
    }
    keptScroll = 0;
    keptDraft = null;
    wasAtBottom = false;
  }

  function applyFilter() {
    var q = filterText.trim().toLowerCase();
    document.querySelectorAll(".card").forEach(function (card) {
      var jiraEl = card.querySelector(".jira-link");
      var hay = card.dataset.title + " " + (jiraEl ? jiraEl.textContent.toLowerCase() : "");
      card.style.display = hay.indexOf(q) !== -1 ? "" : "none";
    });
  }

  /* ---------- tương tác ---------- */

  /* Kéo thả card đổi status. KHÔNG dùng HTML5 native drag-and-drop (draggable=true/dragstart/
     dragover/drop) — một số trình duyệt có bug thật khi kết hợp draggable với nội dung chọn
     được: mọi cách chặn "chọn chữ thay vì kéo" (CSS user-select ở bất kỳ đâu trong cây .card,
     JS mousedown/selectstart preventDefault) đều làm dragstart chết hẳn, còn không chặn gì thì
     chập chờn ăn/không. Tự quản lý toàn bộ vòng đời kéo bằng con trỏ (pointerdown/move/up) thay
     thế — né hẳn bug vì không còn dựa vào cơ chế kéo gốc của trình duyệt. Chỉ chuột trái
     (pointerType "mouse", button 0): cảm ứng vẫn đổi status qua dropdown trong popup như cũ,
     không phải lối duy nhất mất đi.

     TOÀN BỘ khối này (state + hàm) nằm Ở NGOÀI wire() — chỉ cardDragOnPointerDown được GẮN lại
     mỗi lần wire() chạy (để bắt card mới sau render()), còn onMove/onUp/cardDragState sống
     xuyên suốt cả phiên. Định nghĩa chúng BÊN TRONG wire() là bug thật dễ dính: mỗi lần wire()
     chạy lại (mọi render(), kể cả do chính lượt kéo vừa xong gây ra refresh()) sẽ tạo ra một bộ
     onMove/onUp/st MỚI trong closure mới, nhưng listener ở document (pointermove/pointerup) chỉ
     gắn được ĐÚNG 1 LẦN — nên từ lần render thứ 2 trở đi, pointerdown ghi vào một "st" khác hẳn
     với "st" mà document đang lắng nghe, kéo coi như chết ngay sau lượt đầu tiên. */
  var CARD_DRAG_THRESHOLD = 5; // px — dưới ngưỡng này vẫn coi là click đứng yên, không phải kéo
  var cardDragState = null; // { card, taskId, startX, startY, dragging, ghost, col }

  function cardDropZoneAt(x, y) {
    var el = document.elementFromPoint(x, y);
    return el && el.closest(".column, .backlog-rail");
  }

  // Bản sao nổi theo con trỏ — card thật đứng yên tại chỗ (chỉ mờ đi qua .card--dragging), giống
  // cảm giác Trello/Jira dù không có ảnh kéo do trình duyệt tự vẽ (đặc quyền riêng của native
  // DnD, custom kéo bằng JS không có sẵn).
  function cardMakeGhost(card, e) {
    var r = card.getBoundingClientRect();
    var ghost = card.cloneNode(true);
    ghost.className = "card card--ghost";
    ghost.style.cssText = "position:fixed;pointer-events:none;z-index:9999;margin:0;" +
      "width:" + r.width + "px;left:" + r.left + "px;top:" + r.top + "px;";
    ghost.dataset.dx = e.clientX - r.left;
    ghost.dataset.dy = e.clientY - r.top;
    document.body.appendChild(ghost);
    return ghost;
  }

  function cardDragOnMove(e) {
    var st = cardDragState;
    if (!st) return;
    var dx = e.clientX - st.startX, dy = e.clientY - st.startY;
    if (!st.dragging) {
      if (Math.abs(dx) < CARD_DRAG_THRESHOLD && Math.abs(dy) < CARD_DRAG_THRESHOLD) return;
      st.dragging = true;
      st.card.classList.add("card--dragging");
      st.ghost = cardMakeGhost(st.card, e);
    }
    e.preventDefault();
    st.ghost.style.left = (e.clientX - st.ghost.dataset.dx) + "px";
    st.ghost.style.top = (e.clientY - st.ghost.dataset.dy) + "px";
    var col = cardDropZoneAt(e.clientX, e.clientY);
    if (col !== st.col) {
      if (st.col) st.col.classList.remove("column--dragover");
      if (col) col.classList.add("column--dragover");
      st.col = col;
    }
  }

  async function cardDragOnUp() {
    var cur = cardDragState;
    if (!cur) return;
    cardDragState = null;
    cur.card.classList.remove("card--dragging");
    if (cur.ghost) cur.ghost.remove();
    if (cur.col) cur.col.classList.remove("column--dragover");
    if (!cur.dragging) return; // không di chuyển đủ ngưỡng — để click tự lo như bình thường
    // Vừa kéo thật xong: click nổ theo ngay sau đây (trên card này hoặc bất kỳ card nào dưới con
    // trỏ lúc thả) không phải PO bấm mở card — chặn đúng 1 lần, tự dọn nếu không ai tiêu.
    cardDragJustHappened = true;
    setTimeout(function () { cardDragJustHappened = false; }, 50);
    if (!cur.col) return;
    var newStatus = cur.col.dataset.status;
    var task = null;
    data.tasks.forEach(function (t) { if (t.id === cur.taskId) task = t; });
    if (!task || task.status === newStatus) return; // thả về đúng cột cũ, không làm gì
    try {
      await api("/api/tasks/" + cur.taskId, {
        method: "PATCH", body: JSON.stringify({ status: newStatus }),
      });
      lastSnapshot = null;
      await refresh(true);
    } catch (err) {
      setSync("error", "status change failed: " + err.message);
    }
  }

  // pointermove/pointerup/pointercancel gắn Ở TÀI LIỆU (không chỉ trên card) để vẫn nhận được dù
  // con trỏ đã rời khỏi card lúc kéo nhanh — và CHỈ MỘT LẦN, ở module scope (ngoài wire()), vì
  // hàm xử lý đọc cardDragState sống ở module scope nên không cần/không được gắn lại mỗi render.
  document.addEventListener("pointermove", cardDragOnMove);
  document.addEventListener("pointerup", cardDragOnUp);
  document.addEventListener("pointercancel", cardDragOnUp);

  function cardDragOnPointerDown(e) {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    // Chặn chọn-chữ NGAY TỪ ĐÂY, không đợi qua khỏi ngưỡng ở cardDragOnMove — một số trình
    // duyệt kịp bắt đầu chọn chữ ngay trong vài px đầu, trước khi cardDragOnMove kịp gọi
    // preventDefault() ở ngưỡng. An toàn để gọi ở đây vì đã bỏ hẳn draggable=true — không còn cơ
    // chế kéo gốc nào của trình duyệt bị preventDefault() trên mousedown/pointerdown làm gãy.
    e.preventDefault();
    cardDragState = {
      card: this, taskId: this.dataset.open, startX: e.clientX, startY: e.clientY,
      dragging: false, ghost: null, col: null,
    };
  }

  // Thanh địa chỉ luôn phản ánh card đang mở, để copy thẳng từ address bar cũng ra link đúng.
  function syncUrl() {
    var url = openTaskId ? taskUrl(openTaskId) : location.origin + location.pathname;
    history.replaceState(null, "", url);
  }

  function wire() {
    // Nhớ lại đúng trạng thái PO vừa bấm — không thì poll 15s dựng lại DOM là bung/gấp về mặc
    // định ngay trước mắt, kể cả khi PO chỉ vừa mở ra đọc Jira key.
    document.querySelectorAll(".sidebar-details").forEach(function (el) {
      el.addEventListener("toggle", function () { sidebarExpanded[el.dataset.task] = el.open; });
    });

    document.querySelectorAll("[data-open]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        // Vừa kéo-thả xong (xem cardDragJustHappened trong khối Pointer Events bên dưới) thì
        // click ăn theo SAU pointerup không phải PO bấm mở card — chỉ là hệ quả tự nhiên của
        // chuỗi pointerdown/up trên cùng phần tử. Bỏ qua ĐÚNG MỘT LẦN rồi tắt cờ ngay.
        if (cardDragJustHappened) { cardDragJustHappened = false; return; }
        openTaskId = btn.dataset.open;
        var m = document.getElementById("modal-" + openTaskId);
        if (m) {
          m.showModal();
          syncUrl();
          // Đo ngay tại đây (xem updateScrollNav) — không đợi tới lần render() kế tiếp, nếu
          // không PO phải chờ tới poll 15s sau hoặc lúc ensureMessages() tải xong mới thấy nút.
          updateScrollNav(m.querySelector(".modal-main"));
        }
        markRead(openTaskId);
        ensureMessages(openTaskId);
      });
      // Card giờ là <div role="button"> chứ không phải <button> thật (để kéo-thả hoạt động —
      // xem ghi chú ở taskCard()), nên Enter/Space không tự kích hoạt như button nữa. Bù lại
      // bằng tay để giữ điều hướng bàn phím: bắn "click" thật để dùng chung đúng một chỗ xử lý
      // ở trên, không chép lại logic. Bỏ qua khi KHÔNG phải chính card này (Space cũng cuộn
      // trang theo mặc định của trình duyệt — chỉ chặn khi target đúng là card đang focus).
      btn.addEventListener("keydown", function (e) {
        if (e.target !== btn) return;
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          btn.click();
        }
      });
    });

    document.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var done = function () {
          var old = btn.textContent;
          btn.textContent = "✓ Copied";
          setTimeout(function () { btn.textContent = old; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(btn.dataset.copy).then(done, function () { prompt("Copy link:", btn.dataset.copy); });
        } else {
          prompt("Copy link:", btn.dataset.copy);
        }
      });
    });

    document.querySelectorAll("[data-editdesc]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        editingDescTask = btn.dataset.editdesc;
        render();
        var ta = document.querySelector(".desc-edit-input");
        if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
      });
    });

    document.querySelectorAll("[data-canceledit]").forEach(function (btn) {
      btn.addEventListener("click", function () { editingDescTask = null; render(); });
    });

    document.querySelectorAll("[data-descedit]").forEach(function (form) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var ta = form.querySelector(".desc-edit-input");
        var text = ta.value.trim();
        if (!text) return;
        var saveBtn = form.querySelector('button[type="submit"]');
        saveBtn.disabled = true;
        saveBtn.textContent = "saving…";
        try {
          await api("/api/messages/" + form.dataset.msgid, {
            method: "PATCH", body: JSON.stringify({ text: text }),
          });
          var task = null;
          data.tasks.forEach(function (t) { if (t.id === form.dataset.descedit) task = t; });
          if (task && task.messages.length) task.messages[0].text = text;
          editingDescTask = null;
          lastSnapshot = null;             // ép render lại đúng bản mới ở vòng poll kế tiếp
          render();
        } catch (err) {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
          setSync("error", "edit description failed: " + err.message);
        }
      });
    });

    document.querySelectorAll("[data-edittitle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        editingTitleTask = btn.dataset.edittitle;
        render();
        var inp = document.querySelector(".title-edit-input");
        if (inp) { inp.focus(); inp.select(); }
      });
    });

    document.querySelectorAll("[data-canceltitleedit]").forEach(function (btn) {
      btn.addEventListener("click", function () { editingTitleTask = null; render(); });
    });

    document.querySelectorAll("[data-titleedit]").forEach(function (form) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var inp = form.querySelector(".title-edit-input");
        var title = inp.value.trim();
        if (!title) return;
        var saveBtn = form.querySelector('button[type="submit"]');
        saveBtn.disabled = true;
        saveBtn.textContent = "saving…";
        try {
          await api("/api/tasks/" + form.dataset.titleedit, {
            method: "PATCH", body: JSON.stringify({ title: title }),
          });
          var task = null;
          data.tasks.forEach(function (t) { if (t.id === form.dataset.titleedit) task = t; });
          if (task) task.title = title;
          editingTitleTask = null;
          lastSnapshot = null;              // ép render lại đúng bản mới ở vòng poll kế tiếp
          render();
        } catch (err) {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
          setSync("error", "edit title failed: " + err.message);
        }
      });
    });

    document.querySelectorAll("dialog.modal").forEach(function (dialog) {
      function close() {
        dialog.close();
        if (dialog.id === "modal-" + openTaskId) { openTaskId = null; syncUrl(); }
        editingDescTask = null;
        editingTitleTask = null;
      }
      dialog.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", close); });
      dialog.addEventListener("click", function (e) { if (e.target === dialog) close(); });
      dialog.addEventListener("cancel", function () {
        if (dialog.id === "modal-" + openTaskId) { openTaskId = null; syncUrl(); }
      });
    });

    document.querySelectorAll("[data-mute], [data-unmute]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var muting = "mute" in btn.dataset;
        btn.disabled = true;
        try {
          await api("/api/tasks/" + (muting ? btn.dataset.mute : btn.dataset.unmute), {
            method: "PATCH",
            body: JSON.stringify({ alerts_cleared_id: muting ? Number(btn.dataset.upto) : null }),
          });
          lastSnapshot = null;
          await refresh(true);
        } catch (err) {
          btn.disabled = false;
          setSync("error", (muting ? "dismiss" : "restore") + " failed: " + err.message);
        }
      });
    });

    // Chu y: data-setstatus chu KHONG phai data-status — data-status da la cua cot tren board.
    document.querySelectorAll("[data-setstatus]").forEach(function (sel) {
      var was = sel.value;
      sel.addEventListener("change", async function () {
        sel.disabled = true;
        try {
          await api("/api/tasks/" + sel.dataset.setstatus, {
            method: "PATCH", body: JSON.stringify({ status: sel.value }),
          });
          was = sel.value;
          lastSnapshot = null;
          await refresh(true);
        } catch (err) {
          sel.value = was;                 // tra ve gia tri cu, dung de PO tuong da doi xong
          sel.disabled = false;
          setSync("error", "status change failed: " + err.message);
        }
      });
    });

    // Kéo thả card đổi status — gắn pointerdown cho MỌI card ở mỗi lần wire() (card mới sau khi
    // render() dựng lại DOM cũng phải có), nhưng dùng chung state/hàm xử lý sống Ở NGOÀI wire()
    // (cardDragOnPointerDown, xem định nghĩa phía trên). Xem giải thích đầy đủ ở đó — TUYỆT ĐỐI
    // không định nghĩa lại onMove/onUp/st bên trong wire(): mỗi lần wire() chạy lại (mọi lần
    // render(), kể cả do chính lượt kéo vừa xong gây ra refresh()) sẽ tạo closure MỚI, trong khi
    // listener ở document chỉ gắn được đúng 1 lần — 2 bản lệch nhau là kéo chết ngay sau lần đầu.
    document.querySelectorAll(".card").forEach(function (card) {
      card.addEventListener("pointerdown", cardDragOnPointerDown);
    });

    // Giao ngay cho Coordinator: ghi 1 comment po -> coordinator, đi lại đúng đường pickup đã có.
    document.querySelectorAll("[data-runnow]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        var old = btn.textContent;
        btn.textContent = "sending…";
        try {
          await api("/api/tasks/" + btn.dataset.runnow + "/messages", {
            method: "POST",
            body: JSON.stringify({
              from: "po", to: "coordinator", kind: "comment",
              text: "Xử lý task này giúp tôi (bấm Run now trên board).",
            }),
          });
          lastSnapshot = null;
          await refresh(true);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = old;
          setSync("error", "run failed: " + err.message);
        }
      });
    });

    document.querySelectorAll("[data-schedule]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var input = btn.parentElement.querySelector(".run-at-existing");
        if (!input.value) { input.focus(); return; }
        btn.disabled = true;
        try {
          // Gắn +07:00 cho khớp quy ước giờ VN của cả hệ — để trần thì Coordinator so chuỗi sẽ lệch múi.
          await api("/api/tasks/" + btn.dataset.schedule, {
            method: "PATCH",
            body: JSON.stringify({ run_at: input.value + ":00+07:00" }),
          });
          lastSnapshot = null;
          await refresh(true);
        } catch (err) {
          btn.disabled = false;
          setSync("error", "schedule failed: " + err.message);
        }
      });
    });

    document.querySelectorAll("[data-unschedule]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        try {
          await api("/api/tasks/" + btn.dataset.unschedule, {
            method: "PATCH", body: JSON.stringify({ run_at: "" }),
          });
          lastSnapshot = null;
          await refresh(true);
        } catch (err) {
          btn.disabled = false;
          setSync("error", "cancel failed: " + err.message);
        }
      });
    });

    // Xoá card: 2 bước cố ý — xoá là mất luôn cả hội thoại, không có undo, nên một cú bấm
    // nhầm không được phép làm gì cả.
    document.querySelectorAll("[data-delete]").forEach(function (btn) {
      var note = btn.parentElement.querySelector(".danger-note");
      var armed = false;
      btn.addEventListener("click", async function () {
        if (!armed) {
          armed = true;
          btn.textContent = "Click again to delete";
          btn.classList.add("btn--danger-armed");
          if (note) note.hidden = false;
          setTimeout(function () {           // tự nguội, tránh để nút "đã lên đạn" nằm chờ
            if (!armed) return;
            armed = false;
            btn.textContent = "Delete card";
            btn.classList.remove("btn--danger-armed");
            if (note) note.hidden = true;
          }, 5000);
          return;
        }
        btn.disabled = true;
        btn.textContent = "deleting…";
        try {
          await api("/api/tasks/" + btn.dataset.delete, { method: "DELETE" });
          var dlg = document.getElementById("modal-" + btn.dataset.delete);
          if (dlg) dlg.close();
          openTaskId = null;
          syncUrl();
          lastSnapshot = null;               // ép render lại, card vừa xoá phải biến mất ngay
          await refresh(true);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "Delete card";
          btn.classList.remove("btn--danger-armed");
          armed = false;
          setSync("error", "delete failed: " + err.message);
        }
      });
    });

    // Reply: tag sẵn @handle của agent vừa nói vào đúng ô comment của CARD ĐÓ (mỗi dialog một
    // ô, tìm bằng closest chứ không phải querySelector toàn trang — nhiều card có thể mở popup
    // cùng lúc trong DOM dù chỉ một cái đang showModal()).
    document.querySelectorAll("[data-reply]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var dialog = btn.closest("dialog.modal");
        var box = dialog && dialog.querySelector(".comment-input");
        if (!box) return;
        var tag = "@" + agent(btn.dataset.reply).handle + " ";
        if (!box.value.trim()) {
          box.value = tag;
        } else if (box.value.toLowerCase().indexOf(tag.trim().toLowerCase()) !== 0) {
          box.value = tag + box.value;
        }
        box.dispatchEvent(new Event("input", { bubbles: true })); // repaint highlight + auto-grow
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
        box.scrollIntoView({ block: "nearest" });
      });
    });

    document.querySelectorAll(".comment-form").forEach(function (form) {
      var box = form.querySelector(".comment-input");
      var taskId = form.dataset.task;
      // Gợi ý @, highlight tag hợp lệ, và Enter để gửi (Shift+Enter xuống dòng) — xem
      // wireCommentEditor().
      var editor = wireCommentEditor(form);

      // File đính kèm (PO chốt) — tải lên NGAY lúc chọn file (không đợi bấm Send),
      // để PO thấy rõ file nào đã lên thành công trước khi gửi cả comment. Logic dùng chung với
      // form "New task" — xem wireAttachControls().
      wireAttachControls(form, taskId);

      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var text = box.value.trim();
        var attachments = pendingAttachments[taskId] || [];
        if (!text && !attachments.length) return;   // chat rỗng hoàn toàn thì không gửi
        var btn = form.querySelector(".comment-send");
        var msg = form.querySelector(".comment-form-msg");
        var target = parseTarget(text);
        btn.disabled = true;
        msg.textContent = "sending…";
        try {
          await api("/api/tasks/" + taskId + "/messages", {
            method: "POST",
            body: JSON.stringify({
              from: "po", to: target, kind: "comment", text: text, attachments: attachments,
            }),
          });
          box.value = "";
          box.style.height = "";   // thu lại 2 dòng, nếu không ô vẫn cao bằng bài vừa gửi
          editor.paint();   // xoá luôn phần highlight ở lớp gương, không để chữ ma còn lại
          pendingAttachments[taskId] = [];
          renderPendingAttachments(form.querySelector(".comment-pending-attachments"), taskId);
          msg.textContent = "sent to " + agent(target).label + " — picked up within ~30s";
          await refresh(false);
          // Cuộn xuống đúng tin vừa gửi — refresh() ở trên đã DỰNG LẠI TOÀN BỘ DOM (kể cả popup
          // đang mở) và trả scroll về đúng chỗ PO đọc TRƯỚC lúc gửi, nên `form`/`box` ở đây đã
          // là node cũ bị gỡ khỏi cây; phải tra lại dialog/modal-main MỚI bằng id, không dùng
          // closest() trên node cũ (luôn ra null vì nó không còn cha nào cả).
          var freshMain = document.querySelector(
            "#modal-" + CSS.escape(taskId) + " .modal-main");
          if (freshMain) freshMain.scrollTo({ top: lastCommentTop(freshMain), behavior: "smooth" });
        } catch (err) {
          msg.textContent = "send failed: " + err.message;
        } finally {
          btn.disabled = false;
        }
      });
    });

    /* Cuộn nhanh trong popup. Ẩn hẳn khi nội dung ngắn hơn khung — hai nút không làm gì thì
       chỉ tổ che mất chữ. Kiểm lại mỗi lần render vì nội dung card dài ra theo từng message. */
    // Xem thêm / thu bớt cột Done — thuần client, không gọi API.
    document.querySelectorAll("[data-browser]").forEach(function (inp) {
      var cu = inp.value;
      inp.addEventListener("change", async function () {
        var moi = inp.value.trim();
        if (moi === cu) return;
        inp.disabled = true;
        try {
          await api("/api/tasks/" + inp.dataset.browser, {
            method: "PATCH", body: JSON.stringify({ browser: moi }),
          });
          cu = moi;
          lastSnapshot = null;
          await refresh(true);
        } catch (err) {
          inp.value = cu;
          setSync("error", "browser change failed: " + err.message);
        } finally {
          inp.disabled = false;
        }
      });
    });

    document.querySelectorAll("[data-showall], [data-showless]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showAllDone = "showall" in btn.dataset;
        lastSnapshot = null;
        render();
      });
    });

    document.querySelectorAll("[data-showmore-comments]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        expandedComments[btn.dataset.showmoreComments] = true;
        lastSnapshot = null;
        render();
      });
    });

    document.querySelectorAll("[data-toggle-col]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.toggleCol;
        collapsedColumns[key] = !collapsedColumns[key];
        lastSnapshot = null;
        render();
      });
    });

    // Card đã lưu trữ: bật/tắt thì phải gọi lại API vì Worker mới là chỗ lọc chúng ra.
    var arch = document.getElementById("archived-btn");
    if (arch) {
      arch.addEventListener("click", async function () {
        showArchived = !showArchived;
        arch.disabled = true;
        lastSnapshot = null;
        await refresh(true);
      });
    }

    // Ẩn/hiện cặp nút cuộn nhanh tính TRONG render() sau khi dialog thật sự showModal() —
    // ở đây chỉ gắn click, không đo kích thước: dialog chưa mở thì scrollHeight/clientHeight
    // luôn ra 0/0 (UA ẩn nội dung dialog đóng), đo ở bước này lúc nào cũng ẩn nút dù nội dung
    // dài cỡ nào (bug thật — PO báo không thấy nút, xem điểm đo lại trong render()).
    document.querySelectorAll(".modal-main").forEach(function (main) {
      var nav = main.querySelector(".scroll-nav");
      if (!nav) return;
      nav.querySelectorAll("[data-scroll]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          // Xuống ĐẦU comment cuối, không phải đáy cùng của khung cuộn (PO chốt) —
          // trước đó dùng scrollHeight nên comment cuối dài là bị đẩy qua khỏi màn hình, PO
          // phải cuộn ngược lên mới đọc được chữ đầu.
          var top = btn.dataset.scroll === "top" ? 0 : lastCommentTop(main);
          main.scrollTo({ top: top, behavior: "smooth" });
        });
      });
    });

    document.querySelectorAll("[data-approve]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        btn.textContent = "approving…";
        try {
          await api("/api/messages/" + btn.dataset.approve + "/approve", { method: "POST" });
          // Đánh dấu approved trong DB thôi thì Coordinator không biết gì — nó chỉ nghe message
          // kind="comment". Nên ghi thêm 1 comment để đi đúng đường pickup đã có.
          //
          // CỐ Ý làm ở phía client, KHÔNG nhét vào endpoint /approve của Worker: chính Coordinator
          // cũng gọi approve (khi PO duyệt qua Slack), nên nếu Worker tự đẻ comment mỗi lần
          // approve thì Coordinator sẽ tự kích hoạt lại chính mình -> chạy lặp việc vừa làm.
          await api("/api/tasks/" + btn.dataset.task + "/messages", {
            method: "POST",
            body: JSON.stringify({
              from: "po", to: "coordinator", kind: "comment",
              text: "Approved the step above (via the board). Carry out what was approved, then continue with the next step.",
            }),
          });
          await refresh(true);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "Approve & continue";
          setSync("error", "approve failed: " + err.message);
        }
      });
    });

    // File đính kèm cho form New task — cùng cơ chế comment-form, key cố định vì task chưa
    // tồn tại lúc PO chọn file (xem NEW_TASK_ATTACH_KEY, wireAttachControls()).
    wireAttachControls(document.getElementById("new-task-modal"), NEW_TASK_ATTACH_KEY);

    document.getElementById("new-task-btn").addEventListener("click", function () {
      document.getElementById("nt-error").textContent = "";
      document.getElementById("new-task-modal").showModal();
      document.getElementById("nt-desc").focus();
      // Dropdown lịch hẹn luôn bắt đầu đóng — dialog cũ bị tái dùng qua nhiều lần mở nếu
      // render() không chạy lại xen giữa (poll không thấy gì đổi), nên trạng thái mở/đóng
      // lần trước có thể còn dính lại nếu không tự tay đóng ở đây.
      var menu = document.getElementById("nt-schedule-menu");
      var toggle = document.getElementById("nt-schedule-toggle");
      if (menu) menu.hidden = true;
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    });

    // Nút mũi tên cạnh Later mở/đóng dropdown chọn giờ hẹn — bấm ra ngoài cũng đóng lại,
    // giống mọi popover khác trong app này (agent hover card, menu @mention...).
    document.getElementById("nt-schedule-toggle").addEventListener("click", function (e) {
      e.stopPropagation();
      var menu = document.getElementById("nt-schedule-menu");
      var opening = menu.hidden;
      menu.hidden = !opening;
      this.setAttribute("aria-expanded", String(opening));
      if (opening) document.getElementById("nt-run-at").focus();
    });
    document.addEventListener("click", function (e) {
      var menu = document.getElementById("nt-schedule-menu");
      var toggle = document.getElementById("nt-schedule-toggle");
      if (!menu || menu.hidden) return;
      if (menu.contains(e.target) || (toggle && toggle.contains(e.target))) return;
      menu.hidden = true;
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    });

    // Run now / Later / Schedule (trong dropdown) đều tạo task giống nhau, chỉ khác đúng
    // MỘT điểm: có ghi thêm comment kích hoạt Coordinator ngay hay không, và có kèm run_at hay không.
    // Description tuỳ chọn (PO chốt): bỏ trống thì tạo card rỗng, PO bấm Edit điền
    // sau. Không hỏi Title nữa (PO chốt): luôn để Worker đặt "(untitled)", Coordinator tự
    // tóm tắt tên sau — xem field--chat phía trên.
    async function createTask(when) {
      var errEl = document.getElementById("nt-error");
      errEl.textContent = "";
      var description = document.getElementById("nt-desc").value.trim();
      var runAt = document.getElementById("nt-run-at").value;   // "YYYY-MM-DDTHH:mm" (giờ máy PO)
      if (when === "at" && !runAt) {
        errEl.textContent = "Pick a date and time to schedule.";
        return;
      }
      var buttons = [
        document.getElementById("nt-submit"),
        document.getElementById("nt-later"),
        document.getElementById("nt-schedule-submit"),
      ];
      buttons.forEach(function (b) { b.disabled = true; });
      try {
        var body = {
          description: description,
          attachments: pendingAttachments[NEW_TASK_ATTACH_KEY] || [],
        };
        // Hẹn giờ: gắn offset +07:00 cho khớp quy ước timestamp của cả hệ (Worker và agent đều
        // ghi giờ VN), nếu để trần thì Coordinator so chuỗi sẽ lệch múi giờ.
        if (when === "at") body.run_at = runAt + ":00+07:00";
        var created = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });

        // "Run now" đi lại đúng đường pickup đã có: ghi 1 comment po -> coordinator, luồng nền của Coordinator
        // nhận trong ~30s. Không đẻ cơ chế kích hoạt thứ hai.
        if (when === "now") {
          await api("/api/tasks/" + created.id + "/messages", {
            method: "POST",
            body: JSON.stringify({
              from: "po", to: "coordinator", kind: "comment",
              text: "Xử lý task này giúp tôi (bấm Run now trên board).",
            }),
          });
        }
        pendingAttachments[NEW_TASK_ATTACH_KEY] = [];
        document.getElementById("new-task-modal").close();
        await refresh(true);
      } catch (err) {
        errEl.textContent = "Could not create task: " + err.message;
        buttons.forEach(function (b) { b.disabled = false; });
      }
    }

    document.getElementById("nt-submit").addEventListener("click", function () { createTask("now"); });
    document.getElementById("nt-later").addEventListener("click", function () { createTask("later"); });
    document.getElementById("nt-schedule-submit").addEventListener("click", function () { createTask("at"); });

    var filter = document.getElementById("filter");
    filter.addEventListener("input", function () {
      filterText = filter.value;
      applyFilter();
    });
  }

  /* ---------- khởi động ---------- */

  document.getElementById("root").innerHTML = '<p class="page-loading">Loading board…</p>';

  // Link riêng của từng card: ?task=<id> mở thẳng popup card đó khi vào trang.
  try {
    var deep = new URLSearchParams(location.search).get("task");
    if (deep) openTaskId = deep;
  } catch (e) { /* URL lạ thì bỏ qua, vẫn mở board bình thường */ }

  // Vào thẳng bằng link ?task=... cũng là mở card ra đọc — phải tính, nếu không card Done
  // mở kiểu đó sẽ báo "Unread" mãi.
  refresh(true).then(function () {
    if (!openTaskId) return;
    markRead(openTaskId);
    ensureMessages(openTaskId);
  });

  // Poll để thấy việc agent vừa ghi; dừng khi tab ẩn cho đỡ tốn.
  /* Tab ẩn thì vẫn PHẢI poll, nếu không sẽ không bao giờ biết có việc mới để báo lên tab —
     nhưng poll thưa hơn (mỗi 4 nhịp ≈ 60s) cho đỡ tốn. Bản trước bỏ hẳn poll khi ẩn nên chỉ
     báo được đúng lúc PO đang nhìn, tức là vô dụng. */
  /* ---------- thẻ hồ sơ agent khi rê chuột ---------- */

  var hoverCard = null, showTimer = null, hideTimer = null;

  function agentCardHtml(key) {
    var a = agent(key);
    var isImg = /^(\/|https?:)/.test(String(a.icon || ""));
    return '<span class="agent-card-face" style="--avatar-color:' + esc(a.color) + '">' +
      (isImg ? '<img src="' + esc(a.icon) + '" alt="">' : a.icon) + "</span>" +
      '<span class="agent-card-text">' +
      '<span class="agent-card-name">' + esc(a.label) + "</span>" +
      '<span class="agent-card-handle">@' + esc(a.handle) + "</span>" +
      '<span class="agent-card-role">' + esc(a.role) + "</span></span>";
  }

  function hideAgentCard() {
    if (hoverCard) hoverCard.remove();
    hoverCard = null;
  }

  function showAgentCard(el, key) {
    if (!data || !data.agents || !data.agents[key]) return;
    hideAgentCard();
    /* Popup card nằm ở TOP LAYER (dialog.showModal). Thẻ gắn vào <body> sẽ bị nó che hoàn toàn,
       nên phải gắn vào chính dialog đang mở. position:fixed nên overflow của .modal-body không
       cắt được nó — miễn là không tổ tiên nào có transform/filter (đã kiểm: không có). */
    var host = (el.closest && el.closest("dialog[open]")) || document.body;
    hoverCard = document.createElement("div");
    hoverCard.className = "agent-card";
    hoverCard.innerHTML = agentCardHtml(key);
    host.appendChild(hoverCard);

    // Gắn vào DOM trước rồi mới đo: cần kích thước thật để kẹp cho gọn trong màn hình.
    var r = el.getBoundingClientRect(), c = hoverCard.getBoundingClientRect();
    var top = r.top - c.height - 8;
    if (top < 8) top = r.bottom + 8;                       // sát mép trên thì lật xuống dưới
    var left = r.left + r.width / 2 - c.width / 2;
    left = Math.min(Math.max(8, left), window.innerWidth - c.width - 8);
    hoverCard.style.top = Math.round(top) + "px";
    hoverCard.style.left = Math.round(left) + "px";
    hoverCard.classList.add("is-on");
  }

  /* Uỷ quyền ở document và gắn ĐÚNG MỘT LẦN: avatar được vẽ lại sau mỗi lần render, gắn trong
     wire() thì listener chồng lên nhau mãi. mouseover/mouseout chứ không phải mouseenter —
     hai cái sau không nổi bọt nên uỷ quyền không bắt được. */
  document.addEventListener("mouseover", function (e) {
    var el = e.target.closest ? e.target.closest("[data-agent]") : null;
    if (!el) return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(function () { showAgentCard(el, el.dataset.agent); }, 140);
  });
  document.addEventListener("mouseout", function (e) {
    var el = e.target.closest ? e.target.closest("[data-agent]") : null;
    if (!el) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hideAgentCard, 120);
  });
  // Thẻ đặt theo toạ độ màn hình nên cuộn một cái là nó lệch khỏi avatar — bỏ đi luôn.
  document.addEventListener("scroll", hideAgentCard, true);

  function startPoll() {
    if (pollTimer) return;
    var tick = 0;
    pollTimer = setInterval(function () {
      tick++;
      if (!document.hidden || tick % 4 === 0) refresh(false);
    }, POLL_MS);
  }
  startPoll();
  setFavicon(false);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      setAttention(0);   // PO đã quay lại tab -> coi như đã xem
      refresh(false);
    }
  });
  window.addEventListener("focus", function () { setAttention(0); });
})();
