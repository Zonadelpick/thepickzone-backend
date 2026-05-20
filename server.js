const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const Stripe = require('stripe');
let Resvg = null;
try {
  ({ Resvg } = require('@resvg/resvg-js'));
} catch {
  Resvg = null;
}
const {
  resolveAutoCloseThresholdConfig,
  shouldAutoClosePick,
  mapAiOutcomeToPickResult
} = require('./autoCloseRules');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'JSON inválido en el body de la solicitud' });
  }
  return next(err);
});

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
const STRIPE_LIVE_REQUIRED = (() => {
  const explicit = String(process.env.STRIPE_REQUIRE_LIVE || '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
})();
if (STRIPE_LIVE_REQUIRED && STRIPE_MODE !== 'live') {
  throw new Error('Stripe live requerido: configura STRIPE_SECRET_KEY con una clave sk_live_ y desactiva credenciales de prueba.');
}
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
  role:       { type: String, default: 'basic', enum: ['basic','pro','tipster','admin'] },
  avatar:     { type: String },
  bio:        { type: String },
  username:   { type: String },
  roi:        { type: String, default: '+0%' },
  yield:      { type: String, default: '+0%' },
  roiValue:   { type: Number, default: 0 },
  yieldValue: { type: Number, default: 0 },
  netUnits:   { type: Number, default: 0 },
  totalRiskedUnits: { type: Number, default: 0 },
  winRate:    { type: Number, default: 0 },
  totalPicks: { type: Number, default: 0 },
  wonPicks:   { type: Number, default: 0 },
  lostPicks:  { type: Number, default: 0 },
  pushPicks:  { type: Number, default: 0 },
  avgOdds:    { type: Number, default: 0 },
  balance:    { type: Number, default: 0 },
  bankClabeMasked: { type: String, default: '' },
  bankClabeLast4: { type: String, default: '' },
  bankAccountHolder: { type: String, default: '' },
  bankName: { type: String, default: '' },
  emailVerified: { type: Boolean, default: false },
  emailVerifiedAt: { type: Date },
  emailVerificationTokenHash: { type: String, default: '' },
  emailVerificationExpiresAt: { type: Date },
  passwordResetTokenHash: { type: String, default: '' },
  passwordResetExpiresAt: { type: Date },
  stripeConnectedAccountId: { type: String, default: '' },
  stripeExternalAccountId: { type: String, default: '' },
  stripePayoutReady: { type: Boolean, default: false },
  stripePayoutStatus: { type: String, default: 'not_configured' },
  stripeLastTransferId: { type: String, default: '' },
  stripeLastPayoutAt: { type: Date },
  proExpiry:  { type: Date },
  createdAt:  { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);
const PickBetSchema = new mongoose.Schema({
  betType: { type: String },
  marketType: { type: String },
  marketKey: { type: String },
  selection: { type: String },
  selectionLabel: { type: String },
  side: { type: String },
  line: { type: Number },
  playerName: { type: String },
  statType: { type: String },
  eventId: { type: String },
  eventDate: { type: String },
  homeTeam: { type: String },
  awayTeam: { type: String },
  bookmaker: { type: String },
  source: { type: String, default: 'manual' },
  confidence: { type: Number, default: 0 },
  sportKey: { type: String },
  sport: { type: String }
}, { _id: false, strict: false });

const PickVerificationEvidenceSchema = new mongoose.Schema({
  provider: { type: String },
  type: { type: String },
  detail: { type: String },
  value: { type: mongoose.Schema.Types.Mixed },
  raw: { type: mongoose.Schema.Types.Mixed },
  at: { type: Date, default: Date.now }
}, { _id: false, strict: false });

const PickVerificationSchema = new mongoose.Schema({
  status: { type: String, default: 'not_started' },
  preliminaryResult: { type: String },
  confidence: { type: Number, default: 0 },
  needsReview: { type: Boolean, default: false },
  summary: { type: String },
  engineVersion: { type: String, default: 'v2-ocr-props-20260512' },
  lastAnalyzedAt: { type: Date },
  lastClosedAt: { type: Date },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ocr: {
    status: { type: String, default: 'not_attempted' },
    confidence: { type: Number, default: 0 },
    parsedAt: { type: Date },
    warnings: [{ type: String }],
    raw: { type: mongoose.Schema.Types.Mixed }
  },
  evidence: [PickVerificationEvidenceSchema],
  providerTrace: [{ type: mongoose.Schema.Types.Mixed }]
}, { _id: false, strict: false });

const PickSchema = new mongoose.Schema({
  tipster:    { type: String, required: true },
  tipsterId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  league:     { type: String },
  sportKey:   { type: String },
  sport:      { type: String },
  flag:       { type: String },
  homeLogo:   { type: String, default: '' },
  awayLogo:   { type: String, default: '' },
  match:      { type: String, required: true },
  time:       { type: String },
  odds:       { type: Number },
  bank:       { type: Number, default: 10 },
  price:      { type: Number, default: 0 },
  ticketImg:  { type: String },
  result:     { type: String, default: 'pending', enum: ['pending','won','lost','void'] },
  buyers:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  salesCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  bet:        { type: PickBetSchema, default: () => ({ source: 'manual' }) },
  verification: { type: PickVerificationSchema, default: () => ({}) },
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

const WeeklyTipsterPayoutSchema = new mongoose.Schema({
  tipsterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  weekStart: { type: Date, required: true },
  weekEnd: { type: Date, required: true },
  grossCents: { type: Number, default: 0 },
  payoutCents: { type: Number, default: 0 },
  platformFeeCents: { type: Number, default: 0 },
  salesCount: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'processing', 'paid', 'failed'], default: 'pending' },
  stripeTransferId: { type: String, default: '' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  errorMessage: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
WeeklyTipsterPayoutSchema.index({ tipsterId: 1, weekStart: 1, weekEnd: 1 }, { unique: true });
const WeeklyTipsterPayout = mongoose.model('WeeklyTipsterPayout', WeeklyTipsterPayoutSchema);

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
  const roiValue = totalProfitUnits;
  const yieldValue = totalRiskedUnits > 0 ? ((totalProfitUnits / totalRiskedUnits) * 100) : 0;
  const avgOdds = oddsCount > 0 ? Number((oddsAccumulator / oddsCount).toFixed(2)) : 0;

  return {
    roi: formatRoiPercent(Number(roiValue.toFixed(1))),
    yield: formatRoiPercent(Number(yieldValue.toFixed(1))),
    roiValue: Number(roiValue.toFixed(2)),
    yieldValue: Number(yieldValue.toFixed(2)),
    netUnits: Number(totalProfitUnits.toFixed(2)),
    totalRiskedUnits: Number(totalRiskedUnits.toFixed(2)),
    winRate,
    totalPicks: wonPicks + lostPicks + pushPicks,
    wonPicks,
    lostPicks,
    pushPicks,
    avgOdds
  };
};
const resolveConnectReturnUrls = (req) => {
  const bodyRefreshUrl = toSafeString(req.body?.refreshUrl);
  const bodyReturnUrl = toSafeString(req.body?.returnUrl);
  if (isValidHttpUrl(bodyRefreshUrl) && isValidHttpUrl(bodyReturnUrl)) {
    return {
      refreshUrl: bodyRefreshUrl,
      returnUrl: bodyReturnUrl
    };
  }
  const frontendBaseUrl = buildFrontendBaseUrl();
  if (isValidHttpUrl(frontendBaseUrl)) {
    const normalizedBase = frontendBaseUrl.replace(/\/+$/, '');
    return {
      refreshUrl: `${normalizedBase}/?stripe=connect-refresh`,
      returnUrl: `${normalizedBase}/?stripe=connect-return`
    };
  }
  return null;
};

const recalculateTipsterStats = async (tipsterId) => {
  const normalizedTipsterId = String(tipsterId || '').trim();
  if (!normalizedTipsterId || !mongoose.Types.ObjectId.isValid(normalizedTipsterId)) return null;
  const resolvedPicks = await Pick.find({
    tipsterId: normalizedTipsterId,
    result: { $in: ['won', 'lost', 'void'] }
  }).select('result bank odds');
  const stats = calculateTipsterStatsFromPicks(resolvedPicks);
  await User.findByIdAndUpdate(normalizedTipsterId, stats);
  return stats;
};
const safeRecalculateTipsterStats = async (tipsterId, sourceLabel = 'unknown') => {
  try {
    return await recalculateTipsterStats(tipsterId);
  } catch (error) {
    console.error(`[tipster-stats] ${sourceLabel}:`, error.message || error);
    return null;
  }
};

const normalizeManualResultValue = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'voyd') return 'void';
  if (normalized === 'push') return 'void';
  return normalized;
};

const findPickByIdentifier = async (pickIdentifier) => {
  const normalized = String(pickIdentifier || '').trim();
  if (!normalized) return null;
  if (mongoose.Types.ObjectId.isValid(normalized)) {
    const byObjectId = await Pick.findById(normalized);
    if (byObjectId) return byObjectId;
  }
  return await Pick.findOne({ id: normalized });
};
const AUTO_CLOSE_THRESHOLD_CONFIG = resolveAutoCloseThresholdConfig(process.env);
const AUTO_CLOSE_MIN_EXTRACTION_QUALITY = Number.isFinite(Number(process.env.AUTO_CLOSE_MIN_EXTRACTION_QUALITY))
  ? Math.max(0, Math.min(100, Number(process.env.AUTO_CLOSE_MIN_EXTRACTION_QUALITY)))
  : 55;
const AUTO_CLOSE_MIN_EVENT_MATCH_QUALITY = Number.isFinite(Number(process.env.AUTO_CLOSE_MIN_EVENT_MATCH_QUALITY))
  ? Math.max(0, Math.min(100, Number(process.env.AUTO_CLOSE_MIN_EVENT_MATCH_QUALITY)))
  : 60;
const AUTO_CLOSE_MIN_OFFICIAL_DATA_QUALITY = Number.isFinite(Number(process.env.AUTO_CLOSE_MIN_OFFICIAL_DATA_QUALITY))
  ? Math.max(0, Math.min(100, Number(process.env.AUTO_CLOSE_MIN_OFFICIAL_DATA_QUALITY)))
  : 70;

const DEFAULT_PENDING_STALE_HOURS = Number.isFinite(Number(process.env.PICK_PENDING_STALE_HOURS))
  ? Math.max(1, Math.min(720, Number(process.env.PICK_PENDING_STALE_HOURS)))
  : 12;
const DEFAULT_REVIEW_STALE_HOURS = Number.isFinite(Number(process.env.PICK_REVIEW_STALE_HOURS))
  ? Math.max(1, Math.min(720, Number(process.env.PICK_REVIEW_STALE_HOURS)))
  : 6;
const DEFAULT_ALERT_LOOKBACK_HOURS = Number.isFinite(Number(process.env.PICK_ALERT_LOOKBACK_HOURS))
  ? Math.max(1, Math.min(720, Number(process.env.PICK_ALERT_LOOKBACK_HOURS)))
  : 24;

function parseHoursSetting(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(720, parsed));
}

function parseListLimit(value, fallback = 120, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function dateHoursAgo(hours) {
  return new Date(Date.now() - (Number(hours) * 60 * 60 * 1000));
}

function toDateOrNull(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function computeAgeHours(dateLike) {
  const parsed = toDateOrNull(dateLike);
  if (!parsed) return 0;
  const delta = Date.now() - parsed.getTime();
  return Number((Math.max(0, delta) / (1000 * 60 * 60)).toFixed(1));
}

function resolveVerificationTimestamp(pick) {
  return pick?.verification?.lastAnalyzedAt || pick?.createdAt || null;
}

function buildManualVerificationPatch(pickDoc, result, adminUserId) {
  const currentVerification = pickDoc?.verification && typeof pickDoc.verification === 'object' ? pickDoc.verification : {};
  if (result === 'pending') {
    return {
      ...currentVerification,
      status: pickDoc?.aiAnalysis?.needsReview ? 'needs_review' : 'preliminary_ready',
      preliminaryResult: pickDoc?.aiAnalysis?.resultado || currentVerification.preliminaryResult || 'PENDIENTE',
      confidence: pickDoc?.aiAnalysis?.confianza ?? currentVerification.confidence ?? 0,
      summary: pickDoc?.aiAnalysis?.detalle || currentVerification.summary || 'Pick reabierto por inconformidad',
      needsReview: Boolean(pickDoc?.aiAnalysis?.needsReview),
      closedBy: null,
      lastClosedAt: null
    };
  }
  return {
    ...currentVerification,
    status: 'closed_by_admin',
    needsReview: false,
    summary: `Cierre final admin: ${String(result).toUpperCase()}`,
    closedBy: adminUserId || null,
    lastClosedAt: new Date()
  };
}

async function setOfficialResultForPick(pickId, result, adminUserId) {
  const pick = await findPickByIdentifier(pickId);
  if (!pick) return null;
  const verificationPatch = buildManualVerificationPatch(pick, result, adminUserId);
  pick.result = result;
  pick.verification = verificationPatch;
  const updatedPick = await pick.save();
  let tipsterStats = null;
  if (pick.tipsterId) {
    tipsterStats = await safeRecalculateTipsterStats(pick.tipsterId, `setOfficialResultForPick:${pickId}`);
  }
  return { pick, updatedPick, tipsterStats };
}

function buildNeedsReviewStaleQuery(reviewCutoff) {
  return {
    result: 'pending',
    'verification.status': 'needs_review',
    $or: [
      { 'verification.lastAnalyzedAt': { $lt: reviewCutoff } },
      { 'verification.lastAnalyzedAt': { $exists: false }, createdAt: { $lt: reviewCutoff } }
    ]
  };
}

function buildPreliminaryReadyStaleQuery(pendingCutoff) {
  return {
    result: 'pending',
    'verification.status': 'preliminary_ready',
    $or: [
      { 'verification.lastAnalyzedAt': { $lt: pendingCutoff } },
      { 'verification.lastAnalyzedAt': { $exists: false }, createdAt: { $lt: pendingCutoff } }
    ]
  };
}

function resolveStaleReason(pick, pendingCutoff, reviewCutoff) {
  const status = String(pick?.verification?.status || '').toLowerCase();
  const verificationAt = resolveVerificationTimestamp(pick);
  const verificationTime = toDateOrNull(verificationAt);
  const createdAt = toDateOrNull(pick?.createdAt);
  if (
    status === 'needs_review' &&
    ((verificationTime && verificationTime < reviewCutoff) || (!verificationTime && createdAt && createdAt < reviewCutoff))
  ) {
    return 'needs_review_stale';
  }
  if (
    status === 'preliminary_ready' &&
    ((verificationTime && verificationTime < pendingCutoff) || (!verificationTime && createdAt && createdAt < pendingCutoff))
  ) {
    return 'preliminary_ready_stale';
  }
  return 'pending_stale';
}

async function buildVerificationMonitorSnapshot(options = {}) {
  const pendingStaleHours = parseHoursSetting(options.pendingStaleHours, DEFAULT_PENDING_STALE_HOURS);
  const reviewStaleHours = parseHoursSetting(options.reviewStaleHours, DEFAULT_REVIEW_STALE_HOURS);
  const lookbackHours = parseHoursSetting(options.lookbackHours, DEFAULT_ALERT_LOOKBACK_HOURS);
  const limit = parseListLimit(options.limit, 120, 500);
  const pendingCutoff = dateHoursAgo(pendingStaleHours);
  const reviewCutoff = dateHoursAgo(reviewStaleHours);
  const autoClosedCutoff = dateHoursAgo(lookbackHours);

  const staleQuery = {
    result: 'pending',
    $or: [
      { createdAt: { $lt: pendingCutoff } },
      buildNeedsReviewStaleQuery(reviewCutoff),
      buildPreliminaryReadyStaleQuery(pendingCutoff)
    ]
  };

  const [staleDocs, pendingTotal, pendingStale, needsReviewTotal, needsReviewStale, preliminaryReadyTotal, preliminaryReadyStale, autoClosedRecent, statusCounts] = await Promise.all([
    Pick.find(staleQuery)
      .sort({ createdAt: 1 })
      .limit(limit)
      .select('_id match tipster league sport result createdAt verification.status verification.lastAnalyzedAt verification.confidence'),
    Pick.countDocuments({ result: 'pending' }),
    Pick.countDocuments({ result: 'pending', createdAt: { $lt: pendingCutoff } }),
    Pick.countDocuments({ result: 'pending', 'verification.status': 'needs_review' }),
    Pick.countDocuments(buildNeedsReviewStaleQuery(reviewCutoff)),
    Pick.countDocuments({ result: 'pending', 'verification.status': 'preliminary_ready' }),
    Pick.countDocuments(buildPreliminaryReadyStaleQuery(pendingCutoff)),
    Pick.countDocuments({ 'verification.status': 'closed_auto', 'verification.lastClosedAt': { $gte: autoClosedCutoff } }),
    Pick.aggregate([
      { $match: { result: 'pending' } },
      { $group: { _id: '$verification.status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ])
  ]);

  const stalePicks = staleDocs.map((pick) => ({
    pickId: String(pick._id),
    match: toSafeString(pick.match),
    tipster: toSafeString(pick.tipster),
    league: toSafeString(pick.league),
    sport: toSafeString(pick.sport),
    result: toSafeString(pick.result) || 'pending',
    status: toSafeString(pick?.verification?.status) || 'pending',
    confidence: Number(pick?.verification?.confidence ?? 0),
    createdAt: pick?.createdAt || null,
    lastAnalyzedAt: pick?.verification?.lastAnalyzedAt || null,
    ageHours: computeAgeHours(resolveVerificationTimestamp(pick) || pick?.createdAt),
    staleReason: resolveStaleReason(pick, pendingCutoff, reviewCutoff)
  }));

  return {
    generatedAt: new Date(),
    thresholds: {
      pendingStaleHours,
      reviewStaleHours,
      lookbackHours
    },
    totals: {
      pendingTotal,
      pendingStale,
      needsReviewTotal,
      needsReviewStale,
      preliminaryReadyTotal,
      preliminaryReadyStale,
      autoClosedRecent
    },
    statusCounts: statusCounts.map((entry) => ({
      status: toSafeString(entry?._id) || 'pending',
      count: Number(entry?.count || 0)
    })),
    stalePicks
  };
}

async function buildVerificationAlerts(options = {}) {
  const monitor = options.monitor || await buildVerificationMonitorSnapshot(options);
  const lookbackHours = monitor?.thresholds?.lookbackHours || DEFAULT_ALERT_LOOKBACK_HOURS;
  const autoClosedCutoff = dateHoursAgo(lookbackHours);
  const recentAutoClosed = await Pick.find({
    'verification.status': 'closed_auto',
    'verification.lastClosedAt': { $gte: autoClosedCutoff }
  })
    .sort({ 'verification.lastClosedAt': -1 })
    .limit(parseListLimit(options.autoClosedLimit, 8, 25))
    .select('_id match tipster league result verification.lastClosedAt verification.confidence');

  const alerts = [];
  if (monitor?.totals?.pendingStale > 0) {
    alerts.push({
      id: 'pending-stale',
      severity: 'high',
      title: 'Picks pendientes atascados',
      message: `${monitor.totals.pendingStale} picks llevan más de ${monitor.thresholds.pendingStaleHours}h en pending.`,
      metric: monitor.totals.pendingStale,
      at: new Date().toISOString()
    });
  }
  if (monitor?.totals?.needsReviewStale > 0) {
    alerts.push({
      id: 'needs-review-stale',
      severity: 'medium',
      title: 'Revisión admin retrasada',
      message: `${monitor.totals.needsReviewStale} picks en needs_review superan ${monitor.thresholds.reviewStaleHours}h.`,
      metric: monitor.totals.needsReviewStale,
      at: new Date().toISOString()
    });
  }
  if (monitor?.totals?.preliminaryReadyStale > 0) {
    alerts.push({
      id: 'preliminary-ready-stale',
      severity: 'medium',
      title: 'Dictámenes listos sin cierre',
      message: `${monitor.totals.preliminaryReadyStale} picks con preliminary_ready siguen sin cierre oficial.`,
      metric: monitor.totals.preliminaryReadyStale,
      at: new Date().toISOString()
    });
  }
  if (monitor?.totals?.autoClosedRecent > 0) {
    alerts.push({
      id: 'auto-closed-recent',
      severity: 'info',
      title: 'Cierres automáticos recientes',
      message: `${monitor.totals.autoClosedRecent} picks se cerraron automáticamente en las últimas ${monitor.thresholds.lookbackHours}h.`,
      metric: monitor.totals.autoClosedRecent,
      at: new Date().toISOString()
    });
  }

  const autoClosedEvents = recentAutoClosed.map((pick, index) => ({
    id: `auto-closed-event-${index}-${pick._id}`,
    severity: 'info',
    title: 'Pick cerrado automáticamente',
    message: `${toSafeString(pick.match)} · ${toSafeString(pick.tipster)} (${String(pick.result || 'pending').toUpperCase()})`,
    metric: Number(pick?.verification?.confidence ?? 0),
    at: pick?.verification?.lastClosedAt || new Date().toISOString(),
    pickId: String(pick._id)
  }));

  const staleEvents = (monitor?.stalePicks || []).slice(0, 8).map((pick, index) => ({
    id: `stale-pick-${index}-${pick.pickId}`,
    severity: pick.staleReason === 'needs_review_stale' ? 'high' : 'medium',
    title: 'Pick requiere atención',
    message: `${pick.match} · ${pick.tipster} · ${pick.staleReason.replace(/_/g, ' ')}`,
    metric: pick.ageHours,
    at: new Date().toISOString(),
    pickId: pick.pickId
  }));

  return {
    generatedAt: new Date(),
    totals: monitor?.totals || {},
    alerts: [...alerts, ...autoClosedEvents, ...staleEvents].slice(0, 30)
  };
}

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

const normalizeTextField = (value, maxLength) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.slice(0, maxLength);
};

const sanitizeUsername = (value) => {
  if (typeof value !== 'string') return undefined;
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
};

const buildDefaultUsername = (name, email) => {
  const fromName = sanitizeUsername(name || '');
  if (fromName) return fromName;
  const fromEmail = sanitizeUsername(String(email || '').split('@')[0] || '');
  if (fromEmail) return fromEmail;
  return `tpz${Date.now().toString(36)}`;
};

const resolveAvailableUsername = async (desiredUsername, excludeUserId = null) => {
  const base = sanitizeUsername(desiredUsername || '');
  if (!base) return null;

  const queryBase = excludeUserId ? { _id: { $ne: excludeUserId } } : {};
  let candidate = base;
  let suffix = 1;

  while (suffix <= 500) {
    const exists = await User.findOne({ ...queryBase, username: candidate }).select('_id');
    if (!exists) return candidate;
    const suffixText = String(suffix);
    const maxBaseLength = Math.max(1, 24 - suffixText.length - 1);
    candidate = `${base.slice(0, maxBaseLength)}-${suffixText}`;
    suffix += 1;
  }

  return `${base.slice(0, 16)}-${Date.now().toString(36).slice(-7)}`.slice(0, 24);
};

const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const FULL_NAME_REGEX = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:[ '-][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)+$/;

const isValidFunctionalEmail = (email) => {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || normalized.length > 120) return false;
  return EMAIL_FORMAT_REGEX.test(normalized);
};

const isValidFullName = (name) => {
  const normalized = normalizeTextField(name, 80);
  if (!normalized) return false;
  if (normalized.length < 5) return false;
  return FULL_NAME_REGEX.test(normalized);
};

const buildEmailVerificationPayload = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000));
  return { rawToken, tokenHash, expiresAt };
};
const buildPasswordResetPayload = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + (60 * 60 * 1000));
  return { rawToken, tokenHash, expiresAt };
};
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{10,}$/;
const isStrongPassword = (passwordValue) => STRONG_PASSWORD_REGEX.test(String(passwordValue || ''));
const STRONG_PASSWORD_ERROR = 'La contraseña debe tener mínimo 10 caracteres e incluir mayúscula, minúscula, número y símbolo';

