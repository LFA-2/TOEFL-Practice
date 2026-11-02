# TOEFL Coach

為 2026 新制 TOEFL iBT 量身打造的個人練習 app。依考試日期、目標級分和每個題型的能力估計，每天自動排出練習任務；寫作由 Claude 批改。

- 零依賴：只用 Node.js 內建模組（`node:http`、`node:sqlite`），**不需要 `npm install`**
- PWA：手機瀏覽器「加入主畫面」即可當 app 用
- 資料存在 `data/toefl.db`（SQLite 單一檔案，備份就是複製這個檔）

## 目前功能（v0.1）

| 科目 | 題型 | 批改 |
|---|---|---|
| 閱讀 | Complete the Words、Read in Daily Life、Read an Academic Passage | 自動 |
| 寫作 | Build a Sentence | 自動 |
| 寫作 | Write an Email、Academic Discussion | Claude（0–5 分 + 逐句修改 + 範文） |
| 單字 | 每日篩選新字、單字卡、間隔複習 | 自動 |

- **單字填空**照 ETS 官方格式：第一句完整，之後每隔一個字刪掉後半段，共 10 格，一格一個字母，拼字必須完全正確。
- **句子重組**照實際考法：回覆句裡有部分字固定，其餘空格從字塊填入，可能有一個用不到的干擾字塊，每題 41 秒。

### 單字

1. **挑新單字**：一次一個字，只顯示英文，點「會／不熟／不會」。「會」的字之後不再出現；另外兩種加進單字本。每天的數量在「設定」調整（預設 60）。
2. **單字卡**：只替你挑出來的字產生，內容有中文意思、詞性、學術例句、常見搭配、詞性變化，以及一題選擇題（新例句＋三個陷阱選項＋說明）。用較便宜的 Haiku 模型。
3. **兩種題型**，都自動批改：
   - **句子填空選字**：新例句挖空，四選一。陷阱是意思很像但放不進這句的字，或長得很像的字；答完說明每個錯誤選項為什麼不行。
   - **看中文打英文**：給中文、詞性和挖空的例句，格子數等於字母數，不給字母。可以按「提示」看第一個字母，但只算「模糊」。
4. **間隔複習**：第 1、2、4、7、14、21、45、90 天。
   - 剛挑進來的字當天先考選擇題（附中文提示），答對再考一次打字，明天再出現
   - 之後以打字為主，每三次穿插一次選擇題；剛答錯的字重考時改考選擇題
   - 答對往下一個間隔；用了提示或打成意思接近的字，間隔不變；答錯當天再考一次，明天從頭開始
5. **自由測驗**：隨時從單字本抽 20 個字（偏重常錯的），答錯會拉回明天複習，答對不會提前往後推。也可以只考難字。
6. **難字**：累計答錯 4 次以上的字，單字本可以篩選出來。
7. 候選字的難度會跟著你的回答調整：大多會就變難，大多不會就變簡單。
8. 單字最多佔每天練習時間的一半。

下一版：聽力（TTS 音檔）、口說（打字版）、錯題本、全真模考。

### 運作方式

- **診斷**：第一天每個題型各做一點，建立起點。
- **能力估計**：每個題型一個 1–6 級分的估計值。選擇題用類似 Elo 的方式更新；寫作把 0–5 分換算成級分（分數 +1）後逐步逼近。
- **適性出題**：挑難度略高於你目前能力（+0.25）的題目，題庫不夠時即時請 Claude 出題，背景會再補幾題。
- **每日計畫**：依「目標 − 目前能力」的差距和該題型在考試中的配分分配時間；考前四週進入模考期，最後一週減量。

## 部署到 Arch 工作站

### 1. 安裝 Node.js（需要 22.13 以上）

```bash
sudo pacman -S nodejs
node -v   # 確認 >= 22.13
```

### 2. 下載程式碼

```bash
cd ~
git clone https://github.com/LFA-2/TOEFL-Practice.git
cd TOEFL-Practice
```

### 3. 建立 `.env`（設定檔）

`.env` 是放「密碼」和「API key」這類機密的檔案。它已經被 `.gitignore` 排除，**不會**被推上 GitHub。

```bash
cp .env.example .env
nano .env
```

填兩個值：

- `APP_PASSWORD`：你從手機登入用的密碼，設長一點。
- `ANTHROPIC_API_KEY`：到 <https://console.anthropic.com> → Settings → API keys 建立一把 key（需要先在 Billing 儲值，幾美元就夠用很久），貼進來。

```bash
chmod 600 .env   # 只有你自己能讀
```

### 4. 先手動跑一次確認

```bash
node server.js
# 看到 TOEFL Coach listening on http://127.0.0.1:3000 就成功了
# 在工作站上：curl http://127.0.0.1:3000/api/me
```

按 Ctrl+C 停掉。

### 5. 設成開機自動啟動（systemd user service）

```bash
mkdir -p ~/.config/systemd/user
cp deploy/toefl-coach.service deploy/toefl-generate.service deploy/toefl-generate.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now toefl-coach.service toefl-generate.timer
sudo loginctl enable-linger $USER   # 沒登入時服務也繼續跑
systemctl --user status toefl-coach
```

> 如果 repo 不是放在 `~/TOEFL-Practice`，要改 `.service` 檔裡的 `WorkingDirectory`。

`toefl-generate.timer` 每天凌晨 3:30 用 Claude 補題、準備隔天要篩選的單字和單字卡，讓你白天在手機上作答不用等。

### 6. 讓手機連得到（需要 HTTPS）

二選一：

**A. Tailscale（推薦，不需要網域）**：工作站和手機都裝 Tailscale、登入同一個帳號，然後：

```bash
sudo pacman -S tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
sudo tailscale serve --bg 3000
```

會得到 `https://<機器名>.<tailnet>.ts.net` 這種網址，只有你自己的裝置連得到。

**B. Cloudflare Tunnel（需要一個放在 Cloudflare 的網域）**：

```bash
sudo pacman -S cloudflared
cloudflared tunnel login
cloudflared tunnel create toefl
cloudflared tunnel route dns toefl toefl.你的網域.com
# 設定 ~/.cloudflared/config.yml 把 toefl.你的網域.com 指到 http://127.0.0.1:3000
```

### 7. 手機安裝

用手機開那個 HTTPS 網址 → 登入 → iPhone 按「分享 → 加入主畫面」；Android 按選單裡的「安裝應用程式」。

## 更新

```bash
cd ~/TOEFL-Practice && git pull && systemctl --user restart toefl-coach
```

如果 `deploy/` 裡的 systemd 檔有改，再多跑一次：

```bash
cp deploy/toefl-*.service deploy/toefl-*.timer ~/.config/systemd/user/ && systemctl --user daemon-reload
```

資料庫的新資料表會在啟動時自動建立，舊的練習紀錄不受影響。手機上如果看到舊畫面，關掉 app 再打開一次。

## 開發

```bash
AI_MOCK=1 node --watch server.js     # 不呼叫 API，用假資料測試
```

- `server.js`：HTTP 路由
- `lib/tasks.js`：題型定義、Complete the Words 挖空、選擇題計分
- `lib/skills.js`：能力估計
- `lib/plan.js`：每日計畫
- `lib/bank.js`：選題、出題、作答紀錄
- `lib/vocab.js`：單字篩選、單字卡、間隔複習
- `lib/ai.js`：Claude 出題與批改的 prompt
- `lib/seed.js`：內建的起始題目
- `public/`：前端（原生 JS）

## 備份

```bash
sqlite3 data/toefl.db ".backup data/backup-$(date +%F).db"
```
