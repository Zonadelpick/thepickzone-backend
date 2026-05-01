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
  flag:      { type: String, default: '=���' },
  match:     { type: String, required: true },
  time:      { type: String, required: true },
  odds:      { type: Number, required: true },
  bank:      { type: Number, required: true },
  price:     { type: Number, default: 0 },
  ticketImg: { type: String },
  locked:    { type: Boolean, default: true },
  result:    { type: String, enum: ['pending','won','lost'], default: 'pending' },
  buyers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  aiAnalysis:{ type: Object, default: null },
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
  'Liga de Espa+�a':             { api: 'football', id: 140 },
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

  'Liga de Expansion MX':       { api: 'football', id: 263 },
  'Copa MX':                    { api: 'football', id: 264 },
  'Brasileirao Serie B':        { api: 'football', id: 72  },
  'Copa do Brasil':             { api: 'football', id: 73  },
  'Primera Nacional Argentina': { api: 'football', id: 131 },
  'Copa Argentina':             { api: 'football', id: 132 },
  'Liga BetPlay Colombia':      { api: 'football', id: 239 },
  'Copa Colombia':              { api: 'football', id: 240 },
  'Primera Division Chile':     { api: 'football', id: 265 },
  'Primera B Chile':            { api: 'football', id: 266 },
  'Liga 1 Peru':                { api: 'football', id: 281 },
  'Liga Pro Ecuador':           { api: 'football', id: 268 },
  'Liga FUTVE Venezuela':       { api: 'football', id: 310 },
  'Primera Division Uruguay':   { api: 'football', id: 268 },
  'Division Profesional Paraguay': { api: 'football', id: 385 },
  'Division Profesional Bolivia':  { api: 'football', id: 386 },
  'Copa Sudamericana':          { api: 'football', id: 11  },
  'Recopa Sudamericana':        { api: 'football', id: 12  },
  'Copa America':               { api: 'football', id: 9   },
  'Mundial FIFA':               { api: 'football', id: 1   },
  'Mundial de Clubes':          { api: 'football', id: 15  },
  'Concacaf Champions':          { api: 'football', id: 16  },
  'Concacaf Gold Cup':            { api: 'football', id: 22  },
  'Concacaf Nations League':      { api: 'football', id: 536 },
  'Concacaf League':              { api: 'football', id: 767 },
    'NBA':                        { api: 'basketball', id: 12  },
  'NCAA Basketball':            { api: 'basketball', id: 116 },
  'MLB':                        { api: 'baseball',   id: 1   },
  'NFL':                        { api: 'american-football', id: 1 },
  'NHL':                        { api: 'hockey',     id: 57  },
  'Formula 1':                  { api: 'formula-1',  id: 1   },
  'UFC':                        { api: 'mma',        id: 1   },
};