const buildFrontendBaseUrl = () => {
  const value = String(process.env.FRONTEND_BASE_URL || process.env.FRONTEND_URL || process.env.APP_BASE_URL || '').trim();
  return value.replace(/\/+$/, '');
};
const RESEND_KEY_ENV_VARS = ['RESEND_API_KEY', 'RESEND_API_TOKEN', 'RESEND_KEY'];
const RESEND_FROM_ENV_VARS = ['EMAIL_FROM', 'RESEND_FROM', 'RESEND_FROM_EMAIL', 'RESEND_SENDER'];
const DEFAULT_RESEND_FROM = 'The Pick Zone <noreply@tpz.mx>';
const extractSenderEmail = (senderValue) => {
  const sender = String(senderValue || '').trim();
  if (!sender) return '';
  const bracketMatch = sender.match(/<([^>]+)>/);
  if (bracketMatch && bracketMatch[1]) return String(bracketMatch[1]).trim().toLowerCase();
  return sender.toLowerCase();
};
const isLikelyValidSender = (senderValue) => {
  const email = extractSenderEmail(senderValue);
  if (!email) return false;
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/i.test(email);
};
const resolveResendApiKeyWithSource = () => {
  const candidates = [
    { name: 'RESEND_API_KEY', value: process.env.RESEND_API_KEY },
    { name: 'RESEND_API_TOKEN', value: process.env.RESEND_API_TOKEN },
    { name: 'RESEND_KEY', value: process.env.RESEND_KEY }
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate?.value || '').trim();
    if (normalized) return { value: normalized, source: candidate.name };
  }
  return { value: '', source: '' };
};
const resolveResendApiKey = () => {
  return resolveResendApiKeyWithSource().value;
};
const resolveResendFromEmailWithSource = () => {
  const candidates = [
    { name: 'EMAIL_FROM', value: process.env.EMAIL_FROM },
    { name: 'RESEND_FROM', value: process.env.RESEND_FROM },
    { name: 'RESEND_FROM_EMAIL', value: process.env.RESEND_FROM_EMAIL },
    { name: 'RESEND_SENDER', value: process.env.RESEND_SENDER }
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate?.value || '').trim();
    if (normalized) return { value: normalized, source: candidate.name, isDefault: false };
  }
  return { value: DEFAULT_RESEND_FROM, source: 'default', isDefault: true };
};
const resolveResendFromEmail = () => {
  return resolveResendFromEmailWithSource().value;
};
const buildEmailProviderDiagnostics = () => {
  const keyConfig = resolveResendApiKeyWithSource();
  const fromConfig = resolveResendFromEmailWithSource();
  return {
    hasResendApiKey: Boolean(keyConfig.value),
    resendApiKeySource: keyConfig.source || null,
    fromAddress: fromConfig.value,
    fromSource: fromConfig.source,
    usingDefaultFrom: Boolean(fromConfig.isDefault),
    fromLooksValid: isLikelyValidSender(fromConfig.value)
  };
};
const logEmailProviderStartupDiagnostics = () => {
  const diagnostics = buildEmailProviderDiagnostics();
  if (!diagnostics.hasResendApiKey) {
    console.warn(`[Auth/EmailConfig] Missing Resend API key. Define one of: ${RESEND_KEY_ENV_VARS.join(', ')}`);
  } else {
    console.log(`[Auth/EmailConfig] Resend API key loaded from ${diagnostics.resendApiKeySource}`);
  }
  if (diagnostics.usingDefaultFrom) {
    console.warn(`[Auth/EmailConfig] Using default sender "${diagnostics.fromAddress}". Configure one of: ${RESEND_FROM_ENV_VARS.join(', ')}`);
  }
  if (!diagnostics.fromLooksValid) {
    console.warn(`[Auth/EmailConfig] Sender format may be invalid: "${diagnostics.fromAddress}"`);
  }
};
const resolveEmailVerificationRequired = () => {
  const explicit = String(process.env.AUTH_REQUIRE_EMAIL_VERIFICATION || '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return Boolean(resolveResendApiKey());
};
logEmailProviderStartupDiagnostics();

const sendVerificationWelcomeEmail = async ({ toEmail, fullName, verificationLink }) => {
  const resendConfig = resolveResendApiKeyWithSource();
  const fromConfig = resolveResendFromEmailWithSource();
  const resendKey = resendConfig.value;
  const fromEmail = fromConfig.value;
  const subject = 'Bienvenido a The Pick Zone · Verifica tu correo';
  const html = `
    <div style="font-family:Arial,sans-serif;color:#101114;line-height:1.6;">
      <h2 style="margin-bottom:8px;">¡Bienvenido a The Pick Zone! 👋</h2>
      <p>Hola ${String(fullName || 'Tipster').replace(/[<>]/g, '')},</p>
      <p>Gracias por registrarte. Para activar tu cuenta y mantener la comunidad protegida contra usuarios falsos, confirma tu correo electrónico en el siguiente botón:</p>
      <p style="margin:22px 0;">
        <a href="${verificationLink}" style="background:#1DB954;color:#000;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:6px;display:inline-block;">
          Activar mi cuenta
        </a>
      </p>
      <p>Si no solicitaste este registro, puedes ignorar este mensaje.</p>
      <p style="font-size:12px;color:#5e6770;">Este enlace vence en 24 horas.</p>
    </div>
  `;
  const text = `¡Bienvenido a The Pick Zone!\n\nHola ${fullName || 'Tipster'},\nGracias por registrarte. Para activar tu cuenta y validar tu correo, usa este enlace:\n${verificationLink}\n\nSi no solicitaste este registro, ignora este mensaje.\n\nEste enlace vence en 24 horas.`;

  if (!resendKey) {
    console.warn(`[Auth] Resend API key no configurada (usa ${RESEND_KEY_ENV_VARS.join(', ')}). Correo de verificación pendiente para ${toEmail}.`);
    return {
      sent: false,
      reason: 'missing_resend_api_key',
      acceptedKeyEnvVars: RESEND_KEY_ENV_VARS,
      acceptedFromEnvVars: RESEND_FROM_ENV_VARS
    };
  }

  await axios.post(
    'https://api.resend.com/emails',
    {
      from: fromEmail,
      to: [toEmail],
      subject,
      html,
      text
    },
    {
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  return { sent: true };
};
const sendPasswordResetEmail = async ({ toEmail, fullName, resetLink }) => {
  const resendConfig = resolveResendApiKeyWithSource();
  const fromConfig = resolveResendFromEmailWithSource();
  const resendKey = resendConfig.value;
  const fromEmail = fromConfig.value;
  const subject = 'The Pick Zone · Restablecer contraseña';
  const html = `
    <div style="font-family:Arial,sans-serif;color:#101114;line-height:1.6;">
      <h2 style="margin-bottom:8px;">Restablecer contraseña</h2>
      <p>Hola ${String(fullName || 'Tipster').replace(/[<>]/g, '')},</p>
      <p>Recibimos una solicitud para restablecer tu contraseña. Puedes continuar desde el siguiente botón:</p>
      <p style="margin:22px 0;">
        <a href="${resetLink}" style="background:#1DB954;color:#000;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:6px;display:inline-block;">
          Restablecer contraseña
        </a>
      </p>
      <p>Si no solicitaste este cambio, ignora este correo.</p>
      <p style="font-size:12px;color:#5e6770;">Este enlace vence en 1 hora.</p>
    </div>
  `;
  const text = `Restablecer contraseña\n\nHola ${fullName || 'Tipster'},\nRecibimos una solicitud para restablecer tu contraseña. Usa este enlace:\n${resetLink}\n\nSi no solicitaste este cambio, ignora este correo.\n\nEste enlace vence en 1 hora.`;

  if (!resendKey) {
    console.warn(`[Auth] Resend API key no configurada (usa ${RESEND_KEY_ENV_VARS.join(', ')}). Correo de reset pendiente para ${toEmail}.`);
    return {
      sent: false,
      reason: 'missing_resend_api_key',
      acceptedKeyEnvVars: RESEND_KEY_ENV_VARS,
      acceptedFromEnvVars: RESEND_FROM_ENV_VARS
    };
  }

  await axios.post(
    'https://api.resend.com/emails',
    {
      from: fromEmail,
      to: [toEmail],
      subject,
      html,
      text
    },
    {
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  return { sent: true };
};

const CLABE_WEIGHTS = [3, 7, 1];

const normalizeDigits = (value) => String(value || '').replace(/\D+/g, '');

const isValidClabe = (clabeValue) => {
  const clabe = normalizeDigits(clabeValue);
  if (!/^\d{18}$/.test(clabe)) return false;
  const expectedDigit = clabe
    .slice(0, 17)
    .split('')
    .reduce((acc, digit, index) => acc + ((Number(digit) * CLABE_WEIGHTS[index % 3]) % 10), 0);
  const checkDigit = (10 - (expectedDigit % 10)) % 10;
  return checkDigit === Number(clabe[17]);
};

const maskClabe = (clabeValue) => {
  const digits = normalizeDigits(clabeValue);
  if (digits.length < 4) return '';
  return `**************${digits.slice(-4)}`;
};

const centsToAmount = (centsValue) => {
  const cents = Number(centsValue);
  if (!Number.isFinite(cents)) return 0;
  return Number((cents / 100).toFixed(2));
};

const resolveWeekRange = (weekOffset = 0) => {
  const now = new Date();
  const normalizedOffset = Number.isFinite(Number(weekOffset)) ? Math.max(-52, Math.min(52, Number(weekOffset))) : 0;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const currentDay = weekStart.getUTCDay();
  const deltaToMonday = currentDay === 0 ? -6 : 1 - currentDay;
  weekStart.setUTCDate(weekStart.getUTCDate() + deltaToMonday + (normalizedOffset * 7));
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  return { weekStart, weekEnd };
};

async function ensureTipsterStripeAccount(userDoc) {
  const existingAccountId = toSafeString(userDoc?.stripeConnectedAccountId);
  if (existingAccountId) return existingAccountId;
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'MX',
    email: userDoc?.email || undefined,
    business_type: 'individual',
    capabilities: { transfers: { requested: true } },
    metadata: { tpzUserId: String(userDoc?._id || '') }
  });
  return toSafeString(account?.id);
}
const resolveConnectAccountPayoutStatus = (accountSnapshot) => {
  const transfersActive = accountSnapshot?.capabilities?.transfers === 'active';
  const payoutsEnabled = Boolean(accountSnapshot?.payouts_enabled);
  const pendingRequirementsCount = Array.isArray(accountSnapshot?.requirements?.currently_due)
    ? accountSnapshot.requirements.currently_due.length
    : 0;
  const payoutReady = Boolean(transfersActive && payoutsEnabled && pendingRequirementsCount === 0);
  return {
    payoutReady,
    payoutStatus: payoutReady ? 'configured' : 'pending_verification',
    requirementsDue: pendingRequirementsCount
  };
};

async function hydrateUserStripePayoutState(userDoc, options = {}) {
  const persist = options?.persist !== false;
  const userId = userDoc?._id;
  const stripeConnectedAccountId = toSafeString(userDoc?.stripeConnectedAccountId);
  if (!userId || !stripeConnectedAccountId) return userDoc;

  const accountSnapshot = await stripe.accounts.retrieve(stripeConnectedAccountId);
  const externalAccounts = Array.isArray(accountSnapshot?.external_accounts?.data)
    ? accountSnapshot.external_accounts.data
    : [];
  const externalBankAccount = externalAccounts.find((entry) => String(entry?.object || '').toLowerCase() === 'bank_account') || null;
  const stripeExternalAccountId = toSafeString(userDoc?.stripeExternalAccountId) || toSafeString(externalBankAccount?.id);
  const bankClabeLast4 = toSafeString(userDoc?.bankClabeLast4) || (toSafeString(userDoc?.bankClabeMasked).match(/(\d{4})$/)?.[1] || '') || toSafeString(externalBankAccount?.last4);
  const bankClabeMasked = toSafeString(userDoc?.bankClabeMasked) || (bankClabeLast4 ? `**************${bankClabeLast4}` : '');
  const payoutState = resolveConnectAccountPayoutStatus(accountSnapshot);
  const payoutReady = Boolean(payoutState.payoutReady && stripeExternalAccountId && bankClabeLast4);
  const payoutStatus = payoutReady
    ? 'configured'
    : payoutState.requirementsDue > 0
      ? 'pending_verification'
      : 'onboarding_required';

  const hydrated = {
    ...(userDoc?.toObject ? userDoc.toObject() : userDoc),
    stripeConnectedAccountId,
    stripeExternalAccountId,
    bankClabeMasked,
    bankClabeLast4,
    stripePayoutReady: payoutReady,
    stripePayoutStatus: payoutStatus
  };

  if (persist) {
    await User.findByIdAndUpdate(userId, {
      stripeConnectedAccountId,
      stripeExternalAccountId,
      bankClabeMasked,
      bankClabeLast4,
      stripePayoutReady: payoutReady,
      stripePayoutStatus: payoutStatus
    });
  }

  return hydrated;
}

async function configureTipsterBankDestination(userDoc, { clabe, accountHolder, bankName }) {
  const clabeDigits = normalizeDigits(clabe);
  if (!isValidClabe(clabeDigits)) throw new Error('CLABE inválida');
  const stripeAccountId = await ensureTipsterStripeAccount(userDoc);
  const holder = toSafeString(accountHolder || userDoc?.name || 'Tipster');
  const token = await stripe.tokens.create({
    bank_account: {
      country: 'MX',
      currency: 'mxn',
      account_holder_name: holder,
      account_holder_type: 'individual',
      account_number: clabeDigits
    }
  });

  const currentExternalId = toSafeString(userDoc?.stripeExternalAccountId);
  if (currentExternalId) {
    try {
      await stripe.accounts.deleteExternalAccount(stripeAccountId, currentExternalId);
    } catch {}
  }

  const externalAccount = await stripe.accounts.createExternalAccount(stripeAccountId, {
    external_account: token.id,
    default_for_currency: true
  });
  const accountSnapshot = await stripe.accounts.retrieve(stripeAccountId);
  const payoutState = resolveConnectAccountPayoutStatus(accountSnapshot);
  return {
    bankClabeMasked: maskClabe(clabeDigits),
    bankClabeLast4: clabeDigits.slice(-4),
    bankAccountHolder: holder,
    bankName: toSafeString(bankName),
    stripeConnectedAccountId: stripeAccountId,
    stripeExternalAccountId: toSafeString(externalAccount?.id),
    stripePayoutReady: payoutState.payoutReady,
    stripePayoutStatus: payoutState.payoutStatus
  };
}
function isStripeConnectUnavailableError(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  const rawCode = String(error?.raw?.code || '').toLowerCase();
  return (
    message.includes('signed up for connect') ||
    (message.includes('connect') && (message.includes('not enabled') || message.includes('not available'))) ||
    code === 'feature_not_enabled' ||
    rawCode === 'feature_not_enabled'
  );
}

function formatWeeklyPayoutEntry(recordDoc, tipsterDoc) {
  const stripeConnectedAccountId = toSafeString(tipsterDoc?.stripeConnectedAccountId);
  const stripeExternalAccountId = toSafeString(tipsterDoc?.stripeExternalAccountId);
  const bankClabeMasked = toSafeString(tipsterDoc?.bankClabeMasked);
  const bankClabeLast4 = toSafeString(tipsterDoc?.bankClabeLast4) || (bankClabeMasked.match(/(\d{4})$/)?.[1] || '');
  const payoutActionReady = Boolean(
    stripeConnectedAccountId &&
    stripeExternalAccountId &&
    bankClabeMasked &&
    bankClabeLast4
  );
  return {
    _id: String(recordDoc?._id || ''),
    tipsterId: String(recordDoc?.tipsterId || tipsterDoc?._id || ''),
    tipsterName: toSafeString(tipsterDoc?.name),
    tipsterEmail: toSafeString(tipsterDoc?.email),
    bankClabeMasked,
    bankClabeLast4,
    bankAccountHolder: toSafeString(tipsterDoc?.bankAccountHolder),
    bankName: toSafeString(tipsterDoc?.bankName),
    stripeConnectedAccountId,
    stripeExternalAccountId,
    stripePayoutReady: Boolean(tipsterDoc?.stripePayoutReady),
    payoutActionReady,
    status: toSafeString(recordDoc?.status) || 'pending',
    salesCount: Number(recordDoc?.salesCount || 0),
    grossAmount: centsToAmount(recordDoc?.grossCents || 0),
    payoutAmount: centsToAmount(recordDoc?.payoutCents || 0),
    platformFeeAmount: centsToAmount(recordDoc?.platformFeeCents || 0),
    stripeTransferId: toSafeString(recordDoc?.stripeTransferId),
    approvedAt: recordDoc?.approvedAt || null,
    errorMessage: toSafeString(recordDoc?.errorMessage),
    weekStart: recordDoc?.weekStart || null,
    weekEnd: recordDoc?.weekEnd || null
  };
}

async function buildWeeklyPayoutSummary(weekOffset = 0) {
  const { weekStart, weekEnd } = resolveWeekRange(weekOffset);
  const proUsers = await User.find({ role: { $in: ['pro', 'tipster'] } }).select('name email bankClabeMasked bankClabeLast4 bankAccountHolder bankName stripeConnectedAccountId stripeExternalAccountId stripePayoutReady stripePayoutStatus');
  const purchases = await Purchase.find({ createdAt: { $gte: weekStart, $lt: weekEnd } }).select('pickId amountCents currency createdAt');
  const pickIds = Array.from(new Set(purchases.map((item) => String(item.pickId || '')).filter(Boolean)));
  const picks = pickIds.length > 0
    ? await Pick.find({ _id: { $in: pickIds } }).select('_id tipsterId price')
    : [];
  const pickById = new Map(picks.map((pickDoc) => [String(pickDoc._id), pickDoc]));
  const totalsByTipster = new Map();

  purchases.forEach((purchaseDoc) => {
    const currency = toSafeString(purchaseDoc?.currency || 'usd').toLowerCase();
    if (currency !== 'usd') return;
    const pickDoc = pickById.get(String(purchaseDoc?.pickId || ''));
    const tipsterId = String(pickDoc?.tipsterId || '');
    if (!tipsterId) return;
    const amountCents = Number(purchaseDoc?.amountCents) > 0
      ? Number(purchaseDoc.amountCents)
      : normalizeUsdCents(pickDoc?.price || 0);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return;
    const current = totalsByTipster.get(tipsterId) || { grossCents: 0, salesCount: 0 };
    current.grossCents += amountCents;
    current.salesCount += 1;
    totalsByTipster.set(tipsterId, current);
  });

  const existingPayouts = await WeeklyTipsterPayout.find({ weekStart, weekEnd });
  const payoutByTipster = new Map(existingPayouts.map((record) => [String(record.tipsterId), record]));
  const formattedPayouts = [];

  for (const tipster of proUsers) {
    const tipsterId = String(tipster._id);
    const totals = totalsByTipster.get(tipsterId) || { grossCents: 0, salesCount: 0 };
    const hasExisting = payoutByTipster.has(tipsterId);
    if (totals.grossCents <= 0 && !hasExisting) continue;

    const payoutCents = Math.round(totals.grossCents * 0.9);
    const platformFeeCents = Math.max(0, totals.grossCents - payoutCents);
    let payoutDoc = payoutByTipster.get(tipsterId) || null;

    if (!payoutDoc && totals.grossCents > 0) {
      payoutDoc = await WeeklyTipsterPayout.create({
        tipsterId: tipster._id,
        weekStart,
        weekEnd,
        grossCents: totals.grossCents,
        payoutCents,
        platformFeeCents,
        salesCount: totals.salesCount,
        status: 'pending',
        updatedAt: new Date()
      });
    } else if (payoutDoc && !['paid', 'processing'].includes(payoutDoc.status)) {
      payoutDoc = await WeeklyTipsterPayout.findByIdAndUpdate(
        payoutDoc._id,
        {
          grossCents: totals.grossCents,
          payoutCents,
          platformFeeCents,
          salesCount: totals.salesCount,
          updatedAt: new Date()
        },
        { new: true }
      );
    }

    let tipsterSnapshot = tipster;
    if (
      toSafeString(tipster?.stripeConnectedAccountId) &&
      (
        !tipster?.stripePayoutReady ||
        !toSafeString(tipster?.stripeExternalAccountId) ||
        !toSafeString(tipster?.bankClabeLast4)
      )
    ) {
      try {
        tipsterSnapshot = await hydrateUserStripePayoutState(tipster, { persist: true });
      } catch {}
    }

    if (payoutDoc) formattedPayouts.push(formatWeeklyPayoutEntry(payoutDoc, tipsterSnapshot));
  }

  const totals = formattedPayouts.reduce((acc, row) => {
    acc.grossAmount += row.grossAmount;
    acc.payoutAmount += row.payoutAmount;
    acc.platformFeeAmount += row.platformFeeAmount;
    acc.salesCount += row.salesCount;
    return acc;
  }, { grossAmount: 0, payoutAmount: 0, platformFeeAmount: 0, salesCount: 0 });

  return {
    week: {
      start: weekStart,
      end: weekEnd,
      label: `${weekStart.toLocaleDateString('es-MX')} - ${new Date(weekEnd.getTime() - 1).toLocaleDateString('es-MX')}`
    },
    totals: {
      ...totals,
      tipsters: formattedPayouts.length
    },
    payouts: formattedPayouts
  };
}
const DEFAULT_WEEKLY_PAYOUT_MIN_CENTS = Number.isFinite(Number(process.env.WEEKLY_PAYOUT_MIN_CENTS))
  ? Math.max(0, Math.floor(Number(process.env.WEEKLY_PAYOUT_MIN_CENTS)))
  : 2000;
const DEFAULT_WEEKLY_PAYOUT_RUN_LIMIT = Number.isFinite(Number(process.env.WEEKLY_PAYOUT_RUN_LIMIT))
  ? Math.max(1, Math.min(500, Math.floor(Number(process.env.WEEKLY_PAYOUT_RUN_LIMIT))))
  : 150;
const buildHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};
async function processWeeklyPayoutById({ payoutId, approvedByUserId }) {
  const payout = await WeeklyTipsterPayout.findById(payoutId);
  if (!payout) throw buildHttpError(404, 'Corte semanal no encontrado');
  if (payout.status === 'paid') throw buildHttpError(400, 'Este pago ya fue procesado');
  if (payout.status === 'processing') throw buildHttpError(400, 'Este pago está en procesamiento');
  if (Number(payout.payoutCents || 0) <= 0) throw buildHttpError(400, 'Monto de payout inválido');
  const tipster = await User.findById(payout.tipsterId).select('name email bankClabeMasked bankClabeLast4 bankAccountHolder bankName stripeConnectedAccountId stripeExternalAccountId stripePayoutReady stripePayoutStatus');
  if (!tipster) throw buildHttpError(404, 'Tipster no encontrado');
  const stripeConnectedAccountId = toSafeString(tipster.stripeConnectedAccountId);
  if (!stripeConnectedAccountId) {
    throw buildHttpError(400, 'El tipster no tiene cuenta Stripe Connect configurada');
  }
  let accountSnapshot = null;
  try {
    accountSnapshot = await stripe.accounts.retrieve(stripeConnectedAccountId);
  } catch (connectError) {
    const connectErrorMessage = toSafeString(connectError?.message || 'No se pudo validar la cuenta Connect del tipster');
    throw buildHttpError(400, connectErrorMessage || 'No se pudo validar la cuenta Connect del tipster');
  }
  const externalAccounts = Array.isArray(accountSnapshot?.external_accounts?.data)
    ? accountSnapshot.external_accounts.data
    : [];
  const externalBankAccount = externalAccounts.find((entry) => String(entry?.object || '').toLowerCase() === 'bank_account') || null;
  const stripeExternalAccountId = toSafeString(tipster.stripeExternalAccountId) || toSafeString(externalBankAccount?.id);
  const bankClabeLast4 = toSafeString(tipster.bankClabeLast4) || (toSafeString(tipster.bankClabeMasked).match(/(\d{4})$/)?.[1] || '') || toSafeString(externalBankAccount?.last4);
  const bankClabeMasked = toSafeString(tipster.bankClabeMasked) || (bankClabeLast4 ? `**************${bankClabeLast4}` : '');
  if (!stripeExternalAccountId || !bankClabeMasked || !bankClabeLast4) {
    throw buildHttpError(400, 'El tipster no tiene CLABE bancaria vinculada en Stripe Connect');
  }
  const payoutState = resolveConnectAccountPayoutStatus(accountSnapshot);
  if (!payoutState.payoutReady) {
    throw buildHttpError(400, 'La cuenta Stripe del tipster aún no está lista para transferencias');
  }
  await User.findByIdAndUpdate(tipster._id, {
    stripeConnectedAccountId,
    stripeExternalAccountId,
    bankClabeMasked,
    bankClabeLast4,
    stripePayoutReady: true,
    stripePayoutStatus: 'configured'
  });
  tipster.stripeConnectedAccountId = stripeConnectedAccountId;
  tipster.stripeExternalAccountId = stripeExternalAccountId;
  tipster.bankClabeMasked = bankClabeMasked;
  tipster.bankClabeLast4 = bankClabeLast4;
  tipster.stripePayoutReady = true;
  tipster.stripePayoutStatus = 'configured';
  await WeeklyTipsterPayout.findByIdAndUpdate(payout._id, {
    status: 'processing',
    errorMessage: '',
    updatedAt: new Date()
  });
  try {
    const transfer = await stripe.transfers.create({
      amount: Number(payout.payoutCents),
      currency: 'usd',
      destination: stripeConnectedAccountId,
      metadata: {
        tpzPayoutId: String(payout._id),
        tpzTipsterId: String(tipster._id),
        tpzBankClabeLast4: bankClabeLast4,
        weekStart: new Date(payout.weekStart).toISOString(),
        weekEnd: new Date(payout.weekEnd).toISOString()
      }
    });
    await WeeklyTipsterPayout.findByIdAndUpdate(payout._id, {
      status: 'paid',
      stripeTransferId: transfer.id,
      approvedBy: approvedByUserId || null,
      approvedAt: new Date(),
      errorMessage: '',
      updatedAt: new Date()
    });
    await User.findByIdAndUpdate(tipster._id, {
      stripeLastTransferId: transfer.id,
      stripeLastPayoutAt: new Date(),
      stripePayoutStatus: 'configured',
      stripePayoutReady: true
    });
    const refreshed = await WeeklyTipsterPayout.findById(payout._id);
    return {
      payout: formatWeeklyPayoutEntry(refreshed, tipster),
      stripeTransferId: transfer.id,
      transferSource: 'stripe_balance',
      destinationType: 'connect_external_bank_account',
      destinationClabeLast4: bankClabeLast4
    };
  } catch (stripeError) {
    const errorMessage = toSafeString(stripeError?.message || 'No se pudo procesar el pago en Stripe').slice(0, 400);
    await WeeklyTipsterPayout.findByIdAndUpdate(payout._id, {
      status: 'failed',
      errorMessage,
      updatedAt: new Date()
    });
    throw buildHttpError(400, errorMessage || 'No se pudo procesar el pago en Stripe');
  }
}

function normalizeWindowDays(value, fallback = 30) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(365, Math.floor(parsed)));
}

