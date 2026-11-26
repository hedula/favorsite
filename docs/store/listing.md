# Chrome 線上應用程式商店：商店資訊與填表對照

開發人員資訊主頁中的項目 ID：`kgejpdifpchclmfnafpignhfiejfefgp`
（上架後執行 `npm run mcp:install -- --extension-id kgejpdifpchclmfnafpignhfiejfefgp`）

「隱私權」分頁要填的內容見 [permission-justifications.md](permission-justifications.md)。

---

## 商店資訊（Store listing）

| 欄位 | 填入 |
| --- | --- |
| 套件 | `.output/favorsite-extension-0.2.0-chrome.zip` |
| 標題、摘要 | 由 manifest 帶入：`Favorsite`／118 字元的說明 |
| 類別 | 生產力 › 工具（Productivity › Tools） |
| 語言 | 中文（繁體）；英文說明附在詳細說明的後半 |
| 官方網址 | `https://hedula.dev`（已在 Search Console 驗證，需與開發人員帳戶同一個 Google 帳戶） |
| 首頁網址 | `https://github.com/hedula/favorsite` |
| 支援網址 | `https://github.com/hedula/favorsite/issues` |
| 圖示 | 套件內的 128×128 圖示 |
| 螢幕截圖 | `assets/screenshot-1-workspace.png`、`-2-preview`、`-3-duplicates`、`-4-history`（皆 1280×800，依序上傳） |
| 小型宣傳圖塊 | `assets/promo-small-440x280.png` |

截圖用假資料在暫時的 Chromium 設定檔中拍攝，重拍方式：先 `npm run build`，再執行 `node scripts/capture-store-screenshots.mjs`；宣傳圖塊用 `node scripts/render-promo-tile.mjs`。

### 詳細說明（Description）

```text
Favorsite 是在本機運作的 Chrome 書籤工作台。整理、去重、分類、檢查失效連結都先預覽差異，確認後才寫入，每一步都能一鍵復原。

主要功能
• 書籤搜尋：中英混合斷詞，支援 domain: 與 tag: 篩選，可依意思做語意搜尋。
• 自動分類：內建多語語意模型，在你的電腦上執行，不需連網、不需帳號。支援的 Chrome 也可使用裝置端 Gemini Nano。
• 重複書籤清理：分開列出完全相同與疑似重複的項目，刪除前先保存快照。
• 失效連結檢查：只對你授權的網站送出輕量請求，不帶 Cookie，可移到待清理資料夾或刪除。
• 差異預覽與復原：每次批次變更都先顯示前後差異，套用後可從歷程一鍵復原。
• 標籤與備份：為書籤加上標籤，匯出或還原 JSON 備份。
• 收錄本文：把正在閱讀的文章存進本機知識庫，之後可搜尋、問答並引用原文段落。
• 本機 MCP（選用）：安裝橋接程式後，ChatGPT、Claude Desktop 可唯讀查詢你指定的資料夾。

隱私
沒有伺服器，不蒐集、不上傳、不出售任何資料，也沒有分析或廣告追蹤。所有資料都存在你的瀏覽器裡，移除擴充功能時一併刪除。
隱私權政策：https://hedula.dev/favorsite/privacy

—

Favorsite is a local-first workspace for your Chrome bookmarks. Organize, de-duplicate, classify, and check for broken links with a diff preview before every change and one-click undo.

• Search with domain: and tag: filters, plus on-device semantic search.
• Auto-classify with a bundled multilingual model that runs on your computer, with no network or account needed. Gemini Nano is used where Chrome supports it.
• Clean up exact and likely duplicates, with a snapshot saved before anything is deleted.
• Check for broken links with lightweight requests sent only to sites you approve.
• Tag bookmarks, export or restore JSON backups, and save articles into a local knowledge base.
• Optional local MCP bridge for read-only access from ChatGPT or Claude Desktop.

No servers, no data collection, no analytics. Privacy policy: https://hedula.dev/favorsite/privacy
```

---

## 發布（Distribution）

| 欄位 | 建議 |
| --- | --- |
| 付款 | 免費 |
| 瀏覽權限 | 公開（想先自己測試可選「不公開」） |
| 發布地區 | 所有地區 |
