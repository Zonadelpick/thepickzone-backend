const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
  paypal:     { type: String },
  roi:        { type: String, default: '+0%' },
  winRate:    { type: Number, default: 0 },
  totalPicks: { type: Number, default: 0 },
  balance:    { type: Number, default: 0 },
  proExpiry:  { type: Date },
  createdAt:  { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const PickSchema = new mongoose.Schema({
  tipster:    { type: String, required: true },
  tipsterId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  league:     { type: String },
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
  aiAnalysis: { type: Object },
  createdAt:  { type: Date, default: Date.now }
});
const Pick = mongoose.model('Pick', PickSchema);

const PurchaseSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  pickId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Pick', required: true },
  amount:       { type: Number, required: true },
  paypalOrderId:{ type: String },
  status:       { type: String, default: 'pending' },
  createdAt:    { type: Date, default: Date.now }
});
const Purchase = mongoose.model('Purchase', PurchaseSchema);

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
    res.json({ token, user: { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, bio: user.bio, paypal: user.paypal, roi: user.roi, winRate: user.winRate, totalPicks: user.totalPicks, proExpiry: user.proExpiry } });
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
    const { name, avatar, bio, username, paypal } = req.body;
    const updated = await User.findByIdAndUpdate(req.user.id, { name, avatar, bio, username, paypal }, { new: true }).select('-password');
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

app.put('/api/picks/:id/result', auth, requireAdmin, async (req, res) => {
  try {
    const { result } = req.body;
    if (!['won','lost','void','pending'].includes(result)) return res.status(400).json({ error: 'Invalid result' });
    const pick = await Pick.findById(req.params.id);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });
    await Pick.findByIdAndUpdate(req.params.id, { result });
    if (result !== 'void' && result !== 'pending' && pick.tipsterId) {
      const allPicks = await Pick.find({ tipsterId: pick.tipsterId, result: { $in: ['won','lost'] } });
      const won = allPicks.filter(p => p.result === 'won').length;
      const total = allPicks.length;
      const winRate = total > 0 ? Math.round((won / total) * 100) : 0;
      const totalInvested = allPicks.reduce((s,p) => s + (parseFloat(p.bank)||10), 0);
      const totalReturn = allPicks.filter(p=>p.result==='won').reduce((s,p) => s + (parseFloat(p.bank)||10) * (parseFloat(p.odds)||1), 0);
      const roiVal = totalInvested > 0 ? ((totalReturn - totalInvested) / totalInvested * 100).toFixed(1) : '0';
      const roiStr = parseFloat(roiVal) >= 0 ? '+'+roiVal+'%' : roiVal+'%';
      await User.findByIdAndUpdate(pick.tipsterId, { roi: roiStr, winRate, totalPicks: total });
    }
    res.json({ success: true, result });
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

app.get('/api/fixtures/odds', async (req, res) => {
  try {
    const { league } = req.query;
    if (!league) return res.status(400).json({ error: 'League required' });
    const sportKey = SPORT_KEYS[league];
    if (!sportKey) return res.json([]);
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${process.env.ODDS_API_KEY}&dateFormat=iso`;
    const resp = await axios.get(url);
    const fixtures = resp.data.map(e => ({
      id: e.id, home: e.home_team, away: e.away_team,
      time: e.commence_time, league
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
    await User.updateMany({}, { roi: '+0%', winRate: 0, totalPicks: 0, balance: 0 });
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
    await User.updateMany({}, { roi: '+0%', winRate: 0, totalPicks: 0, balance: 0 });
    res.json({ success: true, usersDeleted: deleted.deletedCount, picksDeleted: picksDeleted.deletedCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PAYPAL ───────────────────────────────────────────────────────────────────
const paypal = require('@paypal/checkout-server-sdk');
const paypalEnv = new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_SECRET || '');
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

app.post('/api/paypal/create-order', auth, async (req, res) => {
  try {
    const { amount, description } = req.body;
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: String(amount) }, description: description || 'ThePickZone Pro' }] });
    const order = await paypalClient.execute(request);
    res.json({ orderId: order.result.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paypal/capture-order', auth, async (req, res) => {
  try {
    const { orderId } = req.body;
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});
    const capture = await paypalClient.execute(request);
    if (capture.result.status === 'COMPLETED') {
      await User.findByIdAndUpdate(req.user.id, { role: 'pro', proExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Pago no completado' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AI ANALYSIS ───────────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getMatchScore(league, home, away) {
  try {
    const sportKey = SPORT_KEYS[league];
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
      const score = await getMatchScore(pick.league, parts[0].trim(), parts[1].trim());
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
    const score = await getMatchScore(pick.league, parts[0].trim(), parts[1].trim());
    if (!score) return res.status(404).json({ error: 'Score not found' });
    const analysis = await analyzeWithClaude(pick, score);
    if (analysis) { await Pick.findByIdAndUpdate(pick._id, { aiAnalysis: analysis }); res.json({ success: true, analysis }); }
    else res.status(500).json({ error: 'Analysis failed' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SERVER ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