function normalizeMinPicks(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(0, Math.min(10000, Math.floor(parsed)));
}

async function buildTipsterPickAnalysis(options = {}) {
  const windowDays = normalizeWindowDays(options.windowDays, 30);
  const minPicks = normalizeMinPicks(options.minPicks);
  const limit = parseListLimit(options.limit, 30, 500);
  const sinceDate = new Date(Date.now() - (windowDays * 24 * 60 * 60 * 1000));
  const last24hDate = new Date(Date.now() - (24 * 60 * 60 * 1000));

  const aggregates = await Pick.aggregate([
    { $match: { createdAt: { $gte: sinceDate } } },
    {
      $group: {
        _id: { tipsterId: '$tipsterId', tipster: '$tipster' },
        totalPicks: { $sum: 1 },
        pendingPicks: { $sum: { $cond: [{ $eq: ['$result', 'pending'] }, 1, 0] } },
        wonPicks: { $sum: { $cond: [{ $eq: ['$result', 'won'] }, 1, 0] } },
        lostPicks: { $sum: { $cond: [{ $eq: ['$result', 'lost'] }, 1, 0] } },
        voidPicks: { $sum: { $cond: [{ $eq: ['$result', 'void'] }, 1, 0] } },
        needsReviewPicks: { $sum: { $cond: [{ $eq: ['$verification.status', 'needs_review'] }, 1, 0] } },
        autoClosedPicks: { $sum: { $cond: [{ $eq: ['$verification.status', 'closed_auto'] }, 1, 0] } },
        avgOdds: { $avg: '$odds' },
        avgPrice: { $avg: '$price' },
        avgBank: { $avg: '$bank' },
        avgConfidence: { $avg: '$verification.confidence' },
        downloads: { $sum: { $ifNull: ['$downloadCount', 0] } },
        buyersTotal: { $sum: { $size: { $ifNull: ['$buyers', []] } } },
        picks24h: { $sum: { $cond: [{ $gte: ['$createdAt', last24hDate] }, 1, 0] } },
        lastPickAt: { $max: '$createdAt' },
        firstPickAt: { $min: '$createdAt' }
      }
    },
    { $match: { totalPicks: { $gte: minPicks } } },
    { $sort: { totalPicks: -1, picks24h: -1, lastPickAt: -1 } },
    { $limit: limit }
  ]);

  const tipsterIds = aggregates
    .map((entry) => String(entry?._id?.tipsterId || '').trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  const uniqueTipsterIds = Array.from(new Set(tipsterIds));
  const tipsters = uniqueTipsterIds.length
    ? await User.find({ _id: { $in: uniqueTipsterIds } }).select('_id name email username role')
    : [];
  const tipsterMap = new Map(tipsters.map((tipster) => [String(tipster._id), tipster]));

  const data = aggregates.map((entry) => {
    const tipsterId = String(entry?._id?.tipsterId || '').trim();
    const tipsterDoc = tipsterMap.get(tipsterId);
    const totalPicks = Number(entry?.totalPicks || 0);
    const wonPicks = Number(entry?.wonPicks || 0);
    const lostPicks = Number(entry?.lostPicks || 0);
    const resolvedPicks = wonPicks + lostPicks + Number(entry?.voidPicks || 0);
    const decisivePicks = wonPicks + lostPicks;
    const hitRate = decisivePicks > 0 ? Number(((wonPicks / decisivePicks) * 100).toFixed(1)) : 0;
    const closeRate = totalPicks > 0 ? Number(((resolvedPicks / totalPicks) * 100).toFixed(1)) : 0;
    const pendingPicks = Number(entry?.pendingPicks || 0);
    const needsReviewPicks = Number(entry?.needsReviewPicks || 0);
    const reviewRisk = pendingPicks > 0
      ? Number((((needsReviewPicks / pendingPicks) * 100)).toFixed(1))
      : 0;
    return {
      tipsterId: tipsterId || null,
      tipster: toSafeString(tipsterDoc?.name) || toSafeString(entry?._id?.tipster) || 'Sin nombre',
      username: toSafeString(tipsterDoc?.username),
      email: toSafeString(tipsterDoc?.email),
      role: toSafeString(tipsterDoc?.role),
      totalPicks,
      picks24h: Number(entry?.picks24h || 0),
      pendingPicks,
      wonPicks,
      lostPicks,
      voidPicks: Number(entry?.voidPicks || 0),
      resolvedPicks,
      needsReviewPicks,
      autoClosedPicks: Number(entry?.autoClosedPicks || 0),
      downloads: Number(entry?.downloads || 0),
      buyersTotal: Number(entry?.buyersTotal || 0),
      avgOdds: Number(Number(entry?.avgOdds || 0).toFixed(2)),
      avgPrice: Number(Number(entry?.avgPrice || 0).toFixed(2)),
      avgBank: Number(Number(entry?.avgBank || 0).toFixed(2)),
      avgConfidence: Number(Number(entry?.avgConfidence || 0).toFixed(1)),
      hitRate,
      closeRate,
      reviewRisk,
      firstPickAt: entry?.firstPickAt || null,
      lastPickAt: entry?.lastPickAt || null
    };
  });

  const totals = data.reduce((acc, row) => {
    acc.totalPicks += row.totalPicks;
    acc.pendingPicks += row.pendingPicks;
    acc.resolvedPicks += row.resolvedPicks;
    acc.wonPicks += row.wonPicks;
    acc.lostPicks += row.lostPicks;
    acc.voidPicks += row.voidPicks;
    acc.needsReviewPicks += row.needsReviewPicks;
    return acc;
  }, {
    totalPicks: 0,
    pendingPicks: 0,
    resolvedPicks: 0,
    wonPicks: 0,
    lostPicks: 0,
    voidPicks: 0,
    needsReviewPicks: 0
  });

  return {
    generatedAt: new Date(),
    filters: { windowDays, minPicks, limit },
    totals: {
      ...totals,
      tipsters: data.length
    },
    tipsters: data
  };
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const normalizedName = normalizeTextField(name, 60);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedName || !normalizedEmail || !password) return res.status(400).json({ error: 'Faltan campos' });
    if (!isValidFullName(normalizedName)) {
      return res.status(400).json({ error: 'Nombre completo obligatorio (nombre y apellido)' });
    }
    if (!isValidFunctionalEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: STRONG_PASSWORD_ERROR });
    }
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) return res.status(400).json({ error: 'Email ya registrado' });
    const username = await resolveAvailableUsername(buildDefaultUsername(normalizedName, normalizedEmail));
    if (!username) return res.status(400).json({ error: 'Username inválido' });
    const emailVerificationRequired = resolveEmailVerificationRequired();
    const verificationPayload = buildEmailVerificationPayload();
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({
      name: normalizedName,
      username,
      email: normalizedEmail,
      password: hash,
      emailVerified: !emailVerificationRequired,
      emailVerifiedAt: emailVerificationRequired ? null : new Date(),
      emailVerificationTokenHash: verificationPayload.tokenHash,
      emailVerificationExpiresAt: verificationPayload.expiresAt
    });

    const frontendBaseUrl = buildFrontendBaseUrl();
    const verificationLink = frontendBaseUrl
      ? `${frontendBaseUrl}/?flow=verify-email&token=${encodeURIComponent(verificationPayload.rawToken)}`
      : `https://tpz.mx/?flow=verify-email&token=${encodeURIComponent(verificationPayload.rawToken)}`;
    let emailDelivery = { sent: false, reason: 'verification_not_required' };
    if (emailVerificationRequired) {
      emailDelivery = { sent: false, reason: 'missing_config' };
      try {
        emailDelivery = await sendVerificationWelcomeEmail({
          toEmail: normalizedEmail,
          fullName: normalizedName,
          verificationLink
        });
      } catch (mailError) {
        console.error('[Auth/Register] sendVerificationWelcomeEmail error:', mailError.message || mailError);
        emailDelivery = { sent: false, reason: 'send_failed' };
      }
      if (!emailDelivery?.sent) {
        await User.findByIdAndUpdate(user._id, {
          emailVerified: true,
          emailVerifiedAt: new Date()
        });
        user.emailVerified = true;
        user.emailVerifiedAt = new Date();
      }
    }

    res.json({
      success: true,
      requiresEmailVerification: Boolean(emailVerificationRequired && emailDelivery?.sent),
      message: emailVerificationRequired && emailDelivery?.sent
        ? 'Registro exitoso. Revisa tu correo para activar tu cuenta.'
        : 'Registro exitoso. Ya puedes iniciar sesión.',
      emailSent: Boolean(emailDelivery.sent),
      emailDeliveryReason: emailDelivery.reason || null,
      user: {
        _id: user._id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const rawToken = String(req.query?.token || '').trim();
    if (!rawToken) return res.status(400).json({ error: 'Token requerido' });
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const user = await User.findOne({
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: { $gt: new Date() }
    }).select('_id email emailVerified');
    if (!user) {
      return res.status(400).json({ error: 'Token inválido o expirado' });
    }
    if (user.emailVerified) {
      return res.json({ success: true, message: 'El correo ya estaba verificado.' });
    }
    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    user.emailVerificationTokenHash = '';
    user.emailVerificationExpiresAt = null;
    await user.save();
    res.json({ success: true, message: 'Correo verificado correctamente. Ya puedes iniciar sesión.' });
  } catch (e) {
    const statusCode = Number(e?.statusCode || 500);
    res.status(statusCode).json({ error: e.message });
  }
});
app.post('/api/payouts/run-weekly', auth, requireAdmin, async (req, res) => {
  try {
    if (!enforceLiveStripeMode(res)) return;
    const weekOffsetRaw = Number(req.body?.weekOffset ?? req.query.weekOffset ?? 0);
    const weekOffset = Number.isFinite(weekOffsetRaw) ? Math.max(-52, Math.min(52, Math.floor(weekOffsetRaw))) : 0;
    const minPayoutRaw = Number(req.body?.minPayoutCents ?? req.query.minPayoutCents ?? DEFAULT_WEEKLY_PAYOUT_MIN_CENTS);
    const minPayoutCents = Number.isFinite(minPayoutRaw) ? Math.max(0, Math.floor(minPayoutRaw)) : DEFAULT_WEEKLY_PAYOUT_MIN_CENTS;
    const limitRaw = Number(req.body?.limit ?? req.query.limit ?? DEFAULT_WEEKLY_PAYOUT_RUN_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : DEFAULT_WEEKLY_PAYOUT_RUN_LIMIT;
    const includeFailedRetries = String(req.body?.includeFailedRetries ?? req.query.includeFailedRetries ?? 'false').toLowerCase() === 'true';
    await buildWeeklyPayoutSummary(weekOffset);
    const { weekStart, weekEnd } = resolveWeekRange(weekOffset);
    const eligibleStatuses = includeFailedRetries ? ['pending', 'failed'] : ['pending'];
    const candidates = await WeeklyTipsterPayout.find({
      weekStart,
      weekEnd,
      status: { $in: eligibleStatuses },
      payoutCents: { $gte: minPayoutCents }
    })
      .sort({ payoutCents: -1, createdAt: 1 })
      .limit(limit);
    const summary = {
      success: true,
      filters: { weekOffset, minPayoutCents, limit, includeFailedRetries },
      totals: { considered: candidates.length, paid: 0, failed: 0 },
      payouts: []
    };
    for (const payout of candidates) {
      try {
        const result = await processWeeklyPayoutById({ payoutId: payout._id, approvedByUserId: req.user.id });
        summary.totals.paid += 1;
        summary.payouts.push({
          payoutId: String(payout._id),
          tipsterId: String(payout.tipsterId || ''),
          status: 'paid',
          stripeTransferId: result.stripeTransferId
        });
      } catch (error) {
        summary.totals.failed += 1;
        summary.payouts.push({
          payoutId: String(payout._id),
          tipsterId: String(payout.tipsterId || ''),
          status: 'failed',
          error: toSafeString(error?.message || 'payout_failed')
        });
      }
    }
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const emailVerificationRequired = resolveEmailVerificationRequired();
    if (!emailVerificationRequired) {
      return res.json({
        success: true,
        requiresEmailVerification: false,
        message: 'La verificación por correo está desactivada en este momento.'
      });
    }
    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!normalizedEmail) return res.status(400).json({ error: 'Email requerido' });
    const user = await User.findOne({ email: normalizedEmail }).select('_id name email emailVerified');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.emailVerified) {
      return res.json({
        success: true,
        alreadyVerified: true,
        message: 'Este correo ya está verificado.'
      });
    }

    const verificationPayload = buildEmailVerificationPayload();
    await User.findByIdAndUpdate(user._id, {
      emailVerificationTokenHash: verificationPayload.tokenHash,
      emailVerificationExpiresAt: verificationPayload.expiresAt
    });
    const frontendBaseUrl = buildFrontendBaseUrl();
    const verificationLink = frontendBaseUrl
      ? `${frontendBaseUrl}/?flow=verify-email&token=${encodeURIComponent(verificationPayload.rawToken)}`
      : `https://tpz.mx/?flow=verify-email&token=${encodeURIComponent(verificationPayload.rawToken)}`;
    let emailDelivery = { sent: false, reason: 'missing_config' };
    try {
      emailDelivery = await sendVerificationWelcomeEmail({
        toEmail: normalizedEmail,
        fullName: user.name,
        verificationLink
      });
    } catch (mailError) {
      console.error('[Auth/ResendVerification] sendVerificationWelcomeEmail error:', mailError.message || mailError);
      emailDelivery = { sent: false, reason: 'send_failed' };
    }
    if (!emailDelivery?.sent) {
      return res.status(503).json({
        error: 'No se pudo enviar el correo de verificación en este momento.',
        requiresEmailVerification: true,
        emailSent: false,
        emailDeliveryReason: emailDelivery.reason || 'send_failed'
      });
    }
    res.json({
      success: true,
      requiresEmailVerification: true,
      emailSent: true,
      message: 'Correo de verificación reenviado. Revisa tu bandeja de entrada.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    const genericResponse = {
      success: true,
      message: 'Si el correo existe, enviaremos instrucciones para restablecer tu contraseña.'
    };
    if (!normalizedEmail || !isValidFunctionalEmail(normalizedEmail)) {
      return res.json(genericResponse);
    }

    const user = await User.findOne({ email: normalizedEmail }).select('_id name email');
    if (!user) return res.json(genericResponse);

    const resetPayload = buildPasswordResetPayload();
    await User.findByIdAndUpdate(user._id, {
      passwordResetTokenHash: resetPayload.tokenHash,
      passwordResetExpiresAt: resetPayload.expiresAt
    });

    const frontendBaseUrl = buildFrontendBaseUrl();
    const resetLink = frontendBaseUrl
      ? `${frontendBaseUrl}/?flow=reset-password&token=${encodeURIComponent(resetPayload.rawToken)}`
      : `https://tpz.mx/?flow=reset-password&token=${encodeURIComponent(resetPayload.rawToken)}`;
    try {
      await sendPasswordResetEmail({
        toEmail: normalizedEmail,
        fullName: user.name,
        resetLink
      });
    } catch (mailError) {
      const resendErrorBody = mailError?.response?.data || null;
      const resendErrorStatus = mailError?.response?.status || null;
      console.error('[Auth/ForgotPassword] sendPasswordResetEmail error:', mailError.message || mailError, resendErrorStatus ? `status=${resendErrorStatus}` : '', resendErrorBody ? `body=${JSON.stringify(resendErrorBody)}` : '');
    }

    res.json(genericResponse);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const rawToken = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.password || '');
    if (!rawToken || !newPassword) return res.status(400).json({ error: 'Token y contraseña son requeridos' });
    if (!isStrongPassword(newPassword)) return res.status(400).json({ error: STRONG_PASSWORD_ERROR });

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() }
    }).select('_id');
    if (!user) return res.status(400).json({ error: 'Token inválido o expirado' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(user._id, {
      password: hashedPassword,
      passwordResetTokenHash: '',
      passwordResetExpiresAt: null
    });
    res.json({ success: true, message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !password) return res.status(400).json({ error: 'Faltan campos' });
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(400).json({ error: 'Usuario no encontrado' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Contraseña incorrecta' });
    const emailVerificationRequired = resolveEmailVerificationRequired();
    if (!user.emailVerified && !emailVerificationRequired) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
      await user.save();
    }
    if (!user.emailVerified) {
      return res.status(403).json({
        error: 'Debes verificar tu correo antes de iniciar sesión',
        requiresEmailVerification: true
      });
    }
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
        username: user.username,
        email: user.email,
        role: user.role,
        emailVerified: Boolean(user.emailVerified),
        avatar: user.avatar,
        bio: user.bio,
        roi: user.roi,
        yield: user.yield,
        roiValue: user.roiValue,
        yieldValue: user.yieldValue,
        netUnits: user.netUnits,
        totalRiskedUnits: user.totalRiskedUnits,
        winRate: user.winRate,
        totalPicks: user.totalPicks,
        wonPicks: user.wonPicks,
        lostPicks: user.lostPicks,
        pushPicks: user.pushPicks,
        avgOdds: user.avgOdds,
        proExpiry: user.proExpiry,
        bankClabeMasked: user.bankClabeMasked,
        bankClabeLast4: user.bankClabeLast4,
        bankAccountHolder: user.bankAccountHolder,
        bankName: user.bankName,
        stripeConnectedAccountId: user.stripeConnectedAccountId,
        stripePayoutReady: user.stripePayoutReady,
        stripePayoutStatus: user.stripePayoutStatus
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
    const { name, avatar, bio, username, clabe, bankAccountHolder, bankName } = req.body;
    const currentUser = await User.findById(req.user.id).select('name email stripeConnectedAccountId stripeExternalAccountId bankName bankAccountHolder stripePayoutReady stripePayoutStatus');
    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    const updates = {};

    if (typeof name === 'string') {
      const normalizedName = normalizeTextField(name, 60);
      if (!normalizedName) return res.status(400).json({ error: 'Nombre inválido' });
      updates.name = normalizedName;
    }

    if (typeof username === 'string') {
      const normalizedUsername = sanitizeUsername(username);
      if (!normalizedUsername) return res.status(400).json({ error: 'Username inválido' });
      const usernameInUse = await User.findOne({ username: normalizedUsername, _id: { $ne: req.user.id } }).select('_id');
      if (usernameInUse) return res.status(400).json({ error: 'Username no disponible' });
      updates.username = normalizedUsername;
    }

    if (typeof bio === 'string') {
      updates.bio = normalizeTextField(bio, 220) || '';
    }

    if (typeof avatar === 'string') {
      const trimmedAvatar = avatar.trim();
      if (!trimmedAvatar) {
        updates.avatar = '';
      } else if (trimmedAvatar.length > 4_000_000) {
        return res.status(400).json({ error: 'Avatar demasiado grande' });
      } else if (trimmedAvatar.startsWith('data:image/') || isValidHttpUrl(trimmedAvatar)) {
        updates.avatar = trimmedAvatar;
      } else {
        return res.status(400).json({ error: 'Formato de avatar inválido' });
      }
    }

    const requestedPayoutFields = (
      typeof clabe === 'string' ||
      typeof bankAccountHolder === 'string' ||
      typeof bankName === 'string'
    );
    let payoutSetupWarning = '';
    if (requestedPayoutFields) {
      if (typeof bankAccountHolder === 'string') {
        updates.bankAccountHolder = normalizeTextField(bankAccountHolder, 80) || '';
      }
      if (typeof bankName === 'string') {
        updates.bankName = normalizeTextField(bankName, 80) || '';
      }
      if (typeof clabe === 'string' && clabe.trim()) {
        const normalizedClabe = normalizeDigits(clabe);
        if (!isValidClabe(normalizedClabe)) {
          return res.status(400).json({ error: 'CLABE inválida' });
        }
        const accountHolder = updates.bankAccountHolder || currentUser.bankAccountHolder || updates.name || currentUser.name;
        const normalizedBankName = updates.bankName || currentUser.bankName;
        const saveLocalBankData = (status, warningText) => {
          Object.assign(updates, {
            bankClabeMasked: maskClabe(normalizedClabe),
            bankClabeLast4: normalizedClabe.slice(-4),
            bankAccountHolder: toSafeString(accountHolder),
            bankName: toSafeString(normalizedBankName),
            stripePayoutReady: false,
            stripePayoutStatus: status
          });
          payoutSetupWarning = warningText;
        };

        const stripeAccountId = toSafeString(currentUser.stripeConnectedAccountId);
        if (!stripeAccountId) {
          saveLocalBankData(
            'onboarding_required',
            'Tus datos bancarios se guardaron localmente. Completa primero Stripe Connect desde tu perfil para habilitar transferencias automáticas.'
          );
        } else {
          let connectSnapshot = null;
          try {
            connectSnapshot = await stripe.accounts.retrieve(stripeAccountId);
          } catch (statusError) {
            if (isStripeConnectUnavailableError(statusError)) {
              saveLocalBankData(
                'connect_not_enabled',
                'Tus datos bancarios se guardaron, pero Stripe Connect no está habilitado aún. Actívalo en dashboard.stripe.com/connect para transferencias automáticas.'
              );
            } else {
              saveLocalBankData(
                'stripe_setup_pending',
                'Tus datos bancarios se guardaron, pero no se pudo validar tu estado de Connect en este momento. Intenta nuevamente más tarde.'
              );
            }
          }

          if (connectSnapshot) {
            const payoutState = resolveConnectAccountPayoutStatus(connectSnapshot);
            if (!payoutState.payoutReady) {
              saveLocalBankData(
                'pending_verification',
                'Tus datos bancarios se guardaron localmente. Completa/verifica tu onboarding de Stripe Connect y luego vuelve a guardar para vincular la cuenta bancaria.'
              );
            } else {
              try {
                const setupPayload = await configureTipsterBankDestination(currentUser, {
                  clabe: normalizedClabe,
                  accountHolder,
                  bankName: normalizedBankName
                });
                Object.assign(updates, setupPayload);
              } catch (stripeConnectError) {
                const connectUnavailable = isStripeConnectUnavailableError(stripeConnectError);
                const fallbackStatus = connectUnavailable ? 'connect_not_enabled' : 'stripe_setup_pending';
                const fallbackWarning = connectUnavailable
                  ? 'Tus datos bancarios se guardaron, pero Stripe Connect no está habilitado aún. Actívalo en dashboard.stripe.com/connect para transferencias automáticas.'
                  : 'Tus datos bancarios se guardaron, pero Stripe no pudo completar la vinculación automáticamente en este momento. Intenta nuevamente más tarde.';
                saveLocalBankData(fallbackStatus, fallbackWarning);
              }
            }
          }
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    const updated = await User.findByIdAndUpdate(req.user.id, updates, { new: true }).select('-password');
    if (!updated) return res.status(404).json({ error: 'User not found' });
    if (updates.name && currentUser?.name && currentUser.name !== updates.name) {
      await Pick.updateMany({ tipsterId: req.user.id }, { $set: { tipster: updates.name } });
    }
    const payload = updated.toObject ? updated.toObject() : updated;
    if (payoutSetupWarning) payload.setupWarning = payoutSetupWarning;
    res.json(payload);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PICKS ─────────────────────────────────────────────────────────────────────
app.get('/api/picks', async (req, res) => {
  try {
    const picks = await Pick.find({ result: 'pending' }).sort({ createdAt: -1 }).select('-ticketImg');
    const pickIds = picks.map((pick) => pick?._id).filter(Boolean);
    const salesByPickId = pickIds.length
      ? await Purchase.aggregate([
          { $match: { pickId: { $in: pickIds } } },
          { $group: { _id: '$pickId', salesCount: { $sum: 1 } } }
        ])
      : [];
    const salesMap = new Map(
      salesByPickId.map((entry) => [String(entry?._id), Number(entry?.salesCount || 0)])
    );
    const payload = picks.map((pick) => {
      const pickObject = pick.toObject ? pick.toObject() : pick;
      const persistedSales = Number(pickObject?.salesCount || 0);
      const derivedSales = Number(salesMap.get(String(pickObject?._id)) || 0);
      return {
        ...pickObject,
        salesCount: Math.max(0, persistedSales, derivedSales)
      };
    });
    res.json(payload);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/share/pick/:id/og-image.png', async (req, res) => {
  try {
    const pickId = String(req.params?.id || '').trim();
    if (!pickId || !mongoose.Types.ObjectId.isValid(pickId)) return res.status(404).send('not_found');
    const pick = await Pick.findById(pickId).select('match league sport tipster odds price homeLogo awayLogo');
    if (!pick) return res.status(404).send('not_found');
    if (!Resvg) return res.status(503).send('image_renderer_unavailable');
    const svg = await buildPickShareCardSvg(pick);
    const renderer = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
    const pngBuffer = renderer.render().asPng();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).send(pngBuffer);
  } catch {
    return res.status(500).send('error');
  }
});
app.get('/share/pick/:id/og-image.svg', async (req, res) => {
  try {
    const pickId = String(req.params?.id || '').trim();
    if (!pickId || !mongoose.Types.ObjectId.isValid(pickId)) return res.status(404).send('not_found');
    const pick = await Pick.findById(pickId).select('match league sport tipster odds price homeLogo awayLogo');
    if (!pick) return res.status(404).send('not_found');
    const svg = await buildPickShareCardSvg(pick);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).send(svg);
  } catch {
    return res.status(500).send('error');
  }
});
app.get('/share/pick/:id', async (req, res) => {
  try {
    const pickId = String(req.params?.id || '').trim();
    if (!pickId || !mongoose.Types.ObjectId.isValid(pickId)) return res.status(404).send('not_found');
    const pick = await Pick.findById(pickId).select('match league sport tipster odds price');
    if (!pick) return res.status(404).send('not_found');
    const frontendBase = (buildFrontendBaseUrl() || 'https://tpz.mx').replace(/\/+$/, '');
    const destinationUrl = `${frontendBase}/?flow=pick&pickId=${encodeURIComponent(String(pick._id))}`;
    const requestOrigin = resolveRequestOrigin(req);
    const imageUrl = requestOrigin
      ? `${requestOrigin}/share/pick/${encodeURIComponent(String(pick._id))}/og-image.png`
      : `${frontendBase}/logo192.png`;
    const matchText = String(pick?.match || 'Pick deportivo').trim();
    const tipsterText = String(pick?.tipster || 'Tipster').trim();
    const oddsText = formatShareOdds(pick?.odds);
    const priceText = formatShareUsdAmount(pick?.price);
    const leagueText = String(pick?.league || pick?.sport || 'The Pick Zone').trim();
    const ogTitle = `${matchText} · Momio ${oddsText} · ${priceText}`;
    const ogDescription = `Pick de ${tipsterText} en ${leagueText}. Costo ${priceText}.`;
    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(ogTitle)}</title>
  <meta name="description" content="${escapeHtml(ogDescription)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="The Pick Zone" />
  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(ogDescription)}" />
  <meta property="og:image" content="${escapeHtml(imageUrl)}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${escapeHtml(destinationUrl)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}" />
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
  <meta http-equiv="refresh" content="0; url=${escapeHtml(destinationUrl)}" />
</head>
<body>
  <script>window.location.replace(${JSON.stringify(destinationUrl)});</script>
  <p>Redirigiendo a <a href="${escapeHtml(destinationUrl)}">The Pick Zone</a>...</p>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(html);
  } catch {
    return res.status(500).send('error');
  }
});

app.post('/api/picks', auth, async (req, res) => {
  try {
    if (!['pro','tipster','admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo tipsters Pro/Tipster pueden publicar picks' });
    const draftPick = { ...req.body, tipsterId: req.user.id };
    draftPick.bet = mergeBetData(buildBetFromPick(draftPick), draftPick.bet || {});
    draftPick.verification = {
      ...(draftPick.verification || {}),
      status: 'pending_data',
      preliminaryResult: 'PENDIENTE',
      confidence: 0,
      needsReview: false,
      summary: 'Esperando análisis preliminar',
      engineVersion: AI_ENGINE_VERSION
    };
    const pick = await Pick.create(draftPick);
    let enrichedPick = pick;
    try {
      const analyzed = await analyzeAndPersistPick(pick, { forceOcr: true });
      if (analyzed) enrichedPick = analyzed;
    } catch (analysisError) {
      console.error('post /api/picks analysis error:', analysisError.message || analysisError);
    }
    res.json(enrichedPick);
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
    const result = normalizeManualResultValue(req.body?.result);
    if (!['won','lost','void','pending'].includes(result)) return res.status(400).json({ error: 'Invalid result' });
    const resultPayload = await setOfficialResultForPick(req.params.id, result, req.user.id);
    if (!resultPayload) return res.status(404).json({ error: 'Pick not found' });
    res.json({
      success: true,
      result: resultPayload.updatedPick?.result || result,
      tipsterStats: resultPayload.tipsterStats,
      pick: resultPayload.updatedPick
    });
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
const TEAM_LOGO_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const teamLogoCache = new Map();
const espnTeamsDirectoryCache = new Map();
const ESPN_TEAM_DIRECTORY_TTL_MS = 1000 * 60 * 60 * 6;
const ESPN_LEAGUE_PATH_BY_SPORT_KEY = {
  basketball_nba: 'basketball/nba',
  basketball_wnba: 'basketball/wnba',
  baseball_mlb: 'baseball/mlb',
  americanfootball_nfl: 'football/nfl',
  icehockey_nhl: 'hockey/nhl',
  soccer_epl: 'soccer/eng.1',
  soccer_usa_mls: 'soccer/usa.1',
  soccer_mexico_ligamx: 'soccer/mex.1',
  soccer_spain_la_liga: 'soccer/esp.1',
  soccer_germany_bundesliga: 'soccer/ger.1',
  soccer_italy_serie_a: 'soccer/ita.1',
  soccer_france_ligue_one: 'soccer/fra.1'
};
function buildTeamLogoCacheKey(teamName, sportKey = '') {
  const normalizedName = String(teamName || '').trim().toLowerCase();
  const normalizedSportKey = String(sportKey || '').trim().toLowerCase();
  return `${normalizedSportKey}::${normalizedName}`;
}
function readTeamLogoCache(cacheKey) {
  const hit = teamLogoCache.get(cacheKey);
  if (!hit) return null;
  if ((Date.now() - Number(hit.at || 0)) > TEAM_LOGO_CACHE_TTL_MS) {
    teamLogoCache.delete(cacheKey);
    return null;
  }
  return typeof hit.logo === 'string' ? hit.logo : '';
}
function writeTeamLogoCache(cacheKey, logoUrl) {
  teamLogoCache.set(cacheKey, { logo: String(logoUrl || ''), at: Date.now() });
}
function buildEspnTeamsCacheKey(sportKey = '') {
  return String(sportKey || '').trim().toLowerCase();
}
function resolveEspnLeaguePathFromSportKey(sportKey = '') {
  const normalizedSportKey = String(sportKey || '').trim().toLowerCase();
  return ESPN_LEAGUE_PATH_BY_SPORT_KEY[normalizedSportKey] || '';
}
function readEspnTeamsDirectoryCache(cacheKey) {
  const hit = espnTeamsDirectoryCache.get(cacheKey);
  if (!hit) return null;
  if ((Date.now() - Number(hit.at || 0)) > ESPN_TEAM_DIRECTORY_TTL_MS) {
    espnTeamsDirectoryCache.delete(cacheKey);
    return null;
  }
  return Array.isArray(hit.teams) ? hit.teams : [];
}
function writeEspnTeamsDirectoryCache(cacheKey, teams) {
  espnTeamsDirectoryCache.set(cacheKey, { teams: Array.isArray(teams) ? teams : [], at: Date.now() });
}
async function fetchEspnTeamsDirectoryBySportKey(sportKey = '') {
  const leaguePath = resolveEspnLeaguePathFromSportKey(sportKey);
  if (!leaguePath) return [];
  const cacheKey = buildEspnTeamsCacheKey(sportKey);
  const cached = readEspnTeamsDirectoryCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${leaguePath}/teams?limit=500`;
    const resp = await axios.get(url, { timeout: 9000 });
    const teams = Array.isArray(resp?.data?.sports?.[0]?.leagues?.[0]?.teams)
      ? resp.data.sports[0].leagues[0].teams
      : [];
    const normalized = teams.map((entry) => ({
      name: String(entry?.team?.displayName || entry?.team?.name || entry?.team?.shortDisplayName || '').trim(),
      logo: String(entry?.team?.logos?.[0]?.href || entry?.team?.logo || '').trim()
    }))
      .filter((entry) => entry.name && entry.logo);
    writeEspnTeamsDirectoryCache(cacheKey, normalized);
    return normalized;
  } catch {
    return [];
  }
}
async function fetchTeamLogoByName(teamName, sportKey = '') {
  const cleanName = String(teamName || '').trim();
  if (!cleanName) return '';
  const espnTeams = await fetchEspnTeamsDirectoryBySportKey(sportKey);
  if (espnTeams.length > 0) {
    const normalizedTarget = normalizeTeamName(cleanName);
    const exact = espnTeams.find((entry) => normalizeTeamName(entry.name) === normalizedTarget);
    if (exact?.logo) return exact.logo;
    let bestCandidate = null;
    let bestScore = -1;
    for (const entry of espnTeams) {
      const candidateScore = scoreNameMatch(cleanName, entry.name);
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        bestCandidate = entry;
      }
    }
    if (bestCandidate?.logo && bestScore >= 2) return bestCandidate.logo;
  }
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(cleanName)}`;
    const resp = await axios.get(url, { timeout: 9000 });
    const teams = Array.isArray(resp?.data?.teams) ? resp.data.teams : [];
    if (!teams.length) return '';
    const normalizedTarget = normalizeTeamName(cleanName);
    const exact = teams.find((row) => normalizeTeamName(String(row?.strTeam || '').trim()) === normalizedTarget);
    if (exact) return String(exact?.strBadge || exact?.strTeamBadge || exact?.strLogo || '').trim();
    let bestCandidate = null;
    let bestScore = -1;
    for (const row of teams) {
      const candidateName = String(row?.strTeam || '').trim();
      if (!candidateName) continue;
      const candidateScore = scoreNameMatch(cleanName, candidateName);
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        bestCandidate = row;
      }
    }
    if (bestCandidate && bestScore >= 3) {
      return String(bestCandidate?.strBadge || bestCandidate?.strTeamBadge || bestCandidate?.strLogo || '').trim();
    }
    return '';
  } catch {
    return '';
  }
}
async function resolveTeamLogo(teamName, sportKey = '') {
  const cacheKey = buildTeamLogoCacheKey(teamName, sportKey);
  const cached = readTeamLogoCache(cacheKey);
  if (cached !== null) return cached;
  const logo = await fetchTeamLogoByName(teamName, sportKey);
  writeTeamLogoCache(cacheKey, logo);
  return logo;
}
async function resolveFixtureTeamLogos(homeTeam, awayTeam, sportKey = '') {
  const [homeLogo, awayLogo] = await Promise.all([
    resolveTeamLogo(homeTeam, sportKey),
    resolveTeamLogo(awayTeam, sportKey)
  ]);
  return { homeLogo, awayLogo };
}
function parseMatchTeams(matchValue) {
  const rawMatch = String(matchValue || '').trim();
  if (!rawMatch) return { homeTeam: '', awayTeam: '' };
  const splitters = [/\s+vs\.?\s+/i, /\s+v\s+/i, /\s+-\s+/];
  for (const splitter of splitters) {
    const parts = rawMatch.split(splitter).map((part) => String(part || '').trim()).filter(Boolean);
    if (parts.length >= 2) return { homeTeam: parts[0], awayTeam: parts[1] };
  }
  return { homeTeam: rawMatch, awayTeam: '' };
}
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
function resolveRequestOrigin(req) {
  const protocolHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = protocolHeader || req.protocol || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
}
function formatShareUsdAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  return `$${amount.toFixed(2)}`;
}
function formatShareOdds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed.toFixed(2) : '--';
}
async function fetchImageAsDataUri(imageUrl) {
  const safeUrl = String(imageUrl || '').trim();
  if (!safeUrl) return '';
  try {
    const response = await axios.get(safeUrl, { responseType: 'arraybuffer', timeout: 9000 });
    const contentType = String(response?.headers?.['content-type'] || '').trim().toLowerCase();
    if (!contentType.startsWith('image/')) return '';
    const binary = Buffer.from(response.data);
    if (!binary.length) return '';
    return `data:${contentType};base64,${binary.toString('base64')}`;
  } catch {
    return '';
  }
}
async function buildPickShareCardSvg(pick) {
  const match = String(pick?.match || 'Pick deportivo').trim();
  const teams = parseMatchTeams(match);
  const homeTeam = teams.homeTeam || 'Home';
  const awayTeam = teams.awayTeam || 'Away';
  const oddsText = formatShareOdds(pick?.odds);
  const priceText = formatShareUsdAmount(pick?.price);
  const tipsterText = String(pick?.tipster || 'Tipster').trim();
  const leagueText = String(pick?.league || pick?.sport || 'The Pick Zone').trim();
  const [homeLogoDataUri, awayLogoDataUri] = await Promise.all([
    fetchImageAsDataUri(pick?.homeLogo),
    fetchImageAsDataUri(pick?.awayLogo)
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b0f0e"/>
      <stop offset="100%" stop-color="#122019"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="40" y="40" width="1120" height="550" rx="28" fill="#111815" stroke="#1e2d24" stroke-width="3"/>
  <text x="80" y="110" fill="#1DB954" font-size="40" font-family="Arial, sans-serif" font-weight="700">THE PICK ZONE</text>
  <text x="80" y="175" fill="#E8F0EC" font-size="48" font-family="Arial, sans-serif" font-weight="700">${escapeXml(homeTeam)} vs ${escapeXml(awayTeam)}</text>
  <text x="80" y="225" fill="#92A89F" font-size="30" font-family="Arial, sans-serif">${escapeXml(leagueText)}</text>
  <text x="80" y="295" fill="#E8F0EC" font-size="34" font-family="Arial, sans-serif">Tipster: ${escapeXml(tipsterText)}</text>
  <rect x="80" y="340" width="310" height="100" rx="18" fill="#0f1410" stroke="#1DB954" stroke-width="2"/>
  <text x="105" y="388" fill="#92A89F" font-size="26" font-family="Arial, sans-serif">Momio</text>
  <text x="105" y="426" fill="#E8F0EC" font-size="42" font-family="Arial, sans-serif" font-weight="700">${escapeXml(oddsText)}</text>
  <rect x="420" y="340" width="310" height="100" rx="18" fill="#0f1410" stroke="#1DB954" stroke-width="2"/>
  <text x="445" y="388" fill="#92A89F" font-size="26" font-family="Arial, sans-serif">Costo</text>
  <text x="445" y="426" fill="#E8F0EC" font-size="42" font-family="Arial, sans-serif" font-weight="700">${escapeXml(priceText)}</text>
  ${homeLogoDataUri ? `<rect x="860" y="170" width="120" height="120" rx="60" fill="#0f1410" stroke="#1e2d24" stroke-width="2"/><image href="${escapeXml(homeLogoDataUri)}" x="870" y="180" width="100" height="100" preserveAspectRatio="xMidYMid meet"/>` : ''}
  ${awayLogoDataUri ? `<rect x="1010" y="170" width="120" height="120" rx="60" fill="#0f1410" stroke="#1e2d24" stroke-width="2"/><image href="${escapeXml(awayLogoDataUri)}" x="1020" y="180" width="100" height="100" preserveAspectRatio="xMidYMid meet"/>` : ''}
  <text x="80" y="530" fill="#6B8078" font-size="24" font-family="Arial, sans-serif">Comparte este pick en WhatsApp y redes sociales</text>
</svg>`;
}
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
    const rawFixtures = (Array.isArray(resp.data) ? resp.data : [])
      .filter((e) => e && e.home_team && e.away_team && e.commence_time);
    const fixtures = await Promise.all(rawFixtures.map(async (e) => {
      const logos = await resolveFixtureTeamLogos(e.home_team, e.away_team, resolvedSportKey);
      return {
        id: e.id,
        home: e.home_team,
        away: e.away_team,
        homeLogo: logos.homeLogo || '',
        awayLogo: logos.awayLogo || '',
        time: e.commence_time,
        league: league || e.sport_title || resolvedSportKey,
        sportKey: resolvedSportKey
      };
    }));
    res.json(fixtures);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TIPSTERS ─────────────────────────────────────────────────────────────────
app.get('/api/tipsters', async (req, res) => {
  try {
    const tipsters = await User.find({ role: { $in: ['pro','tipster','admin'] } }).select('-password -proExpiry').sort({ createdAt: -1 });
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
app.delete('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params?.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Usuario inválido' });
    }
    if (String(req.user?.id || '') === userId) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario admin' });
    }

    const targetUser = await User.findById(userId).select('_id name email role');
    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado' });
    const protectedEmails = new Set(['admin@thepickzone.com']);
    if (protectedEmails.has(String(targetUser.email || '').trim().toLowerCase())) {
      return res.status(400).json({ error: 'Este usuario está protegido y no se puede eliminar' });
    }

    const tipsterPicks = await Pick.find({ tipsterId: userId }).select('_id');
    const tipsterPickIds = tipsterPicks.map((pickDoc) => pickDoc?._id).filter(Boolean);

    const [removedPurchasesByBuyer, removedPayouts, pullBuyerRefsResult, removedPurchasesByTipsterPicks, removedTipsterPicks] = await Promise.all([
      Purchase.deleteMany({ buyerId: userId }),
      WeeklyTipsterPayout.deleteMany({ tipsterId: userId }),
      Pick.updateMany({ buyers: userId }, { $pull: { buyers: userId } }),
      tipsterPickIds.length ? Purchase.deleteMany({ pickId: { $in: tipsterPickIds } }) : Promise.resolve({ deletedCount: 0 }),
      Pick.deleteMany({ tipsterId: userId })
    ]);

    await User.findByIdAndDelete(userId);

    res.json({
      success: true,
      removedUserId: userId,
      removedUserEmail: targetUser.email,
      removedUserName: targetUser.name,
      cleanup: {
        purchasesByBuyerDeleted: Number(removedPurchasesByBuyer?.deletedCount || 0),
        weeklyPayoutsDeleted: Number(removedPayouts?.deletedCount || 0),
        picksWithBuyerReferenceUpdated: Number(pullBuyerRefsResult?.modifiedCount || 0),
        purchasesOfTipsterPicksDeleted: Number(removedPurchasesByTipsterPicks?.deletedCount || 0),
        tipsterPicksDeleted: Number(removedTipsterPicks?.deletedCount || 0)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/revenue/weekly-payouts', auth, requireAdmin, async (req, res) => {
  try {
    const weekOffsetRaw = Number(req.query.weekOffset ?? 0);
    const weekOffset = Number.isFinite(weekOffsetRaw) ? weekOffsetRaw : 0;
    const summary = await buildWeeklyPayoutSummary(weekOffset);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/revenue/weekly-payouts/:id/approve', auth, requireAdmin, async (req, res) => {
  try {
    if (!enforceLiveStripeMode(res)) return;
    const result = await processWeeklyPayoutById({ payoutId: req.params.id, approvedByUserId: req.user.id });
    res.json({ success: true, ...result });
  } catch (e) {
    const statusCode = Number(e?.statusCode || 500);
    res.status(statusCode).json({ error: e.message });
  }
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

app.get('/api/admin/tipsters/pick-analysis', auth, requireAdmin, async (req, res) => {
  try {
    const analysis = await buildTipsterPickAnalysis({
      windowDays: req.query.windowDays,
      minPicks: req.query.minPicks,
      limit: req.query.limit
    });
    res.json(analysis);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/picks-monitor', auth, requireAdmin, async (req, res) => {
  try {
    const monitor = await buildVerificationMonitorSnapshot({
      pendingStaleHours: req.query.pendingStaleHours,
      reviewStaleHours: req.query.reviewStaleHours,
      lookbackHours: req.query.lookbackHours,
      limit: req.query.limit
    });
    res.json(monitor);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/verification-alerts', auth, requireAdmin, async (req, res) => {
  try {
    const monitor = await buildVerificationMonitorSnapshot({
      pendingStaleHours: req.query.pendingStaleHours,
      reviewStaleHours: req.query.reviewStaleHours,
      lookbackHours: req.query.lookbackHours,
      limit: req.query.limit
    });
    const alerts = await buildVerificationAlerts({
      monitor,
      autoClosedLimit: req.query.autoClosedLimit
    });
    res.json({ monitor, ...alerts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/picks/reanalyze-stale', auth, requireAdmin, async (req, res) => {
  try {
    const pendingStaleHours = parseHoursSetting(req.body?.pendingStaleHours ?? req.query.pendingStaleHours, DEFAULT_PENDING_STALE_HOURS);
    const reviewStaleHours = parseHoursSetting(req.body?.reviewStaleHours ?? req.query.reviewStaleHours, DEFAULT_REVIEW_STALE_HOURS);
    const limit = parseListLimit(req.body?.limit ?? req.query.limit, 60, 200);
    const pendingCutoff = dateHoursAgo(pendingStaleHours);
    const reviewCutoff = dateHoursAgo(reviewStaleHours);
    const staleQuery = {
      result: 'pending',
      $or: [
        { createdAt: { $lt: pendingCutoff } },
        buildNeedsReviewStaleQuery(reviewCutoff),
        buildPreliminaryReadyStaleQuery(pendingCutoff)
      ]
    };
    const stalePicks = await Pick.find(staleQuery).sort({ createdAt: 1 }).limit(limit);
    const summary = { total: stalePicks.length, analyzed: 0, failed: 0, autoClosed: 0, pending: 0, results: [] };
    for (const pick of stalePicks) {
      try {
        const updated = await analyzeAndPersistPick(pick, { forceOcr: true });
        summary.analyzed += 1;
        if (String(updated?.result || 'pending').toLowerCase() === 'pending') {
          summary.pending += 1;
        } else {
          summary.autoClosed += 1;
        }
        summary.results.push({
          pickId: String(pick._id),
          result: updated?.result || 'pending',
          status: updated?.verification?.status || 'pending',
          confianza: Number(updated?.aiAnalysis?.confianza || 0),
          resultado: updated?.aiAnalysis?.resultado || 'NECESITA_VERIFICACION'
        });
      } catch (error) {
        summary.failed += 1;
        summary.results.push({
          pickId: String(pick._id),
          error: error.message || 'analysis_failed'
        });
      }
    }
    const monitor = await buildVerificationMonitorSnapshot({
      pendingStaleHours,
      reviewStaleHours,
      lookbackHours: req.body?.lookbackHours ?? req.query.lookbackHours,
      limit: req.body?.monitorLimit ?? req.query.monitorLimit ?? req.query.limit
    });
    res.json({ success: true, staleThresholds: { pendingStaleHours, reviewStaleHours }, summary, monitor });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/picks/bulk-result', auth, requireAdmin, async (req, res) => {
  try {
    const rawPickIds = Array.isArray(req.body?.pickIds) ? req.body.pickIds : [];
    const result = String(req.body?.result || '').trim().toLowerCase();
    const pickIds = Array.from(new Set(rawPickIds.map((id) => String(id || '').trim()).filter(Boolean))).slice(0, 300);
    if (!pickIds.length) return res.status(400).json({ error: 'pickIds requerido' });
    if (!['won', 'lost', 'void', 'pending'].includes(result)) return res.status(400).json({ error: 'result inválido' });

    const summary = { requested: pickIds.length, updated: 0, failed: 0, picks: [] };
    for (const pickId of pickIds) {
      try {
        const updateResult = await setOfficialResultForPick(pickId, result, req.user.id);
        if (!updateResult?.updatedPick) {
          summary.failed += 1;
          summary.picks.push({ pickId, error: 'not_found' });
          continue;
        }
        summary.updated += 1;
        summary.picks.push({
          pickId,
          result: updateResult.updatedPick.result,
          status: updateResult.updatedPick?.verification?.status || 'pending'
        });
      } catch (error) {
        summary.failed += 1;
        summary.picks.push({ pickId, error: error.message || 'update_failed' });
      }
    }
    res.json({ success: true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/picks/bulk-analyze', auth, requireAdmin, async (req, res) => {
  try {
    const rawPickIds = Array.isArray(req.body?.pickIds) ? req.body.pickIds : [];
    const pickIds = Array.from(new Set(rawPickIds.map((id) => String(id || '').trim()).filter(Boolean))).slice(0, 300);
    if (!pickIds.length) return res.status(400).json({ error: 'pickIds requerido' });
    const picks = await Pick.find({ _id: { $in: pickIds } });
    const byId = new Map(picks.map((pick) => [String(pick._id), pick]));
    const summary = { requested: pickIds.length, found: picks.length, analyzed: 0, failed: 0, autoClosed: 0, pending: 0, results: [] };
    for (const pickId of pickIds) {
      const pick = byId.get(pickId);
      if (!pick) {
        summary.failed += 1;
        summary.results.push({ pickId, error: 'not_found' });
        continue;
      }
      try {
        const updated = await analyzeAndPersistPick(pick, { forceOcr: true });
        summary.analyzed += 1;
        if (String(updated?.result || 'pending').toLowerCase() === 'pending') {
          summary.pending += 1;
        } else {
          summary.autoClosed += 1;
        }
        summary.results.push({
          pickId,
          result: updated?.result || 'pending',
          status: updated?.verification?.status || 'pending',
          confianza: Number(updated?.aiAnalysis?.confianza || 0),
          resultado: updated?.aiAnalysis?.resultado || 'NECESITA_VERIFICACION'
        });
      } catch (error) {
        summary.failed += 1;
        summary.results.push({ pickId, error: error.message || 'analysis_failed' });
      }
    }
    res.json({ success: true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-stats', auth, requireAdmin, async (req, res) => {
  try {
    await User.updateMany({}, {
      roi: '+0%',
      yield: '+0%',
      roiValue: 0,
      yieldValue: 0,
      netUnits: 0,
      totalRiskedUnits: 0,
      winRate: 0,
      totalPicks: 0,
      wonPicks: 0,
      lostPicks: 0,
      pushPicks: 0,
      avgOdds: 0,
      balance: 0
    });
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
    await User.updateMany({}, {
      roi: '+0%',
      yield: '+0%',
      roiValue: 0,
      yieldValue: 0,
      netUnits: 0,
      totalRiskedUnits: 0,
      winRate: 0,
      totalPicks: 0,
      wonPicks: 0,
      lostPicks: 0,
      pushPicks: 0,
      avgOdds: 0,
      balance: 0
    });
    res.json({ success: true, usersDeleted: deleted.deletedCount, picksDeleted: picksDeleted.deletedCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── AI ANALYSIS ───────────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AI_ENGINE_VERSION = 'v2-ocr-props-20260512';
const GOOGLE_VISION_KEY = (process.env.GOOGLE_VISION_KEY || '').trim();
const APISPORTS_KEY = (process.env.APISPORTS_KEY || process.env.APISPORTS_API_KEY || '').trim();
const APISPORTS_BASE_URLS = {
  basketball: (process.env.APISPORTS_BASKETBALL_BASE_URL || 'https://v1.basketball.api-sports.io').trim(),
  baseball: (process.env.APISPORTS_BASEBALL_BASE_URL || 'https://v1.baseball.api-sports.io').trim(),
  'american-football': (process.env.APISPORTS_AMERICAN_FOOTBALL_BASE_URL || 'https://v1.american-football.api-sports.io').trim(),
  football: (process.env.APISPORTS_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io').trim()
};
const SUPPORTED_PROP_SPORTS = new Set(['basketball', 'baseball', 'american-football', 'football']);
const PROP_STAT_ALIASES = {
  points: ['points', 'pts', 'point'],
  rebounds: ['rebounds', 'total_rebounds', 'reb'],
  assists: ['assists', 'assist'],
  threes: ['threepoint', 'three_points', '3pt', 'threepoint_goals'],
  goals: ['goals', 'goal'],
  shots: ['shots', 'shot'],
  shots_on_target: ['shots_on_target', 'shots_on_goal', 'shots_on'],
  corners: ['corners', 'corner', 'corner_kicks', 'kicks'],
  yellow_cards: ['yellow_cards', 'yellow_card', 'tarjetas_amarillas', 'cards_yellow'],
  red_cards: ['red_cards', 'red_card', 'tarjetas_rojas', 'cards_red'],
  cards_total: ['cards_total', 'total_cards', 'tarjetas', 'cards'],
  fouls: ['fouls', 'faltas', 'fauls'],
  offsides: ['offsides', 'offside', 'fuera_de_juego'],
  saves: ['saves', 'save', 'goalkeeper_saves'],
  hits: ['hits', 'hit'],
  runs: ['runs', 'run'],
  rbi: ['rbi', 'runs_batted_in'],
  home_runs: ['home_runs', 'homeruns', 'home_run'],
  strikeouts: ['strikeouts', 'strike_outs', 'k'],
  passing_yards: ['passing_yards', 'pass_yards'],
  rushing_yards: ['rushing_yards', 'rush_yards'],
  receiving_yards: ['receiving_yards', 'rec_yards'],
  touchdowns: ['touchdowns', 'td']
};
const FOOTBALL_TEAM_PROP_STAT_TYPES = new Set(['corners', 'yellow_cards', 'red_cards', 'cards_total', 'fouls', 'offsides']);
const FOOTBALL_TEAM_STAT_LABEL_ALIASES = {
  corners: ['corner kicks', 'corners'],
  yellow_cards: ['yellow cards'],
  red_cards: ['red cards'],
  fouls: ['fouls'],
  offsides: ['offsides', 'offside']
};
const LIGA_MX_TEAM_HINTS = [
  'guadalajara', 'chivas', 'cruz azul', 'america', 'pumas', 'tigres', 'monterrey', 'toluca',
  'pachuca', 'leon', 'santos', 'atlas', 'necaxa', 'juarez', 'queretaro', 'mazatlan',
  'atletico san luis', 'puebla', 'tijuana'
];
const SOCCER_SCORE_FALLBACK_KEYS = [
  'soccer_mexico_ligamx',
  'soccer_usa_mls',
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_germany_bundesliga',
  'soccer_france_ligue_one',
  'soccer_uefa_champs_league'
];

function toSafeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toSafeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeToken(value) {
  return toSafeString(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTeamName(value) {
  return normalizeToken(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(fc|cf|club|deportivo|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitMatchTeams(match) {
  const raw = toSafeString(match);
  if (!raw) return [null, null];
  const splitters = [/\s+vs\.?\s+/i, /\s+v\s+/i, /\s+-\s+/];
  for (const splitter of splitters) {
    const parts = raw.split(splitter).map((item) => item.trim()).filter(Boolean);
    if (parts.length >= 2) return [parts[0], parts[1]];
  }
  return [null, null];
}

function scoreNameMatch(expected, candidate) {
  const e = normalizeTeamName(expected);
  const c = normalizeTeamName(candidate);
  if (!e || !c) return 0;
  if (e === c) return 5;
  if (c.includes(e) || e.includes(c)) return 4;
  const eParts = e.split(' ').filter(Boolean);
  const cParts = c.split(' ').filter(Boolean);
  const overlap = eParts.filter((part) => cParts.includes(part)).length;
  return overlap;
}

function resolveSportKeyFromContext({ sportKey, league, sport }) {
  const explicitSportKey = toSafeString(sportKey);
  if (explicitSportKey && explicitSportKey.includes('_')) return explicitSportKey;
  const leagueKey = SPORT_KEYS[toSafeString(league)];
  if (leagueKey) return leagueKey;
  const merged = `${toSafeString(league)} ${toSafeString(sport)} ${explicitSportKey}`.toLowerCase();
  if (
    merged.includes('liga mx') ||
    merged.includes('ligamx') ||
    merged.includes('mexico') ||
    merged.includes('méxico')
  ) return 'soccer_mexico_ligamx';
  if (merged.includes('nba')) return 'basketball_nba';
  if (merged.includes('mlb') || merged.includes('baseball')) return 'baseball_mlb';
  if (merged.includes('nfl') || merged.includes('football americano') || merged.includes('american football')) return 'americanfootball_nfl';
  if (merged.includes('soccer') || merged.includes('futbol') || merged.includes('football')) return 'soccer_epl';
  return explicitSportKey || '';
}
function looksLikeLigaMxContext({ league, sport, home, away }) {
  const merged = `${toSafeString(league)} ${toSafeString(sport)} ${toSafeString(home)} ${toSafeString(away)}`.toLowerCase();
  if (
    merged.includes('liga mx') ||
    merged.includes('ligamx') ||
    merged.includes('mexico') ||
    merged.includes('méxico')
  ) return true;
  return LIGA_MX_TEAM_HINTS.some((teamHint) => merged.includes(teamHint));
}
function buildSoccerScoreSearchKeys(primarySportKey, context = {}) {
  const keys = [];
  const primary = toSafeString(primarySportKey);
  if (primary) keys.push(primary);
  if (looksLikeLigaMxContext(context)) keys.unshift('soccer_mexico_ligamx');
  SOCCER_SCORE_FALLBACK_KEYS.forEach((sportKey) => keys.push(sportKey));
  return Array.from(new Set(keys.filter(Boolean)));
}
async function fetchScoreRowsBySportKey(sportKey) {
  const normalizedSportKey = toSafeString(sportKey);
  if (!normalizedSportKey || !process.env.ODDS_API_KEY) return [];
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${normalizedSportKey}/scores?apiKey=${process.env.ODDS_API_KEY}&daysFrom=4`;
    const resp = await axios.get(url, { timeout: 12000 });
    return Array.isArray(resp?.data) ? resp.data : [];
  } catch {
    return [];
  }
}
function resolveBestScoreRow(rows, { home, away, explicitEventId }) {
  const normalizedEventId = toSafeString(explicitEventId);
  const sourceRows = Array.isArray(rows) ? rows : [];
  let bestMatch = null;
  let bestScore = -1;
  for (const row of sourceRows) {
    if (!row) continue;
    if (normalizedEventId && String(row.id || '') === normalizedEventId) {
      return { row, score: 100 };
    }
    const homeScore = scoreNameMatch(home, row.home_team);
    const awayScore = scoreNameMatch(away, row.away_team);
    const candidateScore = homeScore + awayScore;
    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      bestMatch = row;
    }
  }
  return { row: bestMatch, score: bestScore };
}
function buildOfficialScoreFallbackKeys({ primarySportKey, league, sport, home, away }) {
  const keys = [];
  const primary = toSafeString(primarySportKey) || resolveSportKeyFromContext({ sportKey: primarySportKey, league, sport });
  if (primary) keys.push(primary);
  if (primary.startsWith('soccer_') || looksLikeLigaMxContext({ league, sport, home, away })) {
    buildSoccerScoreSearchKeys(primary || 'soccer_mexico_ligamx', { league, sport, home, away }).forEach((key) => keys.push(key));
  }
  [
    'basketball_nba',
    'baseball_mlb',
    'americanfootball_nfl',
    'icehockey_nhl'
  ].forEach((key) => keys.push(key));
  return Array.from(new Set(keys.filter(Boolean)));
}
async function findCompletedOfficialScoreFallback({ league, sport, sportKey, home, away, explicitEventId = '' }) {
  const fallbackKeys = buildOfficialScoreFallbackKeys({ primarySportKey: sportKey, league, sport, home, away });
  let bestCandidate = null;
  let bestCandidateScore = -1;
  for (const candidateSportKey of fallbackKeys) {
    const rows = await fetchScoreRowsBySportKey(candidateSportKey);
    if (!rows.length) continue;
    const { row, score } = resolveBestScoreRow(rows, { home, away, explicitEventId });
    if (!row || score < 2) continue;
    const scores = Array.isArray(row.scores) ? row.scores : [];
    const homeScoreEntry = scores.find((item) => toSafeString(item?.name) === toSafeString(row.home_team));
    const awayScoreEntry = scores.find((item) => toSafeString(item?.name) === toSafeString(row.away_team));
    const homeScore = toSafeNumber(homeScoreEntry?.score);
    const awayScore = toSafeNumber(awayScoreEntry?.score);
    if (homeScore === null || awayScore === null) continue;
    const candidate = {
      eventId: toSafeString(row.id),
      sportKey: candidateSportKey,
      home: toSafeString(row.home_team),
      away: toSafeString(row.away_team),
      homeScore,
      awayScore,
      completed: Boolean(row.completed),
      matchScore: score,
      commenceTime: toSafeString(row.commence_time),
      raw: row
    };
    if (candidate.completed) return candidate;
    if (score > bestCandidateScore) {
      bestCandidate = candidate;
      bestCandidateScore = score;
    }
  }
  return bestCandidate;
}

function resolveSecondarySportCode({ sportKey, sport, league }) {
  const merged = `${toSafeString(sportKey)} ${toSafeString(sport)} ${toSafeString(league)}`.toLowerCase();
  if (merged.includes('basketball') || merged.includes('nba')) return 'basketball';
  if (merged.includes('baseball') || merged.includes('mlb')) return 'baseball';
  if (merged.includes('americanfootball') || merged.includes('nfl')) return 'american-football';
  if (merged.includes('soccer') || merged.includes('futbol')) return 'football';
  return '';
}

function normalizeSide(value) {
  const token = normalizeToken(value);
  if (!token) return '';
  if (token.includes('home') || token.includes('local')) return 'home';
  if (token.includes('away') || token.includes('visit')) return 'away';
  if (token.includes('over') || token.includes('mas')) return 'over';
  if (token.includes('under') || token.includes('menos')) return 'under';
  if (token.includes('yes') || token.includes('si')) return 'yes';
  if (token.includes('no')) return 'no';
  return token.replace(/\s+/g, '_');
}

function normalizeMarketType(value, betType = '') {
  const token = normalizeToken(value);
  const normalizedBetType = normalizeToken(betType);
  if (normalizedBetType === 'parlay') return 'parlay';
  if (token.includes('player') || token.includes('prop')) return 'player_prop';
  if (token.includes('spread') || token.includes('handicap')) return 'spread';
  if (token.includes('team total')) return 'team_total';
  if (token.includes('total') || token.includes('over') || token.includes('under')) return 'total';
  if (token.includes('moneyline') || token.includes('ganador') || token.includes('winner')) return 'moneyline';
  if (token.includes('both teams to score') || token.includes('btts')) return 'both_teams_to_score';
  return token || 'moneyline';
}

function normalizeStatType(value) {
  const token = normalizeToken(value).replace(/\s+/g, '_');
  if (!token) return '';
  const aliases = Object.entries(PROP_STAT_ALIASES);
  for (const [statType, possibleAliases] of aliases) {
    if (token === statType) return statType;
    if (possibleAliases.some((alias) => token.includes(alias))) return statType;
  }
  return token;
}
function formatAiOutcomeLabel(outcome) {
  const normalized = String(outcome || '').trim().toUpperCase();
  if (normalized === 'GANADO') return 'GANADO';
  if (normalized === 'PERDIDO') return 'PERDIDO';
  if (normalized === 'VOID') return 'VOID';
  if (normalized === 'PENDIENTE') return 'PENDIENTE';
  return 'NECESITA_VERIFICACION';
}
function buildAiArgumentSummary({ aiAnalysis, bet }) {
  const outcomeLabel = formatAiOutcomeLabel(aiAnalysis?.resultado);
  const confidence = clampNumber(aiAnalysis?.confianza ?? 0, 0, 100, 0);
  const marketType = normalizeMarketType(bet?.marketType, bet?.betType);
  const selection = toSafeString(bet?.selectionLabel || bet?.selection) || 'selección no identificada';
  const detail = toSafeString(aiAnalysis?.detalle || 'Sin detalle de validación');
  const reviewTag = aiAnalysis?.needsReview ? ' · requiere revisión admin' : '';
  return `Dictamen IA: ${outcomeLabel} (${confidence}%) · Mercado: ${marketType || 'desconocido'} · Selección: ${selection} · Argumento: ${detail}${reviewTag}`.slice(0, 420);
}
function scoreBetExtractionQuality(bet, ocrMeta) {
  const normalizedBet = bet && typeof bet === 'object' ? bet : {};
  const fields = [
    Boolean(toSafeString(normalizedBet.marketType)),
    Boolean(toSafeString(normalizedBet.selection) || toSafeString(normalizedBet.selectionLabel)),
    Boolean(toSafeString(normalizedBet.side)),
    toSafeNumber(normalizedBet.line) !== null || normalizeMarketType(normalizedBet.marketType, normalizedBet.betType) === 'moneyline',
    Boolean(toSafeString(normalizedBet.homeTeam)),
    Boolean(toSafeString(normalizedBet.awayTeam))
  ];
  const filledRatio = fields.filter(Boolean).length / fields.length;
  const structureScore = Math.round(filledRatio * 70);
  const normalizedOcrStatus = toSafeString(ocrMeta?.status).toLowerCase();
  const normalizedOcrConfidence = clampNumber(ocrMeta?.confidence ?? 0, 0, 100, 0);
  let ocrScore = 15;
  if (normalizedOcrStatus === 'parsed') ocrScore = Math.round((normalizedOcrConfidence / 100) * 30);
  if (normalizedOcrStatus === 'failed') ocrScore = 5;
  const sourceToken = toSafeString(normalizedBet.source).toLowerCase();
  const sourceBonus = sourceToken.includes('ocr') ? 0 : 10;
  return clampNumber(structureScore + ocrScore + sourceBonus, 0, 100, 0);
}
function buildConfidenceBreakdown({ bet, ocrMeta, score, resolution, marketType }) {
  const extractionQuality = scoreBetExtractionQuality(bet, ocrMeta);
  const eventMatchQuality = clampNumber(
    score?.matchScore !== undefined && score?.matchScore !== null
      ? Math.round((Number(score.matchScore) / 10) * 100)
      : (resolution?.eventMatchScore !== undefined && resolution?.eventMatchScore !== null
        ? Math.round((Number(resolution.eventMatchScore) / 10) * 100)
        : 0),
    0,
    100,
    0
  );
  let officialDataQuality = 0;
  if (marketType === 'player_prop') {
    officialDataQuality = clampNumber(resolution?.officialDataQuality ?? (resolution?.resultado === 'NECESITA_VERIFICACION' ? 35 : 88), 0, 100, 0);
  } else if (score?.completed && toSafeNumber(score?.homeScore) !== null && toSafeNumber(score?.awayScore) !== null) {
    officialDataQuality = 90;
  } else if (score?.completed) {
    officialDataQuality = 55;
  } else if (score) {
    officialDataQuality = 25;
  }
  return {
    extractionQuality,
    eventMatchQuality,
    officialDataQuality
  };
}
function applyReliabilityGuardsToResolution(resolution, confidenceBreakdown) {
  const baseResolution = resolution && typeof resolution === 'object' ? { ...resolution } : {};
  const extractionQuality = clampNumber(confidenceBreakdown?.extractionQuality ?? 0, 0, 100, 0);
  const eventMatchQuality = clampNumber(confidenceBreakdown?.eventMatchQuality ?? 0, 0, 100, 0);
  const officialDataQuality = clampNumber(confidenceBreakdown?.officialDataQuality ?? 0, 0, 100, 0);
  const weakestLink = Math.min(extractionQuality, eventMatchQuality, officialDataQuality);
  if (['GANADO', 'PERDIDO', 'VOID'].includes(String(baseResolution?.resultado || '').toUpperCase())) {
    const cappedConfidence = clampNumber(Math.min(baseResolution?.confianza ?? 0, weakestLink + 20), 0, 100, 0);
    baseResolution.confianza = cappedConfidence;
    if (officialDataQuality < 50 || eventMatchQuality < 45 || extractionQuality < 45) {
      baseResolution.resultado = 'NECESITA_VERIFICACION';
      baseResolution.needsReview = true;
      baseResolution.detalle = `${toSafeString(baseResolution.detalle)} | Dictamen degradado por baja fiabilidad (extract:${extractionQuality}, match:${eventMatchQuality}, official:${officialDataQuality}).`.slice(0, 420);
      return baseResolution;
    }
    if (extractionQuality < 60 || eventMatchQuality < 60 || officialDataQuality < 70) {
      baseResolution.needsReview = true;
      baseResolution.detalle = `${toSafeString(baseResolution.detalle)} | Requiere revisión por fiabilidad parcial (extract:${extractionQuality}, match:${eventMatchQuality}, official:${officialDataQuality}).`.slice(0, 420);
    }
  }
  return baseResolution;
}

function extractJsonObject(text) {
  const raw = toSafeString(text);
  if (!raw) return null;
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last < 0 || last <= first) return null;
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    return null;
  }
}

function parseDataUrlImage(dataUrl) {
  const match = toSafeString(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}
async function extractTextWithGoogleVisionFromTicket(ticketImg) {
  if (!GOOGLE_VISION_KEY) {
    return { text: '', confidence: 0, status: 'failed', warnings: ['GOOGLE_VISION_KEY no configurado'] };
  }
  const parsedImage = parseDataUrlImage(ticketImg);
  if (!parsedImage?.data) {
    return { text: '', confidence: 0, status: 'failed', warnings: ['ticketImg no válido para Google Vision'] };
  }
  try {
    const response = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_KEY}`,
      {
        requests: [{
          image: { content: parsedImage.data },
          features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
        }]
      },
      { timeout: 20000 }
    );
    const visionPayload = response?.data?.responses?.[0] || {};
    const extractedText = toSafeString(
      visionPayload?.fullTextAnnotation?.text ||
      visionPayload?.textAnnotations?.[0]?.description ||
      ''
    );
    if (!extractedText) {
      return { text: '', confidence: 0, status: 'failed', warnings: ['Google Vision no detectó texto'] };
    }
    return {
      text: extractedText.slice(0, 16000),
      confidence: 82,
      status: 'parsed',
      warnings: []
    };
  } catch (error) {
    return {
      text: '',
      confidence: 0,
      status: 'failed',
      warnings: [error?.message || 'Error en Google Vision']
    };
  }
}
async function compareTicketVsOfficialWithClaude({ pick, ticketText, officialScore }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 0,
      detalle: 'ANTHROPIC_API_KEY no configurado'
    };
  }
  const prompt = `Compara ticket vs resultado oficial y responde SOLO JSON válido con:
{"resultado":"GANADO|PERDIDO|VOID|NECESITA_VERIFICACION","confianza":0-100,"detalle":"explicacion breve"}
Datos pick:
- match: ${toSafeString(pick?.match)}
- league: ${toSafeString(pick?.league)}
- odds: ${toSafeString(pick?.odds)}
- time: ${toSafeString(pick?.time)}
Texto OCR del ticket:
${toSafeString(ticketText).slice(0, 6000)}
Resultado oficial:
- home: ${toSafeString(officialScore?.home)}
- away: ${toSafeString(officialScore?.away)}
- homeScore: ${officialScore?.homeScore ?? null}
- awayScore: ${officialScore?.awayScore ?? null}
- completed: ${Boolean(officialScore?.completed)}
Si no alcanza evidencia suficiente, usa NECESITA_VERIFICACION.`;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 450,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });
    const answer = Array.isArray(response?.content)
      ? response.content.map((chunk) => chunk?.text || '').join('\n')
      : '';
    const parsed = extractJsonObject(answer) || {};
    return {
      resultado: formatAiOutcomeLabel(parsed?.resultado),
      confianza: clampNumber(parsed?.confianza ?? 0, 0, 100, 0),
      detalle: toSafeString(parsed?.detalle || 'Comparación IA sin detalle').slice(0, 400),
      raw: toSafeString(answer).slice(0, 2000)
    };
  } catch (error) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 0,
      detalle: toSafeString(error?.message || 'Error de análisis Claude').slice(0, 400)
    };
  }
}
async function analyzePickImage(pick) {
  const [matchHome, matchAway] = splitMatchTeams(pick?.match);
  const baseBet = buildBetFromPick(pick);
  const homeTeam = baseBet?.homeTeam || matchHome || '';
  const awayTeam = baseBet?.awayTeam || matchAway || '';
  let officialScore = await getMatchScore(
    pick?.league,
    homeTeam,
    awayTeam,
    baseBet?.sportKey || pick?.sportKey,
    baseBet?.eventId || ''
  );
  if (!officialScore?.completed) {
    const fallbackOfficialScore = await findCompletedOfficialScoreFallback({
      league: pick?.league,
      sport: pick?.sport || baseBet?.sport,
      sportKey: baseBet?.sportKey || pick?.sportKey,
      home: homeTeam,
      away: awayTeam,
      explicitEventId: baseBet?.eventId || ''
    });
    if (fallbackOfficialScore) officialScore = fallbackOfficialScore;
  }
  if (!officialScore?.completed) {
    return {
      resultado: 'PENDIENTE',
      confianza: 20,
      detalle: 'Partido aún no finalizado o sin marcador oficial definitivo.',
      needsReview: false,
      officialScore,
      ocr: { status: 'not_attempted', confidence: 0, warnings: ['Evento no finalizado'] }
    };
  }
  const ocr = await extractTextWithGoogleVisionFromTicket(pick?.ticketImg);
  if (!toSafeString(ocr?.text)) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 25,
      detalle: 'No se pudo extraer texto del ticket con Google Vision.',
      needsReview: true,
      officialScore,
      ocr
    };
  }
  const claudeVerdict = await compareTicketVsOfficialWithClaude({
    pick,
    ticketText: ocr.text,
    officialScore
  });
  return {
    resultado: formatAiOutcomeLabel(claudeVerdict?.resultado),
    confianza: clampNumber(claudeVerdict?.confianza ?? 0, 0, 100, 0),
    detalle: toSafeString(claudeVerdict?.detalle || 'Sin detalle'),
    needsReview: clampNumber(claudeVerdict?.confianza ?? 0, 0, 100, 0) < 85,
    officialScore,
    ocr,
    raw: claudeVerdict?.raw || ''
  };
}
async function analyzePickImageAndPersist(pick) {
  const pickDoc = (pick && typeof pick.save === 'function')
    ? pick
    : await findPickByIdentifier(pick?._id || pick?.id);
  if (!pickDoc) throw new Error('pick_not_found');
  const analysis = await analyzePickImage(pickDoc);
  const mappedResult = mapAiOutcomeToPickResult(analysis?.resultado);
  const shouldApprove = Boolean(mappedResult && Number(analysis?.confianza || 0) >= 85);
  const aiAnalysis = {
    resultado: analysis?.resultado || 'NECESITA_VERIFICACION',
    confianza: clampNumber(analysis?.confianza ?? 0, 0, 100, 0),
    detalle: toSafeString(analysis?.detalle || 'Sin detalle'),
    source: 'google-vision+odds-api+claude',
    needsReview: Boolean(analysis?.needsReview ?? !shouldApprove),
    ocr: {
      status: toSafeString(analysis?.ocr?.status) || 'failed',
      confidence: clampNumber(analysis?.ocr?.confidence ?? 0, 0, 100, 0),
      warnings: Array.isArray(analysis?.ocr?.warnings) ? analysis.ocr.warnings.slice(0, 8) : [],
      textSnippet: toSafeString(analysis?.ocr?.text || '').slice(0, 1200)
    },
    officialScore: analysis?.officialScore ? {
      home: toSafeString(analysis.officialScore.home),
      away: toSafeString(analysis.officialScore.away),
      homeScore: toSafeNumber(analysis.officialScore.homeScore),
      awayScore: toSafeNumber(analysis.officialScore.awayScore),
      completed: Boolean(analysis.officialScore.completed)
    } : null
  };
  const verificationStatus = shouldApprove
    ? 'closed_auto'
    : aiAnalysis.resultado === 'PENDIENTE'
      ? 'pending_data'
      : 'needs_review';
  const verification = {
    ...(pickDoc?.verification || {}),
    status: verificationStatus,
    preliminaryResult: aiAnalysis.resultado,
    confidence: aiAnalysis.confianza,
    needsReview: aiAnalysis.needsReview,
    summary: buildAiArgumentSummary({ aiAnalysis, bet: pickDoc?.bet || buildBetFromPick(pickDoc) }),
    lastAnalyzedAt: new Date(),
    lastClosedAt: shouldApprove ? new Date() : (pickDoc?.verification?.lastClosedAt || null),
    engineVersion: AI_ENGINE_VERSION,
    ocr: {
      status: aiAnalysis?.ocr?.status || 'failed',
      confidence: aiAnalysis?.ocr?.confidence || 0,
      parsedAt: aiAnalysis?.ocr?.status === 'parsed' ? new Date() : null,
      warnings: aiAnalysis?.ocr?.warnings || [],
      raw: { provider: 'google-vision', textSnippet: aiAnalysis?.ocr?.textSnippet || '' }
    }
  };
  pickDoc.set('aiAnalysis', aiAnalysis);
  pickDoc.set('verification', verification);
  if (shouldApprove) {
    pickDoc.set('result', mappedResult);
  }
  const updated = await pickDoc.save();
  if (shouldApprove && pickDoc?.tipsterId) {
    await safeRecalculateTipsterStats(pickDoc.tipsterId, `analyzePickImageAndPersist:${pickDoc?._id}`);
  }
  return updated;
}

function buildProviderTrace(provider, endpoint, ok, message, extra = {}) {
  return {
    provider,
    endpoint,
    ok: Boolean(ok),
    message: toSafeString(message),
    at: new Date().toISOString(),
    ...extra
  };
}

function formatDateYmd(dateLike) {
  const parsed = new Date(dateLike);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function buildDateCandidates(eventDate) {
  const baseDate = formatDateYmd(eventDate) || formatDateYmd(new Date());
  const parsed = new Date(baseDate);
  const candidates = [baseDate];
  [-1, 1].forEach((offset) => {
    const copy = new Date(parsed);
    copy.setDate(copy.getDate() + offset);
    candidates.push(formatDateYmd(copy));
  });
  return Array.from(new Set(candidates.filter(Boolean)));
}

function buildBetFromPick(pickLike = {}) {
  const rawBet = (pickLike && typeof pickLike.bet === 'object' && pickLike.bet) ? pickLike.bet : {};
  const [matchHome, matchAway] = splitMatchTeams(rawBet.match || pickLike.match);
  const betType = normalizeToken(rawBet.betType || pickLike.betType || (String(pickLike.league || '').toLowerCase().includes('parlay') ? 'parlay' : 'straight'));
  const marketType = normalizeMarketType(rawBet.marketType || rawBet.marketKey || rawBet.selection || '', betType);
  return {
    betType,
    marketType,
    marketKey: toSafeString(rawBet.marketKey || rawBet.marketType),
    selection: toSafeString(rawBet.selection || pickLike.selection),
    selectionLabel: toSafeString(rawBet.selectionLabel || pickLike.selectionLabel),
    side: normalizeSide(rawBet.side || pickLike.side || rawBet.selection),
    line: toSafeNumber(rawBet.line ?? pickLike.line),
    playerName: toSafeString(rawBet.playerName || pickLike.playerName),
    statType: normalizeStatType(rawBet.statType || pickLike.statType || rawBet.marketKey),
    eventId: toSafeString(rawBet.eventId || pickLike.eventId),
    eventDate: toSafeString(rawBet.eventDate || pickLike.time),
    homeTeam: toSafeString(rawBet.homeTeam || matchHome),
    awayTeam: toSafeString(rawBet.awayTeam || matchAway),
    bookmaker: toSafeString(rawBet.bookmaker || pickLike.bookmaker),
    source: toSafeString(rawBet.source || 'manual'),
    confidence: clampNumber(rawBet.confidence ?? 0, 0, 100, 0),
    sportKey: resolveSportKeyFromContext({
      sportKey: rawBet.sportKey || pickLike.sportKey,
      league: rawBet.league || pickLike.league,
      sport: rawBet.sport || pickLike.sport
    }),
    sport: toSafeString(rawBet.sport || pickLike.sport)
  };
}

function mergeBetData(baseBet, incomingBet = {}) {
  const merged = { ...(baseBet || {}) };
  const allowedKeys = [
    'betType', 'marketType', 'marketKey', 'selection', 'selectionLabel', 'side', 'line', 'playerName',
    'statType', 'eventId', 'eventDate', 'homeTeam', 'awayTeam', 'bookmaker', 'source', 'confidence', 'sportKey', 'sport'
  ];
  for (const key of allowedKeys) {
    const incomingValue = incomingBet?.[key];
    if (incomingValue === undefined || incomingValue === null || incomingValue === '') continue;
    merged[key] = incomingValue;
  }
  if (baseBet?.source && incomingBet?.source && baseBet.source !== incomingBet.source) {
    merged.source = `${baseBet.source}+${incomingBet.source}`;
  }
  merged.marketType = normalizeMarketType(merged.marketType, merged.betType);
  merged.side = normalizeSide(merged.side || merged.selection);
  merged.statType = normalizeStatType(merged.statType || merged.marketKey);
  merged.confidence = clampNumber(merged.confidence, 0, 100, 0);
  return merged;
}

function inferSideFromSelectionLabel(selectionLabel, homeTeam, awayTeam) {
  const label = toSafeString(selectionLabel);
  if (!label) return '';
  const normalized = normalizeTeamName(label);
  const homeScore = scoreNameMatch(homeTeam, normalized);
  const awayScore = scoreNameMatch(awayTeam, normalized);
  if (homeScore > awayScore && homeScore > 0) return 'home';
  if (awayScore > homeScore && awayScore > 0) return 'away';
  return '';
}

function getWinnerSide(homeScore, awayScore) {
  if (homeScore > awayScore) return 'home';
  if (awayScore > homeScore) return 'away';
  return 'draw';
}

function resolveStandardMarket(bet, score) {
  const evidence = [];
  if (!score) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 25,
      detalle: 'No se pudo obtener marcador oficial para este evento.',
      needsReview: true,
      evidence
    };
  }
  if (!score.completed) {
    return {
      resultado: 'PENDIENTE',
      confianza: 15,
      detalle: 'El evento todavía no está finalizado.',
      needsReview: false,
      evidence
    };
  }
  const homeScore = toSafeNumber(score.homeScore);
  const awayScore = toSafeNumber(score.awayScore);
  if (homeScore === null || awayScore === null) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 30,
      detalle: 'Marcador final incompleto en fuente oficial.',
      needsReview: true,
      evidence
    };
  }
  const marketType = normalizeMarketType(bet?.marketType, bet?.betType);
  const scoreProvider = toSafeString(score?.source) === 'api-sports-football' ? 'api-sports' : 'odds-api';
  evidence.push({
    provider: scoreProvider,
    type: 'score',
    detail: `${score.home} ${homeScore} - ${awayScore} ${score.away} (${scoreProvider})`,
    value: { homeScore, awayScore, source: scoreProvider }
  });
  if (marketType === 'parlay') {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 20,
      detalle: 'Parlay requiere verificación manual por múltiples selecciones.',
      needsReview: true,
      evidence
    };
  }
  if (marketType === 'moneyline') {
    let expectedSide = normalizeSide(bet?.side || bet?.selection);
    if (!['home', 'away'].includes(expectedSide)) {
      expectedSide = inferSideFromSelectionLabel(`${bet?.selectionLabel || ''} ${bet?.selection || ''}`, score.home, score.away);
    }
    if (!['home', 'away'].includes(expectedSide)) {
      return {
        resultado: 'NECESITA_VERIFICACION',
        confianza: 35,
        detalle: 'No se pudo identificar equipo seleccionado en moneyline.',
        needsReview: true,
        evidence
      };
    }
    const winnerSide = getWinnerSide(homeScore, awayScore);
    if (winnerSide === 'draw') {
      return {
        resultado: 'VOID',
        confianza: 80,
        detalle: 'Empate detectado, market moneyline marcado como VOID.',
        needsReview: false,
        evidence
      };
    }
    return {
      resultado: winnerSide === expectedSide ? 'GANADO' : 'PERDIDO',
      confianza: 88,
      detalle: winnerSide === expectedSide ? 'Moneyline coincide con marcador final.' : 'Moneyline no coincide con marcador final.',
      needsReview: false,
      evidence
    };
  }
  if (marketType === 'spread') {
    const line = toSafeNumber(bet?.line);
    let side = normalizeSide(bet?.side || bet?.selection);
    if (!['home', 'away'].includes(side)) {
      side = inferSideFromSelectionLabel(`${bet?.selectionLabel || ''} ${bet?.selection || ''}`, score.home, score.away);
    }
    if (line === null || !['home', 'away'].includes(side)) {
      return {
        resultado: 'NECESITA_VERIFICACION',
        confianza: 35,
        detalle: 'Spread requiere lado (home/away) y línea numérica.',
        needsReview: true,
        evidence
      };
    }
    const adjustedHome = side === 'home' ? homeScore + line : homeScore;
    const adjustedAway = side === 'away' ? awayScore + line : awayScore;
    if (adjustedHome === adjustedAway) {
      return {
        resultado: 'VOID',
        confianza: 82,
        detalle: 'Resultado exacto al spread, se marca como VOID.',
        needsReview: false,
        evidence
      };
    }
    const won = (side === 'home' && adjustedHome > adjustedAway) || (side === 'away' && adjustedAway > adjustedHome);
    return {
      resultado: won ? 'GANADO' : 'PERDIDO',
      confianza: 86,
      detalle: won ? 'Spread cubierto según marcador final.' : 'Spread no cubierto según marcador final.',
      needsReview: false,
      evidence
    };
  }
  if (marketType === 'total') {
    const line = toSafeNumber(bet?.line);
    const side = normalizeSide(bet?.side || bet?.selection);
    if (line === null || !['over', 'under'].includes(side)) {
      return {
        resultado: 'NECESITA_VERIFICACION',
        confianza: 35,
        detalle: 'Total requiere línea numérica y selección over/under.',
        needsReview: true,
        evidence
      };
    }
    const total = homeScore + awayScore;
    if (total === line) {
      return {
        resultado: 'VOID',
        confianza: 84,
        detalle: `Total exacto (${total}) igual a línea (${line}).`,
        needsReview: false,
        evidence
      };
    }
    const won = (side === 'over' && total > line) || (side === 'under' && total < line);
    return {
      resultado: won ? 'GANADO' : 'PERDIDO',
      confianza: 86,
      detalle: won ? `Total ${side} acertado (${total} vs ${line}).` : `Total ${side} fallado (${total} vs ${line}).`,
      needsReview: false,
      evidence
    };
  }
  if (marketType === 'team_total') {
    const line = toSafeNumber(bet?.line);
    let side = normalizeSide(bet?.side || bet?.selection);
    if (!['home', 'away'].includes(side)) {
      side = inferSideFromSelectionLabel(`${bet?.selectionLabel || ''} ${bet?.selection || ''}`, score.home, score.away);
    }
    const ouSide = normalizeSide(bet?.selection || bet?.side);
    if (line === null || !['home', 'away'].includes(side) || !['over', 'under'].includes(ouSide)) {
      return {
        resultado: 'NECESITA_VERIFICACION',
        confianza: 35,
        detalle: 'Team total requiere equipo, over/under y línea.',
        needsReview: true,
        evidence
      };
    }
    const selectedScore = side === 'home' ? homeScore : awayScore;
    if (selectedScore === line) {
      return {
        resultado: 'VOID',
        confianza: 82,
        detalle: 'Team total exacto, se marca VOID.',
        needsReview: false,
        evidence
      };
    }
    const won = (ouSide === 'over' && selectedScore > line) || (ouSide === 'under' && selectedScore < line);
    return {
      resultado: won ? 'GANADO' : 'PERDIDO',
      confianza: 86,
      detalle: won ? 'Team total acertado.' : 'Team total fallado.',
      needsReview: false,
      evidence
    };
  }
  if (marketType === 'both_teams_to_score') {
    const side = normalizeSide(bet?.side || bet?.selection);
    if (!['yes', 'no'].includes(side)) {
      return {
        resultado: 'NECESITA_VERIFICACION',
        confianza: 35,
        detalle: 'BTTS requiere selección sí/no.',
        needsReview: true,
        evidence
      };
    }
    const bothScored = homeScore > 0 && awayScore > 0;
    const won = (side === 'yes' && bothScored) || (side === 'no' && !bothScored);
    return {
      resultado: won ? 'GANADO' : 'PERDIDO',
      confianza: 87,
      detalle: won ? 'BTTS validado con marcador oficial.' : 'BTTS no coincide con marcador oficial.',
      needsReview: false,
      evidence
    };
  }
  return {
    resultado: 'NECESITA_VERIFICACION',
    confianza: 30,
    detalle: `Mercado no soportado automáticamente: ${marketType || 'desconocido'}.`,
    needsReview: true,
    evidence
  };
}

async function resolveAiVerdictFallbackForStandardMarket({ pick, bet, score, baseResolution, ocrMeta, oddsSignal = null }) {
  const base = baseResolution && typeof baseResolution === 'object' ? baseResolution : {};
  const baseOutcome = String(base.resultado || '').trim().toUpperCase();
  if (['GANADO', 'PERDIDO', 'VOID'].includes(baseOutcome)) return base;
  if (!score?.completed) return base;
  if (!process.env.ANTHROPIC_API_KEY) return base;

  const prompt = `Eres un árbitro de apuestas deportivas.
Debes responder SOLO JSON válido con:
{
  "resultado":"GANADO|PERDIDO|VOID|NECESITA_VERIFICACION",
  "confianza":0-100,
  "detalle":"explicación corta",
  "needsReview":true|false
}
Reglas:
- Si la evidencia alcanza, prioriza GANADO/PERDIDO/VOID.
- Usa NECESITA_VERIFICACION solo si no es posible decidir.

Datos del ticket/pick:
- match: ${toSafeString(pick?.match)}
- league: ${toSafeString(pick?.league)}
- marketType: ${toSafeString(bet?.marketType)}
- selection: ${toSafeString(bet?.selection)}
- selectionLabel: ${toSafeString(bet?.selectionLabel)}
- side: ${toSafeString(bet?.side)}
- line: ${bet?.line ?? null}
- homeTeam: ${toSafeString(bet?.homeTeam)}
- awayTeam: ${toSafeString(bet?.awayTeam)}
- ocrRaw: ${toSafeString(ocrMeta?.raw?.answer || '').slice(0, 2000)}

Resultado oficial:
- home: ${toSafeString(score?.home)}
- away: ${toSafeString(score?.away)}
- homeScore: ${score?.homeScore ?? null}
- awayScore: ${score?.awayScore ?? null}
- completed: ${Boolean(score?.completed)}

Señal de momios (odds):
- available: ${Boolean(oddsSignal?.available)}
- market: ${toSafeString(oddsSignal?.marketType)}
- sampleSize: ${Number(oddsSignal?.sampleSize || 0)}
- marketPrice: ${oddsSignal?.marketPrice ?? null}
- ticketOdds: ${oddsSignal?.ticketOdds ?? null}
- delta: ${oddsSignal?.ticketVsMarketDelta ?? null}
- summary: ${toSafeString(oddsSignal?.summary)}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 450,
      cache_control: { type: 'ephemeral' },
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });
    const answer = Array.isArray(response?.content)
      ? response.content.map((chunk) => chunk?.text || '').join('\n')
      : '';
    const parsed = extractJsonObject(answer);
    const resultado = String(parsed?.resultado || '').trim().toUpperCase();
    if (!['GANADO', 'PERDIDO', 'VOID', 'NECESITA_VERIFICACION'].includes(resultado)) return base;

    const confianza = clampNumber(parsed?.confianza ?? 0, 0, 100, 0);
    const detalle = toSafeString(parsed?.detalle || 'Dictamen IA sin detalle');
    const needsReview = Boolean(parsed?.needsReview);

    return {
      ...base,
      resultado,
      confianza,
      detalle,
      needsReview,
      evidence: [
        ...(Array.isArray(base?.evidence) ? base.evidence : []),
        {
          provider: 'anthropic',
          type: 'ai-verdict-fallback',
          detail: detalle,
          value: { resultado, confianza, needsReview }
        }
      ]
    };
  } catch {
    return base;
  }
}

