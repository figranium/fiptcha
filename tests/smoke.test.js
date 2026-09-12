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

const advertised2GbInMiB = 2_000_000_000 / (1024 * 1024);
assert(advertised2GbInMiB > 1907 && advertised2GbInMiB < 2048);
assert.strictEqual(
  fiptcha.selectModelTier({ totalMb: advertised2GbInMiB, availableMb: 768 }, { CAPTCHA_MODEL_TIER: 'auto' }),
  'owlvit',
  'A provider-advertised 2 GB host should qualify even though it is less than 2 GiB'
);

async function testDelayedCheckboxFrame() {
  let scans = 0;
  let clicked = 0;
  const checkbox = {
    isVisible: async () => true,
    isEnabled: async () => true,
    evaluate: async () => true,
    click: async () => { clicked += 1; }
  };
  const emptyLocator = {
    count: async () => 0,
    nth: () => { throw new Error('empty locator has no matches'); }
  };
  const frame = {
    url: () => 'https://www.google.com/recaptcha/api2/anchor?k=test',
    locator: (selector) => selector === '#recaptcha-anchor'
      ? { count: async () => 1, nth: () => checkbox }
      : emptyLocator
  };
  const page = {
    frames: () => (++scans < 3 ? [] : [frame]),
    waitForTimeout: async () => {}
  };

  assert.strictEqual(await fiptcha.clickCheckbox(page, 'recaptcha_v2', 1000), true);
  assert.strictEqual(clicked, 1);
  assert(scans >= 3, 'checkbox interaction should retry until the provider frame attaches');
}

async function testHiddenFirstCheckboxMatch() {
  let visibleClicked = 0;
  const candidates = [
    {
      isVisible: async () => false,
      isEnabled: async () => true,
      evaluate: async () => true,
      click: async () => { throw new Error('hidden match must not be clicked'); }
    },
    {
      isVisible: async () => true,
      isEnabled: async () => true,
      evaluate: async () => true,
      click: async () => { visibleClicked += 1; }
    }
  ];
  const frame = {
    url: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0',
    locator: (selector) => selector === '[role="checkbox"]'
      ? { count: async () => candidates.length, nth: (index) => candidates[index] }
      : { count: async () => 0, nth: () => null }
  };
  const page = { frames: () => [frame], waitForTimeout: async () => {} };

  assert.strictEqual(await fiptcha.clickCheckbox(page, 'turnstile', 1000), true);
  assert.strictEqual(visibleClicked, 1);
}

Promise.resolve()
  .then(testDelayedCheckboxFrame)
  .then(testHiddenFirstCheckboxMatch)
  .then(() => console.log('fiptcha checkbox interaction tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

console.log('fiptcha smoke tests passed');
