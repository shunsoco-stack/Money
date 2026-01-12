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
const https = require("node:https");

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

function pickHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  return typeof v === "string" ? v : Array.isArray(v) ? v.join(",") : undefined;
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

async function forwardToUpstream({ method, upstreamUrl, req, body }) {
  return await new Promise((resolve, reject) => {
    const headers = {};
    const auth = pickHeader(req, "authorization");
    const ct = pickHeader(req, "content-type");
    const accept = pickHeader(req, "accept");
    if (auth) headers["authorization"] = auth;
    if (ct) headers["content-type"] = ct;
    if (accept) headers["accept"] = accept;
    if (body && typeof body.length === "number") headers["content-length"] = String(body.length);

    const r = https.request(
      upstreamUrl,
      {
        method,
        headers,
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on("data", (c) => chunks.push(c));
        upstreamRes.on("end", () => {
          resolve({
            statusCode: upstreamRes.statusCode || 502,
            contentType: upstreamRes.headers["content-type"] || "application/json; charset=utf-8",
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
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

    const upstream = await forwardToUpstream({
      method: req.method,
      upstreamUrl,
      req,
      body: body ?? null,
    });
    send(res, upstream.statusCode, withCors({ "Content-Type": upstream.contentType }), upstream.body);
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

