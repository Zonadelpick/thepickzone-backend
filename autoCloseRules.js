const DEFAULT_AUTO_CLOSE_THRESHOLD = 80;

const MARKET_THRESHOLD_ENV_KEYS = {
  moneyline: 'AUTO_CLOSE_THRESHOLD_MONEYLINE',
  spread: 'AUTO_CLOSE_THRESHOLD_SPREAD',
  total: 'AUTO_CLOSE_THRESHOLD_TOTAL',
  team_total: 'AUTO_CLOSE_THRESHOLD_TEAM_TOTAL',
  player_prop: 'AUTO_CLOSE_THRESHOLD_PLAYER_PROP',
  both_teams_to_score: 'AUTO_CLOSE_THRESHOLD_BTTS',
  parlay: 'AUTO_CLOSE_THRESHOLD_PARLAY'
};

function clampPercent(value, fallback = DEFAULT_AUTO_CLOSE_THRESHOLD) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, parsed));
}

function normalizeMarketType(marketType) {
  return String(marketType || '').trim().toLowerCase();
}

function resolveAutoCloseThresholdConfig(env = process.env) {
  const defaultThreshold = clampPercent(env?.AUTO_CLOSE_CONFIDENCE_THRESHOLD, DEFAULT_AUTO_CLOSE_THRESHOLD);
  const marketThresholds = {};
  Object.entries(MARKET_THRESHOLD_ENV_KEYS).forEach(([marketType, envKey]) => {
    const raw = env?.[envKey];
    if (raw === undefined || raw === null || raw === '') return;
    marketThresholds[marketType] = clampPercent(raw, defaultThreshold);
  });
  return { defaultThreshold, marketThresholds };
}

function resolveAutoCloseThresholdForMarket(marketType, thresholdConfig = resolveAutoCloseThresholdConfig()) {
  const normalizedMarket = normalizeMarketType(marketType);
  if (!normalizedMarket) return thresholdConfig.defaultThreshold;
  if (Number.isFinite(thresholdConfig?.marketThresholds?.[normalizedMarket])) {
    return thresholdConfig.marketThresholds[normalizedMarket];
  }
  return thresholdConfig.defaultThreshold;
}

function mapAiOutcomeToPickResult(outcome) {
  const normalized = String(outcome || '').trim().toUpperCase();
  if (['GANADO', 'WON'].includes(normalized)) return 'won';
  if (['PERDIDO', 'LOST'].includes(normalized)) return 'lost';
  if (['VOID', 'PUSH'].includes(normalized)) return 'void';
  return null;
}

function shouldAutoClosePick({
  currentResult,
  aiOutcome,
  needsReview,
  confidence,
  marketType,
  thresholdConfig = resolveAutoCloseThresholdConfig()
}) {
  const resolvedResult = mapAiOutcomeToPickResult(aiOutcome);
  const normalizedCurrentResult = String(currentResult || 'pending').trim().toLowerCase();
  const normalizedConfidence = Number(confidence ?? 0);
  const threshold = resolveAutoCloseThresholdForMarket(marketType, thresholdConfig);
  const shouldAutoClose = Boolean(
    normalizedCurrentResult === 'pending' &&
    resolvedResult &&
    !needsReview &&
    Number.isFinite(normalizedConfidence) &&
    normalizedConfidence >= threshold
  );
  return { shouldAutoClose, resolvedResult, threshold, confidence: normalizedConfidence };
}

module.exports = {
  DEFAULT_AUTO_CLOSE_THRESHOLD,
  MARKET_THRESHOLD_ENV_KEYS,
  resolveAutoCloseThresholdConfig,
  resolveAutoCloseThresholdForMarket,
  mapAiOutcomeToPickResult,
  shouldAutoClosePick
};
