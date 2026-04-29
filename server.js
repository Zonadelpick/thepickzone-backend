require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const PORT           = process.env.PORT           || 3001;
const MONGO_URI      = process.env.MONGO_URI      || '';
const JWT_SECRET     = process.env.JWT_SECRET     || 'thepickzone_secret_2026';
const API_SPORTS_KEY = process.env.API_SPORTS_KEY || '6e223c4a4618a8df2d8cd3ea63248740';

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB conectado'))
    .catch(err => console.error('MongoDB error:', err.message));
}

const UserSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true },
  role:      { type: String, enum: ['basic','pro','admin'], default: 'basic' },
  roi:       { type: String, default: '0%' },
  balance:   { type: Number, default: 0 },
  proExpiry: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

const PickSchema = new mongoose.Schema({
  tipster:   { type: String, required: true },
  tipsterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  league:    { type: String, required: true },
  sport:     { type: String, required: true },
  flag:      { type: String, default: '🌍' },
  match:     { type: String, required: true },
  time:      { type: String, required: true },
  odds:      { type: Number, required: true },
  bank:      { type: Number, required: true },
  price:     { type: Number, default: 0 },
  ticketImg: { type: String },
  locked:    { type: Boolean, default: true },
  result:    { type: String, enum: ['pending','won','lost'], default: 'pending' },
  buyers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
});

const PurchaseSchema = new mongoose.Schema({
  buyer:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  pick:      { type: mongoose.Schema.Types.ObjectId, ref: 'Pick', required: true },
  amount:    { type: Number, required: true },
  paypalId:  { type: String },
  status:    { type: String, enum: ['pending','completed','refunded'], default: 'completed' },
  createdAt: { type: Date, default: Date.now },
});

const User     = mongoose.model('User',     UserSchema);
const Pick     = mongoose.model('Pick',     PickSchema);
const Purchase = mongoose.model('Purchase', PurchaseSchema);

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalido' }); }
}

function requirePro(req, res, next) {
  if (req.user.role !== 'pro' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Se requiere cuenta Pro' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Se requiere cuenta Admin' });
  next();
}

