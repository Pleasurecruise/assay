#!/usr/bin/env node
/**
 * ARK 多 Token 故障切换代理（零依赖，Node >= 18）。
 *
 * 作用：本地反代火山方舟，请求逐 Token 尝试——上游返回 401/403/429/5xx 时自动
 * 换下一个 Token 重试；拿到正常状态后按流式透传（SSE 不受影响）。
 *
 * 启用：
 *   1) node scripts/ark-failover-proxy.mjs
 *   2) .env 里改 ARK_BASE_URL=http://127.0.0.1:3210/api/v3
 *
 * Token 来源：.env 的 ARK_API_KEYS（逗号分隔），缺省回落 ARK_API_KEY。
 * 安全：Token 只存在于内存与 .env，永不写入日志（日志仅打 key#序号）。
 */

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(HERE, "..", ".env");

try {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
  }
} catch {
  /* .env 缺失时仅依赖进程环境变量 */
}

const KEYS = (process.env.ARK_API_KEYS || process.env.ARK_API_KEY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (KEYS.length === 0) {
  console.error("未找到 ARK_API_KEYS / ARK_API_KEY，退出。");
  process.exit(1);
}

const UPSTREAM_HOST = process.env.ARK_UPSTREAM_HOST || "ark.cn-beijing.volces.com";
const PORT = Number(process.env.ARK_PROXY_PORT || 3210);
const RETRIABLE = new Set([401, 403, 429, 500, 502, 503, 529]);

const cooldownUntil = Array.from({ length: KEYS.length }, () => 0);
let preferred = 0;
const ts = () => new Date().toISOString();

function candidateOrder() {
  const now = Date.now();
  const ready = [];
  for (let off = 0; off < KEYS.length; off++) {
    const i = (preferred + off) % KEYS.length;
    if (cooldownUntil[i] <= now) ready.push(i);
  }
  return ready.length ? ready : KEYS.map((_, i) => i);
}

function forward(keyIdx, req, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    headers.authorization = `Bearer ${KEYS[keyIdx]}`;
    headers["content-length"] = Buffer.byteLength(body);
    const up = https.request(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers,
        timeout: 600_000,
      },
      resolve,
    );
    up.on("error", reject);
    up.on("timeout", () => up.destroy(new Error("upstream timeout")));
    up.end(body);
  });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const order = candidateOrder();
    let lastErr = null;
    for (let n = 0; n < order.length; n++) {
      const i = order[n];
      const isLast = n === order.length - 1;
      let up;
      try {
        up = await forward(i, req, body);
      } catch (e) {
        lastErr = e;
        console.log(
          ts(),
          req.method,
          req.url,
          `key#${i + 1}`,
          "网络错误:",
          e.message,
          isLast ? "(exhausted)" : "(switch)",
        );
        continue;
      }
      if (RETRIABLE.has(up.statusCode) && !isLast) {
        // 鉴权类失效冷却 10 分钟；限流/服务端类冷却 20 秒
        cooldownUntil[i] =
          Date.now() + (up.statusCode === 401 || up.statusCode === 403 ? 600_000 : 20_000);
        console.log(ts(), req.method, req.url, `key#${i + 1}`, "->", up.statusCode, "(switch)");
        up.resume();
        continue;
      }
      preferred = i;
      console.log(ts(), req.method, req.url, `key#${i + 1}`, "->", up.statusCode);
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      return;
    }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "all_ark_keys_failed",
        message: String((lastErr && lastErr.message) || "exhausted"),
      }),
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `ARK failover proxy: http://127.0.0.1:${PORT} -> https://${UPSTREAM_HOST}（Token 数: ${KEYS.length}，日志不打印 Token）`,
  );
});
