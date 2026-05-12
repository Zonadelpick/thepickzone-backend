const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const axios = require('axios');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const resolveStripeSecretKey = () => {
  const direct = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (direct) return direct;
  const mode = (process.env.STRIPE_MODE || '').trim().toLowerCase();
  const liveKey = (process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_LIVE || '').trim();
  const testKey = (process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || '').trim();
  if (mode === 'live') return liveKey || testKey;
  if (mode === 'test') return testKey || liveKey;
  if ((process.env.NODE_ENV || '').trim() === 'production') return liveKey || testKey;
  return testKey || liveKey;
};
const STRIPE_SECRET_KEY = resolveStripeSecretKey();
if (!STRIPE_SECRET_KEY) {
  throw new Error('Stripe no configurado: define STRIPE_SECRET_KEY o STRIPE_LIVE_SECRET_KEY/STRIPE_TEST_SECRET_KEY');
}
const STRIPE_MODE = STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';
console.log(`[Stripe] initialized in ${STRIPE_MODE} mode`);
const stripe = new Stripe(STRIPE_SECRET_KEY);
const PRO_PLAN_AMOUNT_USD = 29.99;
const PRO_PLAN_AMOUNT_CENTS = Math.round(PRO_PLAN_AMOUNT_USD * 100);
const PRO_PLAN_DURATION_DAYS = 30;

// ── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI).then(()=>console.log('MongoDB connected')).catch(e=>console.error(e));

// ── MODELS ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  email:      { type: String, required: true, unique: true },
  password:   { type: String, required: true },
  role:       { type: String, default: 'basic', enum: ['basic','pro','admin'] },
  avatar:     { type: String },
  bio:        { type: String },
  username:   { type: String },
  roi:        { type: String, default: '+0%' },
  winRate:    { type: Number, default: 0 },
  totalPicks: { type: Number, default: 0 },
  wonPicks:   { type: Number, default: 0 },
  lostPicks:  { type: Number, default: 0 },
  pushPicks:  { type: Number, default: 0 },
  avgOdds:    { type: Number, default: 0 },
  balance:    { type: Number, default: 0 },
  proExpiry:  { type: Date },
  createdAt:  { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const PickSchema = new mongoose.Schema({
  tipster:    { type: String, required: true },
  tipsterId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  league:     { type: String },
  sportKey:   { type: String },
  sport:      { type: String },
  flag:       { type: String },
  match:      { type: String, required: true },
  time:       { type: String },
  odds:       { type: Number },
  bank:       { type: Number, default: 10 },
  price:      { type: Number, default: 0 },
  ticketImg:  { type: String },
  result:     { type: String, default: 'pending', enum: ['pending','won','lost','void'] },
  buyers:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  downloadCount: { type: Number, default: 0 },
  aiAnalysis: { type: Object },
  createdAt:  { type: Date, default: Date.now }
});
const Pick = mongoose.model('Pick', PickSchema);

const PurchaseSchema = new mongoose.Schema({
  pickId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Pick', required: true },
  buyerId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  stripeSessionId: { type: String },
  amountCents:     { type: Number, default: 0 },
  currency:        { type: String, default: 'usd' },
  createdAt:       { type: Date, default: Date.now }
});
PurchaseSchema.index({ pickId: 1, buyerId: 1 }, { unique: true });
const Purchase = mongoose.model('Purchase', PurchaseSchema);

const parsePositiveNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const formatRoiPercent = (value) => {
  const numeric = Number.isFinite(value) ? value : 0;
  const fixed = numeric.toFixed(1);
  return numeric >= 0 ? `+${fixed}%` : `${fixed}%`;
};

const calculateTipsterStatsFromPicks = (resolvedPicks) => {
  const picks = Array.isArray(resolvedPicks) ? resolvedPicks : [];
  let wonPicks = 0;
  let lostPicks = 0;
  let pushPicks = 0;
  let totalRiskedUnits = 0;
  let totalProfitUnits = 0;
  let oddsAccumulator = 0;
  let oddsCount = 0;

  for (const pick of picks) {
    const stakeUnits = parsePositiveNumber(pick?.bank, 10);
    const oddsValue = parsePositiveNumber(pick?.odds, 0);
    if (oddsValue > 0) {
      oddsAccumulator += oddsValue;
      oddsCount += 1;
    }

    if (pick?.result === 'won') {
      wonPicks += 1;
      totalRiskedUnits += stakeUnits;
      totalProfitUnits += stakeUnits * (Math.max(oddsValue, 1) - 1);
      continue;
    }
    if (pick?.result === 'lost') {
      lostPicks += 1;
      totalRiskedUnits += stakeUnits;
      totalProfitUnits -= stakeUnits;
      continue;
    }
    if (pick?.result === 'void') {
      pushPicks += 1;
    }
  }

  const decisivePicks = wonPicks + lostPicks;
  const winRate = decisivePicks > 0 ? Math.round((wonPicks / decisivePicks) * 100) : 0;
  const roiValue = totalRiskedUnits > 0 ? ((totalProfitUnits / totalRiskedUnits) * 100) : 0;
  const avgOdds = oddsCount > 0 ? Number((oddsAccumulator / oddsCount).toFixed(2)) : 0;

  return {
    roi: formatRoiPercent(Number(roiValue.toFixed(1))),
    winRate,
    totalPicks: wonPicks + lostPicks + pushPicks,
    wonPicks,
    lostPicks,
    pushPicks,
    avgOdds
  };
};

const recalculateTipsterStats = async (tipsterId) => {
  if (!tipsterId) return null;
  const resolvedPicks = await Pick.find({
    tipsterId,
    result: { $in: ['won', 'lost', 'void'] }
  }).select('result bank odds');
  const stats = calculateTipsterStatsFromPicks(resolvedPicks);
  await User.findByIdAndUpdate(tipsterId, stats);
  return stats;
};

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'thepickzone_secret_2026');
    req.user = decoded;
    // Check pro expiry
    const user = await User.findById(decoded.id);
    if (user && user.role === 'pro' && user.proExpiry && new Date() > user.proExpiry) {
      await User.findByIdAndUpdate(decoded.id, { role: 'basic' });
      req.user.role = 'basic';
    } else if (user) {
      req.user.role = user.role;
    }
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

const isValidHttpUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const appendQueryParams = (baseUrl, params) => {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  return url.toString();
};

// ── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Faltan campos' });
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: 'Email ya registrado' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hash });
    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'thepickzone_secret_2026', { expiresIn: '7d' });
    res.json({ token, user: { _id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Usuario no encontrado' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Contraseña incorrecta' });
    if (user.role === 'pro' && user.proExpiry && new Date() > user.proExpiry) {
      await User.findByIdAndUpdate(user._id, { role: 'basic' });
      user.role = 'basic';
    }
    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'thepickzone_secret_2026', { expiresIn: '7d' });
    res.json({
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        bio: user.bio,
        roi: user.roi,
        winRate: user.winRate,
        totalPicks: user.totalPicks,
        wonPicks: user.wonPicks,
        lostPicks: user.lostPicks,
        pushPicks: user.pushPicks,
        avgOdds: user.avgOdds,
        proExpiry: user.proExpiry
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/auth/profile', auth, async (req, res) => {
  try {
    const { name, avatar, bio, username } = req.body;
    const updated = await User.findByIdAndUpdate(req.user.id, { name, avatar, bio, username }, { new: true }).select('-password');
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PICKS ─────────────────────────────────────────────────────────────────────
app.get('/api/picks', async (req, res) => {
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const picks = await Pick.find({ result: 'pending', createdAt: { $gte: sixHoursAgo } }).sort({ createdAt: -1 }).select('-ticketImg');
    res.json(picks);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/picks', auth, async (req, res) => {
  try {
    if (!['pro','admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo tipsters Pro pueden publicar picks' });
    const pick = await Pick.create({ ...req.body, tipsterId: req.user.id });
    res.json(pick);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/picks/:id/download', auth, async (req, res) => {
  try {
    const pick = await Pick.findById(req.params.id);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });
    const accessState = await getPickAccessState(pick, req.user.id, req.user.role);
    if (!accessState.hasAccess) return res.status(403).json({ error: 'No tienes acceso' });
    if (!pick.ticketImg) return res.status(404).json({ error: 'Ticket no disponible' });

    const updatedPick = await Pick.findByIdAndUpdate(
      req.params.id,
      { $inc: { downloadCount: 1 } },
      { new: true, projection: { ticketImg: 1, downloadCount: 1 } }
    );

    res.json({ success: true, ticketImg: updatedPick?.ticketImg || pick.ticketImg, downloadCount: updatedPick?.downloadCount || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/picks/:id/result', auth, requireAdmin, async (req, res) => {
  try {
    const { result } = req.body;
    if (!['won','lost','void','pending'].includes(result)) return res.status(400).json({ error: 'Invalid result' });
    const pick = await Pick.findById(req.params.id);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });
    const updatedPick = await Pick.findByIdAndUpdate(req.params.id, { result }, { new: true });
    let tipsterStats = null;
    if (pick.tipsterId) {
      tipsterStats = await recalculateTipsterStats(pick.tipsterId);
    }
    res.json({ success: true, result: updatedPick?.result || result, tipsterStats });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FIXTURES ─────────────────────────────────────────────────────────────────
const SPORT_KEYS = {
  'Liga MX': 'soccer_mexico_ligamx', 'MLS': 'soccer_usa_mls',
  'Premier League': 'soccer_epl', 'EPL': 'soccer_epl',
  'La Liga': 'soccer_spain_la_liga', 'La Liga - Spain': 'soccer_spain_la_liga', 'Liga de España': 'soccer_spain_la_liga',
  'Bundesliga': 'soccer_germany_bundesliga', 'Bundesliga - Germany': 'soccer_germany_bundesliga',
  'Serie A': 'soccer_italy_serie_a', 'Serie A - Italy': 'soccer_italy_serie_a',
  'Ligue 1': 'soccer_france_ligue_one', 'Ligue 1 - France': 'soccer_france_ligue_one',
  'Champions League': 'soccer_uefa_champs_league', 'UEFA Champions League': 'soccer_uefa_champs_league',
  'Europa League': 'soccer_uefa_europa_league', 'UEFA Europa League': 'soccer_uefa_europa_league',
  'Copa Libertadores': 'soccer_conmebol_copa_libertadores',
  'Copa Sudamericana': 'soccer_conmebol_copa_sudamericana',
  'Liga Argentina': 'soccer_argentina_primera_division', 'Primera División Argentina': 'soccer_argentina_primera_division',
  'Liga Brasil': 'soccer_brazil_campeonato', 'Brasileirão Serie A': 'soccer_brazil_campeonato',
  'Liga Chile': 'soccer_chile_campeonato', 'Primera División Chile': 'soccer_chile_campeonato',
  'NBA': 'basketball_nba', 'MLB': 'baseball_mlb', 'NHL': 'icehockey_nhl',
  'NFL': 'americanfootball_nfl', 'WNBA': 'basketball_wnba',
  'Scottish Premiership': 'soccer_spl', 'Eredivisie': 'soccer_netherlands_eredivisie',
  'Dutch Eredivisie': 'soccer_netherlands_eredivisie',
  'Allsvenskan': 'soccer_sweden_allsvenskan', 'Eliteserien': 'soccer_norway_eliteserien',
  'Saudi Pro League': 'soccer_saudi_arabia_pro_league', 'Liga Arabia Saudita': 'soccer_saudi_arabia_pro_league',
  'J1 League': 'soccer_japan_j_league', 'K League 1': 'soccer_korea_kleague1',
  'A-League Australia': 'soccer_australia_aleague', 'Chinese Super League': 'soccer_china_superleague',
  'Ekstraklasa': 'soccer_poland_ekstraklasa', 'Superliga Dinamarca': 'soccer_denmark_superliga',
  'Veikkausliiga': 'soccer_finland_veikkausliiga', 'Copa América': 'soccer_conmebol_copa_america',
  'FIFA World Cup': 'soccer_fifa_world_cup', 'Mundial FIFA': 'soccer_fifa_world_cup',
  'FA Cup': 'soccer_fa_cup', 'DFB Pokal': 'soccer_germany_dfb_pokal',
  'Coppa Italia': 'soccer_italy_coppa_italia', 'Coupe de France': 'soccer_france_coupe_de_france',
};
app.get('/api/fixtures/sports', async (req, res) => {
  try {
    const all = req.query.all === 'false' ? 'false' : 'true';
    const url = `https://api.the-odds-api.com/v4/sports?apiKey=${process.env.ODDS_API_KEY}&all=${all}`;
    const resp = await axios.get(url);
    const sports = Array.isArray(resp.data) ? resp.data.map((s) => ({
      key: s.key,
      title: s.title,
      group: s.group,
      description: s.description,
      active: Boolean(s.active),
      hasOutrights: Boolean(s.has_outrights)
    })) : [];
    res.json(sports);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/fixtures/odds', async (req, res) => {
  try {
    const { league, sportKey } = req.query;
    const resolvedSportKey = (typeof sportKey === 'string' && sportKey.trim()) ? sportKey.trim() : SPORT_KEYS[league];
    if (!resolvedSportKey) return res.status(400).json({ error: 'sportKey o league requerido' });
    const url = `https://api.the-odds-api.com/v4/sports/${resolvedSportKey}/events?apiKey=${process.env.ODDS_API_KEY}&dateFormat=iso`;
    const resp = await axios.get(url);
    const fixtures = (Array.isArray(resp.data) ? resp.data : [])
      .filter((e) => e && e.home_team && e.away_team && e.commence_time)
      .map(e => ({
        id: e.id,
        home: e.home_team,
        away: e.away_team,
        time: e.commence_time,
        league: league || e.sport_title || resolvedSportKey,
        sportKey: resolvedSportKey
      }));
    res.json(fixtures);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TIPSTERS ─────────────────────────────────────────────────────────────────
app.get('/api/tipsters', async (req, res) => {
  try {
    const tipsters = await User.find({ role: { $in: ['pro','admin'] } }).select('-password -proExpiry').sort({ createdAt: -1 });
    res.json(tipsters);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/stats', auth, requireAdmin, async (req, res) => {
  try {
    const users = await User.countDocuments();
    const picks = await Pick.countDocuments();
    res.json({ users, picks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/picks-pending', auth, requireAdmin, async (req, res) => {
  try {
    const picks = await Pick.find({ result: 'pending' }).sort({ createdAt: -1 });
    res.json(picks);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/picks-all', auth, requireAdmin, async (req, res) => {
  try {
    const picks = await Pick.find().sort({ createdAt: -1 }).select('-ticketImg');
    res.json(picks);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reset-stats', auth, requireAdmin, async (req, res) => {
  try {
    await User.updateMany({}, { roi: '+0%', winRate: 0, totalPicks: 0, wonPicks: 0, lostPicks: 0, pushPicks: 0, avgOdds: 0, balance: 0 });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/set-role', async (req, res) => {
  try {
    const { secret, email, role } = req.body;
    if (secret !== 'tpz-setup-2026') return res.status(403).json({ error: 'Forbidden' });
    const update = { role };
    if (role === 'pro') update.proExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const user = await User.findOneAndUpdate({ email }, update, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/clean-db', async (req, res) => {
  try {
    const { secret } = req.body;
    if (secret !== 'tpz-clean-2026') return res.status(403).json({ error: 'Forbidden' });
    const keepEmails = ['admin@thepickzone.com','75_solos_cierne@icloud.com','fernando.martinez10@hotmail.com'];
    const deleted = await User.deleteMany({ email: { $nin: keepEmails } });
    const picksDeleted = await Pick.deleteMany({});
    await User.updateMany({}, { roi: '+0%', winRate: 0, totalPicks: 0, wonPicks: 0, lostPicks: 0, pushPicks: 0, avgOdds: 0, balance: 0 });
    res.json({ success: true, usersDeleted: deleted.deletedCount, picksDeleted: picksDeleted.deletedCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── AI ANALYSIS ───────────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getMatchScore(league, home, away, explicitSportKey) {
  try {
    const sportKey = explicitSportKey || SPORT_KEYS[league];
    if (!sportKey) return null;
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores?apiKey=${process.env.ODDS_API_KEY}&daysFrom=3`;
    const resp = await axios.get(url);
    const match = resp.data.find(m => {
      const h = m.home_team?.toLowerCase(); const a = m.away_team?.toLowerCase();
      const ph = home.toLowerCase(); const pa = away.toLowerCase();
      return (h?.includes(ph)||ph.includes(h||'')) && (a?.includes(pa)||pa.includes(a||''));
    });
    if (!match?.scores) return null;
    const homeScore = match.scores.find(s=>s.name===match.home_team)?.score;
    const awayScore = match.scores.find(s=>s.name===match.away_team)?.score;
    return { home: match.home_team, away: match.away_team, homeScore, awayScore, completed: match.completed };
  } catch(e) { return null; }
}

async function analyzeWithClaude(pick, score) {
  try {
    const messages = [{ role: 'user', content: `Eres experto verificador de apuestas. Analiza:
Pick: ${pick.match} | Liga: ${pick.league} | Odds: ${pick.odds}
Resultado: ${score.home} ${score.homeScore} - ${score.awayScore} ${score.away}
Responde SOLO JSON: {"resultado":"GANADO|PERDIDO|VOID|NECESITA_VERIFICACION","confianza":0-100,"detalle":"breve"}` }];
    const resp = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages });
    const text = resp.content[0].text;
    const json = text.match(/\{[\s\S]*\}/);
    return json ? JSON.parse(json[0]) : null;
  } catch(e) { return null; }
}

async function runPickAnalysis() {
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const picks = await Pick.find({ result: 'pending', createdAt: { $lt: sixHoursAgo } });
    for (const pick of picks) {
      const parts = pick.match.split(' vs ');
      if (parts.length < 2) continue;
      const score = await getMatchScore(pick.league, parts[0].trim(), parts[1].trim(), pick.sportKey);
      if (!score?.completed) continue;
      const analysis = await analyzeWithClaude(pick, score);
      if (analysis) {
        await Pick.findByIdAndUpdate(pick._id, { aiAnalysis: analysis });
        console.log(`Analyzed: ${pick.match} -> ${analysis.resultado}`);
      }
    }
  } catch(e) { console.error('runPickAnalysis error:', e); }
}

setInterval(runPickAnalysis, 60 * 60 * 1000);

app.post('/api/admin/analyze-picks', auth, requireAdmin, async (req, res) => {
  runPickAnalysis();
  res.json({ success: true, message: 'Analisis iniciado' });
});

app.post('/api/picks/:id/analyze', auth, requireAdmin, async (req, res) => {
  try {
    const pick = await Pick.findById(req.params.id);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });
    const parts = pick.match.split(' vs ');
    if (parts.length < 2) return res.status(400).json({ error: 'Invalid match format' });
    const score = await getMatchScore(pick.league, parts[0].trim(), parts[1].trim(), pick.sportKey);
    if (!score) return res.status(404).json({ error: 'Score not found' });
    const analysis = await analyzeWithClaude(pick, score);
    if (analysis) { await Pick.findByIdAndUpdate(pick._id, { aiAnalysis: analysis }); res.json({ success: true, analysis }); }
    else res.status(500).json({ error: 'Analysis failed' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SERVER ────────────────────────────────────────────────────────────────────
const normalizeUsdCents = (amount) => {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 100);
};

const getUserBaseUrlFromRequest = (req) => {
  const { successUrl, cancelUrl, baseUrl } = req.body || {};
  if (isValidHttpUrl(successUrl) && isValidHttpUrl(cancelUrl)) {
    return { successUrl, cancelUrl };
  }
  if (!isValidHttpUrl(baseUrl)) return null;
  return {
    successUrl: `${baseUrl.replace(/\/+$/, '')}/`,
    cancelUrl: `${baseUrl.replace(/\/+$/, '')}/`
  };
};

const resolveCheckoutPaymentState = async (session) => {
  let paymentIntentStatus = null;
  if (session?.payment_intent) {
    if (typeof session.payment_intent === 'string') {
      const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
      paymentIntentStatus = paymentIntent?.status || null;
    } else {
      paymentIntentStatus = session.payment_intent?.status || null;
    }
  }
  const isPaid = session?.payment_status === 'paid' || paymentIntentStatus === 'succeeded';
  return {
    isPaid,
    paymentStatus: session?.payment_status || null,
    checkoutStatus: session?.status || null,
    paymentIntentStatus
  };
};

const STRIPE_CHECKOUT_SESSION_TOKEN = '{CHECKOUT_SESSION_ID}';

const injectCheckoutSessionToken = (url) => {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/%7BCHECKOUT_SESSION_ID%7D/gi, STRIPE_CHECKOUT_SESSION_TOKEN);
};

const normalizeCheckoutSessionId = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
};

const isValidCheckoutSessionId = (value) => /^cs_(test|live)_[^\s]+$/.test(value);
const hasPickBuyerAccess = async (pickId, userId) => {
  if (!pickId || !userId) return false;
  const existingPurchase = await Purchase.exists({ pickId, buyerId: userId });
  return Boolean(existingPurchase);
};

const getPickAccessState = async (pick, userId, userRole) => {
  if (!pick || !userId) {
    return { hasAccess: false, isOwner: false, isPurchased: false, isFree: false, isAdmin: false };
  }
  const isOwner = String(pick.tipsterId) === String(userId);
  const isPurchased = await hasPickBuyerAccess(pick._id, userId);
  const isFree = normalizeUsdCents(pick.price) === 0;
  const isAdmin = userRole === 'admin';
  return {
    hasAccess: Boolean(isOwner || isPurchased || isFree || isAdmin),
    isOwner,
    isPurchased,
    isFree,
    isAdmin
  };
};

app.post('/api/stripe/picks/create-checkout-session', auth, async (req, res) => {
  try {
    const { pickId } = req.body || {};
    if (!pickId) return res.status(400).json({ error: 'pickId requerido' });
    const pick = await Pick.findById(pickId);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });

    const isOwner = String(pick.tipsterId) === String(req.user.id);
    const isPurchased = await hasPickBuyerAccess(pick._id, req.user.id);
    const cents = normalizeUsdCents(pick.price);
    const isFree = cents === 0;

    if (isOwner && !isFree) {
      return res.status(403).json({ error: 'No puedes comprar tu propio pick' });
    }

    if (isPurchased || isFree) {
      if (!isPurchased && isFree) {
        await Pick.findByIdAndUpdate(pickId, { $addToSet: { buyers: req.user.id } });
      }
      const unlocked = await Pick.findById(pickId);
      return res.json({
        success: true,
        free: isFree,
        alreadyUnlocked: true,
        unlockReason: isPurchased ? 'purchased' : 'free',
        pick: unlocked
      });
    }

    const urls = getUserBaseUrlFromRequest(req);
    if (!urls) return res.status(400).json({ error: 'URLs de retorno inválidas' });

    const user = await User.findById(req.user.id).select('email');
    const successUrl = injectCheckoutSessionToken(appendQueryParams(urls.successUrl, {
      checkout: 'success',
      flow: 'pick',
      pickId: String(pick._id),
      session_id: STRIPE_CHECKOUT_SESSION_TOKEN
    }));
    const cancelUrl = appendQueryParams(urls.cancelUrl, {
      checkout: 'cancel',
      flow: 'pick',
      pickId: String(pick._id)
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: user?.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: {
            name: `Pick: ${pick.match}`,
            description: `${pick.league || 'Sports'} | Tipster: ${pick.tipster || 'ThePickZone'}`
          }
        }
      }],
      metadata: {
        flow: 'pick',
        pickId: String(pick._id),
        userId: String(req.user.id)
      }
    });

    res.json({ success: true, sessionId: session.id, checkoutUrl: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe/picks/confirm-checkout-session', auth, async (req, res) => {
  try {
    const { sessionId, pickId } = req.body || {};
    const normalizedSessionId = normalizeCheckoutSessionId(sessionId);
    if (!normalizedSessionId) return res.status(400).json({ error: 'sessionId requerido' });
    if (normalizedSessionId === STRIPE_CHECKOUT_SESSION_TOKEN || !isValidCheckoutSessionId(normalizedSessionId)) {
      return res.status(400).json({ error: 'sessionId inválido o incompleto' });
    }
    const session = await stripe.checkout.sessions.retrieve(normalizedSessionId, { expand: ['payment_intent'] });
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
    const paymentState = await resolveCheckoutPaymentState(session);
    if (!paymentState.isPaid) {
      return res.status(400).json({
        error: 'Pago no completado',
        status: paymentState.paymentStatus,
        checkoutStatus: paymentState.checkoutStatus,
        paymentIntentStatus: paymentState.paymentIntentStatus
      });
    }
    if (session.metadata?.flow !== 'pick') return res.status(400).json({ error: 'La sesión no corresponde a compra de pick' });

    if (!session.metadata?.userId) {
      return res.status(400).json({ error: 'La sesión no contiene usuario asociado' });
    }
    if (String(session.metadata.userId) !== String(req.user.id)) {
      return res.status(403).json({ error: 'La sesión no pertenece al usuario autenticado' });
    }
    const targetPickId = session.metadata?.pickId;
    if (!targetPickId) return res.status(400).json({ error: 'No se encontró pickId en la sesión' });
    if (pickId && String(pickId) !== String(targetPickId)) {
      return res.status(400).json({ error: 'pickId no coincide con la sesión de checkout' });
    }

    await Purchase.findOneAndUpdate(
      { pickId: targetPickId, buyerId: req.user.id },
      {
        $set: {
          stripeSessionId: normalizedSessionId,
          amountCents: typeof session.amount_total === 'number' ? session.amount_total : 0,
          currency: session.currency || 'usd'
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    const updated = await Pick.findByIdAndUpdate(
      targetPickId,
      { $addToSet: { buyers: req.user.id } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Pick not found' });

    res.json({ success: true, pick: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe/pro/create-checkout-session', auth, async (req, res) => {
  try {
    const urls = getUserBaseUrlFromRequest(req);
    if (!urls) return res.status(400).json({ error: 'URLs de retorno inválidas' });

    const user = await User.findById(req.user.id).select('email');
    const successUrl = injectCheckoutSessionToken(appendQueryParams(urls.successUrl, {
      checkout: 'success',
      flow: 'pro',
      session_id: STRIPE_CHECKOUT_SESSION_TOKEN
    }));
    const cancelUrl = appendQueryParams(urls.cancelUrl, {
      checkout: 'cancel',
      flow: 'pro'
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: user?.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: PRO_PLAN_AMOUNT_CENTS,
          product_data: {
            name: 'ThePickZone Pro (30 días)',
            description: 'Membresía Pro mensual'
          }
        }
      }],
      metadata: {
        flow: 'pro',
        userId: String(req.user.id)
      }
    });

    res.json({ success: true, sessionId: session.id, checkoutUrl: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe/pro/confirm-checkout-session', auth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const normalizedSessionId = normalizeCheckoutSessionId(sessionId);
    if (!normalizedSessionId) return res.status(400).json({ error: 'sessionId requerido' });
    if (normalizedSessionId === STRIPE_CHECKOUT_SESSION_TOKEN || !isValidCheckoutSessionId(normalizedSessionId)) {
      return res.status(400).json({ error: 'sessionId inválido o incompleto' });
    }
    const session = await stripe.checkout.sessions.retrieve(normalizedSessionId, { expand: ['payment_intent'] });
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
    const paymentState = await resolveCheckoutPaymentState(session);
    if (!paymentState.isPaid) {
      return res.status(400).json({
        error: 'Pago no completado',
        status: paymentState.paymentStatus,
        checkoutStatus: paymentState.checkoutStatus,
        paymentIntentStatus: paymentState.paymentIntentStatus
      });
    }
    if (session.metadata?.flow !== 'pro') return res.status(400).json({ error: 'La sesión no corresponde a membresía Pro' });

    if (!session.metadata?.userId) {
      return res.status(400).json({ error: 'La sesión no contiene usuario asociado' });
    }
    if (String(session.metadata.userId) !== String(req.user.id)) {
      return res.status(403).json({ error: 'La sesión no pertenece al usuario autenticado' });
    }

    const proExpiry = new Date(Date.now() + PRO_PLAN_DURATION_DAYS * 24 * 60 * 60 * 1000);
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { role: 'pro', proExpiry },
      { new: true }
    ).select('-password');

    res.json({ success: true, user, proExpiry });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PICKS FULL (with image) ───────────────────────────────────────────────────
app.get('/api/picks/:id/full', auth, async (req, res) => {
  try {
    const pick = await Pick.findById(req.params.id);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });
    const accessState = await getPickAccessState(pick, req.user.id, req.user.role);
    if (!accessState.hasAccess) return res.status(403).json({ error: 'No tienes acceso' });
    res.json(pick);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
