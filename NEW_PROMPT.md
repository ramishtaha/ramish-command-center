# Ramish Command Center — System Architecture & Onboarding

> Read this first. This document explains the entire system end-to-end: what it is,
> how it's built, where the data lives, how the API works, and how to run/deploy it.
> After reading this you should be able to modify any part of the app without surprises.

---

## 1. Project Overview

The **Ramish Command Center** is a single-user personal dashboard supporting two interlocked goals:

1. **12-week career switch** — TCS → GCC/product company. Tracks 84 working days of DSA (target: 171 problems), Spring Boot, System Design, DevOps, Claude certification, and career tasks.
2. **Islamic life reform** — Salah (5 daily prayers + extras), shields against sin (khalwah, night protocol, phone-out-of-bedroom, lower gaze, no new riba), fasting, evening reset ritual, and journaling.

The core design loop: **markdown trackers are the source of truth for an AI mentor (Hermes); the web app is the visual mirror and quick-input surface for Ramish.** A sync script keeps both sides consistent.

- **Live app:** https://ramish-command-center-f4bee27fd546.herokuapp.com
- **Login:** `ramish` / `ramish2026`
- **GitHub:** `ramishtaha/ramish-command-center` · **Local repo:** `/root/career-tracker`
- **Mentor-side files:** `/root/career-switch-plan/session-state.md`, `/root/career-switch-plan/tracker/{dsa-tracker.md, progress.md}`

---

## 2. Tech Stack

| Layer | Tech | Notes |
|---|---|---|
| Runtime | Node.js 22+ | single process, `server.js` entry |
| Framework | Express 4 | `express`, `express-session` |
| Database | PostgreSQL | Heroku Postgres (essential-0), accessed via `pg.Pool` |
| Templates | EJS | server-rendered, no SPA framework |
| Frontend | Vanilla JS + CSS | fetch() calls to session API, pure-CSS charts |
| Auth (UI) | Session cookies | bcrypt password hashing, 30-day cookie |
| Auth (API) | `x-api-key` header | for machine sync only |
| Hosting | Heroku (EU, heroku-26 stack) | `Procfile`: `web: node server.js` |
| Sync | Python 3 (`sync-heroku.py`) | stdlib only (`urllib`, `re`, `json`) |

No build step, no bundler, no frontend dependencies. Editing CSS/EJS/JS is instant.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  MENTOR SIDE (Hermes Agent, local machine)                          │
│  /root/career-switch-plan/                                          │
│    ├── session-state.md          ← stats: active days, streak, bar  │
│    └── tracker/                                                       │
│        ├── dsa-tracker.md        ← problem log, help_level flags    │
│        └── progress.md           ← daily/weekly history             │
│         ▲                                    │                      │
│         │ pull                               │ push                 │
│         │            sync-heroku.py          ▼                      │
└─────────┼────────────────────────────────────┼──────────────────────┘
          │        (x-api-key over HTTPS)      │
          ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  APP SIDE (Heroku)                                                  │
