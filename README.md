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

## 🛠️ Local Development
```bash
npm install
createdb ramish_command_center  # or use DATABASE_URL
node server.js
```

## 📦 Deploy
```bash
heroku git:remote -a ramish-command-center
git push heroku master
```

## 🔐 Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Heroku Postgres)
- `SESSION_SECRET` — Express session secret
- `API_KEY` — API key for external sync

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
