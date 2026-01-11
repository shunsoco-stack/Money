function parseNumberOrNull(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function formatNum(v, digits = 2) {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatMaybe(v, digits = 2) {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return formatNum(n, digits);
}

function splitSymbols(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg || "";
}

function setLoading(isLoading) {
  const runBtn = document.getElementById("runBtn");
  runBtn.disabled = isLoading;
  runBtn.textContent = isLoading ? "取得中..." : "取得する";
}

function getEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`画面要素が見つかりません: #${id}（古いHTML/JSが混在している可能性があります）`);
  return el;
}

function badge(passes) {
  const cls = passes ? "badge ok" : "badge ng";
  const txt = passes ? "OK" : "NG";
  return `<span class="${cls}">${txt}</span>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderRows(items) {
  const body = document.getElementById("resultsBody");
  if (!items || items.length === 0) {
    body.innerHTML = `<tr><td colspan="13" class="muted">該当データがありません。</td></tr>`;
    return;
  }

  body.innerHTML = items
    .map((r) => {
      const reasons = (r.reasons || []).join(" / ");
      const err = r.error ? `取得エラー: ${r.error}` : "";
      const why = [reasons, err].filter(Boolean).join(" / ");

      return `<tr>
        <td>${badge(!!r.passes)}</td>
        <td>${escapeHtml(r.symbol)}</td>
        <td>${escapeHtml(r.shortName || "-")}</td>
        <td class="num">${formatMaybe(r.lastPrice, 2)}</td>
        <td>${escapeHtml(r.priceSource || "-")}</td>
        <td>${escapeHtml(r.currency || "-")}</td>
        <td class="num">${formatMaybe(r.pe, 2)}</td>
        <td>${escapeHtml(r.peSource || "-")}</td>
        <td class="num">${formatMaybe(r.pbr, 2)}</td>
        <td class="num">${formatMaybe(r.dividendRate, 2)}</td>
        <td class="num">${formatMaybe(r.dividendYield, 2)}</td>
        <td>${escapeHtml(r.asOfDate || "-")}</td>
        <td class="muted">${escapeHtml(why || "-")}</td>
      </tr>`;
    })
    .join("");
}

let mode = "screen"; // 'screen' or 'quotes'

function setMode(nextMode) {
  mode = nextMode;
  const tabScreen = document.getElementById("tabScreen");
  const tabQuotes = document.getElementById("tabQuotes");
  const symbolsField = document.getElementById("symbolsField");
  const screenOptions = document.getElementById("screenOptions");

  const isScreen = mode === "screen";
  tabScreen.classList.toggle("active", isScreen);
  tabQuotes.classList.toggle("active", !isScreen);
  symbolsField.classList.toggle("hidden", isScreen);
  screenOptions.classList.toggle("hidden", !isScreen);
}

async function run() {
  const perMax = parseNumberOrNull(getEl("perMax").value);
  const pbrMax = parseNumberOrNull(getEl("pbrMax").value);
  const divMin = parseNumberOrNull(getEl("divMin").value);

  setLoading(true);
  setStatus("取得中です（時間がかかる場合があります）...");

  try {
    let resp;
    if (mode === "quotes") {
      const symbols = splitSymbols(getEl("symbols").value);
      if (symbols.length === 0) {
        setStatus("銘柄が未入力です。");
        renderRows([]);
        return;
      }
      resp = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbols,
          per_max: perMax,
          pbr_max: pbrMax,
          dividend_yield_min: divMin,
        }),
      });
    } else {
      const limit = parseNumberOrNull(getEl("limit").value) ?? 200;
      const offset = parseNumberOrNull(getEl("offset").value) ?? 0;
      const includeEtf = !!getEl("includeEtf").checked;
      resp = await fetch("/api/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          per_max: perMax,
          pbr_max: pbrMax,
          dividend_yield_min: divMin,
          include_etf: includeEtf,
          limit,
          offset,
          only_passes: true,
        }),
      });
    }

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${t}`);
    }

    const data = await resp.json();
    renderRows(data.results);
    if (mode === "screen") {
      const extra = data.asOfDate ? ` / asOf=${data.asOfDate}` : "";
      setStatus(`取得完了: 表示 ${data.count} 件 / 全 ${data.total} 件${extra}`);
    } else {
      setStatus(`取得完了: ${data.count} 件`);
    }
  } catch (e) {
    setStatus(`エラー: ${e?.message || e}`);
    renderRows([]);
  } finally {
    setLoading(false);
  }
}

function demo() {
  getEl("perMax").value = "12";
  getEl("pbrMax").value = "1.5";
  getEl("divMin").value = "2.5";
  if (mode === "quotes") {
    getEl("symbols").value = ["7203", "9432", "8306", "AAPL"].join(
      "\n",
    );
  } else {
    getEl("limit").value = "200";
    getEl("offset").value = "0";
    getEl("includeEtf").checked = true;
  }
}

function init() {
  // If JS is running, clear initial message.
  setStatus("");

  getEl("runBtn").addEventListener("click", run);
  getEl("demoBtn").addEventListener("click", demo);

  getEl("tabScreen").addEventListener("click", () => setMode("screen"));
  getEl("tabQuotes").addEventListener("click", () => setMode("quotes"));

  setMode("screen");
}

try {
  init();
} catch (e) {
  const msg = e?.message || String(e);
  // Show on screen so user doesn't need DevTools.
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = `初期化エラー: ${msg}`;
}

