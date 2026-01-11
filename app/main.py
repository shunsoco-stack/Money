from __future__ import annotations

import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
import yfinance as yf
from fastapi import FastAPI
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


app = FastAPI(title="Value Investing Screener", version="0.1.0")

_cache: dict[str, CacheEntry] = {}
_CACHE_TTL_SECONDS = 600.0

_BASE_DIR = Path(__file__).resolve().parents[1]
_WEB_DIR = _BASE_DIR / "web"


def _pick_pe(info: dict[str, Any]) -> tuple[float | None, str | None]:
    trailing = _to_float(info.get("trailingPE"))
    forward = _to_float(info.get("forwardPE"))
    if trailing is not None:
        return trailing, "trailingPE"
    if forward is not None:
        return forward, "forwardPE"
    return None, None


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


# ---- Static Frontend ----
app.mount("/static", StaticFiles(directory=str(_WEB_DIR), html=False), name="static")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((_WEB_DIR / "index.html").read_text(encoding="utf-8"))

