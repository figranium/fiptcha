const assert = require('assert');

process.env.SKIP_LOCAL_CAPTCHA_MODEL = 'true';
const fiptcha = require('..');

assert.strictEqual(typeof fiptcha.solveLocalCaptcha, 'function');
assert.strictEqual(typeof fiptcha.CaptchaModelManager, 'function');
assert.strictEqual(typeof fiptcha.selectConfidenceThreshold, 'function');
assert.strictEqual(typeof fiptcha.safeArtifactPath, 'function');
assert.strictEqual(typeof fiptcha.installTurnstileInterceptor, 'function');

const threshold = fiptcha.selectConfidenceThreshold([
  { score: 0.9, match: true },
  { score: 0.8, match: true },
  { score: 0.1, match: false }
], { minimumRecall: 1, minimumF1: 0.8 });
assert.strictEqual(threshold.recall, 1);
assert.strictEqual(fiptcha.selectModelTier({ totalMb: 4096, availableMb: 1024 }, { CAPTCHA_MODEL_TIER: 'auto' }), 'owlvit');
assert.strictEqual(fiptcha.selectModelTier({ totalMb: 1024, availableMb: 256 }, { CAPTCHA_MODEL_TIER: 'auto' }), null);

console.log('fiptcha smoke tests passed');
