const DEFAULT_BASE_DIRECT = "https://api.jquants.com/v1";
const DEFAULT_BASE_PROXY = "http://localhost:8787/api/v1";

const LS_KEYS = {
  baseUrl: "jq.baseUrl",
  transport: "jq.transport",
  refreshToken: "jq.refreshToken",
};

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element not found: #${id}`);
  return el;
};

const ui = {
  baseUrl: $("baseUrl"),
  transport: $("transport"),
  mailaddress: $("mailaddress"),
  password: $("password"),
  btnGetRefreshToken: $("btnGetRefreshToken"),
  refreshToken: $("refreshToken"),
  rememberRefresh: $("rememberRefresh"),
  btnGetIdToken: $("btnGetIdToken"),
  btnClearTokens: $("btnClearTokens"),
  idToken: $("idToken"),
  btnCopyIdToken: $("btnCopyIdToken"),
  code: $("code"),
  from: $("from"),
  to: $("to"),
  btnFetchDaily: $("btnFetchDaily"),
  btnDownloadCsv: $("btnDownloadCsv"),
  summary: $("summary"),
  tableWrap: $("tableWrap"),
  log: $("log"),
  btnClearLog: $("btnClearLog"),
};

let state = {
  idToken: "",
  lastRows: null,
  lastColumns: null,
};

function nowIso() {
  return new Date().toISOString();
}

function logLine(message, data) {
  const lines = [];
  lines.push(`[${nowIso()}] ${message}`);
  if (data !== undefined) {
    if (typeof data === "string") lines.push(data);
    else lines.push(JSON.stringify(data, null, 2));
  }
  ui.log.textContent = `${lines.join("\n")}\n\n${ui.log.textContent}`.trim();
}

function setBusy(busy) {
  ui.btnGetRefreshToken.disabled = busy;
  ui.btnGetIdToken.disabled = busy;
  ui.btnFetchDaily.disabled = busy;
}

function getBaseUrl() {
  const transport = ui.transport.value;
  const raw = ui.baseUrl.value.trim();
  if (raw) return raw.replace(/\/+$/, "");
  return transport === "proxy" ? DEFAULT_BASE_PROXY : DEFAULT_BASE_DIRECT;
}

function persistSettings() {
  localStorage.setItem(LS_KEYS.baseUrl, ui.baseUrl.value);
  localStorage.setItem(LS_KEYS.transport, ui.transport.value);
  if (ui.rememberRefresh.value === "yes") {
    localStorage.setItem(LS_KEYS.refreshToken, ui.refreshToken.value);
  } else {
    localStorage.removeItem(LS_KEYS.refreshToken);
  }
}

function restoreSettings() {
  ui.baseUrl.value = localStorage.getItem(LS_KEYS.baseUrl) ?? "";
  ui.transport.value = localStorage.getItem(LS_KEYS.transport) ?? "direct";
  const savedRefresh = localStorage.getItem(LS_KEYS.refreshToken);
  if (savedRefresh) {
    ui.refreshToken.value = savedRefresh;
    ui.rememberRefresh.value = "yes";
  }
}

function normalizeCode(code) {
  const c = String(code ?? "").trim();
  // allow "7203" or "7203.T" style; extract 4 digits if present
  const m = c.match(/(\d{4})/);
  return m ? m[1] : c;
}

function normalizeYmd(ymd) {
  const v = String(ymd ?? "").trim().replaceAll("-", "");
  if (!v) return "";
  if (!/^\d{8}$/.test(v)) throw new Error(`日付は YYYYMMDD で入力してください: ${ymd}`);
  return v;
}

async function readJsonOrText(res) {
  const text = await res.text();
  try {
    return { kind: "json", value: JSON.parse(text), raw: text };
  } catch {
    return { kind: "text", value: text, raw: text };
  }
}

async function apiFetch(path, { method = "GET", headers = {}, query = null, body = null, auth = false } = {}) {
  const base = getBaseUrl();
  const url = new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }

  const h = new Headers(headers);
  if (auth) {
    if (!state.idToken) throw new Error("idToken が未取得です（先に認証してください）");
    h.set("Authorization", `Bearer ${state.idToken}`);
  }
  const isForm = body instanceof URLSearchParams;
  const isFormData = body instanceof FormData;
  const isString = typeof body === "string";
  const isPlainObject =
    body !== null && body !== undefined && typeof body === "object" && !Array.isArray(body) && !isForm && !isFormData;

  if (body) {
    // Respect explicit Content-Type if caller set it.
    if (!h.has("Content-Type") && !isFormData) {
      if (isForm) h.set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
      else if (isPlainObject) h.set("Content-Type", "application/json");
      // string: leave unset unless caller specified
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: h,
    body: body
      ? isFormData
        ? body
        : isForm
          ? body.toString()
          : isPlainObject
            ? JSON.stringify(body)
            : isString
              ? body
              : JSON.stringify(body)
      : undefined,
  });

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    const hint =
      parsed.kind === "json"
        ? parsed.value
        : { message: parsed.value || `HTTP ${res.status} ${res.statusText}` };
    const err = new Error(`APIエラー: ${res.status} ${res.statusText}`);
    err.details = hint;
    err.url = url.toString();
    throw err;
  }
  return parsed.kind === "json" ? parsed.value : parsed.value;
}

function extractRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  // common J-Quants shapes:
  // { daily_quotes: [...] }
  // { info: [...] }, etc.
  for (const key of Object.keys(payload)) {
    const v = payload[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function makeColumns(rows) {
  if (!rows || rows.length === 0) return [];
  const preferred = [
    "Date",
    "Open",
    "High",
    "Low",
    "Close",
    "Volume",
    "TurnoverValue",
    "AdjustmentFactor",
    "AdjustmentOpen",
    "AdjustmentHigh",
    "AdjustmentLow",
    "AdjustmentClose",
    "AdjustmentVolume",
    "Code",
  ];
  const keys = new Set();
  for (const r of rows) Object.keys(r ?? {}).forEach((k) => keys.add(k));
  const rest = [...keys].filter((k) => !preferred.includes(k)).sort((a, b) => a.localeCompare(b));
  return [...preferred.filter((k) => keys.has(k)), ...rest];
}

function renderTable(rows, columns) {
  if (!rows || rows.length === 0) {
    ui.tableWrap.innerHTML = "";
    ui.btnDownloadCsv.disabled = true;
    return;
  }

  const thead = `<thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => {
      return `<tr>${columns
        .map((c) => `<td>${escapeHtml(formatCell(r?.[c]))}</td>`)
        .join("")}</tr>`;
    })
    .join("")}</tbody>`;
  ui.tableWrap.innerHTML = `<table>${thead}${tbody}</table>`;
  ui.btnDownloadCsv.disabled = false;
}

function formatCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toCsv(rows, columns) {
  const esc = (value) => {
    const s = formatCell(value);
    if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  const header = columns.map((c) => esc(c)).join(",");
  const lines = rows.map((r) => columns.map((c) => esc(r?.[c])).join(","));
  return [header, ...lines].join("\n");
}

function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function getIdTokenFromRefresh(refreshToken) {
  // J-Quants doc: /token/auth_refresh?refreshtoken=xxx (POST)
  // Some environments accept GET as well, so try POST then GET.
  const query = { refreshtoken: refreshToken };
  try {
    const res = await apiFetch("/token/auth_refresh", { method: "POST", query });
    return res?.idToken ?? res?.id_token ?? res?.token ?? "";
  } catch (e) {
    logLine("auth_refresh(POST)失敗。GETで再試行します。", { message: e.message, url: e.url, details: e.details });
    const res = await apiFetch("/token/auth_refresh", { method: "GET", query });
    return res?.idToken ?? res?.id_token ?? res?.token ?? "";
  }
}

async function getRefreshTokenFromUser({ mailaddress, password }) {
  // J-Quants: POST /token/auth_user -> { refreshToken }
  // 環境差で body 形式が異なることがあるため、複数形式で試行する。
  const candidates = [
    { kind: "json(mailaddress)", body: { mailaddress, password } },
    { kind: "json(mailAddress)", body: { mailAddress: mailaddress, password } },
    { kind: "form", body: new URLSearchParams({ mailaddress, password }) },
  ];

  let lastErr = null;
  for (const c of candidates) {
    try {
      const res = await apiFetch("/token/auth_user", { method: "POST", body: c.body });
      const token = res?.refreshToken ?? res?.refresh_token ?? res?.refreshtoken ?? "";
      if (token) return token;
      lastErr = new Error(`refreshToken を取得できませんでした（レスポンス形式が想定外: ${c.kind}）`);
    } catch (e) {
      // 認証情報が正しくても形式不一致で400になるケースを想定し、次候補へ。
      lastErr = e;
      logLine("auth_user 形式を変えて再試行します。", { tried: c.kind, message: e?.message, details: e?.details });
    }
  }
  throw lastErr ?? new Error("refreshToken を取得できませんでした");
}

async function fetchDailyQuotes({ code, from, to }) {
  return await apiFetch("/prices/daily_quotes", {
    method: "GET",
    auth: true,
    query: { code, from, to },
  });
}

function setIdToken(token) {
  state.idToken = token || "";
  ui.idToken.value = state.idToken;
}

function clearAll() {
  state = { idToken: "", lastRows: null, lastColumns: null };
  ui.idToken.value = "";
  ui.refreshToken.value = "";
  ui.mailaddress.value = "";
  ui.password.value = "";
  ui.summary.textContent = "";
  ui.tableWrap.innerHTML = "";
  ui.btnDownloadCsv.disabled = true;
  localStorage.removeItem(LS_KEYS.refreshToken);
  logLine("トークンを消去しました。");
}

function suggestFilename(code, from, to) {
  const parts = ["jquants", "daily_quotes"];
  if (code) parts.push(code);
  if (from) parts.push(from);
  if (to) parts.push(to);
  return `${parts.join("_")}.csv`;
}

function setSummary(text) {
  ui.summary.textContent = text || "";
}

// Wire up
restoreSettings();
function updateBaseUrlPlaceholder() {
  ui.baseUrl.placeholder = ui.transport.value === "proxy" ? DEFAULT_BASE_PROXY : DEFAULT_BASE_DIRECT;
}
updateBaseUrlPlaceholder();
if (!ui.baseUrl.value.trim()) ui.baseUrl.value = "";

ui.transport.addEventListener("change", () => {
  // if switching and baseUrl empty, keep default behavior via placeholder logic in getBaseUrl()
  persistSettings();
  updateBaseUrlPlaceholder();
  logLine(`接続モード変更: ${ui.transport.value}`);
});
ui.baseUrl.addEventListener("change", persistSettings);
ui.rememberRefresh.addEventListener("change", persistSettings);
ui.refreshToken.addEventListener("change", persistSettings);

ui.btnClearLog.addEventListener("click", () => {
  ui.log.textContent = "";
});

ui.btnClearTokens.addEventListener("click", clearAll);

ui.btnCopyIdToken.addEventListener("click", async () => {
  const t = ui.idToken.value.trim();
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    logLine("idToken をクリップボードにコピーしました。");
  } catch (e) {
    logLine("コピーに失敗しました（ブラウザ制約の可能性）。", String(e?.message ?? e));
  }
});

ui.btnGetRefreshToken.addEventListener("click", async () => {
  setBusy(true);
  try {
    const mailaddress = ui.mailaddress.value.trim();
    const password = ui.password.value;
    if (!mailaddress) throw new Error("メールアドレスを入力してください");
    if (!password) throw new Error("パスワードを入力してください");

    logLine("refreshToken 取得中…", { baseUrl: getBaseUrl() });
    const refreshToken = await getRefreshTokenFromUser({ mailaddress, password });
    if (!refreshToken) throw new Error("refreshToken を取得できませんでした（レスポンス形式が想定外）");

    ui.refreshToken.value = refreshToken;
    persistSettings();
    logLine("refreshToken 取得成功。refreshToken 欄にセットしました。");
  } catch (e) {
    logLine("refreshToken 取得失敗。", normalizeError(e));
  } finally {
    setBusy(false);
  }
});

ui.btnGetIdToken.addEventListener("click", async () => {
  setBusy(true);
  try {
    const refreshToken = ui.refreshToken.value.trim();
    if (!refreshToken) throw new Error("refreshToken を入力してください");
    persistSettings();

    logLine("idToken 取得中…", { baseUrl: getBaseUrl() });
    const idToken = await getIdTokenFromRefresh(refreshToken);
    if (!idToken) throw new Error("idToken を取得できませんでした（レスポンス形式が想定外）");
    setIdToken(idToken);
    logLine("idToken 取得成功。");
  } catch (e) {
    logLine("idToken 取得失敗。", normalizeError(e));
  } finally {
    setBusy(false);
  }
});

ui.btnFetchDaily.addEventListener("click", async () => {
  setBusy(true);
  try {
    const code = normalizeCode(ui.code.value);
    const from = normalizeYmd(ui.from.value);
    const to = normalizeYmd(ui.to.value);
    if (!code) throw new Error("銘柄コードを入力してください（例: 7203）");

    logLine("日次株価 取得中…", { baseUrl: getBaseUrl(), code, from, to });
    const payload = await fetchDailyQuotes({ code, from, to });
    const rows = extractRows(payload);
    const columns = makeColumns(rows);

    state.lastRows = rows;
    state.lastColumns = columns;

    setSummary(`取得件数: ${rows.length}件 / columns: ${columns.length} / code: ${code}`);
    renderTable(rows, columns);
    logLine("取得成功（payload概要）", {
      topLevelKeys: payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : "(array)",
      rows: rows.length,
    });
  } catch (e) {
    setSummary("");
    ui.tableWrap.innerHTML = "";
    ui.btnDownloadCsv.disabled = true;
    logLine("日次株価 取得失敗。", normalizeError(e));
  } finally {
    setBusy(false);
  }
});

ui.btnDownloadCsv.addEventListener("click", () => {
  if (!state.lastRows || !state.lastColumns) return;
  const code = normalizeCode(ui.code.value);
  const from = ui.from.value.trim().replaceAll("-", "");
  const to = ui.to.value.trim().replaceAll("-", "");
  const csv = toCsv(state.lastRows, state.lastColumns);
  downloadText(suggestFilename(code, from, to), csv, "text/csv");
});

function normalizeError(e) {
  const obj = {
    message: e?.message ?? String(e),
  };
  if (e?.url) obj.url = e.url;
  if (e?.details) obj.details = e.details;
  return obj;
}

// initial log
logLine("起動しました。", { baseUrl: getBaseUrl(), transport: ui.transport.value });

