## バリュー投資スクリーナー（ブラウザで動作）

希望する **PER / PBR / 配当利回り** を指定し、銘柄コード（例: `7203`）やティッカー（例: `AAPL`）の
**最新株価・PER・PBR・（取得できれば）予想1株配当（年）**などを取得して一覧表示します。

データ取得元は `yfinance`（Yahoo Finance由来）です。銘柄によってはPER/PBR/配当が取得できない場合があります。
また、`yfinance` がレート制限になる場合があるため、**株価（lastPrice）は stooq からフォールバック**することがあります。

### 銘柄入力なし（上場銘柄＋ETFスクリーニング）

銘柄未入力でスクリーニングしたい場合は **J-Quants** を利用します（個人利用）。  
環境変数で認証情報を設定したうえで、画面の「銘柄入力なし（スクリーニング）」タブから実行してください。

- 必要な環境変数（いずれか）
  - `JQUANTS_API_KEY`（ポータルの「API Key」。※一部/全てのAPIで必要な場合があります）
  - `JQUANTS_ID_TOKEN`（推奨: 取得済みのIDトークンを設定）
  - `JQUANTS_REFRESH_TOKEN`（refreshから自動でidTokenを取得）
  - `JQUANTS_EMAIL` と `JQUANTS_PASSWORD`（アプリがrefresh/idを取得）

### 起動方法

```bash
python3 -m venv .venv
source .venv/bin/activate
pip3 install -r requirements.txt

python3 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

ブラウザで `http://localhost:8000` を開いてください。

### 使い方

- **PER 上限**: 指定すると「PERがその値以下」の銘柄をOK判定（取得できない場合はNG理由に表示）
- **PBR 上限**: 指定すると「PBRがその値以下」の銘柄をOK判定
- **配当利回り 下限%**: 指定すると「配当利回りがその値以上」の銘柄をOK判定
- **銘柄入力**:
  - 1行1銘柄
  - 日本株は4桁なら自動で `.T` を付与（例: `7203` → `7203.T`）

### API

- `GET /api/health`
- `POST /api/quotes`
  - body例:
    - `{"symbols":["7203","AAPL"],"per_max":12,"pbr_max":1.5,"dividend_yield_min":2.5}`
- `POST /api/screen`（J-Quantsが必要）
  - body例:
    - `{"per_max":12,"pbr_max":1.5,"dividend_yield_min":2.5,"include_etf":true,"limit":200,"offset":0}`
