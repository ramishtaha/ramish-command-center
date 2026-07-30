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
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Auth middleware
const requireAuth = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login');
};

// Session auth for API endpoints (returns JSON 401 instead of redirect)
const requireApiAuth = (req, res, next) => {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// API key auth for Hermes sync
const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key === process.env.API_KEY) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

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

// Dashboard
app.get('/', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get today's progress
    const progress = await pool.query('SELECT * FROM daily_progress WHERE user_id = $1 AND date = $2', [req.session.user.id, today]);
    const todayProgress = progress.rows[0] || {};
    
    // Get streaks
    const salahStreak = await getStreak(pool, req.session.user.id, 'salah_complete');
    const dsaStreak = await getStreak(pool, req.session.user.id, 'dsa_done');
    const survivalStreak = await getStreak(pool, req.session.user.id, 'survival_layer');
    
    // Get DSA count
    const dsaCount = await pool.query('SELECT COUNT(*) FROM dsa_log WHERE user_id = $1', [req.session.user.id]);
    
    // Get weekly stats
    const weekStats = await getWeekStats(pool, req.session.user.id);
    
    // 12-week progress
    const startDate = new Date('2026-07-27');
    const dayNumber = Math.max(0, Math.ceil((new Date() - startDate) / (1000 * 60 * 60 * 24)));
    
    // Get journal entries
    const journal = await pool.query('SELECT * FROM journal_entries WHERE user_id = $1 ORDER BY date DESC LIMIT 5', [req.session.user.id]);
    
    // Get weekly review
    const review = await pool.query('SELECT * FROM weekly_reviews WHERE user_id = $1 ORDER BY week_number DESC LIMIT 1', [req.session.user.id]);
    
    // Get recent DSA problems
    const recentDsa = await pool.query('SELECT * FROM dsa_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [req.session.user.id]);
    
    // === NEW: Enhanced dashboard queries ===
    
    // Active day count
    const activeDayResult = await pool.query('SELECT COUNT(*) FROM daily_progress WHERE user_id = $1 AND active_day = true', [req.session.user.id]);
    const activeDayCount = parseInt(activeDayResult.rows[0].count, 10);
    
    // DSA unaided breakdown by help_level
    const dsaUnaidedRaw = await pool.query('SELECT help_level, COUNT(*) FROM dsa_log WHERE user_id = $1 GROUP BY help_level', [req.session.user.id]);
    // Transform into object the template expects: { alone, hint, copilot, percent }
    const dsaUnaidedMap = {};
    dsaUnaidedRaw.rows.forEach(r => { dsaUnaidedMap[r.help_level] = parseInt(r.count, 10); });
    const aloneCount = dsaUnaidedMap.alone || 0;
    const hintCount = dsaUnaidedMap.hint || 0;
    const copilotCount = dsaUnaidedMap.copilot || 0;
    const totalDsaForUnaided = aloneCount + hintCount + copilotCount;
    const dsaUnaided = {
      alone: aloneCount,
      hint: hintCount,
      copilot: copilotCount,
      percent: totalDsaForUnaided > 0 ? Math.round((aloneCount / totalDsaForUnaided) * 100) : 0
    };
    
    // History: last 14 days DSA counts
    const dsaHistoryRaw = await pool.query("SELECT date, COUNT(*) FROM dsa_log WHERE user_id = $1 AND date >= NOW() - INTERVAL '14 days' GROUP BY date ORDER BY date", [req.session.user.id]);
    
    // Bar history: last 7 days
    const barHistoryRaw = await pool.query("SELECT date, bar_hit FROM daily_progress WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days' ORDER BY date", [req.session.user.id]);
    
    // Prayer history: last 7 days
    const prayerHistoryRaw = await pool.query("SELECT date, fajr, dhuhr, asr, maghrib, isha FROM daily_progress WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days' ORDER BY date", [req.session.user.id]);
    
    // Assemble history object the template expects: { dsa:[], bars:[], prayers:[] }
    const history = {
      dsa: dsaHistoryRaw.rows.map(r => ({ date: r.date, count: parseInt(r.count, 10) })),
      bars: barHistoryRaw.rows.map(r => ({ date: r.date, bar_hit: r.bar_hit })),
      prayers: prayerHistoryRaw.rows
    };
    
    // App state — parse JSONB values into template vars
    const appStateRaw = await pool.query('SELECT * FROM app_state');
    const appStateMap = {};
    appStateRaw.rows.forEach(r => {
      try { appStateMap[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; }
      catch(e) { appStateMap[r.key] = r.value; }
    });
    const todayPlan = appStateMap.today_plan || { dsa: [], spring_boot: '', system_design: '', career: '', devops: '' };
    const overdueRevisions = appStateMap.overdue_revisions || [];
    const unaidedQueue = appStateMap.unaided_queue || [];
    const appState = appStateRaw.rows;
    const settings = appStateMap.settings || { quotes_toggle: true, chart_range: 14, dua_mode: 'none', learning_blocks: ['DSA', 'Spring Boot', 'System Design', 'Revision'] };
    
    // Projection
    const dsaCountNum = parseInt(dsaCount.rows[0].count, 10);
    const pace = dsaCountNum / Math.max(activeDayCount, 1);
    const projectedFinishDays = activeDayCount + Math.ceil((171 - dsaCountNum) / Math.max(pace, 0.1));
    const restBudget = 84 - projectedFinishDays;
    const needToSpeedUp = projectedFinishDays > 84;
    const daysRemaining = 84 - dayNumber;
    const projection = {
      pace: pace.toFixed(1),
      daysRemaining,
      projectedFinishDays,
      restBudget,
      needToSpeedUp
    };
    
    // === MOTIVATION ENGINE ===
    const motivation = await computeMotivation(req.session.user.id, weekStats, dsaCountNum, activeDayCount, dayNumber, startDate, todayProgress);
    
    // === EXAM/CERT DASHBOARD DATA ===
    const examData = await getExamDashboard(req.session.user.id);
    
    // === STREAK CALENDAR (30 days) ===
    const streakCalRaw = await pool.query("SELECT date, salah_complete, dsa_done, active_day, bar_hit FROM daily_progress WHERE user_id = $1 AND date >= NOW() - INTERVAL '30 days' ORDER BY date", [req.session.user.id]);
    const streakCalendar = streakCalRaw.rows;
    
    // === ALL DSA for table ===
    const allDsa = await pool.query('SELECT * FROM dsa_log WHERE user_id = $1 ORDER BY date DESC, created_at DESC', [req.session.user.id]);
    
    // === ALL JOURNAL ===
    const allJournal = await pool.query('SELECT * FROM journal_entries WHERE user_id = $1 ORDER BY date DESC', [req.session.user.id]);
    
    // Flatten motivation + examData for template
    const examStats = {
      totalMinutes: examData.totalMinutes || 0,
      topics: examData.topicsCovered || 0,
      topScore: (examData.latestReadiness && examData.latestReadiness.ready_score) || 0,
      daysUntilCert: examData.daysUntilExam || 0
    };
    
    res.render('dashboard', {
      user: req.session.user,
      todayProgress,
      salahStreak,
      dsaStreak,
      survivalStreak,
      dsaCount: dsaCount.rows[0].count,
      weekStats,
      dayNumber,
      journal: journal.rows,
      review: review.rows[0],
      recentDsa: recentDsa.rows,
      today: new Date(),
      // Enhanced variables
      activeDayCount,
      dsaUnaided,
      history,
      appState: appState.rows,
      todayPlan,
      overdueRevisions,
      unaidedQueue,
      projection,
      // Motivation engine (flattened)
      disciplineScore: motivation.disciplineScore,
      milestoneNext: motivation.milestoneNext,
      daysUntilOffer: motivation.daysUntilOffer,
      focusScore: motivation.focusScore,
      weeklyTargetProgress: motivation.weeklyTargetProgress,
      // Exam data (flattened)
      examStats,
      examData: examData.latestReadiness ? [examData.latestReadiness] : [],
      // Streak calendar
      streakCalendar,
      // All data for tabs
      allDsa: allDsa.rows,
      allJournal: allJournal.rows,
      // Settings
      settings
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard');
  }
});

// Update progress (AJAX)
app.post('/api/progress', requireAuth, async (req, res) => {
  const { field, value } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const userId = req.session.user.id;
  
  const allowedFields = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah', 'tahajjud', 'duha',
    'survival_layer', 'morning_reading', 'targets_set', 'house_task',
    'mma', 'post_workout_meal', 'shower',
    'dsa_done', 'spring_boot_done', 'system_design_done', 'revision_done',
    'evening_reset', 'haldi_doodh', 'sleep_on_wudu', 'ghusl_rule',
    'khalwah_shield', 'night_protocol', 'phone_out_of_bedroom', 'lower_gaze',
    'fasting', 'no_new_riba',
    'block1_done', 'block2_done', 'block3_done', 'block4_done',
    // NEW fields
    'bar_hit', 'mode_used', 'office_time_used', 'claude_cert_minutes', 'active_day'];
  
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }
  
  // Determine value type based on field
  const stringFields = ['bar_hit', 'mode_used'];
  const intFields = ['claude_cert_minutes'];
  let dbValue;
  if (stringFields.includes(field)) {
    dbValue = String(value);
  } else if (intFields.includes(field)) {
    dbValue = parseInt(value, 10) || 0;
  } else {
    dbValue = value === true || value === 'true';
  }
  
  try {
    await pool.query(`
      INSERT INTO daily_progress (user_id, date, ${field})
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, date) DO UPDATE SET ${field} = $3, updated_at = NOW()
    `, [userId, today, dbValue]);
    
    // Check if salah is complete
    if (['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].includes(field)) {
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

// Add DSA problem
app.post('/api/dsa', requireAuth, async (req, res) => {
  const { problem_name, pattern, difficulty, time_minutes, needed_help, notes, help_level } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  // Validate help_level
  const validHelpLevels = ['alone', 'hint', 'copilot'];
  const safeHelpLevel = validHelpLevels.includes(help_level) ? help_level : 'alone';
  const unaidedResolve = safeHelpLevel === 'alone';
  
  try {
    await pool.query(`
      INSERT INTO dsa_log (user_id, date, problem_name, pattern, difficulty, time_minutes, needed_help, notes, help_level, unaided_resolve)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [req.session.user.id, today, problem_name, pattern, difficulty, time_minutes || null, needed_help === 'true', notes || null, safeHelpLevel, unaidedResolve]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('DSA log error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add journal entry
app.post('/api/journal', requireAuth, async (req, res) => {
  const { entry_type, content } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  try {
    await pool.query(`
      INSERT INTO journal_entries (user_id, date, entry_type, content)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, date, entry_type) DO UPDATE SET content = $4, updated_at = NOW()
    `, [req.session.user.id, today, entry_type, content]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Journal error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save weekly review
app.post('/api/review', requireAuth, async (req, res) => {
  const { week_number, salah_hits, dsa_count, notes, chastity_status, shield_notes } = req.body;
  
  try {
    await pool.query(`
      INSERT INTO weekly_reviews (user_id, week_number, salah_hits, dsa_count, notes, chastity_status, shield_notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, week_number) DO UPDATE SET salah_hits = $3, dsa_count = $4, notes = $5, chastity_status = $6, shield_notes = $7, updated_at = NOW()
    `, [req.session.user.id, week_number, salah_hits, dsa_count, notes, chastity_status || 'pass', shield_notes || null]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============= FULL CRUD APIs =============

// GET /api/progress/history?days=N — array of daily_progress rows for last N days
app.get('/api/progress/history', requireApiAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 14;
    const result = await pool.query(
      `SELECT * FROM daily_progress WHERE user_id = $1 AND date >= NOW() - INTERVAL '${days} days' ORDER BY date DESC`,
      [req.session.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Progress history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/dsa/all — all dsa_log entries
app.get('/api/dsa/all', requireApiAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dsa_log WHERE user_id = $1 ORDER BY created_at DESC', [req.session.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('DSA all error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/dsa/:id — edit a DSA problem (all fields including help_level, date)
app.put('/api/dsa/:id', requireApiAuth, async (req, res) => {
  const dsaId = parseInt(req.params.id, 10);
  const { problem_name, pattern, difficulty, time_minutes, needed_help, notes, help_level, date } = req.body;
  const validHelpLevels = ['alone', 'hint', 'copilot'];
  const safeHelpLevel = validHelpLevels.includes(help_level) ? help_level : 'alone';
  const unaidedResolve = safeHelpLevel === 'alone';
  
  try {
    const result = await pool.query(`
      UPDATE dsa_log SET 
        problem_name = $1, pattern = $2, difficulty = $3, time_minutes = $4,
        needed_help = $5, notes = $6, help_level = $7, unaided_resolve = $8, date = $9
      WHERE id = $10 AND user_id = $11
      RETURNING *
    `, [problem_name, pattern || null, difficulty || null, time_minutes || null,
        needed_help === 'true' || needed_help === true, notes || null,
        safeHelpLevel, unaidedResolve, date, dsaId, req.session.user.id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('DSA edit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/dsa/:id — delete a DSA problem
app.delete('/api/dsa/:id', requireApiAuth, async (req, res) => {
  const dsaId = parseInt(req.params.id, 10);
  try {
    const result = await pool.query('DELETE FROM dsa_log WHERE id = $1 AND user_id = $2 RETURNING id', [dsaId, req.session.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DSA delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/journal/all — all journal_entries
app.get('/api/journal/all', requireApiAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM journal_entries WHERE user_id = $1 ORDER BY date DESC', [req.session.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Journal all error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/journal/:id — edit a journal entry
app.put('/api/journal/:id', requireApiAuth, async (req, res) => {
  const entryId = parseInt(req.params.id, 10);
  const { entry_type, content } = req.body;
  try {
    const result = await pool.query(`
      UPDATE journal_entries SET entry_type = $1, content = $2, updated_at = NOW()
      WHERE id = $3 AND user_id = $4
      RETURNING *
    `, [entry_type, content, entryId, req.session.user.id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('Journal edit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/review/all — all weekly_reviews
app.get('/api/review/all', requireApiAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM weekly_reviews WHERE user_id = $1 ORDER BY week_number DESC', [req.session.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Review all error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/review/:id — edit a weekly review
app.put('/api/review/:id', requireApiAuth, async (req, res) => {
  const reviewId = parseInt(req.params.id, 10);
  const { week_number, salah_hits, dsa_count, notes, chastity_status, shield_notes } = req.body;
  try {
    const result = await pool.query(`
      UPDATE weekly_reviews SET 
        week_number = $1, salah_hits = $2, dsa_count = $3, notes = $4,
        chastity_status = $5, shield_notes = $6, updated_at = NOW()
      WHERE id = $7 AND user_id = $8
      RETURNING *
    `, [week_number, salah_hits, dsa_count, notes, chastity_status || 'pass', shield_notes || null,
        reviewId, req.session.user.id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('Review edit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/progress/bulk — update multiple daily_progress fields at once for a specific date
app.post('/api/progress/bulk', requireApiAuth, async (req, res) => {
  const { date, updates } = req.body;
  if (!date || !updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Missing date or updates' });
  }
  
  const allowedFields = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah', 'tahajjud', 'duha',
    'salah_complete', 'survival_layer', 'morning_reading', 'targets_set', 'house_task',
    'mma', 'post_workout_meal', 'shower',
    'dsa_done', 'spring_boot_done', 'system_design_done', 'revision_done',
    'evening_reset', 'haldi_doodh', 'sleep_on_wudu', 'ghusl_rule',
    'khalwah_shield', 'night_protocol', 'phone_out_of_bedroom', 'lower_gaze',
    'fasting', 'no_new_riba',
    'block1_done', 'block2_done', 'block3_done', 'block4_done',
    'bar_hit', 'mode_used', 'office_time_used', 'claude_cert_minutes', 'active_day'];
  
  const stringFields = ['bar_hit', 'mode_used'];
  const intFields = ['claude_cert_minutes'];
  
  const setClauses = [];
  const values = [];
  let paramIdx = 1;
  
  for (const [field, value] of Object.entries(updates)) {
    if (!allowedFields.includes(field)) continue;
    let dbValue;
    if (stringFields.includes(field)) {
      dbValue = String(value);
    } else if (intFields.includes(field)) {
      dbValue = parseInt(value, 10) || 0;
    } else {
      dbValue = value === true || value === 'true';
    }
    setClauses.push(`${field} = $${paramIdx}`);
    values.push(dbValue);
    paramIdx++;
  }
  
  if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  
  setClauses.push(`updated_at = NOW()`);
  
  try {
    const userId = req.session.user.id;
    // Ensure row exists
    await pool.query('INSERT INTO daily_progress (user_id, date) VALUES ($1, $2) ON CONFLICT (user_id, date) DO NOTHING', [userId, date]);
    
    values.push(userId, date);
    const result = await pool.query(
      `UPDATE daily_progress SET ${setClauses.join(', ')} WHERE user_id = $${paramIdx} AND date = $${paramIdx + 1} RETURNING *`,
      values
    );
    
    // Check if salah is complete after bulk update
    if (['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].some(f => updates.hasOwnProperty(f))) {
      const allPrayers = await pool.query('SELECT fajr, dhuhr, asr, maghrib, isha FROM daily_progress WHERE user_id = $1 AND date = $2', [userId, date]);
      if (allPrayers.rows[0] && allPrayers.rows[0].fajr && allPrayers.rows[0].dhuhr && allPrayers.rows[0].asr && allPrayers.rows[0].maghrib && allPrayers.rows[0].isha) {
        await pool.query('UPDATE daily_progress SET salah_complete = true WHERE user_id = $1 AND date = $2', [userId, date]);
      }
    }
    
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('Progress bulk error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/progress/:date — update a specific past date's fields
app.put('/api/progress/:date', requireApiAuth, async (req, res) => {
  const targetDate = req.params.date;
  const { field, value } = req.body;
  
  const allowedFields = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah', 'tahajjud', 'duha',
    'salah_complete', 'survival_layer', 'morning_reading', 'targets_set', 'house_task',
    'mma', 'post_workout_meal', 'shower',
    'dsa_done', 'spring_boot_done', 'system_design_done', 'revision_done',
    'evening_reset', 'haldi_doodh', 'sleep_on_wudu', 'ghusl_rule',
    'khalwah_shield', 'night_protocol', 'phone_out_of_bedroom', 'lower_gaze',
    'fasting', 'no_new_riba',
    'block1_done', 'block2_done', 'block3_done', 'block4_done',
    'bar_hit', 'mode_used', 'office_time_used', 'claude_cert_minutes', 'active_day'];
  
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }
  
  const stringFields = ['bar_hit', 'mode_used'];
  const intFields = ['claude_cert_minutes'];
  let dbValue;
  if (stringFields.includes(field)) {
    dbValue = String(value);
  } else if (intFields.includes(field)) {
    dbValue = parseInt(value, 10) || 0;
  } else {
    dbValue = value === true || value === 'true';
  }
  
  try {
    const userId = req.session.user.id;
    // Ensure row exists
    await pool.query('INSERT INTO daily_progress (user_id, date) VALUES ($1, $2) ON CONFLICT (user_id, date) DO NOTHING', [userId, targetDate]);
    
    await pool.query(`
      UPDATE daily_progress SET ${field} = $1, updated_at = NOW()
      WHERE user_id = $2 AND date = $3
    `, [dbValue, userId, targetDate]);
    
    // Check if salah is complete
    if (['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].includes(field)) {
      const allPrayers = await pool.query('SELECT fajr, dhuhr, asr, maghrib, isha FROM daily_progress WHERE user_id = $1 AND date = $2', [userId, targetDate]);
      if (allPrayers.rows[0] && allPrayers.rows[0].fajr && allPrayers.rows[0].dhuhr && allPrayers.rows[0].asr && allPrayers.rows[0].maghrib && allPrayers.rows[0].isha) {
        await pool.query('UPDATE daily_progress SET salah_complete = true WHERE user_id = $1 AND date = $2', [userId, targetDate]);
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Progress date update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============= EXAM/CERT TRACKING =============

// GET /api/exam/all — all entries
app.get('/api/exam/all', requireApiAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM exam_progress WHERE user_id = $1 ORDER BY date DESC, created_at DESC', [req.session.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Exam all error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/exam — add entry
app.post('/api/exam', requireApiAuth, async (req, res) => {
  const { date, topic, minutes_studied, notes, ready_score } = req.body;
  const today = date || new Date().toISOString().split('T')[0];
  const score = Math.min(10, Math.max(1, parseInt(ready_score, 10) || 5));
  
  try {
    const result = await pool.query(`
      INSERT INTO exam_progress (user_id, date, topic, minutes_studied, notes, ready_score)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, date, topic) DO UPDATE SET 
        minutes_studied = $4, notes = $5, ready_score = $6
      RETURNING *
    `, [req.session.user.id, today, topic, minutes_studied || 0, notes || null, score]);
    
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('Exam add error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/exam/:id — edit entry
app.put('/api/exam/:id', requireApiAuth, async (req, res) => {
  const examId = parseInt(req.params.id, 10);
  const { date, topic, minutes_studied, notes, ready_score } = req.body;
  const score = Math.min(10, Math.max(1, parseInt(ready_score, 10) || 5));
  
  try {
    const result = await pool.query(`
      UPDATE exam_progress SET 
        date = $1, topic = $2, minutes_studied = $3, notes = $4, ready_score = $5
      WHERE id = $6 AND user_id = $7
      RETURNING *
    `, [date, topic, minutes_studied || 0, notes || null, score, examId, req.session.user.id]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('Exam edit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/exam/:id
app.delete('/api/exam/:id', requireApiAuth, async (req, res) => {
  const examId = parseInt(req.params.id, 10);
  try {
    const result = await pool.query('DELETE FROM exam_progress WHERE id = $1 AND user_id = $2 RETURNING id', [examId, req.session.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Exam delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============= CUSTOMIZATION (SETTINGS) =============

// POST /api/settings — store settings in app_state
app.post('/api/settings', requireApiAuth, async (req, res) => {
  const { quotes_toggle, adventures, chart_range, color_scheme, dua_mode, learning_blocks } = req.body;
  
  const validAdventures = ['none', 'quote', 'dua'];
  const validSchemes = ['emerald', 'ocean', 'dark'];
  const validDuaModes = ['none', 'night', 'morning'];
  const validChartRanges = [7, 14, 30];
  
  const settings = {
    quotes_toggle: quotes_toggle === true || quotes_toggle === 'true',
    adventures: validAdventures.includes(adventures) ? adventures : 'none',
    chart_range: validChartRanges.includes(parseInt(chart_range, 10)) ? parseInt(chart_range, 10) : 7,
    color_scheme: validSchemes.includes(color_scheme) ? color_scheme : 'emerald',
    dua_mode: validDuaModes.includes(dua_mode) ? dua_mode : 'none',
    learning_blocks: Array.isArray(learning_blocks) ? learning_blocks.slice(0, 4) : []
  };
  
  try {
    await upsertAppState('settings', settings);
    res.json({ success: true, settings });
  } catch (err) {
    console.error('Settings save error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/settings — return settings from app_state
app.get('/api/settings', requireApiAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM app_state WHERE key = 'settings'");
    let settings = {
      quotes_toggle: true,
      adventures: 'none',
      chart_range: 7,
      color_scheme: 'emerald',
      dua_mode: 'none',
      learning_blocks: []
    };
    if (result.rows.length > 0) {
      try {
        const parsed = typeof result.rows[0].value === 'string' ? JSON.parse(result.rows[0].value) : result.rows[0].value;
        settings = { ...settings, ...parsed };
      } catch(e) {}
    }
    res.json(settings);
  } catch (err) {
    console.error('Settings get error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============= API FOR HERMES SYNC =============

// Get all progress data
app.get('/api/sync', requireApiKey, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    
    const progress = await pool.query('SELECT * FROM daily_progress WHERE date = $1', [date]);
    const dsaLog = await pool.query('SELECT * FROM dsa_log WHERE date = $1 ORDER BY created_at DESC', [date]);
    const journal = await pool.query('SELECT * FROM journal_entries WHERE date = $1', [date]);
    const reviews = await pool.query('SELECT * FROM weekly_reviews ORDER BY week_number DESC LIMIT 4');
    
    res.json({
      date,
      progress: progress.rows,
      dsa_log: dsaLog.rows,
      journal: journal.rows,
      reviews: reviews.rows
    });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update progress via API (for Hermes)
app.post('/api/sync/update', requireApiKey, async (req, res) => {
  const { field, value, date } = req.body;
  const targetDate = date || new Date().toISOString().split('T')[0];
  
  const allowedFields = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah', 'tahajjud', 'duha',
    'survival_layer', 'morning_reading', 'targets_set', 'house_task',
    'mma', 'post_workout_meal', 'shower',
    'dsa_done', 'spring_boot_done', 'system_design_done', 'revision_done',
    'evening_reset', 'haldi_doodh', 'sleep_on_wudu', 'ghusl_rule',
    'khalwah_shield', 'night_protocol', 'phone_out_of_bedroom', 'lower_gaze',
    'fasting', 'no_new_riba',
    'block1_done', 'block2_done', 'block3_done', 'block4_done',
    // NEW fields
    'bar_hit', 'mode_used', 'office_time_used', 'claude_cert_minutes', 'active_day'];
  
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }
  
  // Determine value type based on field
  const stringFields = ['bar_hit', 'mode_used'];
  const intFields = ['claude_cert_minutes'];
  let dbValue;
  if (stringFields.includes(field)) {
    dbValue = String(value);
  } else if (intFields.includes(field)) {
    dbValue = parseInt(value, 10) || 0;
  } else {
    dbValue = value === true || value === 'true';
  }
  
  try {
    const userId = 1; // Single user
    await pool.query(`
      INSERT INTO daily_progress (user_id, date, ${field})
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, date) DO UPDATE SET ${field} = $3, updated_at = NOW()
    `, [userId, targetDate, dbValue]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Sync update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk sync endpoint (for Hermes) — ENHANCED
app.post('/api/sync/bulk', requireApiKey, async (req, res) => {
  const { dsa_problems, state, overdue_revisions, unaided_queue, today_plan, exam_progress, app_state } = req.body;
  const userId = 1; // Single user
  const today = new Date().toISOString().split('T')[0];
  const validHelpLevels = ['alone', 'hint', 'copilot'];
  
  try {
    // Insert DSA problems
    if (dsa_problems && Array.isArray(dsa_problems)) {
      for (const p of dsa_problems) {
        if (!p.problem_name) continue; // skip invalid entries
        const safeHelpLevel = validHelpLevels.includes(p.help_level) ? p.help_level : 'alone';
        const unaidedResolve = safeHelpLevel === 'alone';
        await pool.query(`
          INSERT INTO dsa_log (user_id, date, problem_name, pattern, difficulty, help_level, unaided_resolve, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [userId, p.date || today, p.problem_name, p.pattern || null, p.difficulty || null, safeHelpLevel, unaidedResolve, p.notes || null]);
      }
    }
    
    // Update daily_progress for today with state values
    if (state) {
      const barHit = state.bar_hit_today || 'none';
      const modeUsed = state.mode_used || 'home';
      const officeTimeUsed = !!state.office_time_used;
      const claudeCertMinutes = state.claude_cert_minutes || 0;
      const activeDay = !!state.active_day;
      
      await pool.query(`
        INSERT INTO daily_progress (user_id, date, bar_hit, mode_used, office_time_used, claude_cert_minutes, active_day)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, date) DO UPDATE SET 
          bar_hit = $3, mode_used = $4, office_time_used = $5, 
          claude_cert_minutes = $6, active_day = $7, updated_at = NOW()
      `, [userId, today, barHit, modeUsed, officeTimeUsed, claudeCertMinutes, activeDay]);
    }
    
    // Store app_state entries
    if (overdue_revisions !== undefined) {
      await upsertAppState('overdue_revisions', overdue_revisions);
    }
    if (unaided_queue !== undefined) {
      await upsertAppState('unaided_queue', unaided_queue);
    }
    if (today_plan !== undefined) {
      await upsertAppState('today_plan', today_plan);
    }
    
    // NEW: Insert exam_progress entries
    if (exam_progress && Array.isArray(exam_progress)) {
      for (const e of exam_progress) {
        if (!e.topic) continue;
        const examDate = e.date || today;
        const score = Math.min(10, Math.max(1, parseInt(e.ready_score, 10) || 5));
        await pool.query(`
          INSERT INTO exam_progress (user_id, date, topic, minutes_studied, notes, ready_score)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id, date, topic) DO UPDATE SET 
            minutes_studied = $4, notes = $5, ready_score = $6
        `, [userId, examDate, e.topic, e.minutes_studied || 0, e.notes || null, score]);
      }
    }
    
    // NEW: Store custom app_state fields
    if (app_state && typeof app_state === 'object') {
      for (const [key, value] of Object.entries(app_state)) {
        if (['overdue_revisions', 'unaided_queue', 'today_plan', 'settings'].includes(key)) continue;
        await upsertAppState(key, value);
      }
    }
    
    res.json({ success: true, date: today });
  } catch (err) {
    console.error('Bulk sync error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get full state for Hermes to read — ENHANCED
app.get('/api/state', requireApiKey, async (req, res) => {
  try {
    const dailyProgress = await pool.query("SELECT * FROM daily_progress WHERE user_id = 1 AND date >= NOW() - INTERVAL '14 days' ORDER BY date DESC");
    const dsaLog = await pool.query('SELECT * FROM dsa_log WHERE user_id = 1 ORDER BY created_at DESC');
    const journal = await pool.query('SELECT * FROM journal_entries WHERE user_id = 1 ORDER BY date DESC');
    const reviews = await pool.query('SELECT * FROM weekly_reviews WHERE user_id = 1 ORDER BY week_number DESC');
    const examProgress = await pool.query('SELECT * FROM exam_progress WHERE user_id = 1 ORDER BY date DESC, created_at DESC');
    const appState = await pool.query('SELECT * FROM app_state');
    
    // Parse app_state into a clean key-value object
    const appStateObj = {};
    appState.rows.forEach(r => {
      try { appStateObj[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; }
      catch(e) { appStateObj[r.key] = r.value; }
    });
    
    res.json({
      daily_progress: dailyProgress.rows,
      dsa_log: dsaLog.rows,
      journal_entries: journal.rows,
      weekly_reviews: reviews.rows,
      exam_progress: examProgress.rows,
      app_state: appState.rows,
      app_state_obj: appStateObj
    });
  } catch (err) {
    console.error('State error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============= STREAK CALENDAR =============

// GET /api/streak-calendar — last 30 days for streak visualization
app.get('/api/streak-calendar', requireApiAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT date, salah_complete, dsa_done, active_day 
       FROM daily_progress 
       WHERE user_id = $1 AND date >= NOW() - INTERVAL '30 days' 
       ORDER BY date ASC`,
      [req.session.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Streak calendar error:', err);
    res.status(500).json({ error: 'Server error' });
  }
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
      COUNT(*) as total_days
    FROM daily_progress
    WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days'
  `, [userId]);
  return result.rows[0];
}

// NEW: Upsert helper for app_state table
async function upsertAppState(key, value) {
  await pool.query(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
}

// === MOTIVATION ENGINE ===
async function computeMotivation(userId, weekStats, dsaCountNum, activeDayCount, dayNumber, startDate, todayProgress) {
  try {
    // disciplineScore: (salah_days*0.3 + survival_days*0.25 + dsa_days*0.25 + active_days*0.2) / max(days_since_start, 1) * 100
    const salahDays = parseInt(weekStats.salah_complete_days, 10) || 0;
    const survivalDays = parseInt(weekStats.survival_days, 10) || 0;
    const dsaDays = parseInt(weekStats.dsa_days, 10) || 0;
    const activeDays = activeDayCount;
    const daysSinceStart = Math.max(Math.ceil((new Date() - startDate) / (1000 * 60 * 60 * 24)), 1);
    const disciplineScore = Math.round(((salahDays * 0.3 + survivalDays * 0.25 + dsaDays * 0.25 + activeDays * 0.2) / daysSinceStart) * 100);
    
    // milestoneNext: compute next milestone as object for template
    const dsaStreakCount = await getStreak(pool, userId, 'dsa_done');
    const salahStreakCount = await getStreak(pool, userId, 'salah_complete');
    
    const milestones = [
      { threshold: 10, current: dsaCountNum, label: '10 DSA Problems', icon: '🎓', name: 'Way of the Scholar' },
      { threshold: 50, current: dsaCountNum, label: '50 DSA Problems', icon: '⚔️', name: 'Pattern Warrior' },
      { threshold: 7, current: dsaStreakCount, label: '7-Day DSA Streak', icon: '👑', name: 'Consistency Crown' },
      { threshold: 5, current: salahStreakCount, label: '5-Day Salah Streak', icon: '🕌', name: 'Salah Shield' }
    ];
    let milestoneNext = { label: 'All milestones reached!', icon: '🏆', name: 'Champion', current: 100, threshold: 100, pct: 100 };
    for (const m of milestones) {
      if (m.current < m.threshold) {
        milestoneNext = { label: m.label, icon: m.icon, name: m.name, current: m.current, threshold: m.threshold, pct: Math.round((m.current / m.threshold) * 100) };
        break;
      }
    }
    
    // daysUntilOffer: days until interview window (Oct 1, 2026)
    const offerDate = new Date('2026-10-01');
    const daysUntilOffer = Math.ceil((offerDate - new Date()) / (1000 * 60 * 60 * 24));
    
    // focusScore: today's toggle completion % (completed toggles / total toggles today)
    const toggleFields = [
      'fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah', 'tahajjud', 'duha',
      'survival_layer', 'morning_reading', 'targets_set', 'house_task',
      'mma', 'post_workout_meal', 'shower',
      'dsa_done', 'spring_boot_done', 'system_design_done', 'revision_done',
      'evening_reset', 'haldi_doodh', 'sleep_on_wudu', 'ghusl_rule',
      'khalwah_shield', 'night_protocol', 'phone_out_of_bedroom', 'lower_gaze',
      'fasting', 'no_new_riba',
      'block1_done', 'block2_done', 'block3_done', 'block4_done', 'active_day'
    ];
    let completedCount = 0;
    let totalToggles = toggleFields.length;
    for (const f of toggleFields) {
      if (todayProgress[f] === true) completedCount++;
    }
    const focusScore = totalToggles > 0 ? Math.round((completedCount / totalToggles) * 100) : 0;
    
    // weeklyTargetProgress: this week DSA solved vs 15-18 target (weekly pace)
    const weekDsaResult = await pool.query(
      `SELECT COUNT(*) FROM dsa_log WHERE user_id = $1 AND date >= NOW() - INTERVAL '7 days'`,
      [userId]
    );
    const weeklyDsaSolved = parseInt(weekDsaResult.rows[0].count, 10) || 0;
    const weeklyTargetMin = 15;
    const weeklyTargetMax = 18;
    const weeklyTargetProgress = {
      solved: weeklyDsaSolved,
      targetMin: weeklyTargetMin,
      targetMax: weeklyTargetMax,
      percent: Math.round((weeklyDsaSolved / weeklyTargetMax) * 100),
      onTrack: weeklyDsaSolved >= weeklyTargetMin
    };
    
    return {
      disciplineScore,
      milestoneNext,
      daysUntilOffer,
      focusScore,
      weeklyTargetProgress
    };
  } catch (err) {
    console.error('Motivation engine error:', err);
    return {
      disciplineScore: 0,
      milestoneNext: { label: '—', icon: '🎯', name: 'Loading', current: 0, threshold: 100, pct: 0 },
      daysUntilOffer: 0,
      focusScore: 0,
      weeklyTargetProgress: { solved: 0, targetMin: 15, targetMax: 18, percent: 0, onTrack: false }
    };
  }
}

// === EXAM DASHBOARD DATA ===
async function getExamDashboard(userId) {
  try {
    // Total minutes studied
    const totalResult = await pool.query('SELECT COALESCE(SUM(minutes_studied), 0) as total_minutes FROM exam_progress WHERE user_id = $1', [userId]);
    const totalMinutes = parseInt(totalResult.rows[0].total_minutes, 10);
    
    // Topics covered (distinct)
    const topicsResult = await pool.query('SELECT COUNT(DISTINCT topic) as topics_count FROM exam_progress WHERE user_id = $1', [userId]);
    const topicsCovered = parseInt(topicsResult.rows[0].topics_count, 10);
    
    // Latest readiness score
    const latestResult = await pool.query('SELECT ready_score, topic, date FROM exam_progress WHERE user_id = $1 ORDER BY date DESC, created_at DESC LIMIT 1', [userId]);
    const latestReadiness = latestResult.rows[0] || { ready_score: null, topic: null, date: null };
    
    // Days until Oct 1
    const offerDate = new Date('2026-10-01');
    const daysUntilExam = Math.ceil((offerDate - new Date()) / (1000 * 60 * 60 * 24));
    
    return {
      totalMinutes,
      topicsCovered,
      latestReadiness,
      daysUntilExam
    };
  } catch (err) {
    console.error('Exam dashboard error:', err);
    return {
      totalMinutes: 0,
      topicsCovered: 0,
      latestReadiness: { ready_score: null, topic: null, date: null },
      daysUntilExam: 0
    };
  }
}

// ============= DB INIT =============

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE, password_hash TEXT, created_at TIMESTAMP DEFAULT NOW())');
    
    await client.query(`CREATE TABLE IF NOT EXISTS daily_progress (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      fajr BOOLEAN DEFAULT false,
      dhuhr BOOLEAN DEFAULT false,
      asr BOOLEAN DEFAULT false,
      maghrib BOOLEAN DEFAULT false,
      isha BOOLEAN DEFAULT false,
      jumuah BOOLEAN DEFAULT false,
      tahajjud BOOLEAN DEFAULT false,
      duha BOOLEAN DEFAULT false,
      salah_complete BOOLEAN DEFAULT false,
      survival_layer BOOLEAN DEFAULT false,
      morning_reading BOOLEAN DEFAULT false,
      targets_set BOOLEAN DEFAULT false,
      house_task BOOLEAN DEFAULT false,
      mma BOOLEAN DEFAULT false,
      post_workout_meal BOOLEAN DEFAULT false,
      shower BOOLEAN DEFAULT false,
      dsa_done BOOLEAN DEFAULT false,
      spring_boot_done BOOLEAN DEFAULT false,
      system_design_done BOOLEAN DEFAULT false,
      revision_done BOOLEAN DEFAULT false,
      evening_reset BOOLEAN DEFAULT false,
      haldi_doodh BOOLEAN DEFAULT false,
      sleep_on_wudu BOOLEAN DEFAULT false,
      ghusl_rule BOOLEAN DEFAULT false,
      khalwah_shield BOOLEAN DEFAULT false,
      night_protocol BOOLEAN DEFAULT false,
      phone_out_of_bedroom BOOLEAN DEFAULT false,
      lower_gaze BOOLEAN DEFAULT false,
      fasting BOOLEAN DEFAULT false,
      no_new_riba BOOLEAN DEFAULT false,
      block1_done BOOLEAN DEFAULT false,
      block2_done BOOLEAN DEFAULT false,
      block3_done BOOLEAN DEFAULT false,
      block4_done BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, date)
    )`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS dsa_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      problem_name VARCHAR(200) NOT NULL,
      pattern VARCHAR(100),
      difficulty VARCHAR(20),
      time_minutes INTEGER,
      needed_help BOOLEAN DEFAULT false,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS journal_entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      entry_type VARCHAR(50) NOT NULL,
      content TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, date, entry_type)
    )`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS weekly_reviews (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      week_number INTEGER NOT NULL,
      salah_hits INTEGER,
      dsa_count INTEGER,
      notes TEXT,
      chastity_status VARCHAR(20) DEFAULT 'pass',
      shield_notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, week_number)
    )`);
    
    // NEW: app_state table for storing JSON state (overdue_revisions, unaided_queue, today_plan)
    await client.query(`CREATE TABLE IF NOT EXISTS app_state (
      id SERIAL PRIMARY KEY,
      key VARCHAR(50) UNIQUE,
      value JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    
    // NEW: exam_progress table for Claude Developer cert tracking
    await client.query(`CREATE TABLE IF NOT EXISTS exam_progress (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      topic VARCHAR(200) NOT NULL,
      minutes_studied INTEGER DEFAULT 0,
      notes TEXT,
      ready_score INTEGER DEFAULT 5,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, date, topic)
    )`);
    
    // NEW: Migrations for daily_progress columns (IF NOT EXISTS for existing Heroku DB)
    await client.query(`ALTER TABLE daily_progress ADD COLUMN IF NOT EXISTS bar_hit VARCHAR(10) DEFAULT 'none'`);
    await client.query(`ALTER TABLE daily_progress ADD COLUMN IF NOT EXISTS mode_used VARCHAR(10) DEFAULT 'home'`);
    await client.query(`ALTER TABLE daily_progress ADD COLUMN IF NOT EXISTS office_time_used BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE daily_progress ADD COLUMN IF NOT EXISTS claude_cert_minutes INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE daily_progress ADD COLUMN IF NOT EXISTS active_day BOOLEAN DEFAULT false`);
    
    // NEW: Migrations for dsa_log columns (IF NOT EXISTS for existing Heroku DB)
    await client.query(`ALTER TABLE dsa_log ADD COLUMN IF NOT EXISTS help_level VARCHAR(20) DEFAULT 'alone'`);
    await client.query(`ALTER TABLE dsa_log ADD COLUMN IF NOT EXISTS unaided_resolve BOOLEAN DEFAULT false`);
    
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
