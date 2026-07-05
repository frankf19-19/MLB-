# MLB 每日預測 + AI 分析

單一 `index.html` 的即時網站(比賽預測、Gameday、球隊名單、球員生涯)+
GitHub Actions 每天自動產生的繁體中文 AI 分析(`analysis.json`)。

## 檔案
- `index.html` — 網站本體(所有即時功能)
- `update.py` — 每日 AI 分析產生器(GitHub Actions 執行)
- `.github/workflows/daily.yml` — 排程(每天 13:00 UTC = 台灣 21:00)
- `analysis.json` — 由 Action 自動產生與更新

## 啟用 AI 分析
1. repo → Settings → Secrets and variables → Actions → New repository secret
   名稱 `ANTHROPIC_API_KEY`,值填你在 console.anthropic.com 建立的 API 金鑰。
2. repo → Actions → 「MLB 每日 AI 分析」→ Run workflow 手動跑第一次。
3. 跑完後 `analysis.json` 會被 commit 回 repo,網站首頁在「今天」的日期就會出現「AI 每日分析」區塊。
4. 之後每天台灣 21:00 自動更新,不用管它。

沒設定金鑰時 Action 會自動略過,網站其他功能完全不受影響。
API 呼叫每天一次、一次幾百字,費用極低,但請留意金鑰只放 Secrets、不要放進任何檔案。
