const { captchaModelManager } = require('./captcha-model-manager');

const DEFAULT_IMAGE_SELECTORS = Object.freeze([
    'img[alt*="captcha" i]',
    'img[id*="captcha" i]',
    'img[class*="captcha" i]',
    'img[src*="captcha" i]',
    'canvas[id*="captcha" i]',
    'canvas[class*="captcha" i]',
    '[class*="captcha" i] img',
    '[id*="captcha" i] img'
]);

const DEFAULT_INPUT_SELECTORS = Object.freeze([
    'input[name*="captcha" i]',
    'input[id*="captcha" i]',
    'input[placeholder*="captcha" i]',
    'input[aria-label*="captcha" i]',
    'input[type="text"]'
]);

function normalizeRecognizedText(rawText, { stripWhitespace = true, alphanumericOnly = false } = {}) {
    let text = String(rawText || '').replace(/[\r\n]+/g, ' ').trim();
    if (stripWhitespace) text = text.replace(/\s+/g, '');
    if (alphanumericOnly) text = text.replace(/[^a-z0-9]/gi, '');
    return text;
}

async function findFirstVisible(root, selectors, timeout = 200) {
    for (const selector of selectors) {
        if (!selector) continue;
        const matches = root.locator(selector);
        const count = await matches.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
            const candidate = matches.nth(index);
            if (await candidate.isVisible({ timeout }).catch(() => false)) {
                return candidate;
            }
        }
    }
    return null;
}

async function findTargetInPage(page, selectors) {
    const direct = await findFirstVisible(page, selectors);
    if (direct) return direct;
    for (const frame of page.frames?.() || []) {
        const match = await findFirstVisible(frame, selectors);
        if (match) return match;
    }
    return null;
}

async function solveTextCaptcha(page, {
    imageSelector,
    inputSelector,
    submitSelector,
    successSelector,
    errorSelector,
    stripWhitespace = true,
    alphanumericOnly = false,
    deadline = Date.now() + 60_000,
    logs = []
} = {}) {
    const imageSelectors = imageSelector ? [imageSelector] : DEFAULT_IMAGE_SELECTORS;
    const imageLocator = await findTargetInPage(page, imageSelectors);
    if (!imageLocator) {
        throw new Error('distorted_text did not expose a visible CAPTCHA image');
    }

    const screenshotTimeout = Math.max(500, Math.min(5000, deadline - Date.now()));
    const imageBuffer = await imageLocator.screenshot({ type: 'png', timeout: screenshotTimeout });
    const rawText = await captchaModelManager.recognizeText(imageBuffer);
    const text = normalizeRecognizedText(rawText, { stripWhitespace, alphanumericOnly });
    if (!text) {
        throw new Error('distorted_text OCR returned empty text');
    }

    logs.push(`Local distorted_text OCR recognized "${text}"`);

    const inputSelectors = inputSelector ? [inputSelector] : DEFAULT_INPUT_SELECTORS;
    const inputLocator = await findTargetInPage(page, inputSelectors);
    if (inputLocator) {
        await inputLocator.fill(text);
        if (submitSelector) {
            const submitLocator = await findTargetInPage(page, [submitSelector]);
            if (submitLocator) await submitLocator.click({ timeout: 2000 });
        }
    }

    if (successSelector || errorSelector) {
        const verifyDeadline = Math.min(deadline, Date.now() + 5000);
        let verified = !successSelector;
        while (Date.now() < verifyDeadline) {
            if (errorSelector) {
                const errEl = await findTargetInPage(page, [errorSelector]);
                if (errEl) {
                    const msg = await errEl.innerText({ timeout: 500 }).catch(() => '');
                    throw new Error(`distorted_text verification failed${msg ? `: ${msg.trim()}` : ''}`);
                }
            }
            if (successSelector) {
                const okEl = await findTargetInPage(page, [successSelector]);
                if (okEl) {
                    verified = true;
                    break;
                }
            }
            await page.waitForTimeout(Math.min(100, Math.max(1, verifyDeadline - Date.now())));
        }
        if (!verified) {
            throw new Error('distorted_text was not confirmed by successSelector');
        }
    }

    return text;
}

module.exports = {
    DEFAULT_IMAGE_SELECTORS,
    DEFAULT_INPUT_SELECTORS,
    normalizeRecognizedText,
    findFirstVisible,
    findTargetInPage,
    solveTextCaptcha
};
