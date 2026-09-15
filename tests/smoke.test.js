const assert = require('assert');

process.env.SKIP_LOCAL_CAPTCHA_MODEL = 'true';
const fiptcha = require('..');
const { classifyGrid, mapDetectionsToCells, normalizeModelLabel, PROVIDERS, solveImageGrid, visibleText } = require('../src/captcha-grid-solver');
const { clickVisibleTarget } = require('../src/captcha-pointer');
const { captchaModelManager } = require('../src/captcha-model-manager');

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
assert.strictEqual(normalizeModelLabel('bicycles'), 'bicycle');
assert.strictEqual(normalizeModelLabel('traffic lights'), 'traffic light');
assert.strictEqual(normalizeModelLabel('buses'), 'bus');
assert.deepStrictEqual(
  mapDetectionsToCells(
    [{ box: [80, 20, 220, 80] }],
    { x: 0, y: 0, width: 300, height: 300 },
    [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 100, y: 0, width: 100, height: 100 },
      { x: 200, y: 0, width: 100, height: 100 }
    ],
    { width: 300, height: 300 }
  ),
  [0, 1, 2],
  'a detection spanning tile boundaries must select every materially intersected square'
);

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
    boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 })
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
    waitForTimeout: async () => {},
    viewportSize: () => ({ width: 100, height: 100 }),
    mouse: { click: async () => { clicked += 1; } }
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
      boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 })
    },
    {
      isVisible: async () => true,
      isEnabled: async () => true,
      evaluate: async () => true,
      boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 })
    }
  ];
  const frame = {
    url: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0',
    locator: (selector) => selector === '[role="checkbox"]'
      ? { count: async () => candidates.length, nth: (index) => candidates[index] }
      : { count: async () => 0, nth: () => null }
  };
  const page = {
    frames: () => [frame],
    waitForTimeout: async () => {},
    viewportSize: () => ({ width: 100, height: 100 }),
    mouse: { click: async () => { visibleClicked += 1; } }
  };

  assert.strictEqual(await fiptcha.clickCheckbox(page, 'turnstile', 1000), true);
  assert.strictEqual(visibleClicked, 1);
}

async function testHcaptchaCustomAssetHostCheckbox() {
  let clicks = 0;
  const checkbox = {
    isVisible: async () => true,
    isEnabled: async () => true,
    evaluate: async () => true,
    boundingBox: async () => ({ x: 20, y: 20, width: 30, height: 30 })
  };
  const empty = { count: async () => 0, nth: () => null };
  const frame = {
    url: () => 'https://captcha.customer.test/widget.html#frame=checkbox&id=widget',
    locator: (selector) => selector === '#checkbox'
      ? { count: async () => 1, nth: () => checkbox }
      : empty
  };
  const page = {
    frames: () => [frame],
    waitForTimeout: async () => {},
    viewportSize: () => ({ width: 100, height: 100 }),
    mouse: { click: async () => { clicks += 1; } }
  };
  assert.strictEqual(await fiptcha.clickCheckbox(page, 'hcaptcha', 1000), true);
  assert.strictEqual(clicks, 1, 'hCaptcha frames on first-party asset hosts must be detected');
}

async function testHcaptchaExecuteUsesRenderedWidgetId() {
  const calls = [];
  const page = {
    evaluate: async (callback) => {
      const previousDocument = global.document;
      const previousHcaptcha = global.hcaptcha;
      global.document = {
        querySelectorAll: () => [{ getAttribute: () => 'widget-7' }]
      };
      global.hcaptcha = { execute: (id) => { calls.push(id); } };
      try { return callback(); } finally {
        global.document = previousDocument;
        global.hcaptcha = previousHcaptcha;
      }
    }
  };
  assert.strictEqual(await fiptcha.executeHcaptchaWidget(page), true);
  assert.deepStrictEqual(calls, ['widget-7']);
}

