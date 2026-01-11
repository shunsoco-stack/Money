from __future__ import annotations

import math
import os
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import requests
import yfinance as yf
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                return None
            return float(value)
        return float(str(value).strip())
    except Exception:
        return None


def _normalize_symbol(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    # If user inputs Japanese 4-digit code, assume Tokyo and append ".T".
    if s.isdigit() and len(s) == 4:
        return f"{s}.T"
    return s


@dataclass
class CacheEntry:
    expires_at: float
    payload: dict[str, Any]


class QuoteRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list, description="Tickers, e.g. 7203.T or AAPL")
    per_max: float | None = Field(default=None, description="Max PER (<=). Uses trailingPE or forwardPE.")
    pbr_max: float | None = Field(default=None, description="Max PBR (<=). Uses priceToBook.")
    dividend_yield_min: float | None = Field(
        default=None,
        description="Min dividend yield (>=). Percent, e.g. 3.0 for 3%",
    )

class ScreenRequest(BaseModel):
    per_max: float | None = Field(default=None, description="Max PER (<=).")
    pbr_max: float | None = Field(default=None, description="Max PBR (<=).")
    dividend_yield_min: float | None = Field(default=None, description="Min dividend yield (>=). Percent.")
    include_etf: bool = Field(default=True, description="Include ETFs in universe.")
    limit: int = Field(default=200, ge=1, le=2000, description="Max number of results returned.")
    offset: int = Field(default=0, ge=0, description="Offset into the screened result set.")
    only_passes: bool = Field(default=True, description="If true, return only items that pass filters.")


app = FastAPI(title="Value Investing Screener", version="0.1.0")

_cache: dict[str, CacheEntry] = {}
_CACHE_TTL_SECONDS = 600.0

_BASE_DIR = Path(__file__).resolve().parents[1]
_WEB_DIR = _BASE_DIR / "web"

_JQUANTS_BASE = "https://api.jquants.com/v1"
_jwt_re = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


def _pick_pe(info: dict[str, Any]) -> tuple[float | None, str | None]:
    trailing = _to_float(info.get("trailingPE"))
    forward = _to_float(info.get("forwardPE"))
    if trailing is not None:
        return trailing, "trailingPE"
    if forward is not None:
        return forward, "forwardPE"
    return None, None


def _env(name: str) -> str | None:
    v = os.environ.get(name)
    if v is None:
        return None
    v = v.strip()
    return v or None


def _ensure_jquants_configured() -> None:
    # Prefer ID token if provided; otherwise refresh token; otherwise email/password.
    if _env("JQUANTS_ID_TOKEN") or _env("JQUANTS_REFRESH_TOKEN") or (_env("JQUANTS_EMAIL") and _env("JQUANTS_PASSWORD")):
        return
    raise HTTPException(
        status_code=400,
        detail=(
            "J-Quantsの認証情報が未設定です。環境変数のいずれかを設定してください: "
            "JQUANTS_ID_TOKEN または JQUANTS_REFRESH_TOKEN または (JQUANTS_EMAIL と JQUANTS_PASSWORD)"
        ),
    )


_jq_token_cache: dict[str, CacheEntry] = {}