const SPORT_CONFIG = {
  'Liga de España':             { api: 'football', id: 140 },
  'Premier League':             { api: 'football', id: 39  },
  'Serie A':                    { api: 'football', id: 135 },
  'Bundesliga':                 { api: 'football', id: 78  },
  'Ligue 1':                    { api: 'football', id: 61  },
  'Champions League':           { api: 'football', id: 2   },
  'Europa League':              { api: 'football', id: 3   },
  'Conference League':          { api: 'football', id: 848 },
  'Segunda Division':           { api: 'football', id: 141 },
  'Championship':               { api: 'football', id: 40  },
  'Serie B':                    { api: 'football', id: 136 },
  '2. Bundesliga':              { api: 'football', id: 79  },
  'Ligue 2':                    { api: 'football', id: 62  },
  'Eredivisie':                 { api: 'football', id: 88  },
  'Pro League Belgica':         { api: 'football', id: 144 },
  'Primeira Liga Portugal':     { api: 'football', id: 94  },
  'Super Lig':                  { api: 'football', id: 203 },
  'Ekstraklasa':                { api: 'football', id: 106 },
  'HNL':                        { api: 'football', id: 210 },
  'Superliga Serbia':           { api: 'football', id: 206 },
  'Allsvenskan':                { api: 'football', id: 113 },
  'Eliteserien':                { api: 'football', id: 103 },
  'Veikkausliiga':              { api: 'football', id: 244 },
  'Superliga Dinamarca':        { api: 'football', id: 119 },
  'Saudi Pro League':           { api: 'football', id: 307 },
  'UAE Pro League':             { api: 'football', id: 435 },
  'Egyptian Premier League':    { api: 'football', id: 233 },
  'J1 League':                  { api: 'football', id: 98  },
  'K League 1':                 { api: 'football', id: 292 },
  'Chinese Super League':       { api: 'football', id: 169 },
  'Liga MX':                    { api: 'football', id: 262 },
  'MLS':                        { api: 'football', id: 253 },
  'Brasileirao Serie A':        { api: 'football', id: 71  },
  'Primera Division Argentina': { api: 'football', id: 128 },
  'Copa Libertadores':          { api: 'football', id: 13  },
  'NBA':                        { api: 'basketball', id: 12  },
  'NCAA Basketball':            { api: 'basketball', id: 116 },
  'MLB':                        { api: 'baseball',   id: 1   },
  'NFL':                        { api: 'american-football', id: 1 },
  'NHL':                        { api: 'hockey',     id: 57  },
  'Formula 1':                  { api: 'formula-1',  id: 1   },
  'UFC':                        { api: 'mma',        id: 1   },
};

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ThePickZone API funcionando v1.0' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Nombre, email y contrasena requeridos' });
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: 'Email ya registrado' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hash, role: role || 'basic' });
    const token = jwt.sign({ id: user._id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Email o contrasena incorrectos' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Email o contrasena incorrectos' });
    const token = jwt.sign({ id: user._id, email: user.email, role: user.role, name: user.name, roi: user.roi }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, roi: user.roi, balance: user.balance } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fixtures', async (req, res) => {
  const { league } = req.query;
  if (!league) return res.status(400).json({ error: 'Liga requerida' });
  const cfg = SPORT_CONFIG[league];
  if (!cfg) return res.status(404).json({ error: 'Liga no encontrada', league });
  try {
    const today    = new Date().toISOString().split('T')[0];
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    const season   = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const headers  = { 'x-apisports-key': API_SPORTS_KEY };
    const days     = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'];
    const months   = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

    if (cfg.api === 'football') {
      const nextWeek2 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      const r = await axios.get('https://v3.football.api-sports.io/fixtures', {
        headers, params: { league: cfg.id, season, from: today, to: nextWeek2, status: 'NS' }
      });
      return res.json((r.data.response || []).slice(0, 10).map((f, i) => {
        const d = new Date(f.fixture.date);
        return {
          id: i+1, home: f.teams.home.name, away: f.teams.away.name,
          time: `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} - ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
          venue: f.fixture.venue?.name || ''
        };
      }));
    }
    if (cfg.api === 'basketball') {
      let games = [];
      for(let dd=0; dd<=7; dd++){
        const searchDay = new Date(Date.now()+dd*86400000).toISOString().split('T')[0];
        const r = await axios.get('https://v1.basketball.api-sports.io/games', {
          headers, params: { league: cfg.id, season: `${season}-${season+1}`, date: searchDay }
        });
        games = r.data.response || [];
        if(games.length > 0) break;
      }
      return res.json(games.slice(0, 10).map((g, i) => {
        const d = new Date(g.date?.start || g.date);
        return { id: i+1, home: g.teams?.home?.name || '', away: g.teams?.visitors?.name || '',
          time: days[d.getDay()]+' '+d.getDate()+' '+months[d.getMonth()]+' - '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'),
          venue: g.arena?.name || '' };
      }));
    }
    if (cfg.api === 'baseball') {
      const r = await axios.get('https://v1.baseball.api-sports.io/games', {
        headers, params: { league: cfg.id, season, date: today }
      });
      return res.json((r.data.response || []).slice(0, 10).map((g, i) => ({
        id: i+1, home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
        time: new Date(g.date).toLocaleString('es-MX', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }),
        venue: g.venue?.name || ''
      })));
    }
    if (cfg.api === 'american-football') {
      const r = await axios.get('https://v1.american-football.api-sports.io/games', {
        headers, params: { league: cfg.id, season }
      });
      const upcoming = (r.data.response || []).filter(g => new Date(g.game?.date?.date || g.date) > new Date());
      return res.json(upcoming.slice(0, 8).map((g, i) => ({
        id: i+1, home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
        time: new Date(g.game?.date?.date || g.date).toLocaleString('es-MX', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }),
        venue: g.game?.venue?.name || ''
      })));
    }
    if (cfg.api === 'hockey') {
      const r = await axios.get('https://v1.hockey.api-sports.io/games', {
        headers, params: { league: cfg.id, season: `${season}-${season+1}`, date: today }
      });
      return res.json((r.data.response || []).slice(0, 8).map((g, i) => ({
        id: i+1, home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
        time: new Date(g.date).toLocaleString('es-MX', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }),
        venue: g.arena || ''
      })));
    }
    if (cfg.api === 'formula-1') {
      const r = await axios.get('https://v1.formula-1.api-sports.io/races', {
        headers, params: { season, type: 'Race' }
      });
      const upcoming = (r.data.response || []).filter(r => new Date(r.date) > new Date());
      return res.json(upcoming.slice(0, 5).map((r, i) => ({
        id: i+1, home: r.competition?.name || 'GP', away: r.circuit?.location?.country || '',
        time: new Date(r.date).toLocaleString('es-MX', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }),
        venue: r.circuit?.name || ''
      })));
    }
    if (cfg.api === 'mma') {
      const r = await axios.get('https://v1.mma.api-sports.io/fights', { headers, params: { next: 8 } });
      return res.json((r.data.response || []).slice(0, 8).map((f, i) => ({
        id: i+1, home: f.fighters?.first?.name || '', away: f.fighters?.second?.name || '',
        time: new Date(f.date).toLocaleString('es-MX', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }),
        venue: f.event?.name || ''
      })));
    }
    res.json([]);
  } catch (err) {
    console.error('API-Sports error:', err.message);
    res.status(500).json({ error: 'Error API-Sports', details: err.message });
  }
});

app.get('/api/picks', async (req, res) => {
  try {
    const picks = await Pick.find({ createdAt: { $gte: new Date(Date.now() - 7*86400000) } })
      .sort({ createdAt: -1 }).select('-ticketImg -buyers');
    res.json(picks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/picks', auth, requirePro, async (req, res) => {
  try {
    const { league, sport, flag, match, time, odds, bank, price, ticketImg } = req.body;
    if (!league || !match || !odds || !bank)
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    const pick = await Pick.create({
      tipster: req.user.name, tipsterId: req.user.id,
      league, sport, flag, match, time,
      odds: parseFloat(odds), bank: parseInt(bank), price: parseFloat(price) || 0,
      ticketImg: ticketImg || null,
    });
    res.json(pick);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/picks/:id/buy', auth, async (req, res) => {
  try {
    const pick = await Pick.findById(req.params.id);
    if (!pick) return res.status(404).json({ error: 'Pick no encontrado' });
    if (pick.buyers.includes(req.user.id)) return res.json({ pick, alreadyOwned: true });
    pick.buyers.push(req.user.id);
    await pick.save();
    await Purchase.create({ buyer: req.user.id, pick: pick._id, amount: pick.price });
    if (pick.price > 0) await User.findByIdAndUpdate(pick.tipsterId, { $inc: { balance: pick.price * 0.9 } });
    res.json({ pick, alreadyOwned: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', auth, requireAdmin, async (req, res) => {
  try {
    const [users, picks, purchases] = await Promise.all([
      User.countDocuments(), Pick.countDocuments(), Purchase.countDocuments({ status: 'completed' })
    ]);
    const revenue = await Purchase.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    res.json({ users, picks, purchases, revenue: revenue[0]?.total || 0, commission: (revenue[0]?.total || 0) * 0.10 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/users/:id/role', auth, requireAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { role: req.body.role }, { new: true }).select('-password');
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fixtures/team', async (req, res) => { const { team } = req.query; if (!team) return res.status(400).json({ error: 'Equipo requerido' }); const headers = { 'x-apisports-key': API_SPORTS_KEY }; const days = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab']; const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']; const fmt = d => { const dt=new Date(d); return String(dt.getFullYear()).length<4?null:days[dt.getDay()]+' '+dt.getDate()+' '+months[dt.getMonth()]+' - '+String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0'); }; const today = new Date().toISOString().split('T')[0]; const season = new Date().getFullYear(); const results = []; try { const nba = await axios.get('https://v1.basketball.api-sports.io/games', { headers, params: { league:12, season:season+'-'+(season+1), date:today } }); (nba.data.response||[]).forEach(g => { const h=(g.teams?.home?.name||'').toLowerCase(),a=(g.teams?.visitors?.name||'').toLowerCase(),t=team.toLowerCase(); if(h.includes(t)||a.includes(t)) results.push({ home:g.teams.home.name, away:g.teams.visitors.name, league:'NBA '+season, time:fmt(g.date?.start||g.date)||today, venue:g.arena?.name||'' }); }); const mlb = await axios.get('https://v1.baseball.api-sports.io/games', { headers, params: { league:1, season, date:today } }); (mlb.data.response||[]).forEach(g => { const h=(g.teams?.home?.name||'').toLowerCase(),a=(g.teams?.away?.name||'').toLowerCase(),t=team.toLowerCase(); if(h.includes(t)||a.includes(t)) results.push({ home:g.teams.home.name, away:g.teams.away.name, league:'MLB '+season, time:fmt(g.date)||today, venue:g.venue?.name||'' }); }); const nhl = await axios.get('https://v1.hockey.api-sports.io/games', { headers, params: { league:57, season:season+'-'+(season+1), date:today } }); (nhl.data.response||[]).forEach(g => { const h=(g.teams?.home?.name||'').toLowerCase(),a=(g.teams?.away?.name||'').toLowerCase(),t=team.toLowerCase(); if(h.includes(t)||a.includes(t)) results.push({ home:g.teams.home.name, away:g.teams.away.name, league:'NHL '+season, time:fmt(g.date)||today, venue:g.arena||'' }); }); if(results.length===0) return res.json([{ notFound:true }]); res.json(results); } catch(err) { console.error('team search error:',err.message); res.status(500).json({ error: err.message }); }});

app.get('/api/fixtures/espn', async (req, res) => {
  const { league } = req.query;
  if(!league) return res.status(400).json({ error: 'liga requerida' });
  const ESPN_MAP = {
    'Formula 1': 'racing/f1',
    'UFC': 'mma/ufc',
    'NCAA Football': 'football/college-football',
    'NCAA Basketball': 'basketball/mens-college-basketball',
    'NBA':  'basketball/nba',
    'MLB':  'baseball/mlb',
    'NHL':  'hockey/nhl',
    'NFL':  'football/nfl',
    'MLS':  'soccer/usa.1',
    'UFC':  'mma/ufc',
  };
  const path = ESPN_MAP[league];
  if(!path) return res.json([]);
  try {
    const days = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'];
    const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const r = await axios.get('https://site.api.espn.com/apis/site/v2/sports/'+path+'/scoreboard');
    const events = r.data.events || [];
    const results = events.filter(e => {
      const status = e.status?.type?.state;
      return status === 'pre';
    }).slice(0, 10).map((e, i) => {
      const d = new Date(e.date);
      const comps = e.competitions?.[0];
      const home = comps?.competitors?.find(t => t.homeAway === 'home');
      const away = comps?.competitors?.find(t => t.homeAway === 'away');
      return {
        id: i+1,
        home: home?.team?.displayName || '',
        away: away?.team?.displayName || '',
        time: days[d.getDay()]+' '+d.getDate()+' '+months[d.getMonth()]+' - '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'),
        venue: comps?.venue?.fullName || ''
      };
    });
    if(results.length === 0) return res.json([{notFound: true}]);
    res.json(results);
  } catch(err) {
    console.error('ESPN error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('ThePickZone Backend corriendo en puerto ' + PORT);
  console.log('API-Sports key: ' + API_SPORTS_KEY.substring(0,8) + '...');
  console.log('MongoDB: ' + (MONGO_URI ? 'configurado' : 'no configurado'));
});

// ── STRIPE PAYMENTS ───────────────────────────────────────────────────────────
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Charge card via Stripe
app.post('/api/payments/charge', auth, async (req, res) => {
  try {
    const { paymentMethodId, amount, description } = req.body;
    if (!paymentMethodId || !amount)
      return res.status(400).json({ error: 'paymentMethodId y amount requeridos' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true,
      description: description || 'ThePickZone',
      metadata: { userId: req.user.id, userEmail: req.user.email },
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    res.json({ success: true, paymentIntentId: paymentIntent.id, status: paymentIntent.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Create subscription (Pro plan $20/month)
app.post('/api/payments/subscribe', auth, async (req, res) => {
  try {
    const { paymentMethodId } = req.body;

    // Create or get customer
    let customer;
    const existing = await stripe.customers.list({ email: req.user.email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name,
        payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    // Charge $20 one-time for now (in production create recurring subscription)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 2000, // $20.00
      currency: 'usd',
      customer: customer.id,
      payment_method: paymentMethodId,
      confirm: true,
      description: 'ThePickZone Pro - Suscripcion mensual',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    // Upgrade user to Pro
    await User.findByIdAndUpdate(req.user.id, {
      role: 'pro',
      proExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    res.json({ success: true, paymentIntentId: paymentIntent.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