async function testGridFallsBackToTilesWhenWholeGridHasNoDetection() {
  const originalDetect = captchaModelManager.detect;
  const gridPng = Buffer.alloc(24);
  gridPng.write('PNG', 1, 'ascii');
  gridPng.writeUInt32BE(300, 16);
  gridPng.writeUInt32BE(300, 20);
  const cells = Array.from({ length: 9 }, (_, index) => ({
    boundingBox: async () => ({ x: (index % 3) * 100, y: Math.floor(index / 3) * 100, width: 100, height: 100 }),
    screenshot: async () => Buffer.from(`tile-${index}`)
  }));
  const locator = {
    count: async () => cells.length,
    nth: (index) => cells[index]
  };
  const grid = {
    boundingBox: async () => ({ x: 0, y: 0, width: 300, height: 300 }),
    screenshot: async () => gridPng
  };
  const frame = { locator: (selector) => selector === PROVIDERS.recaptcha_v2.grid ? { first: () => grid } : locator };
  captchaModelManager.detect = async (image) => image === gridPng ? [] : (String(image) === 'tile-4' ? [{ score: 0.9 }] : []);
  try {
    assert.deepStrictEqual(
      await classifyGrid(frame, PROVIDERS.recaptcha_v2, locator, 'a fire hydrant', new Map()),
      [4],
      'per-tile detection must run when a whole-grid model pass returns no boxes'
    );
  } finally {
    captchaModelManager.detect = originalDetect;
  }
}

async function testGridFusesPartialWholeGridAndTileDetections() {
  const originalDetect = captchaModelManager.detect;
  const gridPng = Buffer.alloc(24);
  gridPng.write('PNG', 1, 'ascii');
  gridPng.writeUInt32BE(300, 16);
  gridPng.writeUInt32BE(300, 20);
  const cells = Array.from({ length: 9 }, (_, index) => ({
    boundingBox: async () => ({ x: (index % 3) * 100, y: Math.floor(index / 3) * 100, width: 100, height: 100 }),
    screenshot: async () => Buffer.from(`fusion-tile-${index}`)
  }));
  const locator = { count: async () => cells.length, nth: (index) => cells[index] };
  const grid = {
    boundingBox: async () => ({ x: 0, y: 0, width: 300, height: 300 }),
    screenshot: async () => gridPng
  };
  const frame = { locator: (selector) => selector === PROVIDERS.recaptcha_v2.grid ? { first: () => grid } : locator };
  captchaModelManager.detect = async (image) => {
    if (image === gridPng) return [{ box: [110, 110, 190, 190] }];
    return String(image) === 'fusion-tile-8' ? [{ score: 0.9 }] : [];
  };
  try {
    assert.deepStrictEqual(
      await classifyGrid(frame, PROVIDERS.recaptcha_v2, locator, 'bus', new Map()),
      [4, 8],
      'tile inference must supplement a partial whole-grid result'
    );
  } finally {
    captchaModelManager.detect = originalDetect;
  }
}

async function testHiddenChallengeErrorIsIgnored() {
  const hiddenError = { isVisible: async () => false, innerText: async () => 'Please try again' };
  const visibleError = { isVisible: async () => true, innerText: async () => 'Select all matching images' };
  const locator = { count: async () => 2, nth: (index) => [hiddenError, visibleError][index] };
  assert.strictEqual(await visibleText({ locator: () => locator }, '.error'), 'Select all matching images');
}

