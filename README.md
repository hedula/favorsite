# Favorsite

Favorsite 是本機優先的 Chrome 書籤工作台。可整理及備份原生書籤、以自然語言找回收藏、主動收錄網頁正文，並透過 MCP 提供來源給桌面 AI。

## 建置與載入

在專案目錄執行下列指令。模型準備會下載固定版本的 E5 權重並校驗檔案，建置會再次檢查完整性。

```sh
npm ci
npm run prepare:semantic-model
npm run build
```

在 Chrome 擴充功能管理頁開啟開發人員模式，按「載入未封裝項目」，選擇 `.output/chrome-mv3`。升級後重新載入擴充功能及工作台，設定頁可核對版本、建置及模型狀態。

工作台的「知識庫」提供關鍵字及語意搜尋，範圍可選資料夾並包含子資料夾。第一次語意查詢會建立本機索引，畫面顯示進度並可停止。後續查詢可重用向量快取。

## 收錄與引用

開啟要保存的文章，點 Chrome 工具列的 Favorsite，再按「收錄本文」。知識庫可讀取正文、查看原始網址、重新開啟原頁更新或清除正文。相同網址更新後維持來源 ID，正文與段落有各自的版本資訊。

「詢問這個範圍」會先找相關來源。Chrome 內建回答模型可用時產生附引用的回答，其餘情況提供可核對的原文片段。

## 桌面 MCP

1. 在 Favorsite 設定頁的「提供給桌面 AI」，建立連線並選定可查詢的資料夾及正文權限。保存這次顯示的連線金鑰與設定檔識別值。
2. 將 Chrome 擴充功能 ID 帶入安裝指令。可先用 `--dry-run` 查看路徑，再執行安裝。

```sh
npm run mcp:install -- --extension-id YOUR_EXTENSION_ID --dry-run
npm run mcp:install -- --extension-id YOUR_EXTENSION_ID
```

安裝器會建立使用者層級的 Native Messaging 註冊與本機 host。macOS 與 Linux 的檔案放在目前使用者的設定目錄，Windows 使用目前使用者的登錄設定。自訂位置可用 `--manifest-dir`、`--install-dir` 及 `--bridge-dir`。測試用瀏覽器可指定 `--browser chrome-for-testing` 或 `--browser chromium`。

重新載入 Favorsite，在設定頁按「重新檢查連線」。使用時保持 Chrome 啟動，Studio 可以關閉。

### ChatGPT 桌面版與 Codex

在支援本機 MCP 的設定頁新增 STDIO 服務，啟動命令為 `node`，參數為專案內 `scripts/favorsite-mcp.mjs` 的絕對路徑。設定兩個環境變數，填入 Favorsite 連線資訊。

| 環境變數 | 值 |
| --- | --- |
| `FAVORSITE_PROFILE_KEY` | Favorsite 設定頁顯示的設定檔識別值 |
| `FAVORSITE_MCP_TOKEN` | 該連線建立時顯示的金鑰 |

使用自訂橋接目錄時，也要設定 `FAVORSITE_BRIDGE_DIR` 為安裝器使用的同一路徑。設定值放在桌面客戶端的使用者設定中。

### Claude Desktop

```sh
npm run mcp:package
```

在 Claude Desktop 安裝 `.output/favorsite-mcp.mcpb`，填入同一個設定檔識別值及為 Claude 建立的連線金鑰。本機 Chrome host 依前述步驟完成安裝。也可用手動 MCP 設定啟動同一支 Node.js 程式。

### 工具與存取範圍

| 工具 | 用途 |
| --- | --- |
| `list_folders` | 列出該連線可查詢的資料夾 |
| `search_bookmarks` | 以問句或關鍵字搜尋書籤及可提供的來源片段 |
| `read_source` | 讀取來源資料，或按版本及段落取得已收錄正文 |

工具以唯讀方式查詢。可在 Favorsite 隨時調整範圍、停用或撤回連線。使用雲端 AI 模型時，工具回傳的來源資料及片段會傳給該模型服務。

移除本機 host 可執行以下指令。安裝時採自訂位置者，帶入原有的位置選項。

```sh
npm run mcp:install -- --uninstall
```

## 驗證指令

```sh
npm run typecheck
npm test
npm run test:mcp
npm run build
npm run test:e2e
```

原生瀏覽器測試使用獨立 Chromium 設定檔與合成書籤。MCP 測試會檢查串流協定、並行查詢、取消、安裝／移除與安裝包完整性。執行環境若禁止本機 socket，測試結果會明確標示受限制的 IPC 案例。
