# Chrome 線上應用程式商店：權限用途說明

用於開發人員資訊主頁 →「隱私權」分頁。每個欄位的英文段落可直接貼上（皆在 1000 字元以內），中文段落是給你自己核對用的。

對應 manifest：`permissions: bookmarks, nativeMessaging, offscreen, activeTab, scripting`，`optional_host_permissions: https://*/*, http://*/*`。

---

## 單一用途 / Single purpose

```text
Favorsite helps users organize their own Chrome bookmarks: search, tag, classify, de-duplicate, move, and check for broken links, with a diff preview before every change and one-click undo. Users can also save pages they choose into a local knowledge base. All processing, including AI classification, runs on the user's device.
```

中文：整理使用者自己的 Chrome 書籤（搜尋、標籤、分類、去重、搬移、失效連結檢查），每次變更前先預覽差異，並可一鍵復原。也可把使用者選定的頁面收進本機知識庫。所有處理，包括 AI 分類，都在裝置上進行。

---

## bookmarks

```text
Core function. Favorsite reads the user's bookmark tree to display, search, and classify it, and writes changes (create folder, move, rename, remove duplicates) only after the user reviews a diff preview and clicks Apply. Every change is snapshotted locally so it can be undone. Bookmark data is never sent off the device.
```

中文：核心功能。讀取書籤樹以顯示、搜尋與分類；只有在使用者看過差異預覽並按下「套用」後才寫入變更。每次變更都會先存本機快照，可以復原。書籤資料不會離開裝置。

## activeTab

```text
Used only when the user clicks "Capture this page" in the popup. It grants temporary access to the current tab so Favorsite can read that page's URL and visible text and save it to the user's local knowledge base. No other tab is accessed, and nothing runs in the background.
```

中文：只在使用者於彈出視窗按「收錄本文」時使用，暫時取得目前分頁的網址與可見文字，存進本機知識庫。不存取其他分頁，也不在背景執行。

## scripting

```text
Used together with activeTab, only after the user clicks "Capture this page". Favorsite injects a single bundled function into that tab to extract the visible article text (skipping navigation, hidden elements, and editable fields). The extension never injects remote code and does not use content scripts on any other page.
```

中文：搭配 activeTab，只在使用者按「收錄本文」後，於該分頁注入一個打包在擴充功能內的函式，擷取可見正文（略過導覽列、隱藏元素與可編輯欄位）。不注入遠端程式碼，也不在其他頁面執行內容腳本。

## offscreen

```text
Runs the bundled on-device semantic model (multilingual-e5-small via WebAssembly) in an offscreen document with the WORKERS reason, because MV3 service workers cannot host the Web Worker the model needs. This powers semantic bookmark search and classification locally. No data leaves the device.
```

中文：MV3 的 service worker 無法啟動模型所需的 Web Worker，所以在 offscreen 文件中執行內附的本機語意模型（WebAssembly），用於語意搜尋與分類。資料不會離開裝置。

## nativeMessaging

```text
Optional and off by default. If the user installs Favorsite's local MCP bridge and creates a connection in Settings, the extension talks to that program on the user's own computer so desktop AI apps (e.g. ChatGPT, Claude Desktop) can run read-only searches over the folders the user selected. Each connection is token-authenticated and can be revoked at any time. If no connection is enabled, the extension never opens a native port.
```

中文：選用，預設關閉。使用者安裝本機 MCP 橋接程式並在設定中建立連線後，擴充功能才會與使用者電腦上的該程式通訊，讓桌面 AI 應用程式對使用者選定的資料夾做唯讀查詢。每個連線都以權杖驗證，可隨時撤銷。沒有啟用任何連線時，不會開啟原生通訊埠。

## Host permissions（optional_host_permissions: http://*/*, https://*/*）

```text
Optional; requested at runtime only when the user starts a broken-link check, and only for the origins of the bookmarks being checked. Favorsite sends a HEAD request (or a small GET if HEAD is unsupported) to each bookmarked URL to see whether it still exists, with no cookies, no credentials, no referrer, and no redirect following. Localhost and private-network URLs are skipped. Users can revoke these permissions in Settings. Nothing is granted at install time.
```

中文：選用，只在使用者啟動失效連結檢查時，針對要檢查的書籤網域請求。對每個書籤網址送出 HEAD（不支援時改用少量 GET）確認網頁是否還在，不帶 Cookie、憑證或 Referrer，不跟隨重新導向。略過本機與內網網址。可在設定中撤銷，安裝時不授予任何網站權限。

## 遠端程式碼 / Remote code

選擇：**否，我沒有使用遠端程式碼（No, I am not using remote code）**

```text
All JavaScript and WebAssembly (including the ONNX Runtime and the semantic model weights) are bundled in the package. The CSP is script-src 'self' 'wasm-unsafe-eval'; 'wasm-unsafe-eval' is required to compile the bundled WebAssembly runtime. The transformers.js library contains a default CDN path string, but Favorsite overrides it at runtime to load files from the extension package and disables remote model loading (env.allowRemoteModels = false).
```

中文：所有 JavaScript 和 WebAssembly（含 ONNX Runtime 與模型權重）都打包在擴充功能內。CSP 中的 `'wasm-unsafe-eval'` 是編譯內附 WebAssembly 所必需的。transformers.js 程式庫內留有預設 CDN 路徑字串，但 Favorsite 在執行時改為讀取擴充功能內的檔案，並關閉遠端模型載入。

---

## 資料使用揭露（勾選題）

Chrome 線上應用程式商店所說的「蒐集」，指的是把資料傳出使用者裝置。依目前的程式碼：

| 類別 | 建議 | 理由 |
| --- | --- | --- |
| 網站內容（Website content） | **勾選** | 使用者收錄的正文可經選用的 MCP 連線，交給使用者指定的本機 AI 客戶端。採保守揭露。 |
| 網頁瀏覽記錄（Web history） | **勾選** | 書籤網址可經 MCP 連線提供給本機 AI 客戶端；失效連結檢查會連線到書籤網址。採保守揭露。 |
| 個人識別資訊、健康、財務、驗證資訊、個人通訊、位置、使用者活動 | 不勾選 | 程式碼中沒有讀取或傳送這類資料。 |

三項聲明全部勾選：
- 不會將使用者資料出售或轉移給第三方（核准用途除外）
- 不會將使用者資料用於與單一用途無關的目的
- 不會將使用者資料用於判斷信用或放貸

隱私權政策網址：`https://hedula.dev/favorsite/privacy`（內容來源為 [privacy-policy.md](privacy-policy.md)，修改時兩邊同步）。