async function testRecaptchaGridClicksSelectedTilesThroughTheFrame() {
  const originalDetect = captchaModelManager.detect;
  const gridPng = Buffer.alloc(24);
  gridPng.write('PNG', 1, 'ascii');
  gridPng.writeUInt32BE(300, 16);
  gridPng.writeUInt32BE(300, 20);
  const tileClicks = [];
  let verifyClicks = 0;
  const cells = Array.from({ length: 9 }, (_, index) => ({
    boundingBox: async () => ({ x: (index % 3) * 100, y: Math.floor(index / 3) * 100, width: 100, height: 100 }),
    screenshot: async () => Buffer.from(`tile-${index}`),
    click: async () => { tileClicks.push(index); }
  }));
  const cellLocator = { count: async () => cells.length, nth: (index) => cells[index] };
  const grid = {
    isVisible: async () => true,
    boundingBox: async () => ({ x: 0, y: 0, width: 300, height: 300 }),
    screenshot: async () => gridPng
  };
  const prompt = { isVisible: async () => true, innerText: async () => 'Select all images with a fire hydrant' };
  const empty = { count: async () => 0, nth: () => null };
  const verify = { click: async () => { verifyClicks += 1; } };
  const frame = {
    url: () => 'https://www.google.com/recaptcha/api2/bframe?k=test',
    locator: (selector) => {
      if (selector === PROVIDERS.recaptcha_v2.grid) return { first: () => grid };
      if (selector === PROVIDERS.recaptcha_v2.cells) return cellLocator;
      if (selector === PROVIDERS.recaptcha_v2.instruction) return { count: async () => 1, nth: () => prompt };
      if (selector === PROVIDERS.recaptcha_v2.error) return empty;
      if (selector === PROVIDERS.recaptcha_v2.submit) return { first: () => verify };
      return empty;
    }
  };
  const page = { frames: () => [frame], waitForTimeout: async () => {} };
  captchaModelManager.detect = async (image) => image === gridPng ? [] : (String(image) === 'tile-4' ? [{ score: 0.9 }] : []);
  try {
    const token = await solveImageGrid(page, {
      captchaType: 'recaptcha_v2',
      deadline: Date.now() + 1_000,
      waitForToken: async () => 'token'
    });
    assert.strictEqual(token, 'token');
    assert.deepStrictEqual(tileClicks, [4]);
    assert.strictEqual(verifyClicks, 1);
  } finally {
    captchaModelManager.detect = originalDetect;
  }
}

async function testDynamicRecaptchaWaitsForReplacementTile() {
  const originalDetect = captchaModelManager.detect;
  let tile = 'dynamic-target';
  let clicks = 0;
  let replacementClassifications = 0;
  const gridPng = Buffer.alloc(24);
  gridPng.write('PNG', 1, 'ascii');
  gridPng.writeUInt32BE(300, 16);
  gridPng.writeUInt32BE(300, 20);
  const cells = Array.from({ length: 9 }, (_, index) => ({
    boundingBox: async () => ({ x: (index % 3) * 100, y: Math.floor(index / 3) * 100, width: 100, height: 100 }),
    screenshot: async () => Buffer.from(index === 4 ? tile : `dynamic-${index}`),
    click: async () => { clicks += 1; tile = 'dynamic-replacement'; }
  }));
  const cellLocator = { count: async () => 9, nth: (index) => cells[index] };
  const grid = { isVisible: async () => true, boundingBox: async () => ({ x: 0, y: 0, width: 300, height: 300 }), screenshot: async () => gridPng };
  const prompt = { isVisible: async () => true, innerText: async () => 'Select all images with buses. Click verify once there are none left' };
  const empty = { count: async () => 0, nth: () => null };
  const verify = { click: async () => {} };
  const frame = {
    url: () => 'https://www.google.com/recaptcha/api2/bframe?k=test',
    locator: (selector) => {
      if (selector === PROVIDERS.recaptcha_v2.grid) return { first: () => grid };
      if (selector === PROVIDERS.recaptcha_v2.cells) return cellLocator;
      if (selector === PROVIDERS.recaptcha_v2.instruction) return { count: async () => 1, nth: () => prompt };
      if (selector === PROVIDERS.recaptcha_v2.error) return empty;
      if (selector === PROVIDERS.recaptcha_v2.submit) return { first: () => verify };
      return empty;
    }
  };
  const page = { frames: () => [frame], waitForTimeout: async () => {} };
  captchaModelManager.detect = async (image) => {
    if (image === gridPng) return [];
    if (String(image) === 'dynamic-replacement') replacementClassifications += 1;
    return String(image) === 'dynamic-target' ? [{ score: 0.9 }] : [];
  };
  try {
    assert.strictEqual(await solveImageGrid(page, {
      captchaType: 'recaptcha_v2',
      deadline: Date.now() + 1000,
      waitForToken: async () => 'token'
    }), 'token');
    assert.strictEqual(clicks, 1);
    assert(replacementClassifications > 0, 'replacement tile must be classified before verification');
  } finally {
    captchaModelManager.detect = originalDetect;
  }
}

