# TOEFL Coach

為 2026 新制 TOEFL iBT 量身打造的練習 app。依考試日期、目標級分和每個題型的能力估計，每天自動排出練習任務；寫作由 Claude 批改，單字有每日篩選、單字卡與間隔複習。

- **前端**：`public/`，原生 JS 的 PWA，放在 GitHub Pages。手機、筆電都能用，可「加入主畫面」。
- **後端**：Supabase。Postgres 存資料、Auth 管帳號、一個 Edge Function（`supabase/functions/api`）負責出題、計分、排程和呼叫 Claude。
- 不需要自己的主機，不需要 Tailscale。

## 安全設計

- **Claude API key 只存在 Supabase secrets**，只有 Edge Function 讀得到，不在前端、不在 repo。
- 前端的 `publishableKey` 本來就是公開的，它只能讓瀏覽器連到 Supabase；誰能讀寫什麼由資料庫的 Row Level Security 決定。
- **每張表都開了 RLS**：每個人只能讀寫自己的資料，而且帳號要先被核准。Edge Function 的查詢也是以登入者的身分執行，同樣受 RLS 限制。
- **註冊需要核准**：任何人都能註冊，但新帳號是「等待核准」，核准前不能使用任何功能、也不能呼叫 Claude。
- **AI 次數上限**：每人每天 30 次（台灣時間午夜重置），全站每天 300 次。出一題、批改一篇、產生一批單字卡（10 個字）各算一次。超過上限時 AI 功能暫停，已經產生好的題目和單字卡照常可用。
- Edge Function 只接受固定的操作（例如「產生一題 ctw」），prompt 和模型都寫死在伺服器端，不能被拿來當成任意呼叫 Claude 的代理。

## 第一次部署

需要：Supabase 專案（東京 `ap-northeast-1`，ref：`kubztmahbfpynoskcysd`）、一台有 Node.js 的電腦（工作站即可，只有部署時用到）。

舊專案在愛爾蘭（`eu-west-1`，ref：`sfgsxkglfqyulxyryxtw`），已暫停並保留，不要刪除、不要再部署上去。

### 1. Supabase 後台設定

到 <https://supabase.com/dashboard/project/kubztmahbfpynoskcysd>：

1. **Authentication → Sign In / Providers → Email**
   - 關閉 **Confirm email**。Supabase 內建的寄信服務只會寄給專案成員，其他人收不到確認信；註冊改由你手動核准把關。
   - **Minimum password length** 設成 8。
2. **Authentication → URL Configuration**：Site URL 填網站網址（第 3 步會得到），例如 `https://lfa-2.github.io/TOEFL-Practice/`。

### 2. 部署資料庫和 Edge Function

在工作站上（另外 clone 一份，不影響舊的服務）：

```bash
git clone -b supabase https://github.com/LFA-2/TOEFL-Practice.git ~/toefl-supabase
cd ~/toefl-supabase

npx supabase login                                     # 會開瀏覽器登入 Supabase
npx supabase link --project-ref kubztmahbfpynoskcysd   # 會問資料庫密碼（建立專案時設的）
npx supabase db push --remote                         # 建立資料表、RLS、題庫起始題目

npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...  # 你的 Claude API key，只存在 Supabase
npx supabase functions deploy api --no-verify-jwt
```

> `--no-verify-jwt`：登入檢查由 function 自己做（向 Supabase Auth 確認 token），不是關掉檢查。
> 如果 `functions deploy` 說需要 Docker，改用 `npx supabase functions deploy api --no-verify-jwt --use-api`。

為了避免 API key 留在 shell 歷史裡，可以改成：

```bash
read -rs KEY && npx supabase secrets set ANTHROPIC_API_KEY="$KEY" && unset KEY
```

### 3. 發佈網站（GitHub Pages）

1. GitHub repo → **Settings → Pages** → Source 選 **GitHub Actions**。
2. **Settings → Environments → github-pages → Deployment branches**：加入 `supabase`（合併到 `main` 之前測試用）。
3. 推一次 commit 或到 **Actions → Deploy site to GitHub Pages → Run workflow**。網址是 `https://lfa-2.github.io/TOEFL-Practice/`。

> 私人 repo 要用 GitHub Pages 需要 GitHub Pro（學生可以從 GitHub Student Developer Pack 免費取得）。不想用的話，可以用 Cloudflare Pages：連結這個 repo，Build command 留空，Output directory 填 `public`。

### 4. 註冊你的帳號，搬舊資料

1. 打開網站，用 Email 註冊。畫面會顯示「等待核准」。
2. 在工作站產生匯入用的 SQL（用最新的備份）：

   ```bash
   cd ~/TOEFL-Practice && rm -f ~/toefl-backup.db && node -e 'const {DatabaseSync}=require("node:sqlite");new DatabaseSync("data/toefl.db").exec(`VACUUM INTO '\''${process.env.HOME}/toefl-backup.db'\''`)'
   cd ~/toefl-supabase && node tools/sqlite-to-sql.js ~/toefl-backup.db 你的Email > ~/import.sql
   ```

