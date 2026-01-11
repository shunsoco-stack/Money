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
    body.innerHTML = `<tr><td colspan="12" class="muted">該当データがありません。</td></tr>`;
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
        <td class="muted">${escapeHtml(why || "-")}</td>
      </tr>`;
    })
    .join("");
}

async function run() {
  const perMax = parseNumberOrNull(document.getElementById("perMax").value);
  const pbrMax = parseNumberOrNull(document.getElementById("pbrMax").value);
  const divMin = parseNumberOrNull(document.getElementById("divMin").value);
  const symbols = splitSymbols(document.getElementById("symbols").value);

  if (symbols.length === 0) {
    setStatus("銘柄が未入力です。");
    renderRows([]);
    return;
  }

  setLoading(true);
  setStatus("取得中です（銘柄数が多いと時間がかかります）...");

  try {
    const resp = await fetch("/api/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols,
        per_max: perMax,
        pbr_max: pbrMax,
        dividend_yield_min: divMin,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${t}`);
    }

    const data = await resp.json();
    renderRows(data.results);
    setStatus(`取得完了: ${data.count} 件`);
  } catch (e) {
    setStatus(`エラー: ${e?.message || e}`);
    renderRows([]);
  } finally {
    setLoading(false);
  }
}

function demo() {
  document.getElementById("perMax").value = "12";
  document.getElementById("pbrMax").value = "1.5";
  document.getElementById("divMin").value = "2.5";
  document.getElementById("symbols").value = ["7203", "9432", "8306", "AAPL"].join(
    "\n",
  );
}

document.getElementById("runBtn").addEventListener("click", run);
document.getElementById("demoBtn").addEventListener("click", demo);

