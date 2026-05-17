const DEFAULT_AUTO_CLOSE_THRESHOLD = 80;
const DEFAULT_MIN_EXTRACTION_QUALITY = 55;
const DEFAULT_MIN_EVENT_MATCH_QUALITY = 60;
const DEFAULT_MIN_OFFICIAL_DATA_QUALITY = 70;

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
  extractionQuality,
  eventMatchQuality,
  officialDataQuality,
  minExtractionQuality = DEFAULT_MIN_EXTRACTION_QUALITY,
  minEventMatchQuality = DEFAULT_MIN_EVENT_MATCH_QUALITY,
  minOfficialDataQuality = DEFAULT_MIN_OFFICIAL_DATA_QUALITY,
  thresholdConfig = resolveAutoCloseThresholdConfig()
}) {
  const resolvedResult = mapAiOutcomeToPickResult(aiOutcome);
  const normalizedCurrentResult = String(currentResult || 'pending').trim().toLowerCase();
  const normalizedConfidence = Number(confidence ?? 0);
  const normalizedExtractionQuality = clampPercent(extractionQuality, 0);
  const normalizedEventMatchQuality = clampPercent(eventMatchQuality, 0);
  const normalizedOfficialDataQuality = clampPercent(officialDataQuality, 0);
  const normalizedMinExtractionQuality = clampPercent(minExtractionQuality, DEFAULT_MIN_EXTRACTION_QUALITY);
  const normalizedMinEventMatchQuality = clampPercent(minEventMatchQuality, DEFAULT_MIN_EVENT_MATCH_QUALITY);
  const normalizedMinOfficialDataQuality = clampPercent(minOfficialDataQuality, DEFAULT_MIN_OFFICIAL_DATA_QUALITY);
  const reliabilityGatePassed = Boolean(
    normalizedExtractionQuality >= normalizedMinExtractionQuality &&
    normalizedEventMatchQuality >= normalizedMinEventMatchQuality &&
    normalizedOfficialDataQuality >= normalizedMinOfficialDataQuality
  );
  const threshold = resolveAutoCloseThresholdForMarket(marketType, thresholdConfig);
  const shouldAutoClose = Boolean(
    normalizedCurrentResult === 'pending' &&
    resolvedResult &&
    !needsReview &&
    reliabilityGatePassed &&
    Number.isFinite(normalizedConfidence) &&
    normalizedConfidence >= threshold
  );
  return {
    shouldAutoClose,
    resolvedResult,
    threshold,
    confidence: normalizedConfidence,
    reliabilityGatePassed,
    quality: {
      extraction: normalizedExtractionQuality,
      eventMatch: normalizedEventMatchQuality,
      officialData: normalizedOfficialDataQuality
    },
    minimums: {
      extraction: normalizedMinExtractionQuality,
      eventMatch: normalizedMinEventMatchQuality,
      officialData: normalizedMinOfficialDataQuality
    }
  };
}

module.exports = {
  DEFAULT_AUTO_CLOSE_THRESHOLD,
  DEFAULT_MIN_EXTRACTION_QUALITY,
  DEFAULT_MIN_EVENT_MATCH_QUALITY,
  DEFAULT_MIN_OFFICIAL_DATA_QUALITY,
  MARKET_THRESHOLD_ENV_KEYS,
  resolveAutoCloseThresholdConfig,
  resolveAutoCloseThresholdForMarket,
  mapAiOutcomeToPickResult,
  shouldAutoClosePick
};