async function extractTicketBetWithVision(pick, currentBet) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { bet: null, meta: { status: 'not_attempted', confidence: 0, warnings: ['ANTHROPIC_API_KEY no configurado'] } };
  }
  if (!toSafeString(pick?.ticketImg)) {
    return { bet: null, meta: { status: 'not_attempted', confidence: 0, warnings: ['Sin ticketImg'] } };
  }
  const parsedImage = parseDataUrlImage(pick.ticketImg);
  if (!parsedImage) {
    return { bet: null, meta: { status: 'failed', confidence: 0, warnings: ['Formato de imagen no soportado para OCR'] } };
  }
  const [homeTeam, awayTeam] = splitMatchTeams(pick.match);
  const prompt = `Extrae la apuesta del ticket y responde SOLO JSON válido con esta forma:
{
  "betType":"straight|parlay|prop",
  "marketType":"moneyline|spread|total|team_total|player_prop|both_teams_to_score|unknown",
  "selection":"texto exacto de selección",
  "selectionLabel":"texto legible",
  "side":"home|away|over|under|yes|no|unknown",
  "line":numero_o_null,
  "playerName":"string_o_vacio",
  \"statType\":\"points|rebounds|assists|hits|runs|rbi|home_runs|strikeouts|passing_yards|rushing_yards|receiving_yards|touchdowns|goals|shots|shots_on_target|saves|corners|yellow_cards|red_cards|cards_total|fouls|offsides|unknown\",
  "bookmaker":"string_o_vacio",
  "homeTeam":"string_o_vacio",
  "awayTeam":"string_o_vacio",
  "sport":"string_o_vacio",
  "sportKey":"string_o_vacio",
  "confidence":0-100,
  "warnings":["..."]
}
Contexto pick:
- match: ${pick.match || ''}
- league: ${pick.league || ''}
- sportKey: ${pick.sportKey || ''}
- home sugerido: ${homeTeam || ''}
- away sugerido: ${awayTeam || ''}
Si no sabes un campo, usa null o string vacío según aplique.`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsedImage.mediaType,
              data: parsedImage.data
            }
          }
        ]
      }]
    });
    const answer = Array.isArray(resp?.content)
      ? resp.content.map((chunk) => chunk?.text || '').join('\n')
      : '';
    const parsed = extractJsonObject(answer);
    if (!parsed) {
      return { bet: null, meta: { status: 'failed', confidence: 0, warnings: ['No se pudo parsear JSON de OCR'] } };
    }
    const ocrBet = mergeBetData(currentBet, {
      betType: normalizeToken(parsed.betType),
      marketType: normalizeMarketType(parsed.marketType, parsed.betType),
      marketKey: toSafeString(parsed.marketType || parsed.marketKey),
      selection: toSafeString(parsed.selection),
      selectionLabel: toSafeString(parsed.selectionLabel),
      side: normalizeSide(parsed.side || parsed.selection),
      line: toSafeNumber(parsed.line),
      playerName: toSafeString(parsed.playerName),
      statType: normalizeStatType(parsed.statType),
      eventDate: toSafeString(parsed.eventDate || currentBet?.eventDate),
      homeTeam: toSafeString(parsed.homeTeam || currentBet?.homeTeam),
      awayTeam: toSafeString(parsed.awayTeam || currentBet?.awayTeam),
      bookmaker: toSafeString(parsed.bookmaker),
      sport: toSafeString(parsed.sport || currentBet?.sport),
      sportKey: resolveSportKeyFromContext({
        sportKey: parsed.sportKey || currentBet?.sportKey,
        league: pick?.league,
        sport: parsed.sport || currentBet?.sport
      }),
      source: 'ocr',
      confidence: clampNumber(parsed.confidence, 0, 100, 55)
    });
    return {
      bet: ocrBet,
      meta: {
        status: 'parsed',
        confidence: clampNumber(parsed.confidence, 0, 100, 55),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map((item) => String(item)) : [],
        raw: { model: 'claude-haiku-4-5-20251001', answer: answer.slice(0, 4000) }
      }
    };
  } catch (error) {
    return {
      bet: null,
      meta: {
        status: 'failed',
        confidence: 0,
        warnings: [error.message || 'Error OCR'],
        raw: { error: error.message || 'Error OCR' }
      }
    };
  }
}

