/**
 * J-Quants local proxy (CORS回避用)
 *
 * - ブラウザから http://localhost:8787/api/v1/... にアクセスすると
 *   https://api.jquants.com/v1/... に中継します。
 * - Authorization ヘッダーもそのまま転送します。
 *
 * 起動:
 *   node proxy/server.js
 *
 * ポート変更:
 *   PORT=8787 node proxy/server.js
 */

const http = require("node:http");

const TARGET_ORIGIN = "https://api.jquants.com";
const LISTEN_PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function withCors(headers = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...headers,
  };
}

function isAllowedPath(url) {
  return url.pathname.startsWith("/api/v1/");
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return null;
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      send(res, 204, withCors(), "");
      return;
    }

    if (!isAllowedPath(url)) {
      send(
        res,
        404,
        withCors({ "Content-Type": "application/json; charset=utf-8" }),
        JSON.stringify({ error: "Not Found", hint: "Use /api/v1/..." })
      );
      return;
    }

    const upstreamUrl = new URL(`${TARGET_ORIGIN}${url.pathname.replace(/^\/api/, "")}${url.search}`);
    const body = await readBody(req);

    const headers = new Headers();
    // Forward auth + content-type
    if (req.headers.authorization) headers.set("Authorization", req.headers.authorization);
    if (req.headers["content-type"]) headers.set("Content-Type", req.headers["content-type"]);

    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: body ?? undefined,
    });

    // Pass-through response body & content-type
    const ct = upstreamRes.headers.get("content-type") || "application/json; charset=utf-8";
    const buf = Buffer.from(await upstreamRes.arrayBuffer());

    send(res, upstreamRes.status, withCors({ "Content-Type": ct }), buf);
  } catch (e) {
    send(
      res,
      500,
      withCors({ "Content-Type": "application/json; charset=utf-8" }),
      JSON.stringify({ error: "ProxyError", message: e?.message ?? String(e) })
    );
  }
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[jquants-proxy] listening on http://localhost:${LISTEN_PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[jquants-proxy] proxying ${TARGET_ORIGIN}/v1 via /api/v1`);
});