app.post('/api/admin/set-role', async (req, res) => {
  const { secret, email, role } = req.body;
  if(secret !== 'tpz-setup-2026') return res.status(403).json({ error: 'Forbidden' });
  try {
    const user = await User.findOneAndUpdate({ email }, { role }, { new: true });
    if(user) res.json({ success: true, email: user.email, role: user.role });
    else res.json({ error: 'User not found' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

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
    // Check if Pro subscription expired
    if(user.role === 'pro' && user.proExpiry && new Date() > user.proExpiry){
      await User.findByIdAndUpdate(user._id, { role: 'basic' });
      user.role = 'basic';
    }
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
    const season   = 2025;
    const headers  = { 'x-apisports-key': API_SPORTS_KEY };
    const days     = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'];
    const months   = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

    if (cfg.api === 'football') {
      const nextWeek2 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      let r = await axios.get('https://v3.football.api-sports.io/fixtures', {
        headers, params: { league: cfg.id, season: 2025, from: today, to: nextWeek2, status: 'NS' }
      });
      if((r.data.response||[]).length === 0){
        r = await axios.get('https://v3.football.api-sports.io/fixtures', {
          headers, params: { league: cfg.id, season: 2026, from: today, to: nextWeek2, status: 'NS' }
        });
      }
      return res.json((r.data.response || []).slice(0, 10).map((f, i) => {
        const d = new Date(f.fixture.date);
        return { id: i+1, home: f.teams.home.name, away: f.teams.away.name,
          time: days[d.getDay()]+' '+d.getDate()+' '+months[d.getMonth()]+' - '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'),
          venue: f.fixture.venue?.name || '' };
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
    const cutoff = new Date(Date.now() - 6*3600000);
    const picks = await Pick.find({ createdAt: { $gte: cutoff }, result: 'pending' })
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
    // Build dates for next 7 days
    const espnDates = [];
    for(let d=0; d<=7; d++){
      const dt = new Date(Date.now()+d*86400000);
      const ds = dt.getFullYear().toString()+String(dt.getMonth()+1).padStart(2,'0')+String(dt.getDate()).padStart(2,'0');
      espnDates.push(ds);
    }
    const allEvents = [];
    for(const dateStr of espnDates){
      const r = await axios.get('https://site.api.espn.com/apis/site/v2/sports/'+path+'/scoreboard?dates='+dateStr);
      (r.data.events||[]).forEach(e => allEvents.push(e));
      if(allEvents.filter(e=>e.status?.type?.state==='pre').length >= 10) break;
    }
    const r = { data: { events: allEvents } };
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
        time: e.date,
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


// PayPal
const paypal = require('@paypal/checkout-server-sdk');
const paypalEnv = new paypal.core.LiveEnvironment(
  'AfC5IdhZr9ZgD94g2Rszgj8rwgM8o1R9j2bdsn-rOfvshjKp-jEqPiMKt057mJdfdSK8czay2muw3MB0',
  'EJt_u3ogXQRY87ZWBZ5wStvKy7HZI8V5BL355vHgpNX1DTBrd3znqSisCIeOjT85rdxi3uG0BSV1GPZL'
);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

app.post('/api/paypal/create-order', auth, async (req, res) => {
  try {
    const { amount, description } = req.body;
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: String(amount) },
        description: description || 'ThePickZone Pro'
      }]
    });
    const order = await paypalClient.execute(request);
    res.json({ orderId: order.result.id });
  } catch(err) {
    console.error('PayPal create order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/paypal/capture-order', auth, async (req, res) => {
  try {
    const { orderId, plan } = req.body;
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});
    const capture = await paypalClient.execute(request);
    if(capture.result.status === 'COMPLETED'){
      // Activate Pro
      await User.findByIdAndUpdate(req.user.id, {
        role: 'pro',
        proExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });
      res.json({ success: true, status: 'COMPLETED' });
    } else {
      res.status(400).json({ error: 'Pago no completado', status: capture.result.status });
    }
  } catch(err) {
    console.error('PayPal capture error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Reset all pro users stats
app.post('/api/admin/reset-stats', auth, requireAdmin, async (req, res) => {
  try {
    await User.updateMany({ role: 'pro' }, { roi: '+0%', balance: 0 });
    await Pick.updateMany({}, { result: 'pending', buyers: [] });
    res.json({ success: true, message: 'Stats reseteados' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get pending result picks for admin
app.get('/api/admin/picks-pending', auth, requireAdmin, async (req, res) => {
  try {
    const picks = await Pick.find({ result: 'pending' }).sort({ createdAt: -1 });
    res.json(picks);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get all picks for admin
app.get('/api/admin/picks-all', auth, requireAdmin, async (req, res) => {
  try {
    const picks = await Pick.find().sort({ createdAt: -1 }).select('-ticketImg');
    res.json(picks);
  } catch(err) { res.status(500).json({ error: err.message }); }
});


const axios_cron = axios;

// ESPN sport paths
const ESPN_PATHS = {
  'NBA': 'basketball/nba', 'MLB': 'baseball/mlb', 'NHL': 'hockey/nhl',
  'NFL': 'football/nfl', 'MLS': 'soccer/usa.1',
  'Liga de Espana': 'soccer/esp.1', 'Premier League': 'soccer/eng.1',
  'Champions League': 'soccer/uefa.champions', 'Liga MX': 'soccer/mex.1',
  'Bundesliga': 'soccer/ger.1', 'Serie A': 'soccer/ita.1', 'Ligue 1': 'soccer/fra.1'
};

async function getMatchResult(league, homeTeam, awayTeam, matchDate) {
  try {
    const path = ESPN_PATHS[league];
    if(!path) return null;
    const dateStr = new Date(matchDate).toISOString().split('T')[0].replace(/-/g,'');
    const r = await axios_cron.get('https://site.api.espn.com/apis/site/v2/sports/'+path+'/scoreboard?dates='+dateStr);
    const events = r.data.events || [];
    for(const e of events){
      const comps = e.competitions?.[0];
      const home = comps?.competitors?.find(t=>t.homeAway==='home')?.team?.displayName||'';
      const away = comps?.competitors?.find(t=>t.homeAway==='away')?.team?.displayName||'';
      const homeMatch = home.toLowerCase().includes(homeTeam.toLowerCase().split(' ')[0]) || homeTeam.toLowerCase().includes(home.toLowerCase().split(' ')[0]);
      const awayMatch = away.toLowerCase().includes(awayTeam.toLowerCase().split(' ')[0]) || awayTeam.toLowerCase().includes(away.toLowerCase().split(' ')[0]);
      if(homeMatch && awayMatch && e.status?.type?.completed){
        const homeScore = comps?.competitors?.find(t=>t.homeAway==='home')?.score;
        const awayScore = comps?.competitors?.find(t=>t.homeAway==='away')?.score;
        return { completed: true, home, away, homeScore, awayScore, status: e.status?.type?.description };
      }
    }
    return null;
  } catch(e){ return null; }
}

async function analyzePickResult(pick) {
  try {
    console.log('analyzePickResult started:', pick.match);
    const matchParts = pick.match.split(' vs ');
    if(matchParts.length < 2) return;
    const homeTeam = matchParts[0].trim();
    const awayTeam = matchParts[1].trim();
    
    // Parse match date from pick.time
    const mo2 = {Ene:0,Feb:1,Mar:2,Abr:3,May:4,Jun:5,Jul:6,Ago:7,Sep:8,Oct:9,Nov:10,Dic:11};
    const tp = pick.time?.match(/(\d{1,2})\s+(\w+)\s+-\s+(\d{2}):(\d{2})/);
    const matchDate = tp ? new Date(new Date().getFullYear(), mo2[tp[2]]||0, parseInt(tp[1])) : new Date();
    console.log('Searching ESPN for date:', matchDate.toISOString().split('T')[0]);
    const result = await getMatchResult(pick.league, homeTeam, awayTeam, matchDate);
    console.log('ESPN result:', JSON.stringify(result));
    if(!result || !result.completed){ console.log('No result found for:', pick.match); return; }
    
    // Use Claude to analyze ticket image vs result
    let aiResult = 'pending';
    if(pick.ticketImg){
      const prompt = 'Eres un experto en apuestas deportivas. El partido '+pick.match+' termino con marcador '+result.homeScore+'-'+result.awayScore+' ('+result.home+' vs '+result.away+'). Analiza esta imagen del ticket de apuesta y determina si la apuesta fue GANADA o PERDIDA. Responde SOLO con JSON: {"resultado":"GANADO" o "PERDIDO" o "VOID","confianza":0-100,"detalle":"explicacion breve"}';
      console.log('Calling Claude with image size:', pick.ticketImg?.length);
      const imgData = pick.ticketImg.includes(',') ? pick.ticketImg.split(',')[1] : pick.ticketImg;
      const analyzeRes = await axios_cron.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgData }},
          { type: 'text', text: prompt }
        ]}]
      }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }});
      const text = (analyzeRes.data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
      const match2 = text.match(/\{[\s\S]*\}/);
      if(match2){
        const analysis = JSON.parse(match2[0]);
        aiResult = analysis.resultado === 'GANADO' ? 'won' : analysis.resultado === 'PERDIDO' ? 'lost' : 'void';
        await Pick.findByIdAndUpdate(pick._id, { aiAnalysis: analysis, result: aiResult });
        console.log('Pick analyzed:', pick.match, '->', aiResult);
      }
    } else {
      // No ticket image - just mark as needing manual review
      await Pick.findByIdAndUpdate(pick._id, { aiAnalysis: { resultado: 'SIN TICKET', detalle: result.homeScore+'-'+result.awayScore, confianza: 0 }});
    }
  } catch(e){ console.error('analyzePickResult error:', e.message, e.response?.data ? JSON.stringify(e.response.data).substring(0,300) : ''); }
}

// Auto-analyze picks every hour
async function runPickAnalysis() {
  try {
    const now = new Date();
    console.log('runPickAnalysis started, time:', now);
    const picks = await Pick.find({ result: 'pending', ticketImg: { $exists: true } });
    console.log('Found picks:', picks.length);
    for(const pick of picks){
      // Parse pick time to check if match has ended (assume 3 hours after start)
      const timeStr = pick.time;
      if(!timeStr) continue;
      const mo = {Ene:0,Feb:1,Mar:2,Abr:3,May:4,Jun:5,Jul:6,Ago:7,Sep:8,Oct:9,Nov:10,Dic:11};
      const p = timeStr.match(/(\d{1,2})\s+(\w+)\s+-\s+(\d{2}):(\d{2})/);
      if(!p) continue;
      const month = mo[p[2]];
      if(month===undefined) continue;
      const matchTime = new Date(now.getFullYear(), month, parseInt(p[1]), parseInt(p[3]), parseInt(p[4]));
      const endTime = new Date(matchTime.getTime() + 3*60*60*1000);
      console.log('Pick:', pick.match, '| time:', pick.time, '| ended:', now > endTime);
      if(now > endTime){
        await analyzePickResult(pick);
      }
    }
  } catch(e){ console.error('runPickAnalysis error:', e.message); }
}

// Run every hour
setInterval(runPickAnalysis, 60*60*1000);
// Also run on startup after 5 minutes
setTimeout(runPickAnalysis, 5*60*1000);

// Manual trigger endpoint for admin

// Odds API fixtures endpoint
app.get('/api/fixtures/odds', async (req, res) => {
  try {
    const { league } = req.query;
    const SPORT_KEYS = {
      'NBA':'basketball_nba','MLB':'baseball_mlb','NHL':'icehockey_nhl',
      'NFL':'americanfootball_nfl','MLS':'soccer_usa_mls',
      'Liga MX':'soccer_mexico_ligamx','Premier League':'soccer_epl',
      'Champions League':'soccer_uefa_champs_league','Liga de Espana':'soccer_spain_la_liga',
      'Bundesliga':'soccer_germany_bundesliga','Serie A':'soccer_italy_serie_a',
      'Ligue 1':'soccer_france_ligue_one','Liga MX':'soccer_mexico_ligamx',
      'Copa Libertadores':'soccer_conmebol_copa_libertadores',
      'Liga Colombia':'soccer_colombia_primera_a','Liga Argentina':'soccer_argentina_primera_division',
      'Liga Brasil':'soccer_brazil_campeonato','Liga Chile':'soccer_chile_campeonato'
    };
    const sportKey = SPORT_KEYS[league];
    if(!sportKey) return res.json([]);
    const url = 'https://api.the-odds-api.com/v4/sports/'+sportKey+'/events/?apiKey='+process.env.ODDS_API_KEY+'&dateFormat=iso';
    const r = await axios.get(url);
    const events = r.data || [];
    const now = new Date();
    const in7days = new Date(now.getTime() + 7*24*3600*1000);
    const fixtures = events
      .filter(e => new Date(e.commence_time) > now && new Date(e.commence_time) < in7days)
      .map(e => ({
        id: e.id,
        home: e.home_team,
        away: e.away_team,
        time: e.commence_time,
        league: league
      }));
    res.json(fixtures);
  } catch(err) {
    console.error('Odds fixtures error:', err.message);
    res.json([]);
  }
});
app.post('/api/admin/analyze-picks', auth, requireAdmin, async (req, res) => {
  runPickAnalysis();
  res.json({ success: true, message: 'Analisis iniciado' });
});


const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const ODDS_API_KEY = process.env.ODDS_API_KEY;

const GOOGLE_VISION_KEY = process.env.GOOGLE_VISION_KEY;

const ODDS_SPORT_KEYS = {
  'NBA':'basketball_nba','MLB':'baseball_mlb','NHL':'icehockey_nhl',
  'NFL':'americanfootball_nfl','MLS':'soccer_usa_mls',
  'Liga MX':'soccer_mexico_ligamx','Premier League':'soccer_epl',
  'Champions League':'soccer_uefa_champs_league','Liga de Espana':'soccer_spain_la_liga',
  'Bundesliga':'soccer_germany_bundesliga','Serie A':'soccer_italy_serie_a','Ligue 1':'soccer_france_ligue_one'
};

async function getMatchScore(league, homeTeam, awayTeam) {
  try {
    const sportKey = ODDS_SPORT_KEYS[league];
    if(!sportKey){ console.log('No sport key for:', league); return null; }
    const url = 'https://api.the-odds-api.com/v4/sports/'+sportKey+'/scores/?apiKey='+ODDS_API_KEY+'&daysFrom=3';
    const r = await axios.get(url);
    const games = r.data || [];
    console.log('Odds API:', games.length, 'games for', league);
    for(const g of games){
      if(!g.completed) continue;
      const hn = (g.home_team||'').toLowerCase();
      const h0 = homeTeam.toLowerCase().split(' ')[0];
      if(hn.includes(h0) || h0.includes(hn.split(' ')[0])){
        const homeScore = g.scores?.find(s=>s.name===g.home_team)?.score||'?';
        const awayScore = g.scores?.find(s=>s.name===g.away_team)?.score||'?';
        console.log('Score:', g.home_team, homeScore, '-', awayScore, g.away_team);
        return { home:g.home_team, away:g.away_team, homeScore, awayScore };
      }
    }
    console.log('No score for:', homeTeam, 'vs', awayTeam);
    return null;
  } catch(e){ console.error('Odds API error:', e.message); return null; }
}

async function extractOCR(base64Image) {
  try {
    const imgData = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;
    const res = await axios.post('https://vision.googleapis.com/v1/images:annotate?key='+GOOGLE_VISION_KEY,
      { requests:[{ image:{ content:imgData }, features:[{ type:'TEXT_DETECTION' }] }] }
    );
    return res.data.responses?.[0]?.fullTextAnnotation?.text || '';
  } catch(e){ console.error('OCR error:', e.message); return ''; }
}

async function analyzeWithClaude(pick, score) {
  try {
    let ticketText = '';
    if(pick.ticketImg) ticketText = await extractOCR(pick.ticketImg);
    const prompt = `Eres un experto en apuestas deportivas. Analiza este ticket y determina si la apuesta fue GANADA o PERDIDA.

PARTIDO: ${pick.match}
RESULTADO FINAL: ${score.home} ${score.homeScore} - ${score.awayScore} ${score.away}
TEXTO OCR DEL TICKET: ${ticketText}

INSTRUCCIONES:
- Lee el ticket OCR cuidadosamente e identifica: tipo de apuesta, seleccion, linea/handicap
- Tipos de apuesta comunes: Moneyline (ganador directo), Spread/Handicap (diferencia de puntos), Total Over/Under (puntos totales), Props de jugadores (stats individuales), Parlays (multiples apuestas combinadas), Primera mitad/Segundo tiempo
- Para Spread: si apuesta es -6.5, el equipo debe ganar por mas de 6.5 puntos
- Para Over/Under: compara total de puntos del partido con la linea
- Para Props: si no tienes stats del jugador, indica NECESITA_VERIFICACION
- Para Parlays: todas las apuestas deben ganar para que el parlay gane
- Si el ticket no corresponde al partido indicado, indica NO_RELACIONADO
- Si no puedes determinar con certeza, indica NECESITA_VERIFICACION

Responde SOLO con JSON valido sin markdown:
{"resultado":"GANADO o PERDIDO o NECESITA_VERIFICACION o NO_RELACIONADO","confianza":0-100,"detalle":"explicacion detallada de cada apuesta del ticket","tipo_apuesta":"Moneyline/Spread/Total/Prop/Parlay"}`;
    const res = await axios.post('https://api.anthropic.com/v1/messages',{
      model:'claude-haiku-4-5-20251001',max_tokens:800,
      messages:[{role:'user',content:prompt}]
    },{headers:{'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'}});
    const text = (res.data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    console.log('Claude:', text.substring(0,300));
    const m = text.match(/\{[\s\S]*?\}/);
    if(m) return JSON.parse(m[0]);
  } catch(e){ console.error('Claude error:', e.message, e.response?.data?.error?.message); }
  return null;
}

async function runPickAnalysis() {
  try {
    const now = new Date();
    console.log('runPickAnalysis:', now.toISOString());
    const picks = await Pick.find({ result:'pending' });
    console.log('Pending picks:', picks.length);
    for(const pick of picks){
      const createdAt = new Date(pick.createdAt);
      if(now - createdAt < 6*3600*1000) continue;
      console.log('Analyzing:', pick.match);
      const parts = pick.match.split(' vs ');
      if(parts.length < 2) continue;
      const score = await getMatchScore(pick.league, parts[0].trim(), parts[1].trim());
      if(!score) continue;
      const analysis = await analyzeWithClaude(pick, score);
      if(analysis){
        console.log('Done:', pick.match, '->', analysis.resultado);
        await Pick.findByIdAndUpdate(pick._id, { aiAnalysis: analysis });
      }
    }
  } catch(e){ console.error('runPickAnalysis error:', e.message); }
}

setInterval(runPickAnalysis, 60*60*1000);
setTimeout(runPickAnalysis, 5000);

app.post('/api/admin/analyze-picks', auth, requireAdmin, async (req, res) => {
  runPickAnalysis();
  res.json({ success:true, message:'Analisis iniciado' });
});
app.listen(PORT, () => {
  console.log('ThePickZone Backend corriendo en puerto ' + PORT);
});
