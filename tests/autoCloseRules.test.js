const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mapAiOutcomeToPickResult,
  resolveAutoCloseThresholdConfig,
  resolveAutoCloseThresholdForMarket,
  shouldAutoClosePick
} = require('../autoCloseRules');

test('mapAiOutcomeToPickResult maps known outcomes', () => {
  assert.equal(mapAiOutcomeToPickResult('GANADO'), 'won');
  assert.equal(mapAiOutcomeToPickResult('PERDIDO'), 'lost');
  assert.equal(mapAiOutcomeToPickResult('VOID'), 'void');
  assert.equal(mapAiOutcomeToPickResult('push'), 'void');
  assert.equal(mapAiOutcomeToPickResult('UNKNOWN'), null);
});

test('resolveAutoCloseThresholdConfig resolves default and market thresholds from env', () => {
  const cfg = resolveAutoCloseThresholdConfig({
    AUTO_CLOSE_CONFIDENCE_THRESHOLD: '77',
    AUTO_CLOSE_THRESHOLD_PLAYER_PROP: '92',
    AUTO_CLOSE_THRESHOLD_MONEYLINE: '80'
  });
  assert.equal(cfg.defaultThreshold, 77);
  assert.equal(cfg.marketThresholds.player_prop, 92);
  assert.equal(cfg.marketThresholds.moneyline, 80);
  assert.equal(resolveAutoCloseThresholdForMarket('player_prop', cfg), 92);
  assert.equal(resolveAutoCloseThresholdForMarket('spread', cfg), 77);
});

test('shouldAutoClosePick uses market-specific threshold', () => {
  const thresholdConfig = {
    defaultThreshold: 80,
    marketThresholds: {
      player_prop: 90
    }
  };
  const lowConfidence = shouldAutoClosePick({
    currentResult: 'pending',
    aiOutcome: 'GANADO',
    needsReview: false,
    confidence: 88,
    marketType: 'player_prop',
    extractionQuality: 80,
    eventMatchQuality: 80,
    officialDataQuality: 90,
    thresholdConfig
  });
  assert.equal(lowConfidence.shouldAutoClose, false);
  assert.equal(lowConfidence.threshold, 90);
  assert.equal(lowConfidence.resolvedResult, 'won');

  const enoughConfidence = shouldAutoClosePick({
    currentResult: 'pending',
    aiOutcome: 'GANADO',
    needsReview: false,
    confidence: 90,
    marketType: 'player_prop',
    extractionQuality: 80,
    eventMatchQuality: 80,
    officialDataQuality: 90,
    thresholdConfig
  });
  assert.equal(enoughConfidence.shouldAutoClose, true);
  assert.equal(enoughConfidence.threshold, 90);
});

test('shouldAutoClosePick blocks when review is required or result is already final', () => {
  const cfg = { defaultThreshold: 80, marketThresholds: {} };
  const needsReview = shouldAutoClosePick({
    currentResult: 'pending',
    aiOutcome: 'PERDIDO',
    needsReview: true,
    confidence: 99,
    marketType: 'moneyline',
    thresholdConfig: cfg
  });
  assert.equal(needsReview.shouldAutoClose, false);
  assert.equal(needsReview.resolvedResult, 'lost');

  const alreadyResolved = shouldAutoClosePick({
    currentResult: 'won',
    aiOutcome: 'PERDIDO',
    needsReview: false,
    confidence: 99,
    marketType: 'moneyline',
    thresholdConfig: cfg
  });
  assert.equal(alreadyResolved.shouldAutoClose, false);
});

test('shouldAutoClosePick blocks when reliability quality gates fail', () => {
  const cfg = { defaultThreshold: 80, marketThresholds: {} };
  const blockedByQuality = shouldAutoClosePick({
    currentResult: 'pending',
    aiOutcome: 'GANADO',
    needsReview: false,
    confidence: 95,
    marketType: 'moneyline',
    extractionQuality: 80,
    eventMatchQuality: 55,
    officialDataQuality: 92,
    thresholdConfig: cfg
  });
  assert.equal(blockedByQuality.reliabilityGatePassed, false);
  assert.equal(blockedByQuality.shouldAutoClose, false);

  const passesQuality = shouldAutoClosePick({
    currentResult: 'pending',
    aiOutcome: 'GANADO',
    needsReview: false,
    confidence: 95,
    marketType: 'moneyline',
    extractionQuality: 80,
    eventMatchQuality: 75,
    officialDataQuality: 92,
    thresholdConfig: cfg
  });
  assert.equal(passesQuality.reliabilityGatePassed, true);
  assert.equal(passesQuality.shouldAutoClose, true);
});