│                                                                     │
│  server.js ──────────────┐    Everything lives here:                │
│   • Express routes       │    - session auth (login/logout)         │
│   • pg.Pool → Postgres   │    - dashboard data assembly (GET /)     │
│   • initDB() on boot     │    - session API (POST /api/*)           │
│   • streak/projection    │    - machine sync API (/api/sync*,       │
│     computation          │      /api/state) with x-api-key          │
│        │                                                      │
│        ▼ res.render('dashboard', {...20+ vars...})                  │
│  views/dashboard.ejs ── single-page dashboard, all tabs/sections    │
│        │                                                            │
│        ▼ <link>                                                     │
│  public/css/style.css ── dark theme, responsive, CSS-only charts    │
│                                                                     │
│  views/login.ejs ───── standalone login page (stable, don't touch)  │
│                                                                     │
│  PostgreSQL (Heroku Postgres) ── 7 tables (see §4)                  │
└─────────────────────────────────────────────────────────────────────┘
```

**Request flow (dashboard load):**
`GET /` → `requireAuth` → ~12 SQL queries (today's progress, streaks, DSA counts, unaided breakdown, 14-day history, app_state JSONB, projection math) → one big `res.render('dashboard', {...})` → EJS produces the full page. The template receives **every** variable it references — a missing variable = 500 with a `ReferenceError` in `heroku logs`.

**Key server-side computations:**
- `getStreak(pool, userId, field)` — recursive CTE counting consecutive `true` days backwards from the most recent `true`.
- Projection: `pace = dsaCount / activeDayCount`, `projectedFinishDays = activeDayCount + ceil((171 - dsaCount)/pace)`, `restBudget = 84 - projectedFinishDays`, `needToSpeedUp = projectedFinishDays > 84`.
- JSONB handling: `app_state` values may come back as object **or** string depending on the pg driver — always `typeof r.value === 'string' ? JSON.parse(r.value) : r.value`.

---

## 4. Data Model

All tables are created by `initDB()` in `server.js` with `CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations, so booting against an existing production DB is safe.

### `users`
`id SERIAL PK · username VARCHAR(50) UNIQUE · password_hash TEXT · created_at`
Single user (`ramish`, id=1). Sync endpoints hardcode `userId = 1`.

### `daily_progress` — one row per user per date (UNIQUE(user_id, date))
Booleans (all `DEFAULT false`):
- **Salah:** `fajr, dhuhr, asr, maghrib, isha, jumuah, tahajjud, duha, salah_complete` (last auto-set when all 5 are true)
- **Prime/Survival:** `survival_layer, morning_reading, targets_set, house_task`
- **Training:** `mma, post_workout_meal, shower`
- **Learning:** `dsa_done, spring_boot_done, system_design_done, revision_done, block1_done … block4_done`
- **Evening/Shields:** `evening_reset, haldi_doodh, sleep_on_wudu, ghusl_rule, khalwah_shield, night_protocol, phone_out_of_bedroom, lower_gaze, fasting, no_new_riba`
Non-booleans:
- `bar_hit VARCHAR(10) DEFAULT 'none'` — `'none' | 'partial' | 'full'`
- `mode_used VARCHAR(10) DEFAULT 'home'` — `'home' | 'office'`
- `office_time_used BOOLEAN`
- `claude_cert_minutes INTEGER DEFAULT 0`
- `active_day BOOLEAN` — counts toward the 84-day denominator
Plus `date DATE`, `created_at`, `updated_at`.

### `dsa_log` — one row per solved problem
`id · user_id · date · problem_name VARCHAR(200) NOT NULL · pattern VARCHAR(100) · difficulty VARCHAR(20) · time_minutes INT · needed_help BOOL · help_level VARCHAR(20) DEFAULT 'alone' ('alone'|'hint'|'copilot') · unaided_resolve BOOL (true iff help_level='alone') · notes TEXT · created_at`

### `journal_entries` — UNIQUE(user_id, date, entry_type)
`entry_type` ∈ `wins | targets | brain_dump`; upsert on conflict.

### `weekly_reviews` — UNIQUE(user_id, week_number)
`week_number · salah_hits INT · dsa_count INT · notes · chastity_status VARCHAR(20) DEFAULT 'pass' · shield_notes`

### `exam_progress` — certification/exam tracking
Used by the Exam Tracker tab (e.g. Claude cert): exam name, target date, progress minutes/units, status. Surfaces in the dashboard and is editable in-session.

### `app_state` — schemaless JSONB key/value store
`key VARCHAR(50) UNIQUE · value JSONB · updated_at`. This is how both sync and Settings write structured state without new migrations. Known keys:

| Key | Shape | Written by |
|---|---|---|
| `today_plan` | `{dsa: [], spring_boot: '', system_design: '', career: '', devops: ''}` | sync push |
| `overdue_revisions` | `[{problem_name, days_overdue, ...}]` | sync push |
| `unaided_queue` | `[{problem_name, ...}]` | sync push |
| `quotes` | array of quote strings (rotated daily) | Settings tab |
| `chart_range` | integer days for chart windows | Settings tab |
| `dua_mode` | on/off + selection for dua display | Settings tab |
| `block_names` | names of the 4 learning blocks | Settings tab |
| `milestones` | milestone definitions for Milestones tab | Settings/sync |

---

## 5. API Reference

Two auth modes **never mix**: browser routes use `requireAuth` (session cookie, redirects to `/login`); machine routes use `requireApiKey` (`x-api-key: <API_KEY>` header or `?api_key=` query, 401 JSON on failure).

### Page routes (session)

| Method | Path | Purpose |
|---|---|---|
| GET | `/login` | Render login page |
| POST | `/login` | bcrypt check → sets `req.session.user` → redirect `/` |
| GET | `/logout` | Destroy session → redirect `/login` |
| GET | `/` | Dashboard. Renders `dashboard.ejs` with ~20 template vars (see §6) |

### Session API (browser, `Content-Type: application/json` or form)

All return `{success: true}` or `{error: "..."}` with 4xx/5xx.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/progress` | `{field, value}` | Upsert one `daily_progress` field for **today**. `field` must be in the allowed list (all boolean toggles + `bar_hit`, `mode_used`, `office_time_used`, `claude_cert_minutes`, `active_day`). Type coercion: `bar_hit`/`mode_used` → string; `claude_cert_minutes` → int; everything else → bool. Auto-sets `salah_complete` when all 5 prayers true. |
| POST | `/api/dsa` | `{problem_name, pattern, difficulty, time_minutes, needed_help, notes, help_level}` | Insert into `dsa_log` for today. `help_level` validated against `alone/hint/copilot` (default `alone`); `unaided_resolve` derived. Powers the DSA Table CRUD (create). |
| POST | `/api/journal` | `{entry_type, content}` | Upsert today's journal entry (`wins`/`targets`/`brain_dump`). |
| POST | `/api/review` | `{week_number, salah_hits, dsa_count, notes, chastity_status, shield_notes}` | Upsert weekly review. |

The Quick-Edit feature in the UI is just inline elements calling `POST /api/progress` — there is no separate endpoint.

### Machine sync API (`x-api-key`)

| Method | Path | Params/Body | Response |
|---|---|---|---|
| GET | `/api/sync` | `?date=YYYY-MM-DD` (default today) | `{date, progress[], dsa_log[], journal[], reviews[]}` — reviews = last 4 |
| POST | `/api/sync/update` | `{field, value, date?}` | `{success:true}` — same allowed-field list as `/api/progress`, hardcoded `user_id=1`, any date |
| POST | `/api/sync/bulk` | `{dsa_problems[], state{}, overdue_revisions[], unaided_queue[], today_plan{}}` (all optional) | `{success:true, date}` — inserts DSA rows (skips entries with no `problem_name`), upserts today's `bar_hit/mode_used/office_time_used/claude_cert_minutes/active_day`, upserts the three `app_state` keys |
| GET | `/api/state` | — | Full dump: `{daily_progress[] (14 days), dsa_log[] (all), journal_entries[], weekly_reviews[], app_state[]}` |

### Example calls

```bash
KEY="hermes-sync-ramish-2026"
URL="https://ramish-command-center-f4bee27fd546.herokuapp.com"

curl -s -H "x-api-key: $KEY" "$URL/api/sync?date=2026-07-30"

curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"field":"fajr","value":true,"date":"2026-07-30"}' \
  "$URL/api/sync/update"

curl -s -H "x-api-key: $KEY" "$URL/api/state"
```

---

## 6. Feature Map (Dashboard v3)

The dashboard is one EJS page organized by a **Tab Nav** bar. Everything below renders server-side; interactivity is vanilla JS `fetch()` to the session API with optimistic UI updates.

### Core (from v2)
- **Hero** — Day X of 84, current streak 🔥, today's bar status, DSA unaided %.
- **Trajectory** — pace (problems/active day), projected completion day, rest-day budget, speed-up warning when projectedFinishDays > 84. Pure server math, no chart lib.
- **Today Plan** — from `app_state.today_plan`: DSA queue, Spring Boot, System Design, Career, DevOps lines.
- **Overdue** — red warning cards from `app_state.overdue_revisions`.
- **Unaided** — re-solve queue from `app_state.unaided_queue`; unaided % = `alone / (alone+hint+copilot)`.
- **Charts** — pure-CSS bar charts: 14-day DSA counts, 7-day bar hits, 7-day prayer completion (from the `history` template var).
- **Mode** — 🏠 laptop / 🏢 office indicator + office-time-used toggle.

### New in v3 (this redesign)
- **Tab Nav** — top navigation switching between Today / DSA / Shields / Exams / History / Settings without page reloads.
- **Milestones** — roadmap checkpoints across the 84 days (e.g. "50 DSA", "Week 4 review done"), sourced from `app_state.milestones`, showing hit/missed/upcoming state.
- **Streak Calendar** — GitHub-style heatmap of recent days colored by completion (salah/bar/active day), built from `daily_progress` history.
- **DSA Table CRUD** — full table of `dsa_log` with add (POST `/api/dsa`), inline edit, and delete; filter by pattern/difficulty/help_level.
- **Exam Tracker** — `exam_progress` table surfaced as a tab: cert progress, minutes logged, days-to-exam countdown; complements `claude_cert_minutes` on daily_progress.
- **Shield Hexagon** — radar/hexagon visualization of the shields (khalwah, night protocol, phone, gaze, riba, fasting) so weak sides are visible at a glance.
- **History Mode** — read-only browsing of past days (progress rows + journal + DSA for a selected date).
- **Settings** — writes `app_state` keys: quotes, chart_range, dua_mode, block_names (see §10).
- **Quick-Edit** — inline editing of today-plan lines and key fields straight from the dashboard; saves via `POST /api/progress` / app_state upsert.

### Template variables contract (GET /)
`user, todayProgress, salahStreak, dsaStreak, survivalStreak, dsaCount, weekStats, dayNumber, journal[], review, recentDsa[], today, activeDayCount, dsaUnaided{alone,hint,copilot,percent}, history{dsa[],bars[],prayers[]}, appState[], todayPlan, overdueRevisions[], unaidedQueue[], projection{pace,daysRemaining,projectedFinishDays,restBudget,needToSpeedUp}` — **plus** whatever the v3 tabs require (exam rows, milestones). If you add a `<%= var %>` to the template you MUST add it to this render call or the dashboard 500s.

---

## 7. Sync Flow

```
Evening Close-Out cron (9:30 PM IST, Hermes)
   1. Hermes updates markdown trackers:
      session-state.md, tracker/dsa-tracker.md, tracker/progress.md
   2. python3 /root/career-tracker/sync-heroku.py push
        ├─ parse_session_state()    → active_days, streak, bar_hit, dsa stats
        ├─ parse_dsa_tracker()      → problems w/ help_level
        ├─ parse_overdue_revisions()→ overdue list
        ├─ parse_unaided_queue()    → re-solve queue
        ├─ parse_today_plan()       → next-day plan
        ├─ POST /api/sync/update    (per-field for today)
        └─ POST /api/sync/bulk      (problems + app_state keys)
   3. Heroku API writes Postgres (dsa_log rows, daily_progress, app_state)
   4. Ramish opens the dashboard → sees the evening's state
```

Reverse direction: `sync-heroku.py pull` calls `GET /api/state`, then regenerates the markdown files from Postgres (used when Ramish entered data in the web UI during the day). `sync-heroku.py status` diffs both sides without writing.

**Rules of engagement:**
- Markdown → DB every evening (push). DB → markdown only when the web app was edited that day (pull).
- The sync script is stdlib-only and idempotent-ish: bulk inserts can duplicate DSA rows if pushed twice — check `status` before re-pushing.
- API key is read from `$COMMAND_CENTER_API_KEY`, falling back to the baked-in default.

---

## 8. Run Locally

You need a reachable PostgreSQL. There is **no** bundled dev database.

```bash
cd /root/career-tracker
cp .env.example .env          # then fill in real values:
#   DATABASE_URL=postgresql://user:pass@localhost:5432/command_center
#   SESSION_SECRET=$(openssl rand -hex 32)
#   API_KEY=hermes-sync-ramish-2026
npm install
node server.js                # → http://localhost:3000
```

`initDB()` will create all tables and seed the default `ramish / ramish2026` user on first boot.
No local Postgres? Validate syntax-only: `node -c server.js`, then rely on Heroku deploy + logs (see pitfalls).

---

## 9. Deploy

```bash
export HEROKU_API_KEY="HRKU-…"        # Heroku CLI auth (account API key)
cd /root/career-tracker

git add -A && git commit -m "…" && git push origin master   # GitHub backup
git push heroku master                                       # deploy
heroku logs -a ramish-command-center -n 20                   # verify boot
python3 sync-heroku.py push                                  # refresh data
```

Config vars already set on the app: `DATABASE_URL` (from the Postgres addon), `SESSION_SECRET`, `API_KEY`. Useful: `heroku ps:restart -a ramish-command-center` after config changes.

### Pitfalls (learned the hard way)
- **Diverged origin/master** — prior sessions may have pushed. Fix: `git reset --hard origin/master`, `git checkout <our-commit> -- .`, recommit. Never force-push.
- **Dashboard 500 after deploy** — almost always a missing EJS variable. `heroku logs -a ramish-command-center -n 20` shows the `ReferenceError` with line number.
- **DB migrations** — only ever `ADD COLUMN IF NOT EXISTS`; the production DB must survive every boot.
- **Heroku CLI v11** — use `-n <count>`, not `--tail`, for one-shot logs.
- **JSONB ambiguity** — parse defensively (see §3).

---

## 10. Customization (Settings → `app_state`)

The Settings tab is a UI over the `app_state` JSONB store — no migrations, instant effect on next dashboard render:

| Setting | `app_state` key | Effect |
|---|---|---|
| Rotating quotes | `quotes` | Array shown in the Hero; rotates daily |
| Chart range | `chart_range` | Window size (days) for DSA/bar/prayer charts |
| Dua mode | `dua_mode` | Toggle/choose dua display on dashboard |
| Block names | `block_names` | Labels for the 4 daily learning blocks |
| Milestones | `milestones` | Definitions rendered by the Milestones tab |

Because these live in `app_state`, the sync script or any API client can also set them via a bulk-style upsert — the Settings tab is just the friendly surface.

---

*Stack summary in one line: one Node process (`server.js`) → EJS (`dashboard.ejs`) → CSS (`style.css`) with Postgres underneath and a Python sync script bridging it to Hermes markdown trackers.*