3. Supabase 後台 → **SQL Editor** → 貼上 `~/import.sql` 的內容 → Run。它會核准你的帳號，並匯入題目、作答紀錄、能力估計、單字和複習紀錄。同一個帳號重複執行會被擋下來，不會重複匯入。
4. 回到網站按「重新檢查」。

### 5. 停掉舊的服務

確認新版沒問題之後：

```bash
systemctl --user disable --now toefl-coach.service toefl-generate.timer
sudo tailscale serve reset
```

舊的 `~/TOEFL-Practice/data/toefl.db` 可以留著當備份。

## 日常管理

- **核准新帳號**：Supabase 後台 → Table Editor → `profiles` → 把該列的 `approved` 勾起來。
- **調整 AI 次數**：`app_config` 表的 `ai_daily_limit`（每人）和 `ai_global_daily_limit`（全站）；個別帳號可以在 `profiles.ai_daily_limit` 設不同的上限（空白 = 用預設）。
- **看用量**：`ai_usage` 表，每人每天一列。網站「設定」頁也會顯示今天用了幾次。
- **費用保險**：在 Anthropic Console → Limits 設每月消費上限。這把 key 只給這個專案用，外洩時直接在 Console 撤銷再換新的。
- **停用某個帳號**：把 `approved` 取消勾選，或在 Authentication → Users 刪除（資料會一起刪除）。

## 更新

- **只改前端（`public/`）**：推上 GitHub，Actions 會自動發佈。
- **改了 Edge Function**：`npx supabase functions deploy api --no-verify-jwt`
- **加了 migration**：`npx supabase db push --remote`

## 功能

| 科目 | 題型 | 批改 |
|---|---|---|
| 閱讀 | Complete the Words、Read in Daily Life、Read an Academic Passage | 自動 |
| 寫作 | Build a Sentence | 自動 |
| 寫作 | Write an Email、Academic Discussion | Claude（0–5 分 + 逐句修改 + 範文） |
| 單字 | 每日篩選新字、單字卡、選擇題與拼字測驗、間隔複習、自由測驗 | 自動 |

- **單字填空**照 ETS 官方格式：第一句完整，之後每隔一個字刪掉後半段，共 10 格，一格一個字母。
- **句子重組**照實際考法：部分字固定，其餘空格從字塊填入，可能有一個干擾字塊，每題 41 秒。
- **題庫共用**：AI 產生的題目所有核准的使用者都能練到（作答紀錄各自獨立），可以省下 AI 次數。
- **單字卡**在挑字時每滿 10 個字產生一批，剩下的在開始複習時補齊。
- **間隔複習**：第 1、2、4、7、14、21、45、90 天。剛挑的字當天先考選擇題、再考拼字；答錯當天再考一次，明天從頭開始。
- **能力估計**：每個題型一個 1–6 級分。選擇題用類似 Elo 的方式更新；寫作把 0–5 分換算成級分（分數 +1）後逐步逼近。題目難度挑略高於目前能力（+0.25）。
- **每日計畫**：依「目標 − 目前能力」與題型配分分配時間；考前四週模考期，最後一週減量。單字最多佔一半時間。

下一版：聽力（TTS 音檔）、口說（打字版）、錯題本、全真模考。

## 程式結構

- `public/`：前端。`config.js` 是 Supabase 網址和 publishable key。
- `supabase/migrations/`：資料表、RLS、核准機制、AI 次數函式、起始題目。
- `supabase/functions/api/index.ts`：Edge Function 入口（Deno）。
- `supabase/functions/api/app.js`：路由、登入檢查、AI 次數扣除。
- `supabase/functions/api/lib/`：`tasks.js` 題型與計分、`skills.js` 能力估計、`plan.js` 每日計畫、`bank.js` 選題與作答、`vocab.js` 單字、`ai.js` Claude prompt。
- `tools/sqlite-to-sql.js`：把舊版 SQLite 備份轉成匯入用的 SQL。
- `test/`：本機測試環境（不連網路）。

## 本機開發與測試

需要本機的 PostgreSQL（16 以上）。`test/dev-server.mjs` 會模擬 Supabase Auth，並用真的 Edge Function 程式碼連本機資料庫；`AI_MOCK=1` 時不呼叫 Claude。

```bash
export PGHOST=/var/run/postgresql PGPORT=5432 PGSOCKET=/var/run/postgresql/.s.PGSQL.5432 PGDATABASE=toefl
test/reset-db.sh          # 建立資料庫：Supabase 替身 + 所有 migration
npm run dev               # http://127.0.0.1:3999
npm test                  # API 測試：登入、核准、RLS 隔離、AI 次數上限、單字流程
```
