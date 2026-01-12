## J-Quants 株価ビューア（ブラウザで動作）

J-Quantsのトークンを使って、ブラウザで日次株価を取得・表示・CSV出力する簡易ツールです。

### できること

- **refreshToken → idToken を取得**
- **メール/パスワード（auth_user）→ refreshToken を取得（refreshTokenが見つからない場合）**
- **日次株価（Daily Quotes）を取得して表で表示**
- **取得結果をCSVでダウンロード**

### 重要な注意（セキュリティ）

- **ブラウザで動かす都合上、トークン（APIキー相当）が端末に入力されます。**
- 公開環境や共有PCでは使わないでください。
- さらに、ブラウザから `https://api.jquants.com` に直接アクセスすると **CORS** で失敗する場合があります。その場合はローカルプロキシを使ってください。

### 起動方法（おすすめ）

#### 1) 静的サーバで開く

`index.html` をファイル直開きではなく、ローカルサーバ経由で開くのがおすすめです。

```bash
python3 -m http.server 8000
```

ブラウザで `http://localhost:8000` を開きます。

#### 2) CORSで失敗する場合（ローカルプロキシ）

別ターミナルでプロキシを起動します（Node.js が必要です）。

```bash
node proxy/server.js
```

画面上部の **リクエスト方法** を「ブラウザ → ローカルプロキシ」に切り替え、`API Base URL` が空なら自動で `http://localhost:8787/api/v1` を使います。

### 使い方

1. **refreshToken** を入力して **idToken を取得**
   - refreshToken が見つからない場合は、画面の「メール/パスワードから取得」を開いて **refreshToken を取得**（`/token/auth_user`）
2. **銘柄コード（例: 7203）** と **From/To（YYYYMMDD）** を入れて **取得**
3. 表が出たら **CSV** ボタンでダウンロード

