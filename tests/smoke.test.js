const assert = require('assert');

process.env.SKIP_LOCAL_CAPTCHA_MODEL = 'true';
const { CaptchaModelManager, selectModelTier } = require('../src/captcha-model-manager');
const { selectConfidenceThreshold } = require('../src/captcha-benchmark');
const { safeArtifactPath } = require('../src/captcha-model-downloader');

assert.strictEqual(typeof CaptchaModelManager, 'function');
assert.strictEqual(typeof selectConfidenceThreshold, 'function');
assert.strictEqual(typeof safeArtifactPath, 'function');

const threshold = selectConfidenceThreshold([
  { score: 0.9, match: true },
  { score: 0.8, match: true },
  { score: 0.1, match: false }
], { minimumRecall: 1, minimumF1: 0.8 });
assert.strictEqual(threshold.recall, 1);
assert.strictEqual(selectModelTier({ totalMb: 4096, availableMb: 1024 }, { CAPTCHA_MODEL_TIER: 'auto' }), 'owlvit');
assert.strictEqual(selectModelTier({ totalMb: 1024, availableMb: 256 }, { CAPTCHA_MODEL_TIER: 'auto' }), null);

console.log('fiptcha smoke tests passed');
