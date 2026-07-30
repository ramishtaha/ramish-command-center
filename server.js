require('dotenv').config();

const express = require('express');
const pg = require('pg');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('amazonaws') ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ramish-command-center-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Auth middleware
const requireAuth = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login');
};

const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key === process.env.API_KEY) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// Helper: upsert app_state
async function upsertAppState(client, key, value) {
  await client.query(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
}

// ============= ROUTES =============

// Login
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.render('login', { error: 'Invalid credentials' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.render('login', { error: 'Invalid credentials' });
    req.session.user = { id: user.id, username: user.username };
    res.redirect('/');
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: 'Server error' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ============= DASHBOARD =============
app.get('/', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Today's progress
    const progress = await pool.query('SELECT * FROM daily_progress WHERE user_id = $1 AND date = $2', [req.session.user.id, today]);
    const todayProgress = progress.rows[0] || {};

    // Streaks
    const salahStreak = await getStreak(pool, req.session.user.id, 'salah_complete');
    const dsaStreak = await getStreak(pool, req.session.user.id, 'dsa_done');
    const survivalStreak = await getStreak(pool, req.session.user.id, 'survival_layer');

    // DSA count
    const dsaCount = await pool.query('SELECT COUNT(*) FROM dsa_log WHERE user_id = $1', [req.session.user.id]);

    // Active day count
    const activeDayResult = await pool.query('SELECT COUNT(*) FROM daily_progress WHERE user_id = $1 AND active_day = true', [req.session.user.id]);
    const activeDayCount = parseInt(activeDayResult.rows[0].count, 10);

    // DSA unaided stats
    const dsaUnaidedRaw = await pool.query('SELECT help_level, COUNT(*) FROM dsa_log WHERE user_id = $1 GROUP BY help_level', [req.session.user.id]);
    const dsaUnaidedMap = {};
    dsaUnaidedRaw.rows.forEach(r => { dsaUnaidedMap[r.help_level] = parseInt(r.count, 10); });
    const aloneCount = dsaUnaidedMap.alone || 0;
    const hintCount = dsaUnaidedMap.hint || 0;
    const copilotCount = dsaUnaidedMap.copilot || 0;
    const dsaTotal = aloneCount + hintCount + copilotCount;
    const dsaUnaided = {
      alone: aloneCount, hint: hintCount, copilot: copilotCount,
      total: dsaTotal,
      percent: dsaTotal > 0 ? Math.round((aloneCount / dsaTotal) * 100) : 0
    };

    // Weekly stats
    const weekStats = await getWeekStats(pool, req.session.user.id);

    // 12-week day number (calendar-based for progress bar)
    const startDate = new Date('2026-07-27');
    const dayNumber = Math.max(0, Math.ceil((new Date() - startDate) / (1000 * 60 * 60 * 24)));

    // Journal
    const journal = await pool.query('SELECT * FROM journal_entries WHERE user_id = $1 ORDER BY date DESC LIMIT 5', [req.session.user.id]);

    // Weekly review
    const review = await pool.query('SELECT * FROM weekly_reviews WHERE user_id = $1 ORDER BY week_number DESC LIMIT 1', [req.session.user.id]);

    // Recent DSA
    const recentDsa = await pool.query('SELECT * FROM dsa_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [req.session.user.id]);

    // History: DSA per day (14 days)
    const dsaHistoryRaw = await pool.query("SELECT date, COUNT(*) as count FROM dsa_log WHERE user_id = $1 AND date >= NOW() - INTERVAL '14 days' GROUP BY date ORDER BY date", [req.session.user.id]);

    // History: bar hits (7 days)
    const barHistoryRaw = await pool.query("SELECT date, bar_hit FROM daily_progress WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days' ORDER BY date", [req.session.user.id]);

    // History: prayers (7 days)
    const prayerHistoryRaw = await pool.query("SELECT date, fajr, dhuhr, asr, maghrib, isha FROM daily_progress WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days' ORDER BY date", [req.session.user.id]);

    const history = {
      dsa: dsaHistoryRaw.rows,
      bars: barHistoryRaw.rows,
      prayers: prayerHistoryRaw.rows
    };

    // App state — parse JSONB values
    const appStateRaw = await pool.query('SELECT * FROM app_state');
    const appStateMap = {};
    appStateRaw.rows.forEach(r => {
      try { appStateMap[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; }
      catch(e) { appStateMap[r.key] = r.value; }
    });
    const todayPlan = appStateMap.today_plan || { dsa: [], spring_boot: '', system_design: '', career: '', devops: '' };
    const overdueRevisions = appStateMap.overdue_revisions || [];
    const unaidedQueue = appStateMap.unaided_queue || [];
    const settings = appStateMap.settings || { quotes_toggle: true, chart_range: 14, dua_mode: 'none', learning_blocks: ['DSA', 'Spring Boot', 'System Design', 'Revision'] };

    // Projection
    const dsaCountNum = parseInt(dsaCount.rows[0].count, 10);
    const pace = dsaCountNum / Math.max(activeDayCount, 1);
    const projectedFinishDays = activeDayCount + Math.ceil((171 - dsaCountNum) / Math.max(pace, 0.1));
    const restBudget = 84 - projectedFinishDays;
    const needToSpeedUp = projectedFinishDays > 84;
    const daysRemaining = 84 - dayNumber;
    const projection = { pace: pace.toFixed(1), daysRemaining, projectedFinishDays, restBudget, needToSpeedUp };

    // Motivation engine
    const disciplineDays = await pool.query("SELECT COUNT(*) FROM daily_progress WHERE user_id = $1 AND date >= '2026-07-27'", [req.session.user.id]);
    const disciplineScore = Math.min(100, Math.round((activeDayCount / Math.max(parseInt(disciplineDays.rows[0].count, 10), 1)) * 100));

    // Milestone
    const milestoneNext = computeMilestone(dsaCountNum, dsaStreak, salahStreak);

    // Days until offer window (Oct 1, 2026)
    const offerDate = new Date('2026-10-01');
    const daysUntilOffer = Math.max(0, Math.ceil((offerDate - new Date()) / (1000 * 60 * 60 * 24)));

    // Focus score (today's toggle completion %)
    const toggleFields = ['fajr','dhuhr','asr','maghrib','isha','survival_layer','morning_reading','targets_set','house_task','mma','post_workout_meal','shower','dsa_done','spring_boot_done','system_design_done','revision_done','evening_reset','haldi_doodh','sleep_on_wudu','ghusl_rule','khalwah_shield','night_protocol','phone_out_of_bedroom','lower_gaze','no_new_riba'];
    let completedToggles = 0;
    toggleFields.forEach(f => { if (todayProgress[f]) completedToggles++; });
    const focusScore = Math.round((completedToggles / toggleFields.length) * 100);

    // Weekly target progress (DSA this week)
    const weeklyDsa = await pool.query("SELECT COUNT(*) FROM dsa_log WHERE user_id = $1 AND date >= date_trunc('week', NOW())", [req.session.user.id]);
    const weeklyTargetProgress = { solved: parseInt(weeklyDsa.rows[0].count, 10), target: 15 };

    // Streak calendar (30 days)
    const streakCalRaw = await pool.query("SELECT date, salah_complete, dsa_done, active_day, bar_hit FROM daily_progress WHERE user_id = $1 AND date >= NOW() - INTERVAL '30 days' ORDER BY date", [req.session.user.id]);
    const streakCalendar = streakCalRaw.rows;

    // Exam stats
    const examStatsRaw = await pool.query('SELECT SUM(minutes_studied) as total_minutes, COUNT(DISTINCT topic) as topics, MAX(ready_score) as top_score FROM exam_progress WHERE user_id = $1', [req.session.user.id]);
    const examData = await pool.query('SELECT * FROM exam_progress WHERE user_id = $1 ORDER BY date DESC LIMIT 10', [req.session.user.id]);
    const examStats = {
      totalMinutes: parseInt(examStatsRaw.rows[0].total_minutes || 0, 10),
      topics: parseInt(examStatsRaw.rows[0].topics || 0, 10),
      topScore: parseInt(examStatsRaw.rows[0].top_score || 0, 10),
      daysUntilCert: daysUntilOffer
    };

    // All DSA for table view
    const allDsa = await pool.query('SELECT * FROM dsa_log WHERE user_id = $1 ORDER BY date DESC, created_at DESC', [req.session.user.id]);

    // All journal for journal tab
    const allJournal = await pool.query('SELECT * FROM journal_entries WHERE user_id = $1 ORDER BY date DESC', [req.session.user.id]);

    res.render('dashboard', {
      user: req.session.user,
      todayProgress,
      salahStreak, dsaStreak, survivalStreak,
      dsaCount: dsaCount.rows[0].count,
      dsaUnaided,
      weekStats,
      dayNumber, activeDayCount,
      projection, todayPlan, overdueRevisions, unaidedQueue,
      history, appState: appStateRaw.rows, settings,
      journal: journal.rows, review: review.rows[0],
      recentDsa: recentDsa.rows, allDsa: allDsa.rows, allJournal: allJournal.rows,
      today: new Date(),
      disciplineScore, milestoneNext, daysUntilOffer,
      focusScore, weeklyTargetProgress, streakCalendar,
      examStats, examData: examData.rows
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard: ' + err.message);
  }
});

// ============= PROGRESS API =============

app.post('/api/progress', requireAuth, async (req, res) => {
  const { field, value } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const userId = req.session.user.id;

  const allowedFields = ['fajr','dhuhr','asr','maghrib','isha','jumuah','tahajjud','duha',
    'survival_layer','morning_reading','targets_set','house_task',
    'mma','post_workout_meal','shower',
    'dsa_done','spring_boot_done','system_design_done','revision_done',
    'evening_reset','haldi_doodh','sleep_on_wudu','ghusl_rule',
    'khalwah_shield','night_protocol','phone_out_of_bedroom','lower_gaze',
    'fasting','no_new_riba',
    'block1_done','block2_done','block3_done','block4_done',
    'bar_hit','mode_used','office_time_used','claude_cert_minutes','active_day'];

  if (!allowedFields.includes(field)) return res.status(400).json({ error: 'Invalid field' });

  const stringFields = ['bar_hit', 'mode_used'];
  const intFields = ['claude_cert_minutes'];
  let dbValue;
  if (stringFields.includes(field)) dbValue = String(value);
  else if (intFields.includes(field)) dbValue = parseInt(value, 10) || 0;
  else dbValue = value === true || value === 'true';

  try {
    await pool.query(`INSERT INTO daily_progress (user_id, date, ${field}) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO UPDATE SET ${field} = $3, updated_at = NOW()`, [userId, today, dbValue]);
    if (['fajr','dhuhr','asr','maghrib','isha'].includes(field)) {
      const allPrayers = await pool.query('SELECT fajr, dhuhr, asr, maghrib, isha FROM daily_progress WHERE user_id = $1 AND date = $2', [userId, today]);
      if (allPrayers.rows[0] && allPrayers.rows[0].fajr && allPrayers.rows[0].dhuhr && allPrayers.rows[0].asr && allPrayers.rows[0].maghrib && allPrayers.rows[0].isha) {
        await pool.query('UPDATE daily_progress SET salah_complete = true WHERE user_id = $1 AND date = $2', [userId, today]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Progress update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Progress history
app.get('/api/progress/history', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days, 10) || 7;
  try {
    const result = await pool.query("SELECT * FROM daily_progress WHERE user_id = $1 AND date >= NOW() - INTERVAL '$2 days' ORDER BY date DESC", [req.session.user.id, days]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Update past date
app.put('/api/progress/:date', requireAuth, async (req, res) => {
  const { date } = req.params;
  const { field, value } = req.body;
  const allowedFields = ['fajr','dhuhr','asr','maghrib','isha','jumuah','tahajjud','duha',
    'survival_layer','morning_reading','targets_set','house_task','mma','post_workout_meal','shower',
    'dsa_done','spring_boot_done','system_design_done','revision_done','evening_reset','haldi_doodh',
    'sleep_on_wudu','ghusl_rule','khalwah_shield','night_protocol','phone_out_of_bedroom','lower_gaze',
    'fasting','no_new_riba','block1_done','block2_done','block3_done','block4_done',
    'bar_hit','mode_used','office_time_used','claude_cert_minutes','active_day'];
  if (!allowedFields.includes(field)) return res.status(400).json({ error: 'Invalid field' });
  const stringFields = ['bar_hit','mode_used'];
  const intFields = ['claude_cert_minutes'];
  let dbValue;
  if (stringFields.includes(field)) dbValue = String(value);
  else if (intFields.includes(field)) dbValue = parseInt(value, 10) || 0;
  else dbValue = value === true || value === 'true';
  try {
    await pool.query(`INSERT INTO daily_progress (user_id, date, ${field}) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO UPDATE SET ${field} = $3, updated_at = NOW()`, [req.session.user.id, date, dbValue]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Bulk progress update
app.post('/api/progress/bulk', requireAuth, async (req, res) => {
  const { date: targetDate, updates } = req.body;
  const d = targetDate || new Date().toISOString().split('T')[0];
  try {
    const client = await pool.connect();
    for (const [field, value] of Object.entries(updates)) {
      await client.query(`INSERT INTO daily_progress (user_id, date, ${field}) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO UPDATE SET ${field} = $3, updated_at = NOW()`, [req.session.user.id, d, value]);
    }
    client.release();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= DSA API =============

app.post('/api/dsa', requireAuth, async (req, res) => {
  const { problem_name, pattern, difficulty, time_minutes, needed_help, notes, help_level } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const validHelpLevels = ['alone','hint','copilot'];
  const safeHelpLevel = validHelpLevels.includes(help_level) ? help_level : 'alone';
  const unaidedResolve = safeHelpLevel === 'alone';
  try {
    await pool.query(`INSERT INTO dsa_log (user_id, date, problem_name, pattern, difficulty, time_minutes, needed_help, notes, help_level, unaided_resolve) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [req.session.user.id, today, problem_name, pattern, difficulty, time_minutes || null, needed_help === 'true', notes || null, safeHelpLevel, unaidedResolve]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/dsa/all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dsa_log WHERE user_id = $1 ORDER BY date DESC, created_at DESC', [req.session.user.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/dsa/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { problem_name, pattern, difficulty, time_minutes, needed_help, notes, help_level, date } = req.body;
  const validHelpLevels = ['alone','hint','copilot'];
  const safeHelpLevel = validHelpLevels.includes(help_level) ? help_level : 'alone';
  try {
    await pool.query(`UPDATE dsa_log SET problem_name=$1, pattern=$2, difficulty=$3, time_minutes=$4, needed_help=$5, notes=$6, help_level=$7, date=$8 WHERE id=$9 AND user_id=$10`,
      [problem_name, pattern, difficulty, time_minutes || null, needed_help === 'true' || needed_help === true, notes || null, safeHelpLevel, date, id, req.session.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/dsa/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM dsa_log WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= JOURNAL API =============

app.post('/api/journal', requireAuth, async (req, res) => {
  const { entry_type, content } = req.body;
  const today = new Date().toISOString().split('T')[0];
  try {
    await pool.query(`INSERT INTO journal_entries (user_id, date, entry_type, content) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, date, entry_type) DO UPDATE SET content = $4, updated_at = NOW()`, [req.session.user.id, today, entry_type, content]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/journal/all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM journal_entries WHERE user_id = $1 ORDER BY date DESC', [req.session.user.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/journal/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { entry_type, content } = req.body;
  try {
    await pool.query('UPDATE journal_entries SET entry_type=$1, content=$2, updated_at=NOW() WHERE id=$3 AND user_id=$4', [entry_type, content, id, req.session.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= REVIEW API =============

app.post('/api/review', requireAuth, async (req, res) => {
  const { week_number, salah_hits, dsa_count, notes, chastity_status, shield_notes } = req.body;
  try {
    await pool.query(`INSERT INTO weekly_reviews (user_id, week_number, salah_hits, dsa_count, notes, chastity_status, shield_notes) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, week_number) DO UPDATE SET salah_hits = $3, dsa_count = $4, notes = $5, chastity_status = $6, shield_notes = $7, updated_at = NOW()`, [req.session.user.id, week_number, salah_hits, dsa_count, notes, chastity_status || 'pass', shield_notes || null]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/review/all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM weekly_reviews WHERE user_id = $1 ORDER BY week_number DESC', [req.session.user.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/review/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { week_number, salah_hits, dsa_count, notes, chastity_status, shield_notes } = req.body;
  try {
    await pool.query('UPDATE weekly_reviews SET week_number=$1, salah_hits=$2, dsa_count=$3, notes=$4, chastity_status=$5, shield_notes=$6, updated_at=NOW() WHERE id=$7 AND user_id=$8', [week_number, salah_hits, dsa_count, notes, chastity_status || 'pass', shield_notes, id, req.session.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= EXAM/CERT API =============

app.get('/api/exam/all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM exam_progress WHERE user_id = $1 ORDER BY date DESC', [req.session.user.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/exam', requireAuth, async (req, res) => {
  const { topic, minutes_studied, notes, ready_score, date } = req.body;
  const d = date || new Date().toISOString().split('T')[0];
  try {
    await pool.query(`INSERT INTO exam_progress (user_id, date, topic, minutes_studied, notes, ready_score) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, date, topic) DO UPDATE SET minutes_studied = $4, notes = $5, ready_score = $6`, [req.session.user.id, d, topic, minutes_studied || 0, notes || null, ready_score || 1]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/exam/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { topic, minutes_studied, notes, ready_score, date } = req.body;
  try {
    await pool.query('UPDATE exam_progress SET topic=$1, minutes_studied=$2, notes=$3, ready_score=$4, date=$5 WHERE id=$6 AND user_id=$7', [topic, minutes_studied || 0, notes || null, ready_score || 1, date, id, req.session.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/exam/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM exam_progress WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= SETTINGS API =============

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM app_state WHERE key = 'settings'");
    if (result.rows.length > 0) {
      const val = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      res.json(val);
    } else {
      res.json({ quotes_toggle: true, chart_range: 14, dua_mode: 'none', learning_blocks: ['DSA', 'Spring Boot', 'System Design', 'Revision'] });
    }
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const { quotes_toggle, chart_range, dua_mode, color_scheme, learning_blocks } = req.body;
  const settings = {
    quotes_toggle: quotes_toggle !== false,
    chart_range: parseInt(chart_range, 10) || 14,
    dua_mode: dua_mode || 'none',
    color_scheme: color_scheme || 'emerald',
    learning_blocks: learning_blocks || ['DSA', 'Spring Boot', 'System Design', 'Revision']
  };
  try {
    const client = await pool.connect();
    await upsertAppState(client, 'settings', settings);
    client.release();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= HERMES SYNC API =============

app.get('/api/sync', requireApiKey, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const progress = await pool.query('SELECT * FROM daily_progress WHERE date = $1', [date]);
    const dsaLog = await pool.query('SELECT * FROM dsa_log WHERE date = $1 ORDER BY created_at DESC', [date]);
    const journal = await pool.query('SELECT * FROM journal_entries WHERE date = $1', [date]);
    const reviews = await pool.query('SELECT * FROM weekly_reviews ORDER BY week_number DESC LIMIT 4');
    res.json({ date, progress: progress.rows, dsa_log: dsaLog.rows, journal: journal.rows, reviews: reviews.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/sync/update', requireApiKey, async (req, res) => {
  const { field, value, date } = req.body;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const allowedFields = ['fajr','dhuhr','asr','maghrib','isha','jumuah','tahajjud','duha',
    'survival_layer','morning_reading','targets_set','house_task','mma','post_workout_meal','shower',
    'dsa_done','spring_boot_done','system_design_done','revision_done','evening_reset','haldi_doodh',
    'sleep_on_wudu','ghusl_rule','khalwah_shield','night_protocol','phone_out_of_bedroom','lower_gaze',
    'fasting','no_new_riba','block1_done','block2_done','block3_done','block4_done',
    'bar_hit','mode_used','office_time_used','claude_cert_minutes','active_day'];
  if (!allowedFields.includes(field)) return res.status(400).json({ error: 'Invalid field' });
  try {
    const userId = 1;
    await pool.query(`INSERT INTO daily_progress (user_id, date, ${field}) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO UPDATE SET ${field} = $3, updated_at = NOW()`, [userId, targetDate, value === true || value === 'true']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/sync/bulk', requireApiKey, async (req, res) => {
  const { dsa_problems, state, overdue_revisions, unaided_queue, today_plan, exam_progress: examEntries } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const userId = 1;
  try {
    const client = await pool.connect();
    // Insert DSA problems
    if (dsa_problems && Array.isArray(dsa_problems)) {
      for (const p of dsa_problems) {
        const validHelpLevels = ['alone','hint','copilot'];
        const safeHelpLevel = validHelpLevels.includes(p.help_level) ? p.help_level : 'alone';
        await client.query(`INSERT INTO dsa_log (user_id, date, problem_name, pattern, difficulty, help_level, unaided_resolve, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [userId, p.date || today, p.problem_name, p.pattern || null, p.difficulty || null, safeHelpLevel, safeHelpLevel === 'alone', p.notes || null]);
      }
    }
    // Update daily state
    if (state) {
      const s = state;
      await client.query(`INSERT INTO daily_progress (user_id, date, bar_hit, mode_used, office_time_used, claude_cert_minutes, active_day) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, date) DO UPDATE SET bar_hit=$3, mode_used=$4, office_time_used=$5, claude_cert_minutes=$6, active_day=$7, updated_at=NOW()`, [userId, today, s.bar_hit_today || 'none', s.mode_used || 'home', s.office_time_used || false, s.claude_cert_minutes || 0, s.active_day !== false]);
    }
    // Store state collections
    if (overdue_revisions) await upsertAppState(client, 'overdue_revisions', overdue_revisions);
    if (unaided_queue) await upsertAppState(client, 'unaided_queue', unaided_queue);
    if (today_plan) await upsertAppState(client, 'today_plan', today_plan);
    // Exam entries
    if (examEntries && Array.isArray(examEntries)) {
      for (const e of examEntries) {
        await client.query(`INSERT INTO exam_progress (user_id, date, topic, minutes_studied, notes, ready_score) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, date, topic) DO UPDATE SET minutes_studied=$4, notes=$5, ready_score=$6`, [userId, e.date || today, e.topic, e.minutes_studied || 0, e.notes || null, e.ready_score || 1]);
      }
    }
    client.release();
    res.json({ success: true });
  } catch (err) {
    console.error('Bulk sync error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/state', requireApiKey, async (req, res) => {
  try {
    const progress = await pool.query("SELECT * FROM daily_progress WHERE user_id = 1 AND date >= NOW() - INTERVAL '14 days' ORDER BY date DESC");
    const dsaLog = await pool.query('SELECT * FROM dsa_log WHERE user_id = 1 ORDER BY created_at DESC');
    const journal = await pool.query('SELECT * FROM journal_entries WHERE user_id = 1 ORDER BY date DESC');
    const reviews = await pool.query('SELECT * FROM weekly_reviews WHERE user_id = 1 ORDER BY week_number DESC LIMIT 4');
    const appState = await pool.query('SELECT * FROM app_state');
    const exam = await pool.query('SELECT * FROM exam_progress WHERE user_id = 1 ORDER BY date DESC');
    res.json({ progress: progress.rows, dsa_log: dsaLog.rows, journal: journal.rows, reviews: reviews.rows, app_state: appState.rows, exam_progress: exam.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= HELPER FUNCTIONS =============

async function getStreak(pool, userId, field) {
  const result = await pool.query(`
    WITH RECURSIVE streak_calc AS (
      SELECT date, ${field} as done, 1 as streak_count
      FROM daily_progress
      WHERE user_id = $1 AND ${field} = true
      AND date = (SELECT MAX(date) FROM daily_progress WHERE user_id = $1 AND ${field} = true)
      UNION ALL
      SELECT dp.date, dp.${field}, sc.streak_count + 1
      FROM daily_progress dp
      JOIN streak_calc sc ON dp.date = sc.date - INTERVAL '1 day'
      WHERE dp.user_id = $1 AND dp.${field} = true
    )
    SELECT COALESCE(MAX(streak_count), 0) as streak FROM streak_calc
  `, [userId]);
  return result.rows[0].streak || 0;
}

async function getWeekStats(pool, userId) {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE salah_complete = true) as salah_complete_days,
      COUNT(*) FILTER (WHERE dsa_done = true) as dsa_days,
      COUNT(*) FILTER (WHERE mma = true) as mma_days,
      COUNT(*) FILTER (WHERE survival_layer = true) as survival_days,
      COUNT(*) FILTER (WHERE active_day = true) as active_days,
      COUNT(*) FILTER (WHERE bar_hit = 'green') as low_bar_days,
      COUNT(*) FILTER (WHERE bar_hit = 'yellow') as high_bar_days,
      COUNT(*) as total_days
    FROM daily_progress
    WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days'
  `, [userId]);
  return result.rows[0];
}

function computeMilestone(dsaCount, dsaStreak, salahStreak) {
  const milestones = [
    { threshold: 10, current: dsaCount, label: '10 DSA Problems', icon: '🎓', name: 'Way of the Scholar' },
    { threshold: 50, current: dsaCount, label: '50 DSA Problems', icon: '⚔️', name: 'Pattern Warrior' },
    { threshold: 7, current: dsaStreak, label: '7-Day Streak', icon: '👑', name: 'Consistency Crown' },
    { threshold: 14, current: dsaStreak, label: '14-Day Streak', icon: '🔥', name: 'Fire of Discipline' },
    { threshold: 5, current: salahStreak, label: '5-Day Salah Streak', icon: '🕌', name: 'Salah Shield' }
  ];
  for (const m of milestones) {
    if (m.current < m.threshold) {
      return { label: m.label, icon: m.icon, name: m.name, current: m.current, threshold: m.threshold, pct: Math.round((m.current / m.threshold) * 100) };
    }
  }
  return { label: 'All milestones reached!', icon: '🏆', name: 'Champion', current: 100, threshold: 100, pct: 100 };
}

// ============= DB INIT =============

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE, password_hash TEXT, created_at TIMESTAMP DEFAULT NOW())');

    await client.query(`CREATE TABLE IF NOT EXISTS daily_progress (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), date DATE NOT NULL,
      fajr BOOLEAN DEFAULT false, dhuhr BOOLEAN DEFAULT false, asr BOOLEAN DEFAULT false,
      maghrib BOOLEAN DEFAULT false, isha BOOLEAN DEFAULT false, jumuah BOOLEAN DEFAULT false,
      tahajjud BOOLEAN DEFAULT false, duha BOOLEAN DEFAULT false, salah_complete BOOLEAN DEFAULT false,
      survival_layer BOOLEAN DEFAULT false, morning_reading BOOLEAN DEFAULT false,
      targets_set BOOLEAN DEFAULT false, house_task BOOLEAN DEFAULT false,
      mma BOOLEAN DEFAULT false, post_workout_meal BOOLEAN DEFAULT false, shower BOOLEAN DEFAULT false,
      dsa_done BOOLEAN DEFAULT false, spring_boot_done BOOLEAN DEFAULT false,
      system_design_done BOOLEAN DEFAULT false, revision_done BOOLEAN DEFAULT false,
      evening_reset BOOLEAN DEFAULT false, haldi_doodh BOOLEAN DEFAULT false,
      sleep_on_wudu BOOLEAN DEFAULT false, ghusl_rule BOOLEAN DEFAULT false,
      khalwah_shield BOOLEAN DEFAULT false, night_protocol BOOLEAN DEFAULT false,
      phone_out_of_bedroom BOOLEAN DEFAULT false, lower_gaze BOOLEAN DEFAULT false,
      fasting BOOLEAN DEFAULT false, no_new_riba BOOLEAN DEFAULT false,
      block1_done BOOLEAN DEFAULT false, block2_done BOOLEAN DEFAULT false,
      block3_done BOOLEAN DEFAULT false, block4_done BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, date)
    )`);

    // Migrations: add new columns if not exist
    const newCols = ['bar_hit VARCHAR(10) DEFAULT \'none\'', 'mode_used VARCHAR(10) DEFAULT \'home\'', 'office_time_used BOOLEAN DEFAULT false', 'claude_cert_minutes INTEGER DEFAULT 0', 'active_day BOOLEAN DEFAULT false'];
    for (const col of newCols) {
      const colName = col.split(' ')[0];
      await client.query(`ALTER TABLE daily_progress ADD COLUMN IF NOT EXISTS ${col}`);
    }

    await client.query(`CREATE TABLE IF NOT EXISTS dsa_log (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), date DATE NOT NULL,
      problem_name VARCHAR(200) NOT NULL, pattern VARCHAR(100), difficulty VARCHAR(20),
      time_minutes INTEGER, needed_help BOOLEAN DEFAULT false, notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`ALTER TABLE dsa_log ADD COLUMN IF NOT EXISTS help_level VARCHAR(20) DEFAULT 'alone'`);
    await client.query(`ALTER TABLE dsa_log ADD COLUMN IF NOT EXISTS unaided_resolve BOOLEAN DEFAULT false`);

    await client.query(`CREATE TABLE IF NOT EXISTS journal_entries (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), date DATE NOT NULL,
      entry_type VARCHAR(50) NOT NULL, content TEXT,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, date, entry_type)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS weekly_reviews (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), week_number INTEGER NOT NULL,
      salah_hits INTEGER, dsa_count INTEGER, notes TEXT,
      chastity_status VARCHAR(20) DEFAULT 'pass', shield_notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, week_number)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS app_state (
      id SERIAL PRIMARY KEY, key VARCHAR(50) UNIQUE, value JSONB, updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS exam_progress (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), date DATE NOT NULL,
      topic VARCHAR(200) NOT NULL, minutes_studied INTEGER DEFAULT 0,
      notes TEXT, ready_score INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, date, topic)
    )`);

    // Create default user if not exists
    const userExists = await client.query('SELECT * FROM users WHERE username = $1', ['ramish']);
    if (userExists.rows.length === 0) {
      const hash = await bcrypt.hash('ramish2026', 10);
      await client.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', ['ramish', hash]);
      console.log('Default user created: ramish / ramish2026');
    }
    console.log('Database initialized');
  } catch (err) {
    console.error('DB init error:', err);
  } finally {
    client.release();
  }
}

// Start
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