async function testFourByFourWaitsForNextRound() {
  const originalDetect = captchaModelManager.detect;
  let round = 0;
  let verifyClicks = 0;
  const gridImages = [0, 1].map((value) => {
    const image = Buffer.alloc(25);
    image.write('PNG', 1, 'ascii');
    image.writeUInt32BE(400, 16);
    image.writeUInt32BE(400, 20);
    image[24] = value;
    return image;
  });
  const tileClicks = [];
  const cells = Array.from({ length: 16 }, (_, index) => ({
    boundingBox: async () => ({ x: (index % 4) * 100, y: Math.floor(index / 4) * 100, width: 100, height: 100 }),
    screenshot: async () => Buffer.from(`round-${round}-tile-${index}`),
    click: async () => { tileClicks.push([round, index]); }
  }));
  const cellLocator = { count: async () => 16, nth: (index) => cells[index] };
  const grid = { isVisible: async () => true, boundingBox: async () => ({ x: 0, y: 0, width: 400, height: 400 }), screenshot: async () => gridImages[round] };
  const prompt = { isVisible: async () => true, innerText: async () => 'Select all squares with buses' };
  const empty = { count: async () => 0, nth: () => null };
  const verify = { click: async () => { verifyClicks += 1; if (round === 0) round = 1; } };
  const frame = {
    url: () => 'https://www.google.com/recaptcha/api2/bframe?k=test',
    locator: (selector) => {
      if (selector === PROVIDERS.recaptcha_v2.grid) return { first: () => grid };
      if (selector === PROVIDERS.recaptcha_v2.cells) return cellLocator;
      if (selector === PROVIDERS.recaptcha_v2.instruction) return { count: async () => 1, nth: () => prompt };
      if (selector === PROVIDERS.recaptcha_v2.error) return empty;
      if (selector === PROVIDERS.recaptcha_v2.submit) return { first: () => verify };
      return empty;
    }
  };
  const page = { frames: () => [frame], waitForTimeout: async () => {} };
  captchaModelManager.detect = async (image) => {
    if (gridImages.includes(image)) return [];
    return String(image) === `round-${round}-tile-${round ? 12 : 3}` ? [{ score: 0.9 }] : [];
  };
  try {
    const token = await solveImageGrid(page, {
      captchaType: 'recaptcha_v2',
      deadline: Date.now() + 2000,
      waitForToken: async () => verifyClicks >= 2 ? 'token' : null
    });
    assert.strictEqual(token, 'token');
    assert.deepStrictEqual(tileClicks, [[0, 3], [1, 12]]);
    assert.strictEqual(verifyClicks, 2, 'the new 4x4 round must be solved before re-submission');
  } finally {
    captchaModelManager.detect = originalDetect;
  }
}

async function testPointerClickDoesNotScrollOffscreenTargetsIntoView() {
  let pointerClicks = 0;
  const page = {
    viewportSize: () => ({ width: 100, height: 100 }),
    mouse: { click: async () => { pointerClicks += 1; } }
  };
  const offscreen = { boundingBox: async () => ({ x: 10, y: 140, width: 20, height: 20 }) };
  assert.strictEqual(await clickVisibleTarget(page, offscreen), false);
  assert.strictEqual(pointerClicks, 0);
}

Promise.resolve()
  .then(testDelayedCheckboxFrame)
  .then(testHiddenFirstCheckboxMatch)
  .then(testHcaptchaCustomAssetHostCheckbox)
  .then(testHcaptchaExecuteUsesRenderedWidgetId)
  .then(testGridFallsBackToTilesWhenWholeGridHasNoDetection)
  .then(testGridFusesPartialWholeGridAndTileDetections)
  .then(testHiddenChallengeErrorIsIgnored)
  .then(testRecaptchaGridClicksSelectedTilesThroughTheFrame)
  .then(testDynamicRecaptchaWaitsForReplacementTile)
  .then(testFourByFourWaitsForNextRound)
  .then(testPointerClickDoesNotScrollOffscreenTargetsIntoView)
  .then(() => console.log('fiptcha checkbox interaction tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

console.log('fiptcha smoke tests passed');