def _jq_get_id_token() -> str:
    # 1) If user provides a JWT-like token directly, use it.
    idt = _env("JQUANTS_ID_TOKEN")
    if idt:
        return idt

    # 2) Cached token from refresh.
    now = time.time()
    cached = _jq_token_cache.get("idToken")
    if cached and cached.expires_at > now:
        return str(cached.payload["idToken"])

    refresh = _env("JQUANTS_REFRESH_TOKEN")
    if not refresh:
        email = _env("JQUANTS_EMAIL")
        password = _env("JQUANTS_PASSWORD")
        if not email or not password:
            _ensure_jquants_configured()
            raise HTTPException(status_code=400, detail="J-Quantsの認証情報が不完全です。")
        # Auth user -> refreshToken
        r = requests.post(
            f"{_JQUANTS_BASE}/token/auth_user",
            json={"mailaddress": email, "password": password},
            timeout=15,
        )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"J-Quants auth_user失敗: HTTP {r.status_code}: {r.text}")
        refresh = (r.json() or {}).get("refreshToken")
        if not refresh:
            raise HTTPException(status_code=502, detail="J-Quants auth_userのrefreshTokenが取得できませんでした。")

    # Refresh -> idToken
    r2 = requests.post(
        f"{_JQUANTS_BASE}/token/auth_refresh",
        json={"refreshToken": refresh},
        timeout=15,
    )
    if r2.status_code != 200:
        raise HTTPException(status_code=502, detail=f"J-Quants auth_refresh失敗: HTTP {r2.status_code}: {r2.text}")
    id_token = (r2.json() or {}).get("idToken")
    if not id_token:
        raise HTTPException(status_code=502, detail="J-Quants auth_refreshのidTokenが取得できませんでした。")

    # Cache ~50 minutes (token TTL is typically 24h, but keep conservative).
    _jq_token_cache["idToken"] = CacheEntry(expires_at=now + 50 * 60, payload={"idToken": id_token})
    return id_token


def _jq_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    token = _jq_get_id_token()
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(f"{_JQUANTS_BASE}{path}", params=params or {}, headers=headers, timeout=30)
    if r.status_code == 401:
        # Retry once after forcing refresh if token is cached.
        _jq_token_cache.pop("idToken", None)
        token = _jq_get_id_token()
        headers = {"Authorization": f"Bearer {token}"}
        r = requests.get(f"{_JQUANTS_BASE}{path}", params=params or {}, headers=headers, timeout=30)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"J-Quants API失敗 {path}: HTTP {r.status_code}: {r.text}")
    return r.json() or {}


def _jq_paginate(path: str, params: dict[str, Any] | None = None, data_key: str = "info") -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    p = dict(params or {})
    while True:
        data = _jq_get(path, p)
        chunk = data.get(data_key) or data.get("data") or data.get("items") or []
        if isinstance(chunk, list):
            out.extend([c for c in chunk if isinstance(c, dict)])
        pagination_key = data.get("pagination_key")
        if not pagination_key:
            break
        p["pagination_key"] = pagination_key
    return out


def _jq_is_etf(row: dict[str, Any]) -> bool:
    # Try multiple possible field names (API schemas can vary).
    raw = (
        row.get("ProductCategory")
        or row.get("ProductCategoryName")
        or row.get("SecurityType")
        or row.get("SecurityTypeName")
        or row.get("MarketSection")
        or ""
    )
    s = str(raw).upper()
    return ("ETF" in s) or ("ETN" in s)


def _jq_get_universe(include_etf: bool) -> list[dict[str, Any]]:
    # Cache universe for 24h.
    key = f"jquants_universe_{'etf' if include_etf else 'noetf'}"
    now = time.time()
    cached = _cache.get(key)
    if cached and cached.expires_at > now:
        return list(cached.payload["universe"])

    _ensure_jquants_configured()
    rows = _jq_paginate("/listed/info", params={}, data_key="info")
    universe: list[dict[str, Any]] = []
    for r in rows:
        code = str(r.get("Code") or r.get("code") or "").strip()
        if not code:
            continue
        name = r.get("CompanyName") or r.get("CompanyNameEnglish") or r.get("Name") or r.get("IssueName")
        is_etf = _jq_is_etf(r)
        if (not include_etf) and is_etf:
            continue
        universe.append(
            {
                "code": code,
                "name": name,
                "isEtf": is_etf,
            }
        )

    _cache[key] = CacheEntry(expires_at=now + 24 * 60 * 60, payload={"universe": universe})
    return universe


def _date_window(days_back: int = 14) -> tuple[str, str]:
    # J-Quants uses YYYY-MM-DD.
    today = date.today()
    start = today - timedelta(days=days_back)
    return start.isoformat(), today.isoformat()


