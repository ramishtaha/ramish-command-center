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
      today: new Date()
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
    'block1_done', 'block2_done', 'block3_done', 'block4_done'];
  
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }
  
  try {
    await pool.query(`
      INSERT INTO daily_progress (user_id, date, ${field})
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, date) DO UPDATE SET ${field} = $3, updated_at = NOW()
    `, [userId, today, value === true || value === 'true']);
    
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
  const { problem_name, pattern, difficulty, time_minutes, needed_help, notes } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  try {
    await pool.query(`
      INSERT INTO dsa_log (user_id, date, problem_name, pattern, difficulty, time_minutes, needed_help, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [req.session.user.id, today, problem_name, pattern, difficulty, time_minutes || null, needed_help === 'true', notes || null]);
    
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

// ============= API FOR HERMES SYNC =============

// Get all progress data
app.get('/api/sync', requireApiKey, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    
    const progress = await pool.query('SELECT * FROM daily_progress WHERE date = $1', [date]);
    const dsaLog = await pool.query('SELECT * FROM dsa_log WHERE date = $1 ORDER BY created_at DESC', [date]);
    const journal = await pool.query('SELECT * FROM journal_entries WHERE date = $1', [date]);
    const reviews = await pool.query('SELECT * FROM weekly_reviews ORDER BY week_number DESC LIMIT 4', [date]);
    
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
    'block1_done', 'block2_done', 'block3_done', 'block4_done'];
  
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }
  
  try {
    const userId = 1; // Single user
    await pool.query(`
      INSERT INTO daily_progress (user_id, date, ${field})
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, date) DO UPDATE SET ${field} = $3, updated_at = NOW()
    `, [userId, targetDate, value === true || value === 'true']);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Sync update error:', err);
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