function extractTeamsFromFootballFixtureRow(row) {
  return {
    home: toSafeString(row?.teams?.home?.name),
    away: toSafeString(row?.teams?.away?.name)
  };
}
function isCompletedFootballFixture(row) {
  const shortStatus = toSafeString(row?.fixture?.status?.short).toUpperCase();
  if (['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(shortStatus)) return true;
  return false;
}
async function resolveSoccerScoreWithApiSports({ league, home, away, eventDate, explicitEventId = '', fallbackSportKey = 'soccer_epl' }) {
  if (!APISPORTS_KEY) return null;
  const providerTrace = [];
  const candidates = [];
  const dateCandidates = buildDateCandidates(eventDate);
  for (const date of dateCandidates) {
    const payload = await apiSportsGet('football', '/fixtures', { date }, providerTrace);
    const rows = extractApiSportsRows(payload);
    for (const row of rows) {
      const teams = extractTeamsFromFootballFixtureRow(row);
      const candidateScore = scoreNameMatch(home, teams.home) + scoreNameMatch(away, teams.away);
      if (candidateScore > 0) candidates.push({ row, score: candidateScore });
    }
  }
  const sorted = candidates.sort((a, b) => b.score - a.score);
  const best = sorted[0];
  if (!best || best.score < 3) return null;
  const fixture = best.row?.fixture || {};
  const goals = best.row?.goals || {};
  const homeScore = toSafeNumber(goals?.home);
  const awayScore = toSafeNumber(goals?.away);
  if (homeScore === null || awayScore === null) return null;
  const teams = extractTeamsFromFootballFixtureRow(best.row);
  return {
    eventId: toSafeString(fixture?.id || explicitEventId),
    sportKey: fallbackSportKey,
    home: teams.home || home,
    away: teams.away || away,
    homeScore,
    awayScore,
    completed: isCompletedFootballFixture(best.row),
    matchScore: best.score,
    commenceTime: toSafeString(fixture?.date || eventDate),
    raw: best.row,
    source: 'api-sports-football'
  };
}
async function getMatchScore(league, home, away, explicitSportKey, explicitEventId = '') {
  try {
    const sportKey = explicitSportKey || resolveSportKeyFromContext({ sportKey: explicitSportKey, league, sport: '' });
    if (!sportKey || !process.env.ODDS_API_KEY) return null;
    const searchKeys = sportKey.startsWith('soccer_')
      ? buildSoccerScoreSearchKeys(sportKey, { league, sport: '', home, away })
      : [sportKey];
    let bestMatch = null;
    let bestScore = -1;
    let resolvedSportKey = sportKey;
    for (const candidateSportKey of searchKeys) {
      const rows = await fetchScoreRowsBySportKey(candidateSportKey);
      const candidate = resolveBestScoreRow(rows, { home, away, explicitEventId });
      if (candidate?.row && candidate.score > bestScore) {
        bestMatch = candidate.row;
        bestScore = candidate.score;
        resolvedSportKey = candidateSportKey;
      }
      if (candidate?.score >= 100) break;
    }
    if (!bestMatch || (!toSafeString(explicitEventId) && bestScore < 3)) {
      if ((resolvedSportKey || sportKey).startsWith('soccer_')) {
        return await resolveSoccerScoreWithApiSports({
          league,
          home,
          away,
          eventDate: '',
          explicitEventId,
          fallbackSportKey: resolvedSportKey || sportKey
        });
      }
      return null;
    }
    const scores = Array.isArray(bestMatch.scores) ? bestMatch.scores : [];
    const homeScoreEntry = scores.find((item) => toSafeString(item?.name) === toSafeString(bestMatch.home_team));
    const awayScoreEntry = scores.find((item) => toSafeString(item?.name) === toSafeString(bestMatch.away_team));
    const resolvedScore = {
      eventId: toSafeString(bestMatch.id),
      sportKey: resolvedSportKey,
      home: toSafeString(bestMatch.home_team),
      away: toSafeString(bestMatch.away_team),
      homeScore: toSafeNumber(homeScoreEntry?.score),
      awayScore: toSafeNumber(awayScoreEntry?.score),
      completed: Boolean(bestMatch.completed),
      matchScore: bestScore,
      commenceTime: toSafeString(bestMatch.commence_time),
      raw: bestMatch
    };
    if (
      resolvedScore.sportKey.startsWith('soccer_') &&
      (resolvedScore.homeScore === null || resolvedScore.awayScore === null)
    ) {
      const fallback = await resolveSoccerScoreWithApiSports({
        league,
        home,
        away,
        eventDate: resolvedScore.commenceTime,
        explicitEventId,
        fallbackSportKey: resolvedScore.sportKey
      });
      if (fallback) return fallback;
    }
    return resolvedScore;
  } catch {
    return null;
  }
}

const ODDS_EVENT_BOARD_CACHE_TTL_MS = 1000 * 60 * 4;
const oddsEventBoardCache = new Map();

function buildOddsEventBoardCacheKey(sportKey) {
  return String(sportKey || '').trim().toLowerCase();
}

function readOddsEventBoardCache(cacheKey) {
  const hit = oddsEventBoardCache.get(cacheKey);
  if (!hit) return null;
  if ((Date.now() - Number(hit.at || 0)) > ODDS_EVENT_BOARD_CACHE_TTL_MS) {
    oddsEventBoardCache.delete(cacheKey);
    return null;
  }
  return Array.isArray(hit.rows) ? hit.rows : [];
}

function writeOddsEventBoardCache(cacheKey, rows) {
  oddsEventBoardCache.set(cacheKey, {
    rows: Array.isArray(rows) ? rows : [],
    at: Date.now()
  });
}

function averageNumbers(values) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!numeric.length) return null;
  const total = numeric.reduce((acc, value) => acc + value, 0);
  return Number((total / numeric.length).toFixed(3));
}

