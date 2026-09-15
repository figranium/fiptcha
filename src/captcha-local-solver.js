const { captchaModelManager } = require('./captcha-model-manager');
const { solveImageGrid, PROVIDERS } = require('./captcha-grid-solver');
const { clickVisibleTarget } = require('./captcha-pointer');

const TOKEN_SELECTORS = Object.freeze({
    recaptcha_v2: ['#g-recaptcha-response', 'textarea[name="g-recaptcha-response"]'],
    hcaptcha: ['textarea[name="h-captcha-response"]', 'textarea[name="g-recaptcha-response"]'],
    turnstile: ['input[name="cf-turnstile-response"]', 'textarea[name="cf-turnstile-response"]']
});

const WIDGET_INTERACTIONS = Object.freeze({
    recaptcha_v2: Object.freeze({
        framePatterns: ['/recaptcha/api2/anchor', '/recaptcha/enterprise/anchor'],
        selectors: ['#recaptcha-anchor', '[role="checkbox"]']
    }),
    hcaptcha: Object.freeze({
        framePatterns: ['hcaptcha.com', 'hcaptcha.html', 'hcaptcha-checkbox.html', 'frame=checkbox'],
        selectors: ['#checkbox', '.check', '#anchor', '[role="checkbox"]', 'input[type="checkbox"]', 'label']
    }),
    turnstile: Object.freeze({
        framePatterns: ['challenges.cloudflare.com'],
        selectors: ['[role="checkbox"]', 'input[type="checkbox"]', 'label', 'button']
    })
});

function frameMatches(frame, patterns) {
    const url = String(frame?.url?.() || '').toLowerCase();
    return patterns.some((pattern) => url.includes(pattern));
}

async function readToken(page, captchaType) {
    return page.evaluate(({ type, selectors }) => {
        for (const selector of selectors[type] || []) {
            for (const element of document.querySelectorAll(selector)) {
                const value = String(element.value || element.getAttribute('value') || '').trim();
                if (value) return value;
            }
        }
        if (type === 'recaptcha_v2' && globalThis.grecaptcha?.getResponse) {
            try { return globalThis.grecaptcha.getResponse() || ''; } catch { /* widget id may be required */ }
        }
        if (type === 'hcaptcha' && globalThis.hcaptcha?.getResponse) {
            try { return globalThis.hcaptcha.getResponse() || ''; } catch { /* widget id may be required */ }
        }
        if (type === 'turnstile' && globalThis.turnstile?.getResponse) {
            try { return globalThis.turnstile.getResponse() || ''; } catch { /* widget id may be required */ }
        }
        return '';
    }, { type: captchaType, selectors: TOKEN_SELECTORS }).catch(() => '');
}