def _jq_get_latest_quotes(codes: list[str]) -> dict[str, dict[str, Any]]:
    """
    Returns mapping: code -> latest quote row (by Date) within recent window.

    Note: We don't assume a strict schema; we try common field names.
    """
    # Cache for 10 minutes by code set hash-ish (order independent).
    now = time.time()
    key = "jq_quotes_" + str(hash(tuple(sorted(codes))))
    cached = _cache.get(key)
    if cached and cached.expires_at > now:
        return dict(cached.payload["by_code"])

    _ensure_jquants_configured()
    start, end = _date_window(21)
    # Many endpoints accept date range; if not supported, this will error and bubble with detail.
    rows: list[dict[str, Any]] = []
    # If API supports code filtering, do it in chunks; else fetch whole range.
    # We'll try with 'code' param; if that fails we fall back to no-code fetch.
    def _fetch_for_params(p: dict[str, Any]) -> list[dict[str, Any]]:
        return _jq_paginate("/prices/daily_quotes", params=p, data_key="daily_quotes")

    chunk_size = 200
    try:
        for i in range(0, len(codes), chunk_size):
            chunk = codes[i : i + chunk_size]
            rows.extend(_fetch_for_params({"from": start, "to": end, "code": ",".join(chunk)}))
    except HTTPException:
        rows = _fetch_for_params({"from": start, "to": end})

    by_code: dict[str, dict[str, Any]] = {}
    for r in rows:
        code = str(r.get("Code") or r.get("code") or "").strip()
        if code and code not in set(codes):
            continue
        d = str(r.get("Date") or r.get("date") or "").strip()
        if not code or not d:
            continue
        prev = by_code.get(code)
        if prev is None or str(prev.get("Date") or prev.get("date") or "") < d:
            by_code[code] = r

    _cache[key] = CacheEntry(expires_at=now + 10 * 60, payload={"by_code": by_code})
    return by_code


def _get_quote(symbol: str) -> dict[str, Any]:
    now = time.time()
    cached = _cache.get(symbol)
    if cached and cached.expires_at > now:
        return cached.payload

    t = yf.Ticker(symbol)

    info: dict[str, Any] = {}
    fast: dict[str, Any] = {}
    error: str | None = None

    try:
        fi = getattr(t, "fast_info", None)
        if fi:
            # yfinance exposes FastInfo object; cast to dict-ish
            fast = dict(fi)
    except Exception:
        fast = {}

    try:
        # NOTE: `info` is heavier but contains valuation/dividend fields.
        info = t.info or {}
    except Exception as e:
        error = f"Failed to load ticker info: {e}"
        info = {}

    last_price = _to_float(fast.get("last_price")) or _to_float(info.get("regularMarketPrice"))
    price_source = "yfinance"
    currency = info.get("currency") or fast.get("currency")

    pe, pe_source = _pick_pe(info)
    pbr = _to_float(info.get("priceToBook"))

    # Dividend fields are inconsistent; prefer dividendRate/yield from info.
    dividend_rate = _to_float(info.get("dividendRate"))  # annual per-share dividend (often forward)
    dividend_yield = _to_float(info.get("dividendYield"))  # fraction, e.g. 0.03

    # If dividend_yield missing but we have dividend_rate and price, estimate.
    if dividend_yield is None and dividend_rate is not None and last_price:
        dividend_yield = dividend_rate / last_price

    # Fallback: when yfinance is rate-limited or missing, fetch last price from stooq.
    if last_price is None:
        stooq_price = _get_stooq_last_price(symbol)
        if stooq_price is not None:
            last_price = stooq_price
            price_source = "stooq"
            if currency is None:
                currency = _infer_currency(symbol)

    payload = {
        "symbol": symbol,
        "shortName": info.get("shortName") or info.get("longName"),
        "currency": currency,
        "lastPrice": last_price,
        "priceSource": price_source,
        "pe": pe,
        "peSource": pe_source,
        "pbr": pbr,
        "dividendRate": dividend_rate,
        "dividendYield": (dividend_yield * 100.0) if dividend_yield is not None else None,  # percent
        "marketCap": _to_float(info.get("marketCap")),
        "source": "yfinance",
        "error": error,
    }

    _cache[symbol] = CacheEntry(expires_at=now + _CACHE_TTL_SECONDS, payload=payload)
    return payload