async function fetchOddsEventBoard(sportKey) {
  const normalizedSportKey = toSafeString(sportKey);
  if (!normalizedSportKey || !process.env.ODDS_API_KEY) return [];
  const cacheKey = buildOddsEventBoardCacheKey(normalizedSportKey);
  const cached = readOddsEventBoardCache(cacheKey);
  if (cached) return cached;
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${normalizedSportKey}/odds?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=decimal&dateFormat=iso`;
    const resp = await axios.get(url, { timeout: 12000 });
    const rows = Array.isArray(resp?.data) ? resp.data : [];
    writeOddsEventBoardCache(cacheKey, rows);
    return rows;
  } catch {
    return [];
  }
}

function resolveOddsEventFromBoard(rows, { eventId, home, away }) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const normalizedEventId = toSafeString(eventId);
  if (normalizedEventId) {
    const byId = normalizedRows.find((row) => String(row?.id || '') === normalizedEventId);
    if (byId) return byId;
  }
  let bestMatch = null;
  let bestScore = -1;
  for (const row of normalizedRows) {
    const candidateScore = scoreNameMatch(home, row?.home_team) + scoreNameMatch(away, row?.away_team);
    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      bestMatch = row;
    }
  }
  return bestMatch;
}

function collectOutcomePricesFromEvent(row, marketKey, matcher) {
  const prices = [];
  const normalizedMarketKey = toSafeString(marketKey);
  const bookmakers = Array.isArray(row?.bookmakers) ? row.bookmakers : [];
  for (const bookmaker of bookmakers) {
    const markets = Array.isArray(bookmaker?.markets) ? bookmaker.markets : [];
    const market = markets.find((item) => toSafeString(item?.key) === normalizedMarketKey);
    if (!market) continue;
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    for (const outcome of outcomes) {
      const price = toSafeNumber(outcome?.price);
      if (price === null || price <= 1) continue;
      if (!matcher || matcher(outcome)) {
        prices.push({ price, point: toSafeNumber(outcome?.point), name: toSafeString(outcome?.name) });
      }
    }
  }
  return prices;
}

function resolveOddsSignalForMarket({ pick, bet, score }) {
  const marketType = normalizeMarketType(bet?.marketType, bet?.betType);
  const ticketOdds = toSafeNumber(pick?.odds);
  const signalBase = {
    available: false,
    marketType,
    sampleSize: 0,
    marketPrice: null,
    ticketOdds: ticketOdds && ticketOdds > 1 ? Number(ticketOdds.toFixed(3)) : null,
    ticketVsMarketDelta: null,
    confidenceAdjustment: 0,
    needsReview: false,
    summary: '',
    evidence: null
  };
  if (!score?.completed) {
    signalBase.summary = 'Evento no finalizado para validar señal de momios.';
    return signalBase;
  }

  let oddsMarketKey = '';
  let selectionLabel = '';
  let targetLine = null;
  let matcher = null;

  if (marketType === 'moneyline') {
    let expectedSide = normalizeSide(bet?.side || bet?.selection);
    if (!['home', 'away'].includes(expectedSide)) {
      expectedSide = inferSideFromSelectionLabel(`${bet?.selectionLabel || ''} ${bet?.selection || ''}`, score.home, score.away);
    }
    if (!['home', 'away'].includes(expectedSide)) {
      signalBase.summary = 'Moneyline sin lado identificable para cruzar momios.';
      return signalBase;
    }
    oddsMarketKey = 'h2h';
    selectionLabel = expectedSide === 'home' ? toSafeString(score?.home) : toSafeString(score?.away);
    matcher = (outcome) => normalizeTeamName(outcome?.name) === normalizeTeamName(selectionLabel);
  } else if (marketType === 'spread') {
    const line = toSafeNumber(bet?.line);
    let side = normalizeSide(bet?.side || bet?.selection);
    if (!['home', 'away'].includes(side)) {
      side = inferSideFromSelectionLabel(`${bet?.selectionLabel || ''} ${bet?.selection || ''}`, score.home, score.away);
    }
    if (line === null || !['home', 'away'].includes(side)) {
      signalBase.summary = 'Spread incompleto para comparar contra momios.';
      return signalBase;
    }
    oddsMarketKey = 'spreads';
    targetLine = line;
    selectionLabel = side === 'home' ? toSafeString(score?.home) : toSafeString(score?.away);
    matcher = (outcome) => {
      const point = toSafeNumber(outcome?.point);
      return normalizeTeamName(outcome?.name) === normalizeTeamName(selectionLabel) && point !== null && Math.abs(point - line) <= 0.25;
    };
  } else if (marketType === 'total') {
    const line = toSafeNumber(bet?.line);
    const side = normalizeSide(bet?.side || bet?.selection);
    if (line === null || !['over', 'under'].includes(side)) {
      signalBase.summary = 'Total incompleto para comparar contra momios.';
      return signalBase;
    }
    oddsMarketKey = 'totals';
    targetLine = line;
    selectionLabel = side;
    matcher = (outcome) => {
      const point = toSafeNumber(outcome?.point);
      return normalizeSide(outcome?.name) === side && point !== null && Math.abs(point - line) <= 0.25;
    };
  } else {
    signalBase.summary = `Mercado ${marketType || 'desconocido'} sin soporte de señal de momios.`;
    return signalBase;
  }

  const prices = collectOutcomePricesFromEvent(score?.oddsEvent, oddsMarketKey, matcher);
  const avgPrice = averageNumbers(prices.map((item) => item.price));
  if (!avgPrice) {
    signalBase.summary = 'No se encontraron momios equivalentes en mercado de cierre.';
    return signalBase;
  }

  let confidenceAdjustment = prices.length >= 4 ? 1 : 0;
  let delta = null;
  let alignment = 'market_only';
  if (signalBase.ticketOdds && signalBase.ticketOdds > 1) {
    delta = Number(Math.abs(signalBase.ticketOdds - avgPrice).toFixed(3));
    if (delta <= 0.2) {
      alignment = 'strong';
      confidenceAdjustment += 4;
    } else if (delta <= 0.45) {
      alignment = 'aligned';
      confidenceAdjustment += 2;
    } else if (delta <= 0.75) {
      alignment = 'weak';
      confidenceAdjustment -= 2;
    } else {
      alignment = 'mismatch';
      confidenceAdjustment -= 8;
    }
  }
  const impliedProbability = avgPrice > 1 ? Number((1 / avgPrice).toFixed(4)) : null;
  const needsReview = alignment === 'mismatch';
  const summary = `momio mercado ${avgPrice} (${prices.length} fuentes), ticket ${signalBase.ticketOdds ?? 'N/A'}, delta ${delta ?? 'N/A'}, alignment ${alignment}`;
  return {
    ...signalBase,
    available: true,
    marketType,
    sampleSize: prices.length,
    marketPrice: avgPrice,
    ticketVsMarketDelta: delta,
    confidenceAdjustment: Math.max(-12, Math.min(8, confidenceAdjustment)),
    needsReview,
    summary,
    evidence: {
      provider: 'odds-api',
      type: 'market-odds-signal',
      detail: summary,
      value: {
        marketType,
        marketKey: oddsMarketKey,
        selection: selectionLabel,
        line: targetLine,
        sampleSize: prices.length,
        marketPrice: avgPrice,
        impliedProbability,
        ticketOdds: signalBase.ticketOdds,
        ticketVsMarketDelta: delta,
        alignment
      }
    }
  };
}

function mergeOddsSignalIntoResolution(baseResolution, oddsSignal) {
  const base = baseResolution && typeof baseResolution === 'object' ? baseResolution : {};
  if (!oddsSignal || !oddsSignal.summary) return base;
  const baseConfidence = clampNumber(base.confianza ?? 0, 0, 100, 0);
  const adjustedConfidence = clampNumber(baseConfidence + Number(oddsSignal.confidenceAdjustment || 0), 0, 100, baseConfidence);
  const detailPrefix = toSafeString(base.detalle || 'Sin detalle');
  const mergedDetail = `${detailPrefix} | Señal odds: ${oddsSignal.summary}`.slice(0, 420);
  return {
    ...base,
    confianza: adjustedConfidence,
    needsReview: Boolean(base.needsReview || oddsSignal.needsReview),
    detalle: mergedDetail,
    evidence: [
      ...(Array.isArray(base?.evidence) ? base.evidence : []),
      ...(oddsSignal?.evidence ? [oddsSignal.evidence] : [])
    ]
  };
}

async function buildOddsSignalForStandardMarket({ pick, bet, score }) {
  if (!score?.completed || !process.env.ODDS_API_KEY) return null;
  try {
    const oddsRows = await fetchOddsEventBoard(score?.sportKey || bet?.sportKey || pick?.sportKey);
    const oddsEvent = resolveOddsEventFromBoard(oddsRows, {
      eventId: score?.eventId || bet?.eventId,
      home: score?.home || bet?.homeTeam,
      away: score?.away || bet?.awayTeam
    });
    if (!oddsEvent) return null;
    const scoreWithOdds = { ...score, oddsEvent };
    return resolveOddsSignalForMarket({ pick, bet, score: scoreWithOdds });
  } catch {
    return null;
  }
}

async function apiSportsGet(sportCode, endpoint, params, providerTrace) {
  if (!APISPORTS_KEY) {
    providerTrace.push(buildProviderTrace('api-sports', endpoint, false, 'APISPORTS_KEY no configurado'));
    return null;
  }
  const baseUrl = APISPORTS_BASE_URLS[sportCode];
  if (!baseUrl) {
    providerTrace.push(buildProviderTrace('api-sports', endpoint, false, `Sport no soportado: ${sportCode}`));
    return null;
  }
  const targetUrl = `${baseUrl}${endpoint}`;
  try {
    const response = await axios.get(targetUrl, {
      params,
      timeout: 12000,
      headers: { 'x-apisports-key': APISPORTS_KEY }
    });
    providerTrace.push(buildProviderTrace('api-sports', `${endpoint}`, true, `HTTP ${response.status}`, { params }));
    return response.data;
  } catch (error) {
    providerTrace.push(buildProviderTrace('api-sports', `${endpoint}`, false, error.message || 'Error provider', { params }));
    return null;
  }
}

function extractApiSportsRows(payload) {
  if (Array.isArray(payload?.response)) return payload.response;
  if (Array.isArray(payload)) return payload;
  return [];
}

function extractEventIdFromApiSportsRow(row) {
  return toSafeString(row?.fixture?.id || row?.game?.id || row?.id);
}

function extractEventTeamsFromApiSportsRow(row) {
  const homeTeam = toSafeString(
    row?.teams?.home?.name ||
    row?.home?.name ||
    row?.home_team ||
    row?.homeTeam
  );
  const awayTeam = toSafeString(
    row?.teams?.away?.name ||
    row?.away?.name ||
    row?.away_team ||
    row?.awayTeam
  );
  return { homeTeam, awayTeam };
}

async function findApiSportsEventId({ sportCode, homeTeam, awayTeam, eventDate, providerTrace }) {
  const endpoint = sportCode === 'football' ? '/fixtures' : '/games';
  const dateCandidates = buildDateCandidates(eventDate);
  let best = null;
  let bestScore = -1;
  for (const date of dateCandidates) {
    const payload = await apiSportsGet(sportCode, endpoint, { date }, providerTrace);
    const rows = extractApiSportsRows(payload);
    for (const row of rows) {
      const teams = extractEventTeamsFromApiSportsRow(row);
      const score = scoreNameMatch(homeTeam, teams.homeTeam) + scoreNameMatch(awayTeam, teams.awayTeam);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
  }
  if (!best || bestScore <= 1) return null;
  const eventId = extractEventIdFromApiSportsRow(best);
  if (!eventId) return null;
  return { eventId, row: best, score: bestScore };
}

function flattenNumericPaths(node, prefix = '', acc = [], depth = 0) {
  if (depth > 5 || node === null || node === undefined) return acc;
  if (typeof node === 'number') {
    acc.push({ path: prefix, value: node });
    return acc;
  }
  if (typeof node === 'string') {
    const parsed = Number(node);
    if (Number.isFinite(parsed)) acc.push({ path: prefix, value: parsed });
    return acc;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => flattenNumericPaths(item, `${prefix}[${index}]`, acc, depth + 1));
    return acc;
  }
  if (typeof node === 'object') {
    Object.entries(node).forEach(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      flattenNumericPaths(value, path, acc, depth + 1);
    });
  }
  return acc;
}

function collectPlayerCandidates(node, acc = [], depth = 0) {
  if (depth > 6 || node === null || node === undefined) return acc;
  if (Array.isArray(node)) {
    node.forEach((item) => collectPlayerCandidates(item, acc, depth + 1));
    return acc;
  }
  if (typeof node !== 'object') return acc;

  if (node.player && typeof node.player === 'object' && toSafeString(node.player.name)) {
    acc.push({ name: toSafeString(node.player.name), raw: node });
  } else if (toSafeString(node.player_name)) {
    acc.push({ name: toSafeString(node.player_name), raw: node });
  } else if (toSafeString(node.name) && (node.statistics || node.stats)) {
    acc.push({ name: toSafeString(node.name), raw: node });
  }

  if (Array.isArray(node.players)) {
    node.players.forEach((playerEntry) => {
      if (playerEntry?.player?.name) {
        acc.push({ name: toSafeString(playerEntry.player.name), raw: playerEntry });
      }
    });
  }
  Object.values(node).forEach((value) => collectPlayerCandidates(value, acc, depth + 1));
  return acc;
}

function resolveStatValueFromCandidate(candidateRaw, statType) {
  const normalizedStatType = normalizeStatType(statType);
  const aliases = PROP_STAT_ALIASES[normalizedStatType] || [normalizedStatType];
  if (Array.isArray(candidateRaw?.statistics)) {
    for (const statEntry of candidateRaw.statistics) {
      const statLabel = normalizeToken(statEntry?.type || statEntry?.name || '');
      if (!statLabel) continue;
      if (aliases.some((alias) => statLabel.includes(alias.replace(/_/g, ' ')))) {
        const statValue = toSafeNumber(statEntry?.value);
        if (statValue !== null) return statValue;
      }
    }
  }
  const flat = flattenNumericPaths(candidateRaw);
  for (const alias of aliases) {
    const found = flat.find((item) => normalizeToken(item.path).includes(alias.replace(/_/g, ' ')));
    if (found) return found.value;
  }
  return null;
}

function pickBestPlayerCandidate(candidates, playerName) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (!playerName) return candidates[0];
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreNameMatch(playerName, candidate.name) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].candidate : null;
}

function extractPlayerIds(payload) {
  const rows = extractApiSportsRows(payload);
  return rows
    .map((row) => row?.player?.id || row?.id)
    .filter((item) => item !== undefined && item !== null)
    .map((item) => String(item));
}

function parseApiSportsStatNumericValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : null;
  const valueText = String(rawValue).trim();
  if (!valueText) return null;
  if (/^null$/i.test(valueText)) return null;
  const cleaned = valueText.replace('%', '').replace(',', '.').replace(/[^\d.+-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFootballStatLabel(value) {
  return normalizeToken(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFootballTeamStatsMap(payload) {
  const rows = extractApiSportsRows(payload);
  const map = new Map();
  for (const row of rows) {
    const teamName = toSafeString(row?.team?.name || row?.teamName || row?.team);
    if (!teamName) continue;
    const statRows = Array.isArray(row?.statistics) ? row.statistics : [];
    const statMap = {};
    for (const statRow of statRows) {
      const statLabel = normalizeFootballStatLabel(statRow?.type);
      if (!statLabel) continue;
      const statValue = parseApiSportsStatNumericValue(statRow?.value);
      if (statValue === null) continue;
      statMap[statLabel] = statValue;
    }
    map.set(teamName, statMap);
  }
  return map;
}

function getFootballTeamStatValue(statMap, statType) {
  if (!statMap || typeof statMap !== 'object') return null;
  if (statType === 'cards_total') {
    const yellow = getFootballTeamStatValue(statMap, 'yellow_cards');
    const red = getFootballTeamStatValue(statMap, 'red_cards');
    if (yellow === null && red === null) return null;
    return Number((Number(yellow || 0) + Number(red || 0)).toFixed(3));
  }
  const aliases = FOOTBALL_TEAM_STAT_LABEL_ALIASES[statType] || [];
  for (const alias of aliases) {
    const normalizedAlias = normalizeFootballStatLabel(alias);
    if (Object.prototype.hasOwnProperty.call(statMap, normalizedAlias)) {
      return toSafeNumber(statMap[normalizedAlias]);
    }
  }
  return null;
}

function findTeamStatsByName(teamStatsMap, teamName) {
  const normalizedTarget = normalizeTeamName(teamName);
  let bestEntry = null;
  let bestScore = -1;
  for (const [candidateName, stats] of teamStatsMap.entries()) {
    const candidateScore = scoreNameMatch(normalizedTarget, candidateName);
    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      bestEntry = { teamName: candidateName, stats };
    }
  }
  if (!bestEntry || bestScore <= 0) return null;
  return bestEntry;
}

async function fetchApiSportsFootballTeamPropValue({ eventId, statType, homeTeam, awayTeam, selectionLabel, side, providerTrace }) {
  const payload = await apiSportsGet('football', '/fixtures/statistics', { fixture: eventId }, providerTrace);
  const teamStatsMap = extractFootballTeamStatsMap(payload);
  if (!teamStatsMap.size) {
    return { ok: false, message: 'Sin estadísticas de equipos para el fixture.' };
  }

  const resolvedHome = findTeamStatsByName(teamStatsMap, homeTeam);
  const resolvedAway = findTeamStatsByName(teamStatsMap, awayTeam);
  const homeValue = resolvedHome ? getFootballTeamStatValue(resolvedHome.stats, statType) : null;
  const awayValue = resolvedAway ? getFootballTeamStatValue(resolvedAway.stats, statType) : null;
  const totalValue = (homeValue !== null || awayValue !== null)
    ? Number((Number(homeValue || 0) + Number(awayValue || 0)).toFixed(3))
    : null;

  const selectionHint = normalizeTeamName(selectionLabel);
  let scope = 'match';
  let selectedTeam = null;
  let statValue = totalValue;
  if (side === 'home' && homeValue !== null) {
    scope = 'team';
    selectedTeam = resolvedHome?.teamName || homeTeam;
    statValue = homeValue;
  } else if (side === 'away' && awayValue !== null) {
    scope = 'team';
    selectedTeam = resolvedAway?.teamName || awayTeam;
    statValue = awayValue;
  } else if (selectionHint) {
    if (resolvedHome && normalizeTeamName(resolvedHome.teamName) === selectionHint && homeValue !== null) {
      scope = 'team';
      selectedTeam = resolvedHome.teamName;
      statValue = homeValue;
    } else if (resolvedAway && normalizeTeamName(resolvedAway.teamName) === selectionHint && awayValue !== null) {
      scope = 'team';
      selectedTeam = resolvedAway.teamName;
      statValue = awayValue;
    }
  }

  if (statValue === null) {
    return { ok: false, message: `No se encontró stat ${statType} en fixture.` };
  }
  return {
    ok: true,
    statValue,
    scope,
    selectedTeam: selectedTeam || '',
    homeValue,
    awayValue,
    totalValue
  };
}

async function fetchApiSportsPropValue({ sportCode, eventId, playerName, statType, providerTrace }) {
  let payload = null;
  if (sportCode === 'football') {
    payload = await apiSportsGet(sportCode, '/fixtures/players', { fixture: eventId }, providerTrace);
  } else {
    payload = await apiSportsGet(sportCode, '/games/statistics', { id: eventId }, providerTrace);
    if (!payload) payload = await apiSportsGet(sportCode, '/games/statistics', { game: eventId }, providerTrace);
  }
  let candidates = collectPlayerCandidates(payload);
  if ((!candidates || candidates.length === 0) && playerName) {
    let playerSearch = await apiSportsGet(sportCode, '/players', { search: playerName }, providerTrace);
    if (!playerSearch) playerSearch = await apiSportsGet(sportCode, '/players', { name: playerName }, providerTrace);
    const playerIds = extractPlayerIds(playerSearch).slice(0, 3);
    for (const playerId of playerIds) {
      let statsPayload = await apiSportsGet(sportCode, '/players/statistics', { id: playerId, game: eventId }, providerTrace);
      if (!statsPayload) statsPayload = await apiSportsGet(sportCode, '/players/statistics', { player: playerId, game: eventId }, providerTrace);
      if (!statsPayload) statsPayload = await apiSportsGet(sportCode, '/players/statistics', { id: playerId, fixture: eventId }, providerTrace);
      candidates = collectPlayerCandidates(statsPayload);
      if (candidates.length > 0) break;
    }
  }
  const bestCandidate = pickBestPlayerCandidate(candidates, playerName);
  if (!bestCandidate) {
    return { ok: false, message: 'No se encontró jugador en proveedor secundario.' };
  }
  const statValue = resolveStatValueFromCandidate(bestCandidate.raw, statType);
  if (statValue === null) {
    return { ok: false, message: `No se encontró stat ${statType} para ${bestCandidate.name}.` };
  }
  return { ok: true, statValue, playerName: bestCandidate.name };
}

async function resolvePropMarket(pick, bet) {
  const providerTrace = [];
  const sportCode = resolveSecondarySportCode({
    sportKey: bet?.sportKey || pick?.sportKey,
    sport: bet?.sport || pick?.sport,
    league: pick?.league
  });
  if (!SUPPORTED_PROP_SPORTS.has(sportCode)) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 25,
      detalle: 'Prop en deporte no soportado automáticamente.',
      needsReview: true,
      eventMatchScore: 0,
      officialDataQuality: 20,
      evidence: [],
      providerTrace
    };
  }
  const [matchHome, matchAway] = splitMatchTeams(pick?.match);
  const homeTeam = toSafeString(bet?.homeTeam || matchHome);
  const awayTeam = toSafeString(bet?.awayTeam || matchAway);
  const eventLookup = await findApiSportsEventId({
    sportCode,
    homeTeam,
    awayTeam,
    eventDate: bet?.eventDate || pick?.time,
    providerTrace
  });
  if (!eventLookup?.eventId) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 30,
      detalle: 'No se localizó evento en proveedor secundario de props.',
      needsReview: true,
      eventMatchScore: 0,
      officialDataQuality: 25,
      evidence: [],
      providerTrace
    };
  }
  const side = normalizeSide(bet?.side || bet?.selection);
  const line = toSafeNumber(bet?.line);
  const playerName = toSafeString(bet?.playerName);
  const statType = normalizeStatType(bet?.statType || bet?.marketKey || bet?.marketType);
  const isFootballTeamProp = sportCode === 'football' && FOOTBALL_TEAM_PROP_STAT_TYPES.has(statType);
  if (!statType || line === null || !['over', 'under'].includes(side)) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 32,
      detalle: 'Prop incompleto: se requiere statType, línea y over/under.',
      needsReview: true,
      eventMatchScore: eventLookup.score || 0,
      officialDataQuality: 25,
      evidence: [],
      providerTrace
    };
  }
  if (!isFootballTeamProp && !playerName) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 32,
      detalle: 'Prop incompleto: se requiere jugador para este tipo de mercado.',
      needsReview: true,
      eventMatchScore: eventLookup.score || 0,
      officialDataQuality: 30,
      evidence: [],
      providerTrace
    };
  }
  let statResult;
  if (isFootballTeamProp) {
    statResult = await fetchApiSportsFootballTeamPropValue({
      eventId: eventLookup.eventId,
      statType,
      homeTeam,
      awayTeam,
      selectionLabel: bet?.selectionLabel || bet?.selection || '',
      side,
      providerTrace
    });
  } else {
    statResult = await fetchApiSportsPropValue({
      sportCode,
      eventId: eventLookup.eventId,
      playerName,
      statType,
      providerTrace
    });
  }
  if (!statResult.ok) {
    return {
      resultado: 'NECESITA_VERIFICACION',
      confianza: 35,
      detalle: statResult.message || 'Sin estadística oficial para prop.',
      needsReview: true,
      eventMatchScore: eventLookup.score || 0,
      officialDataQuality: 40,
      evidence: [],
      providerTrace
    };
  }
  const statValue = statResult.statValue;
  const detailLabel = isFootballTeamProp
    ? `${statType}: ${statValue} (${statResult.scope === 'team' ? (statResult.selectedTeam || 'equipo') : 'partido'})`
    : `${statType}: ${statValue}`;
  if (statValue === line) {
    return {
      resultado: 'VOID',
      confianza: 84,
      detalle: isFootballTeamProp
        ? `Prop soccer exacto: ${detailLabel} = línea ${line}.`
        : `${statResult.playerName} terminó con ${statValue}, exacto a la línea ${line}.`,
      needsReview: false,
      eventMatchScore: eventLookup.score || 0,
      officialDataQuality: 90,
      evidence: [{
        provider: 'api-sports',
        type: isFootballTeamProp ? 'team-prop' : 'player-prop',
        detail: detailLabel,
        value: isFootballTeamProp
          ? {
              statType,
              statValue,
              line,
              side,
              scope: statResult.scope,
              selectedTeam: statResult.selectedTeam || null,
              homeValue: statResult.homeValue ?? null,
              awayValue: statResult.awayValue ?? null,
              totalValue: statResult.totalValue ?? null
            }
          : { statType, statValue, line, side, player: statResult.playerName }
      }],
      providerTrace
    };
  }
  const won = (side === 'over' && statValue > line) || (side === 'under' && statValue < line);
  return {
    resultado: won ? 'GANADO' : 'PERDIDO',
    confianza: 86,
    detalle: isFootballTeamProp
      ? (won
          ? `Soccer prop ${side} ${line} cumplido (${detailLabel}).`
          : `Soccer prop ${side} ${line} fallado (${detailLabel}).`)
      : (won
          ? `${statResult.playerName} ${side} ${line} (${statType}: ${statValue})`
          : `${statResult.playerName} no cumplió ${side} ${line} (${statType}: ${statValue})`),
    needsReview: false,
    eventMatchScore: eventLookup.score || 0,
    officialDataQuality: 92,
    evidence: [{
      provider: 'api-sports',
      type: isFootballTeamProp ? 'team-prop' : 'player-prop',
      detail: detailLabel,
      value: isFootballTeamProp
        ? {
            statType,
            statValue,
            line,
            side,
            scope: statResult.scope,
            selectedTeam: statResult.selectedTeam || null,
            homeValue: statResult.homeValue ?? null,
            awayValue: statResult.awayValue ?? null,
            totalValue: statResult.totalValue ?? null
          }
        : { statType, statValue, line, side, player: statResult.playerName }
    }],
    providerTrace
  };
}

async function buildPreliminaryAnalysisForPick(pick, options = {}) {
  const baseBet = buildBetFromPick(pick);
  let mergedBet = mergeBetData(baseBet, pick?.bet || {});
  let ocrMeta = { status: 'not_attempted', confidence: 0, warnings: [] };
  const shouldRunOcr = Boolean(
    toSafeString(pick?.ticketImg) &&
    (
      options.forceOcr ||
      String(pick?.result || '').toLowerCase() === 'pending' ||
      !pick?.bet?.marketType ||
      !pick?.bet?.selection ||
      mergedBet.marketType === 'player_prop'
    )
  );
  if (shouldRunOcr) {
    const ocrResult = await extractTicketBetWithVision(pick, mergedBet);
    ocrMeta = ocrResult.meta || ocrMeta;
    if (ocrResult.bet) mergedBet = mergeBetData(mergedBet, ocrResult.bet);
  }
  const marketType = normalizeMarketType(mergedBet.marketType, mergedBet.betType);
  mergedBet.marketType = marketType;
  let score = null;
  let resolution = null;
  if (marketType === 'player_prop') {
    resolution = await resolvePropMarket(pick, mergedBet);
  } else {
    const [matchHome, matchAway] = splitMatchTeams(pick?.match);
    score = await getMatchScore(
      pick?.league,
      mergedBet.homeTeam || matchHome || '',
      mergedBet.awayTeam || matchAway || '',
      mergedBet.sportKey || pick?.sportKey,
      mergedBet.eventId
    );
    resolution = resolveStandardMarket(mergedBet, score);
    const oddsSignal = await buildOddsSignalForStandardMarket({
      pick,
      bet: mergedBet,
      score
    });
    resolution = mergeOddsSignalIntoResolution(resolution, oddsSignal);
    resolution = await resolveAiVerdictFallbackForStandardMarket({
      pick,
      bet: mergedBet,
      score,
      baseResolution: resolution,
      ocrMeta,
      oddsSignal
    });
  }
  const confidenceBreakdown = buildConfidenceBreakdown({
    bet: mergedBet,
    ocrMeta,
    score,
    resolution,
    marketType
  });
  resolution = applyReliabilityGuardsToResolution(resolution, confidenceBreakdown);
  const aiAnalysis = {
    resultado: resolution.resultado || 'NECESITA_VERIFICACION',
    confianza: clampNumber(resolution.confianza, 0, 100, 0),
    detalle: toSafeString(resolution.detalle || 'Sin detalle'),
    source: marketType === 'player_prop' ? 'deterministic+api-sports' : 'deterministic+odds',
    adminClosureRequired: true,
    needsReview: Boolean(resolution.needsReview),
    confidenceBreakdown,
    reliability: {
      extractionQuality: confidenceBreakdown.extractionQuality,
      eventMatchQuality: confidenceBreakdown.eventMatchQuality,
      officialDataQuality: confidenceBreakdown.officialDataQuality
    },
    evidence: Array.isArray(resolution.evidence) ? resolution.evidence.slice(0, 8) : []
  };
  const verificationStatus = aiAnalysis.resultado === 'PENDIENTE'
    ? 'pending_data'
    : aiAnalysis.needsReview
      ? 'needs_review'
      : 'preliminary_ready';
  const verification = {
    ...(pick?.verification || {}),
    status: verificationStatus,
    preliminaryResult: aiAnalysis.resultado,
    confidence: aiAnalysis.confianza,
    needsReview: aiAnalysis.needsReview,
    summary: buildAiArgumentSummary({ aiAnalysis, bet: mergedBet }),
    confidenceBreakdown,
    reliability: {
      extractionQuality: confidenceBreakdown.extractionQuality,
      eventMatchQuality: confidenceBreakdown.eventMatchQuality,
      officialDataQuality: confidenceBreakdown.officialDataQuality
    },
    engineVersion: AI_ENGINE_VERSION,
    lastAnalyzedAt: new Date(),
    ocr: {
      status: ocrMeta.status || pick?.verification?.ocr?.status || 'not_attempted',
      confidence: clampNumber(ocrMeta.confidence ?? pick?.verification?.ocr?.confidence ?? 0, 0, 100, 0),
      parsedAt: ocrMeta.status === 'parsed' ? new Date() : (pick?.verification?.ocr?.parsedAt || null),
      warnings: Array.isArray(ocrMeta.warnings) ? ocrMeta.warnings.slice(0, 8) : [],
      raw: ocrMeta.raw || null
    },
    evidence: aiAnalysis.evidence,
    providerTrace: Array.isArray(resolution.providerTrace) ? resolution.providerTrace.slice(0, 15) : []
  };
  return { bet: mergedBet, aiAnalysis, verification };
}

async function analyzeAndPersistPick(pick, options = {}) {
  const pickDoc = (pick && typeof pick.save === 'function')
    ? pick
    : await findPickByIdentifier(pick?._id || pick?.id);
  if (!pickDoc) {
    throw new Error('pick_not_found');
  }

  const computed = await buildPreliminaryAnalysisForPick(pickDoc, options);
  const autoCloseDecision = shouldAutoClosePick({
    currentResult: pickDoc?.result,
    aiOutcome: computed?.aiAnalysis?.resultado,
    needsReview: computed?.aiAnalysis?.needsReview,
    confidence: computed?.aiAnalysis?.confianza,
    marketType: computed?.bet?.marketType,
    extractionQuality: computed?.verification?.confidenceBreakdown?.extractionQuality,
    eventMatchQuality: computed?.verification?.confidenceBreakdown?.eventMatchQuality,
    officialDataQuality: computed?.verification?.confidenceBreakdown?.officialDataQuality,
    minExtractionQuality: AUTO_CLOSE_MIN_EXTRACTION_QUALITY,
    minEventMatchQuality: AUTO_CLOSE_MIN_EVENT_MATCH_QUALITY,
    minOfficialDataQuality: AUTO_CLOSE_MIN_OFFICIAL_DATA_QUALITY,
    thresholdConfig: AUTO_CLOSE_THRESHOLD_CONFIG
  });
  const shouldAutoClose = Boolean(autoCloseDecision?.shouldAutoClose);

  if (shouldAutoClose) {
    computed.verification = {
      ...computed.verification,
      status: 'closed_auto',
      needsReview: false,
      summary: `Cierre automático IA: ${computed?.aiAnalysis?.resultado || 'SIN RESULTADO'} (threshold ${autoCloseDecision.threshold})`,
      closedBy: null,
      lastClosedAt: new Date()
    };
  }

  const updatePayload = {
    bet: computed.bet,
    aiAnalysis: computed.aiAnalysis,
    verification: computed.verification
  };
  if (shouldAutoClose) {
    updatePayload.result = autoCloseDecision.resolvedResult;
  }
  Object.entries(updatePayload).forEach(([key, value]) => {
    pickDoc.set(key, value);
  });
  if (shouldAutoClose) {
    pickDoc.set('result', autoCloseDecision.resolvedResult);
  }
  const updated = await pickDoc.save();
  if (shouldAutoClose && pickDoc?.tipsterId) {
    await safeRecalculateTipsterStats(pickDoc.tipsterId, `analyzeAndPersistPick:${pickDoc?._id}`);
  }
  return updated;
}

function buildPendingPickAnalysisQuery(options = {}) {
  if (options.pickId) {
    return { _id: options.pickId };
  }

  if (options.includeRecent) {
    return { result: 'pending' };
  }

  const now = Date.now();
  const minAgeMinutes = Number.isFinite(Number(PICK_ANALYSIS_MIN_AGE_MINUTES))
    ? Math.max(0, Number(PICK_ANALYSIS_MIN_AGE_MINUTES))
    : 0;
  const recheckMinutes = Number.isFinite(Number(PICK_ANALYSIS_RECHECK_MINUTES))
    ? Math.max(1, Number(PICK_ANALYSIS_RECHECK_MINUTES))
    : 30;
  const minAgeCutoff = new Date(now - minAgeMinutes * 60 * 1000);
  const recheckCutoff = new Date(now - recheckMinutes * 60 * 1000);

  const query = {
    result: 'pending',
    $or: [
      { 'verification.lastAnalyzedAt': { $exists: false } },
      { 'verification.lastAnalyzedAt': { $lte: recheckCutoff } }
    ]
  };
  if (minAgeMinutes > 0) {
    query.createdAt = { $lte: minAgeCutoff };
  }
  return query;
}
async function runPendingImagePickAnalysis(options = {}) {
  const limit = Number.isFinite(Number(options?.limit))
    ? Math.max(1, Math.min(300, Number(options.limit)))
    : 120;
  const picks = await Pick.find({ result: 'pending' }).sort({ createdAt: 1 }).limit(limit);
  const summary = { total: picks.length, analyzed: 0, failed: 0, pending: 0, autoClosed: 0, skipped: 0, results: [] };
  for (const pick of picks) {
    try {
      const updated = await analyzePickImageAndPersist(pick);
      summary.analyzed += 1;
      if (String(updated?.result || 'pending').toLowerCase() === 'pending') summary.pending += 1;
      else summary.autoClosed += 1;
      summary.results.push({
        pickId: String(pick._id),
        result: updated?.result || 'pending',
        confianza: Number(updated?.aiAnalysis?.confianza || 0),
        resultado: updated?.aiAnalysis?.resultado || 'NECESITA_VERIFICACION'
      });
    } catch (error) {
      const isPendingEvent = String(error?.message || '').includes('Partido aún no finalizado');
      if (isPendingEvent) summary.skipped += 1;
      else summary.failed += 1;
      summary.results.push({ pickId: String(pick._id), error: error.message || 'analysis_failed' });
    }
  }
  return summary;
}

async function runPickAnalysis(options = {}) {
  const query = buildPendingPickAnalysisQuery(options);
  const batchLimit = Number.isFinite(Number(PICK_ANALYSIS_BATCH_LIMIT))
    ? Math.max(1, Number(PICK_ANALYSIS_BATCH_LIMIT))
    : 200;
  const picks = await Pick.find(query).sort({ createdAt: 1 }).limit(batchLimit);
  const summary = { total: picks.length, analyzed: 0, failed: 0, pending: 0, autoClosed: 0, results: [] };
  for (const pick of picks) {
    try {
      const updated = await analyzeAndPersistPick(pick, { forceOcr: Boolean(options.forceOcr) });
      summary.analyzed += 1;
      if (updated?.aiAnalysis?.resultado === 'PENDIENTE') summary.pending += 1;
      if (String(updated?.result || 'pending').toLowerCase() !== 'pending') summary.autoClosed += 1;
      summary.results.push({
        pickId: String(pick._id),
        resultado: updated?.aiAnalysis?.resultado || 'NECESITA_VERIFICACION',
        confianza: updated?.aiAnalysis?.confianza || 0,
        result: updated?.result || 'pending'
      });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({ pickId: String(pick._id), error: error.message || 'analysis_failed' });
    }
  }
  return summary;
}
const PICK_ANALYSIS_INTERVAL_MS = Number.isFinite(Number(process.env.PICK_ANALYSIS_INTERVAL_MS))
  ? Math.max(60_000, Number(process.env.PICK_ANALYSIS_INTERVAL_MS))
  : 60 * 60 * 1000;
const PICK_ANALYSIS_RECHECK_MINUTES = Number.isFinite(Number(process.env.PICK_ANALYSIS_RECHECK_MINUTES))
  ? Math.max(1, Number(process.env.PICK_ANALYSIS_RECHECK_MINUTES))
  : 30;
const PICK_ANALYSIS_MIN_AGE_MINUTES = Number.isFinite(Number(process.env.PICK_ANALYSIS_MIN_AGE_MINUTES))
  ? Math.max(0, Number(process.env.PICK_ANALYSIS_MIN_AGE_MINUTES))
  : 0;
const PICK_ANALYSIS_BATCH_LIMIT = Number.isFinite(Number(process.env.PICK_ANALYSIS_BATCH_LIMIT))
  ? Math.max(1, Number(process.env.PICK_ANALYSIS_BATCH_LIMIT))
  : 200;

setTimeout(() => {
  runPendingImagePickAnalysis({ limit: PICK_ANALYSIS_BATCH_LIMIT })
    .catch((error) => console.error('initial runPendingImagePickAnalysis error:', error.message || error));
}, 15_000);

setInterval(() => {
  runPendingImagePickAnalysis({ limit: PICK_ANALYSIS_BATCH_LIMIT })
    .catch((error) => console.error('runPendingImagePickAnalysis error:', error.message || error));
}, PICK_ANALYSIS_INTERVAL_MS);

app.post('/api/admin/analyze-picks', auth, requireAdmin, async (req, res) => {
  try {
    const summary = await runPickAnalysis({ includeRecent: true, forceOcr: true });
    res.json({ success: true, ...summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/picks/:id/analyze', auth, requireAdmin, async (req, res) => {
  try {
    const pick = await findPickByIdentifier(req.params.id);
    if (!pick) return res.status(404).json({ error: 'Pick not found' });
    const updated = await analyzePickImageAndPersist(pick);
    res.json({
      success: true,
      analysis: updated?.aiAnalysis || null,
      verification: updated?.verification || null,
      bet: updated?.bet || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
const isValidCheckoutSessionId = (value) => {
  if (typeof value !== 'string') return false;
  if (STRIPE_LIVE_REQUIRED) return /^cs_live_[^\s]+$/.test(value);
  return /^cs_(test|live)_[^\s]+$/.test(value);
};
const enforceLiveStripeMode = (res) => {
  if (!STRIPE_LIVE_REQUIRED || STRIPE_MODE === 'live') return true;
  res.status(503).json({
    error: 'Stripe live requerido: el backend está configurado con credenciales de prueba (sk_test). Cambia a claves live para operar pagos y onboarding reales.'
  });
  return false;
};
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
    if (!enforceLiveStripeMode(res)) return;
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
    if (!enforceLiveStripeMode(res)) return;
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

    const purchaseUpsertResult = await Purchase.updateOne(
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
    const isFirstPaidPurchase = Number(purchaseUpsertResult?.upsertedCount || 0) > 0;
    const pickUpdatePayload = { $addToSet: { buyers: req.user.id } };
    if (isFirstPaidPurchase) {
      pickUpdatePayload.$inc = { salesCount: 1 };
    }

    const updated = await Pick.findByIdAndUpdate(
      targetPickId,
      pickUpdatePayload,
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Pick not found' });

    res.json({ success: true, pick: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe/pro/create-checkout-session', auth, async (req, res) => {
  try {
    if (!enforceLiveStripeMode(res)) return;
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
    if (!enforceLiveStripeMode(res)) return;
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
app.post('/api/stripe/connect/create-onboarding-link', auth, async (req, res) => {
  try {
    if (!enforceLiveStripeMode(res)) return;
    const currentUser = await User.findById(req.user.id).select('email name stripeConnectedAccountId stripePayoutReady stripePayoutStatus');
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const returnUrls = resolveConnectReturnUrls(req);
    if (!returnUrls) return res.status(400).json({ error: 'refreshUrl/returnUrl inválidos o FRONTEND_BASE_URL no configurado' });

    let stripeAccountId = toSafeString(currentUser.stripeConnectedAccountId);
    if (!stripeAccountId) {
      stripeAccountId = await ensureTipsterStripeAccount(currentUser);
      await User.findByIdAndUpdate(currentUser._id, {
        stripeConnectedAccountId: stripeAccountId,
        stripePayoutReady: false,
        stripePayoutStatus: 'onboarding_required'
      });
    }

    const mode = String(req.body?.mode || '').trim().toLowerCase();
    const linkType = mode === 'update' ? 'account_update' : 'account_onboarding';
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: returnUrls.refreshUrl,
      return_url: returnUrls.returnUrl,
      type: linkType
    });

    res.json({
      success: true,
      stripeConnectedAccountId: stripeAccountId,
      linkType,
      onboardingUrl: accountLink?.url || ''
    });
  } catch (error) {
    if (isStripeConnectUnavailableError(error)) {
      return res.status(400).json({
        error: 'Stripe Connect no está habilitado en esta cuenta de Stripe. Actívalo en dashboard.stripe.com/connect.'
      });
    }
    res.status(500).json({ error: error.message || 'No se pudo crear el enlace de onboarding' });
  }
});

app.get('/api/stripe/connect/status', auth, async (req, res) => {
  try {
    if (!enforceLiveStripeMode(res)) return;
    const currentUser = await User.findById(req.user.id).select('stripeConnectedAccountId stripePayoutReady stripePayoutStatus stripeExternalAccountId bankClabeMasked bankClabeLast4');
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const stripeAccountId = toSafeString(currentUser.stripeConnectedAccountId);
    if (!stripeAccountId) {
      const hasLocalClabe = Boolean(toSafeString(currentUser?.bankClabeMasked) || toSafeString(currentUser?.bankClabeLast4));
      const fallbackStatus = hasLocalClabe ? 'onboarding_required' : 'not_configured';
      await User.findByIdAndUpdate(currentUser._id, {
        stripePayoutReady: false,
        stripePayoutStatus: fallbackStatus
      });
      return res.json({
        stripeConnectedAccountId: '',
        hasConnectedAccount: false,
        payoutsEnabled: false,
        transfersCapability: 'inactive',
        requirementsDue: 0,
        stripePayoutReady: false,
        stripePayoutStatus: fallbackStatus
      });
    }

    const hydrated = await hydrateUserStripePayoutState(currentUser, { persist: true });
    const accountSnapshot = await stripe.accounts.retrieve(stripeAccountId);
    const payoutState = resolveConnectAccountPayoutStatus(accountSnapshot);
    const transfersCapability = toSafeString(accountSnapshot?.capabilities?.transfers) || 'inactive';
    const requirementsDue = Number(payoutState.requirementsDue || 0);

    res.json({
      stripeConnectedAccountId: stripeAccountId,
      hasConnectedAccount: true,
      payoutsEnabled: Boolean(accountSnapshot?.payouts_enabled),
      transfersCapability,
      requirementsDue,
      stripeExternalAccountId: toSafeString(hydrated?.stripeExternalAccountId),
      bankClabeMasked: toSafeString(hydrated?.bankClabeMasked),
      bankClabeLast4: toSafeString(hydrated?.bankClabeLast4),
      stripePayoutReady: Boolean(hydrated?.stripePayoutReady),
      stripePayoutStatus: toSafeString(hydrated?.stripePayoutStatus) || (payoutState.payoutReady ? 'configured' : 'pending_verification')
    });
  } catch (error) {
    if (isStripeConnectUnavailableError(error)) {
      await User.findByIdAndUpdate(req.user.id, {
        stripePayoutReady: false,
        stripePayoutStatus: 'connect_not_enabled'
      });
      return res.json({
        stripeConnectedAccountId: '',
        hasConnectedAccount: false,
        payoutsEnabled: false,
        transfersCapability: 'inactive',
        requirementsDue: 0,
        stripePayoutReady: false,
        stripePayoutStatus: 'connect_not_enabled'
      });
    }
    res.status(500).json({ error: error.message || 'No se pudo consultar el estado de Connect' });
  }
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