async function waitForToken(page, captchaType, timeout) {
    const deadline = Date.now() + Math.max(0, timeout);
    do {
        const token = await readToken(page, captchaType);
        if (token) return token;
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return null;
}

async function waitForTokenOrChallenge(page, captchaType, timeout) {
    const adapter = PROVIDERS[captchaType];
    const deadline = Date.now() + Math.max(0, timeout);
    do {
        const token = await readToken(page, captchaType);
        if (token) return token;
        if (adapter) {
            for (const frame of page.frames?.() || []) {
                if (!frameMatches(frame, adapter.framePatterns)) continue;
                if (await frame.locator(adapter.grid).first().isVisible({ timeout: 100 }).catch(() => false)) return null;
            }
        }
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return null;
}

async function clickCheckbox(page, captchaType, timeout = 10_000) {
    const interaction = WIDGET_INTERACTIONS[captchaType];
    if (!interaction) return false;
    const deadline = Date.now() + Math.max(0, timeout);

    do {
        for (const frame of page.frames?.() || []) {
            if (!frameMatches(frame, interaction.framePatterns)) continue;

            for (const selector of interaction.selectors) {
                const matches = frame.locator(selector);
                const count = await matches.count().catch(() => 0);
                for (let index = 0; index < count; index += 1) {
                    const checkbox = matches.nth(index);
                    if (!await checkbox.isVisible({ timeout: 100 }).catch(() => false)) continue;
                    if (!await checkbox.isEnabled({ timeout: 100 }).catch(() => true)) continue;
                    const pointerReady = await checkbox.evaluate((element) => {
                        const style = getComputedStyle(element);
                        return style.pointerEvents !== 'none' && element.getAttribute('aria-disabled') !== 'true';
                    }).catch(() => true);
                    if (!pointerReady) continue;

                    const clicked = await clickVisibleTarget(page, checkbox).catch(() => false);
                    if (clicked) return true;
                }
            }
        }

        if (Date.now() >= deadline) break;
        await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);

    return false;
}

async function executeHcaptchaWidget(page) {
    return page.evaluate(() => {
        if (typeof globalThis.hcaptcha?.execute !== 'function') return false;
        const ids = [...document.querySelectorAll('[data-hcaptcha-widget-id]')]
            .map((element) => element.getAttribute('data-hcaptcha-widget-id'))
            .filter(Boolean);
        for (const id of [...new Set([...ids, null])]) {
            try {
                const pending = id === null ? globalThis.hcaptcha.execute() : globalThis.hcaptcha.execute(id);
                if (pending && typeof pending.catch === 'function') pending.catch(() => {});
                return true;
            } catch { /* try the default/next widget */ }
        }
        return false;
    }).catch(() => false);
}

async function solveLocalCaptcha(page, { captchaType, timeout = 60_000, logs = [] } = {}) {
    if (!['recaptcha_v2', 'hcaptcha', 'turnstile'].includes(captchaType)) {
        throw new Error(`Local solver does not support ${captchaType}`);
    }
    const deadline = Date.now() + Math.max(1, timeout);
    let usedVisionModel = false;
    const modelReadiness = ['recaptcha_v2', 'hcaptcha'].includes(captchaType)
        ? captchaModelManager.reconcile().then((runtime) => ({ runtime }), (error) => ({ error }))
        : null;
    let token = await readToken(page, captchaType);
    if (!token) {
        // Invisible hCaptcha has no checkbox; do not spend ten seconds looking
        // for one before invoking its documented execute path.
        const interactionTimeout = captchaType === 'hcaptcha' ? 2500 : 10_000;
        const clickTimeout = Math.min(interactionTimeout, Math.max(0, deadline - Date.now()));
        const clicked = await clickCheckbox(page, captchaType, clickTimeout)
            .catch((error) => {
                logs.push(`Local ${captchaType} checkbox click failed: ${error.message}`);
                return false;
            });
        logs.push(clicked
            ? `Local ${captchaType} checkbox clicked`
            : `Local ${captchaType} checkbox was not found before the interaction timeout`);
        const initialWait = captchaType === 'hcaptcha' ? 1500 : 7000;
        token = await waitForTokenOrChallenge(page, captchaType, Math.min(initialWait, Math.max(0, deadline - Date.now())));
        if (!token && captchaType === 'hcaptcha' && Date.now() < deadline) {
            const executed = await executeHcaptchaWidget(page);
            if (executed) logs.push('Local hcaptcha widget required programmatic execution after checkbox interaction');
            token = await waitForTokenOrChallenge(page, captchaType, Math.min(5500, Math.max(0, deadline - Date.now())));
        }
    }
    if (!token && captchaType === 'turnstile') {
        throw new Error('Turnstile did not issue a token after the active-browser interaction');
    }
    if (!token) {
        const adapter = PROVIDERS[captchaType];
        const frameDeadline = Math.min(deadline, Date.now() + 4000);
        let challengeVisible = false;
        while (!challengeVisible && Date.now() < frameDeadline) {
            for (const frame of page.frames?.() || []) {
                if (!frameMatches(frame, adapter.framePatterns)) continue;
                challengeVisible = await frame.locator(adapter.grid).first().isVisible({ timeout: 100 }).catch(() => false);
                if (challengeVisible) break;
            }
            if (!challengeVisible) await page.waitForTimeout(100);
        }
        if (!challengeVisible) throw new Error(`${captchaType} did not expose an image challenge or token`);
        if (modelReadiness) {
            const readiness = await modelReadiness;
            if (readiness.error) throw new Error(`vision backend unavailable: ${readiness.error.message}`);
            if (!readiness.runtime) throw new Error(captchaModelManager.status().error || 'vision backend unavailable');
        }
        usedVisionModel = true;
        logs.push(`Local ${captchaType} image challenge is ready; starting grid solver`);
        token = await solveImageGrid(page, { captchaType, deadline, waitForToken, logs });
    }
    if (!token) throw new Error(`${captchaType} challenge ended without producing a token`);
    const status = captchaModelManager.status();
    return {
        token,
        provider: 'local',
        ...(usedVisionModel && status.activeTier ? { model: status.activeTier } : {}),
        device: usedVisionModel ? (status.device || 'cpu') : 'browser'
    };
}

module.exports = { TOKEN_SELECTORS, WIDGET_INTERACTIONS, frameMatches, readToken, waitForToken, waitForTokenOrChallenge, clickCheckbox, executeHcaptchaWidget, solveLocalCaptcha };
