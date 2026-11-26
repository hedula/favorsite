// Renders the 440x280 Chrome Web Store small promo tile. Usage: node scripts/render-promo-tile.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const icon = fs.readFileSync(path.resolve('public/icons/icon-128.png')).toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:440px;height:280px}
  body{display:flex;flex-direction:column;justify-content:center;gap:18px;padding:0 36px;box-sizing:border-box;
    background:linear-gradient(135deg,#0041a2 0%,#0b57d0 100%);color:#fff;
    font-family:-apple-system,"PingFang TC","Noto Sans TC","Helvetica Neue",sans-serif}
  .row{display:flex;align-items:center;gap:16px}
  img{width:72px;height:72px;border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
  h1{margin:0;font-size:38px;font-weight:700;letter-spacing:-.5px}
  p{margin:0;font-size:19px;line-height:1.45;color:#dae2ff}
  .tags{display:flex;gap:8px}
  .tags span{font-size:13px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.16)}
</style></head><body>
  <div class="row"><img src="data:image/png;base64,${icon}" alt=""><h1>Favorsite</h1></div>
  <p>本機書籤工作台<br>先預覽、再套用，一鍵復原</p>
  <div class="tags"><span>裝置端 AI</span><span>不上傳資料</span><span>可復原</span></div>
</body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: path.resolve('docs/store/assets/promo-small-440x280.png') });
await browser.close();
