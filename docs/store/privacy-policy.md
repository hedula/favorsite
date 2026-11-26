# Favorsite 隱私權政策 / Privacy Policy

生效日期 / Effective date：2026-11-26
適用版本 / Applies to：Favorsite Chrome 擴充功能 0.2.0 以後版本

---

## 繁體中文

### 摘要

Favorsite 是在本機運作的書籤整理工具。**我們沒有伺服器，不蒐集、不上傳、不出售任何使用者資料，也不使用分析或廣告追蹤。** 所有資料都保存在你的瀏覽器裡，由你自己控制。

### 1. 擴充功能會處理哪些資料

| 資料 | 用途 | 存放位置 |
| --- | --- | --- |
| Chrome 書籤（標題、網址、資料夾結構、建立時間） | 顯示、搜尋、分類、搬移、去重與復原 | 讀寫 Chrome 原生書籤；索引與快照存於本機 IndexedDB |
| 你加上的標籤、整理方案、操作歷程與刪除前快照 | 預覽差異、套用及一鍵復原 | 本機 IndexedDB |
| 你主動「收錄本文」的網頁正文（標題、網址、可見文字段落） | 建立個人知識庫，供搜尋、問答與引用 | 本機 IndexedDB |
| 設定與 MCP 連線授權（只存權杖的 SHA-256 雜湊值） | 記住偏好、驗證本機 AI 客戶端 | 本機 IndexedDB |

Favorsite 不讀取瀏覽紀錄、Cookie、密碼、表單內容或付款資訊。只有在你按下「收錄本文」時，才會讀取當下那一個分頁的可見文字。

### 2. AI 功能全部在裝置上執行

- **本機語意模型**：多語語意模型（multilingual-e5-small）及其執行環境隨擴充功能一起安裝，在你的電腦上以 WebAssembly 執行，不會把文字傳到任何伺服器。
- **Gemini Nano**：若你的 Chrome 支援，Favorsite 會呼叫 Chrome 內建的裝置端 Prompt API。推論由 Chrome 在本機完成。Chrome 下載與管理該模型的方式依 Google 的條款處理，Favorsite 不參與。

### 3. 會連上網路的情況

Favorsite 只在以下情況連線，而且都由你主動觸發：

- **失效連結檢查**：你啟動檢查並授權特定網站後，Favorsite 才會向那些書籤網址送出 `HEAD`（必要時為少量 `GET`）請求，確認網頁是否還在。請求不帶 Cookie 或登入憑證，不送 Referrer，也不跟隨重新導向。本機、內網位址和帶有敏感參數的網址一律略過。為這次檢查新授權的網站權限，檢查結束後會自動撤銷；你也可以隨時在設定中撤銷。
- **開啟書籤或來源**：你點擊連結時，Chrome 會照常開啟該網頁。

除此之外，Favorsite 不會連到開發者或任何第三方的伺服器。

### 4. 與本機 AI 客戶端分享（MCP，預設關閉）

你可以自行安裝本機橋接程式，讓 ChatGPT、Claude Desktop 等支援 MCP 的應用程式讀取你的書籤與收錄內容：

- 預設**關閉**。你需要在設定中建立連線，並指定開放哪些資料夾、是否包含收錄的正文。
- 資料透過 Chrome 原生訊息（Native Messaging）傳給你電腦上的橋接程式，只提供唯讀查詢，無法修改或刪除書籤。
- 一旦資料交給 AI 客戶端，後續處理（例如送到該服務的雲端）依該服務的隱私權政策辦理。開啟前請先確認你接受。
- 你可以隨時停用或刪除連線，並解除安裝橋接程式。

### 5. 匯出與備份

只有在你按下匯出時，Favorsite 才會產生含書籤與標籤的 JSON 備份檔，並存到你選擇的位置。Favorsite 不會自動上傳或傳送備份。

### 6. 資料保存與刪除

- 書籤本身存放在 Chrome 中，並受 Chrome 同步設定管理。Favorsite 不另外同步。
- 你可以在工作台中刪除收錄的來源、清理較舊的快照、撤銷網站權限，以及刪除 MCP 連線。
- 移除擴充功能時，Chrome 會一併刪除 Favorsite 的本機資料（IndexedDB）。你的 Chrome 書籤會保留。

### 7. 資料分享與出售

