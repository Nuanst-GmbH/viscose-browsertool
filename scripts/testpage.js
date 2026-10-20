// Tiny E2E test page: http://127.0.0.1:8765
// #btn increments #count; #name is a text input.
const http = require("http");

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Browser Tool Test Page</title>
  <style>body { font-family: system-ui, sans-serif; padding: 2rem; }
         button { font-size: 1.2rem; padding: 0.4rem 1rem; }</style>
</head>
<body>
  <h1>Browser Tool Test Page</h1>
  <p>Count: <span id="count">0</span></p>
  <button id="btn">Increment</button>
  <p>Name: <input id="name" value=""></p>
  <script>
    let n = 0;
    document.getElementById("btn").addEventListener("click", () => {
      n += 1;
      document.getElementById("count").textContent = String(n);
    });
  </script>
</body>
</html>`;

http
  .createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  })
  .listen(8765, "127.0.0.1", () => console.log("test page on http://127.0.0.1:8765"));