def _infer_currency(symbol: str) -> str | None:
    s = (symbol or "").upper()
    if s.endswith(".T") or s.endswith(".JP"):
        return "JPY"
    if s.endswith(".US") or (("." not in s) and s.isalpha()):
        return "USD"
    return None


def _to_stooq_symbol(symbol: str) -> str:
    s = (symbol or "").strip()
    if not s:
        return s
    # Tokyo: 7203.T -> 7203.jp
    if s.upper().endswith(".T"):
        return f"{s[:-2]}.jp".lower()
    # US: AAPL -> aapl.us
    if "." not in s and s.isalpha():
        return f"{s}.us".lower()
    # If user provides AAPL.US / 7203.JP etc.
    return s.lower()


def _get_stooq_last_price(symbol: str) -> float | None:
    stooq_symbol = _to_stooq_symbol(symbol)
    # CSV: often a single line without header:
    # Symbol,Date,Time,Open,High,Low,Close,Volume,(OpenInt)
    url = f"https://stooq.com/q/l/?s={stooq_symbol}&i=d"
    try:
        r = requests.get(url, timeout=10)
        if r.status_code != 200:
            return None
        text = (r.text or "").strip()
        if not text:
            return None
        lines = text.splitlines()

        # If response includes header, use it.
        if len(lines) >= 2 and lines[0].lower().startswith("symbol,"):
            header = lines[0].split(",")
            values = lines[1].split(",")
            if len(header) != len(values):
                return None
            row = dict(zip(header, values))
            close = row.get("Close")
            if not close or close.upper() == "N/A":
                return None
            return _to_float(close)

        # Otherwise, parse first line as values.
        values = lines[0].split(",")
        if len(values) < 7:
            return None
        close = values[6]
        if not close or close.upper() == "N/A":
            return None
        return _to_float(close)
    except Exception:
        return None


def _passes_filters(q: dict[str, Any], req: QuoteRequest) -> tuple[bool, list[str]]:
    reasons: list[str] = []

    # PER
    if req.per_max is not None:
        pe = _to_float(q.get("pe"))
        if pe is None:
            reasons.append("PERが取得できません")
        elif pe > req.per_max:
            reasons.append(f"PER {pe:.2f} > {req.per_max:.2f}")

    # PBR
    if req.pbr_max is not None:
        pbr = _to_float(q.get("pbr"))
        if pbr is None:
            reasons.append("PBRが取得できません")
        elif pbr > req.pbr_max:
            reasons.append(f"PBR {pbr:.2f} > {req.pbr_max:.2f}")

    # Dividend yield
    if req.dividend_yield_min is not None:
        dy = _to_float(q.get("dividendYield"))  # percent
        if dy is None:
            reasons.append("配当利回りが取得できません")
        elif dy < req.dividend_yield_min:
            reasons.append(f"配当利回り {dy:.2f}% < {req.dividend_yield_min:.2f}%")

    return (len(reasons) == 0), reasons


def _passes_filters_screen(item: dict[str, Any], req: ScreenRequest) -> tuple[bool, list[str]]:
    # Reuse the same semantics as quotes endpoint.
    qr = QuoteRequest(
        symbols=[],
        per_max=req.per_max,
        pbr_max=req.pbr_max,
        dividend_yield_min=req.dividend_yield_min,
    )
    return _passes_filters(item, qr)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/quotes")
def quotes(req: QuoteRequest) -> dict[str, Any]:
    symbols = [_normalize_symbol(s) for s in req.symbols]
    symbols = [s for s in symbols if s]
    symbols = list(dict.fromkeys(symbols))  # stable unique

    results: list[dict[str, Any]] = []
    for s in symbols:
        q = _get_quote(s)
        ok, reasons = _passes_filters(q, req)
        results.append({**q, "passes": ok, "reasons": reasons})

    # Sort: passing first, then higher dividend yield, then lower PER.
    def _sort_key(item: dict[str, Any]) -> tuple[int, float, float]:
        passes = 0 if item.get("passes") else 1
        dy = _to_float(item.get("dividendYield")) or -1.0
        pe = _to_float(item.get("pe")) or 1e9
        return (passes, -dy, pe)

    results.sort(key=_sort_key)
    return {"count": len(results), "results": results}


