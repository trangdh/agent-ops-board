#!/usr/bin/env node
// Ghép giao diện web thành 1 file src/ui.html để Worker nhúng vào (rule Text trong wrangler.toml).
//
// Chạy: node build.js   (hoặc `npm run build`)

const fs = require("fs");
const path = require("path");

const here = (...p) => path.join(__dirname, ...p);

const baseCss = fs.readFileSync(here("ui", "base.css"), "utf8");
const extraCss = fs.readFileSync(here("ui", "extra.css"), "utf8");
const appJs = fs.readFileSync(here("ui", "app.js"), "utf8");

if (appJs.includes("</scr" + "ipt>")) {
  console.error("LỖI: ui/app.js có thẻ đóng script chưa escape — phải viết <\\/script>.");
  process.exit(1);
}

// Chú thích /* thiếu dấu đóng thì mọi thứ phía sau bị nuốt vào comment — file VẪN parse sạch,
// chỉ là trắng bảng. Đã dính thật một lần (xoá một hàm ăn mất */, taskModal biến mất, board mở
// ra trắng trơn). Kiểm tra cú pháp không bắt được; kiểm tra này thì bắt được.
const REQUIRED = [
  "render", "wire", "taskModal", "taskCard", "commentCard", "richText", "inline",
  "statusSelect", "alertToggle", "runZone", "needsPo", "refresh", "column",
];
const visible = appJs.replace(/\/\*[\s\S]*?\*\//g, "");
const swallowed = REQUIRED.filter((n) => !visible.includes("function " + n + "("));
if (swallowed.length) {
  console.error("LỖI: ui/app.js — các hàm sau nằm trong vùng chú thích hoặc đã biến mất: " +
    swallowed.join(", ") + ". Nhiều khả năng có /* thiếu */.");
  process.exit(1);
}

// <title> ở đây chỉ là giá trị lúc trang chưa tải xong dữ liệu — ngay sau đó JS đổi nó theo
// BOARD_TITLE lấy từ /api/board (xem applyConfig trong ui/app.js). Đổi tên board bằng biến môi
// trường trong wrangler.toml, không phải sửa file này.
const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg">
<title>Agent Ops Board</title>
<style>
${baseCss}
${extraCss}
</style>
</head>
<body>
<div id="root"></div>
<script>
${appJs}
</script>
</body>
</html>
`;

fs.mkdirSync(here("src"), { recursive: true });
fs.writeFileSync(here("src", "ui.html"), html, "utf8");
console.log(`Đã build ${here("src", "ui.html")} (${(html.length / 1024).toFixed(1)} KB).`);
