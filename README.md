# Ramish's Command Center

Personal self-improvement tracker — a full-stack web app to track daily routines, prayers, learning blocks, DSA practice, and weekly reviews.

## 🔗 Live App
**URL:** https://ramish-command-center-f4bee27fd546.herokuapp.com
**Login:** `ramish` / `ramish2026` (change after first login)

## 🚀 Tech Stack
- **Backend:** Node.js + Express.js
- **Database:** PostgreSQL (Heroku Postgres)
- **Frontend:** EJS templates + vanilla CSS/JS
- **Hosting:** Heroku (EU region, heroku-26 stack)
- **Auth:** Session-based with bcrypt password hashing

## 📋 Features
- **Survival Layer** — morning routine checklist (alarm, wudu, tahajjud, Fajr)
- **Salah Tracker** — all 5 daily prayers + Jumu'ah on Fridays + streak counter
- **Prime Layer** — morning reading, targets, house task
- **Training** — MMA, post-workout meal, shower
- **Learning Blocks** — 4 blocks (DSA, Spring Boot, System Design, Revision) = 6 hrs/day
- **Daily Shields** — habit tracking (ghusl rule, khalwah shield, night protocol, phone out of bedroom, lower gaze, no new riba)
- **Evening Reset** — checklist + haldi doodh + sleep on wudu
- **DSA Tracker** — log problems with pattern, difficulty, time, notes
- **Journal** — 3 wins, 3 targets, brain dump
- **Weekly Review** — salah hits, DSA count, shield notes
- **Streaks** — fire emoji badges for Salah, DSA, Survival Layer
- **12-Week Progress Bar** — Day X of 84
- **Rotating Quotes** — Islamic + motivational, changes daily
- **Responsive** — works on phone and PC

## 🔌 API for Sync
The app has an API for external sync (used by Hermes Agent):

### Get today's data
```
GET /api/sync?date=YYYY-MM-DD
Header: x-api-key: hermes-sync-ramish-2026
```

### Update a field
```
POST /api/sync/update
Header: x-api-key: hermes-sync-ramish-2026
Body: { "field": "fajr", "value": true, "date": "YYYY-MM-DD" }
```

### Available fields
`fajr`, `dhuhr`, `asr`, `maghrib`, `isha`, `jumuah`, `tahajjud`, `duha`, `survival_layer`, `morning_reading`, `targets_set`, `house_task`, `mma`, `post_workout_meal`, `shower`, `dsa_done`, `spring_boot_done`, `system_design_done`, `revision_done`, `evening_reset`, `haldi_doodh`, `sleep_on_wudu`, `ghusl_rule`, `khalwah_shield`, `night_protocol`, `phone_out_of_bedroom`, `lower_gaze`, `fasting`, `no_new_riba`, `block1_done`, `block2_done`, `block3_done`, `block4_done`

## 🚀 Deploy

### Prerequisites
- Heroku CLI installed: `https://devcenter.heroku.com/articles/heroku-cli`
- Node.js 22+ installed locally

### Step 1: Create the Heroku app (EU region, latest stack)
```bash
heroku create ramish-command-center --region eu
heroku stack:set heroku-26 -a ramish-command-center
```

### Step 2: Add PostgreSQL database
```bash
heroku addons:create heroku-postgresql:essential-0 -a ramish-command-center
```
This auto-sets the `DATABASE_URL` config var. Wait for provisioning:
```bash
heroku addons:info heroku-postgresql -a ramish-command-center
```

### Step 3: Set environment variables
```bash
heroku config:set \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  API_KEY="hermes-sync-ramish-2026" \
  -a ramish-command-center
```

### Step 4: Deploy
```bash
# First time: set the git remote
heroku git:remote -a ramish-command-center

# Deploy
git push heroku master
```

### Step 5: Scale the dyno
```bash
heroku ps:scale web=1 -a ramish-command-center
```

### Step 6: Verify
```bash
# Check logs
heroku logs -a ramish-command-center -n 20

# Test the login page
curl -s https://<your-app-name>.heroku.com/login

# Test the sync API
curl -s -H "x-api-key: hermes-sync-ramish-2026" https://<your-app-name>.heroku.com/api/sync
```

### Default login
- **Username:** `ramish`
- **Password:** `ramish2026`
- The default user is created automatically on first boot. **Change the password after first login.**

### Useful Heroku commands
```bash
# View app info
heroku apps:info -a ramish-command-center

# View config vars
heroku config -a ramish-command-center

# View logs (live)
heroku logs -a ramish-command-center -t

# Restart the app
heroku ps:restart -a ramish-command-center

# Open the app in browser
heroku open -a ramish-command-center

# Destroy the app (nuclear option)
heroku destroy -a ramish-command-center --confirm ramish-command-center
```

### Heroku CLI Authentication
To deploy from a new machine, authenticate with your Heroku API key:
```bash
export HEROKU_API_KEY=HRKU-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
# Or: heroku login
```

Get your API key from: https://dashboard.heroku.com/account → Account Settings → API Keys

## 🔐 Environment Variables
See `.env.example` for a template with dummy values. Copy to `.env` for local development:
```bash
cp .env.example .env
```

On Heroku, set config vars (DO NOT commit .env to git):
```bash
heroku config:set SESSION_SECRET="..." API_KEY="..." -a ramish-command-center
```

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string (auto-set by Heroku Postgres) | `postgresql://user:pass@host:5432/db` |
| `SESSION_SECRET` | Express session secret (random string) | `openssl rand -hex 32` |
| `API_KEY` | API key for Hermes sync endpoint | `hermes-sync-ramish-2026` |
| `HEROKU_API_KEY` | Heroku CLI API key (for deployment, not the app) | `HRKU-XXXX...` |

## 📁 Project Structure
```
├── server.js          # Express server + DB init + routes
├── package.json       # Dependencies
├── Procfile           # Heroku process file
├── views/
│   ├── login.ejs      # Login page
│   └── dashboard.ejs  # Main dashboard
└── public/
    └── css/
        └── style.css   # Responsive dark theme styles
```

## 🎯 Purpose
This app is a daily command center for a 12-week career switch journey (TCS → GCC/product company). It tracks prayers, fitness, learning, and personal shields — all in one place, optimized for ADHD (visual, chunked, big tap targets).

---

Built with Bismillah. 🤲