@app.post("/api/screen")
def screen(req: ScreenRequest) -> dict[str, Any]:
    """
    Universe-based screener (no symbol input):
    - Universe: JPX listed equities + (optional) ETFs from J-Quants listed/info
    - Latest quote: J-Quants prices/daily_quotes (recent window, choose latest per code)
    - Metrics: if provided by API row, return; otherwise leave null.
    """
    universe = _jq_get_universe(include_etf=req.include_etf)
    # Take codes
    codes = [u["code"] for u in universe]
    if not codes:
        return {"count": 0, "total": 0, "results": [], "asOfDate": None, "universeCount": 0}

    # Quotes for all codes can be large; we fetch for all then filter server-side.
    # For personal use, this is acceptable with caching and a recent window.
    by_code = _jq_get_latest_quotes(codes)

    results: list[dict[str, Any]] = []
    as_of: str | None = None

    u_by_code = {u["code"]: u for u in universe}

    for code, q in by_code.items():
        u = u_by_code.get(code, {})
        d = str(q.get("Date") or q.get("date") or "").strip() or None
        if d and (as_of is None or as_of < d):
            as_of = d

        # Try common fields for last price and metrics; leave None if missing.
        last_price = (
            _to_float(q.get("Close"))
            or _to_float(q.get("AdjustmentClose"))
            or _to_float(q.get("close"))
            or _to_float(q.get("adjClose"))
        )
        per = _to_float(q.get("PER") or q.get("Per") or q.get("pe") or q.get("PE") or q.get("PriceEarningsRatio"))
        pbr = _to_float(q.get("PBR") or q.get("Pbr") or q.get("pb") or q.get("PB") or q.get("PriceBookRatio"))
        dy = _to_float(
            q.get("DividendYield") or q.get("dividendYield") or q.get("DY") or q.get("Dividend_Yield")
        )
        # Many APIs use fraction; if it looks like <= 1.0, assume fraction and convert to percent.
        if dy is not None and dy <= 1.0:
            dy = dy * 100.0

        item = {
            "symbol": f"{code}.T",  # display-friendly for Japanese tickers
            "code": code,
            "shortName": u.get("name"),
            "isEtf": bool(u.get("isEtf")),
            "currency": "JPY",
            "lastPrice": last_price,
            "priceSource": "jquants",
            "pe": per,
            "peSource": "jquants",
            "pbr": pbr,
            "dividendRate": None,
            "dividendYield": dy,
            "source": "jquants",
            "asOfDate": d,
            "error": None,
        }
        ok, reasons = _passes_filters_screen(item, req)
        item["passes"] = ok
        item["reasons"] = reasons
        if req.only_passes and not ok:
            continue
        results.append(item)

    # Sort: passing first, then higher dividend yield, then lower PER, then code.
    def _sort_key(item: dict[str, Any]) -> tuple[int, float, float, str]:
        passes = 0 if item.get("passes") else 1
        dy = _to_float(item.get("dividendYield")) or -1.0
        pe = _to_float(item.get("pe")) or 1e9
        return (passes, -dy, pe, str(item.get("code") or ""))

    results.sort(key=_sort_key)
    total = len(results)
    sliced = results[req.offset : req.offset + req.limit]
    return {
        "count": len(sliced),
        "total": total,
        "results": sliced,
        "asOfDate": as_of,
        "universeCount": len(universe),
    }


# ---- Static Frontend ----
app.mount("/static", StaticFiles(directory=str(_WEB_DIR), html=False), name="static")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((_WEB_DIR / "index.html").read_text(encoding="utf-8"))