我們不出售、出租或轉讓任何使用者資料，也不將資料用於廣告、信用評估或與擴充功能單一用途無關的目的。Favorsite 對資料的使用符合 Chrome 線上應用程式商店的「使用者資料政策」，包括其中的「有限使用」規定。

### 8. 兒童隱私

Favorsite 並非針對 13 歲以下兒童設計，也不會蓄意蒐集兒童的個人資料。

### 9. 政策變更

本政策若有變更，會更新此頁面與生效日期。若變更涉及資料的處理方式，會在擴充功能更新說明中告知。

### 10. 聯絡方式

如有隱私問題，請來信：ping@hedula.dev

---

## English

### Summary

Favorsite is a bookmark organizer that runs locally in your browser. **We operate no servers. We do not collect, upload, or sell any user data, and we use no analytics or ad tracking.** Your data stays in your browser, under your control.

### 1. Data the extension handles

| Data | Purpose | Where it is stored |
| --- | --- | --- |
| Chrome bookmarks (titles, URLs, folder structure, dates added) | Display, search, classify, move, de-duplicate, undo | Chrome's native bookmarks; index and snapshots in local IndexedDB |
| Tags you add, organize plans, history, and pre-deletion snapshots | Diff previews, applying changes, one-click undo | Local IndexedDB |
| Page text you explicitly save with "Capture this page" (title, URL, visible text) | Your personal knowledge base for search, Q&A, and citations | Local IndexedDB |
| Settings and MCP connection grants (only a SHA-256 hash of each token is stored) | Remembering preferences; authenticating local AI clients | Local IndexedDB |

Favorsite does not read your browsing history, cookies, passwords, form data, or payment information. It reads the visible text of a single tab only when you click "Capture this page".

### 2. AI runs on your device

- **Local semantic model**: The multilingual-e5-small model and its runtime ship inside the extension and run on your computer via WebAssembly. No text is sent to any server.
- **Gemini Nano**: Where Chrome supports it, Favorsite calls Chrome's built-in on-device Prompt API. Chrome performs the inference locally. Chrome downloads and manages that model under Google's terms, and Favorsite is not involved.

### 3. When the extension uses the network

Favorsite only connects to the network when you trigger it:

- **Broken-link check**: Only after you start a check and grant access to specific sites does Favorsite send `HEAD` requests (and a limited number of `GET` requests if needed) to those bookmarked URLs to see whether the pages still exist. Requests carry no cookies or credentials, send no referrer, and do not follow redirects. Localhost, private-network addresses, and URLs with sensitive parameters are always skipped. Site access granted just for a check is revoked automatically when the check ends, and you can revoke any site access in Settings at any time.
- **Opening a bookmark or source**: When you click a link, Chrome opens that page as usual.

Favorsite never contacts a developer-operated or third-party server.

### 4. Sharing with local AI clients (MCP, off by default)

You may install an optional local bridge so that MCP-capable apps such as ChatGPT or Claude Desktop can read your bookmarks and saved pages:

- It is **off by default**. You create each connection in Settings and choose which folders it can see and whether saved page text is included.
- Data passes through Chrome Native Messaging to the bridge program on your own computer. Access is read-only, so clients cannot modify or delete bookmarks.
- Once data reaches an AI client, that client's own privacy policy governs what happens next, including whether it is sent to that client's cloud service. Review it before you enable a connection.
- You can disable or delete a connection at any time and uninstall the bridge.

### 5. Export and backup

Favorsite creates a JSON backup of your bookmarks and tags only when you click Export, and saves it where you choose. It never uploads or sends backups.

### 6. Retention and deletion

- Your bookmarks live in Chrome and follow your Chrome Sync settings. Favorsite adds no separate sync.
- In the Studio you can delete saved sources, prune older snapshots, revoke site permissions, and delete MCP connections.
- When you remove the extension, Chrome deletes Favorsite's local data (IndexedDB). Your Chrome bookmarks remain.

### 7. Sale and transfer of data

We do not sell, rent, or transfer user data. We do not use it for advertising, creditworthiness, or any purpose unrelated to the extension's single purpose. Favorsite's use of data complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

### 8. Children's privacy

Favorsite is not directed at children under 13 and does not knowingly collect their personal information.

### 9. Changes to this policy

If this policy changes, we will update this page and its effective date. If a change affects how data is handled, we will also note it in the extension's release notes.

### 10. Contact

For privacy questions, email: ping@hedula.dev
