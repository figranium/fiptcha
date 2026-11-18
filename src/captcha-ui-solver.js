const { captchaModelManager } = require('./captcha-model-manager');
const { findTargetInPage } = require('./captcha-text-solver');

const UI_CAPTCHA_PROMPTS = Object.freeze({
    slider_puzzle: 'slider puzzle target',
    drag_end: 'drag end target',
    image_rotation: 'image rotation target',
    icon_click: 'icon click target',
    text_click: 'text click target',
    visual_reasoning: 'visual reasoning target',
    oneclick_login: 'oneclick login target'
});

const DRAG_CAPTCHA_TYPES = new Set(['slider_puzzle', 'drag_end', 'image_rotation']);

const DEFAULT_SLIDER_SELECTORS = Object.freeze([
    '[role="slider"]',
    '[class*="slider" i] [class*="btn" i]',
    '[class*="slider" i] [class*="thumb" i]',
    '[class*="slider" i] [class*="handle" i]',
    '[class*="drag" i] [class*="handle" i]'
]);

function boxCenter(box, offset = { x: 0, y: 0 }) {
    if (Array.isArray(box) && box.length >= 4) {
        return {
            x: offset.x + ((Number(box[0]) + Number(box[2])) / 2),
            y: offset.y + ((Number(box[1]) + Number(box[3])) / 2)
        };
    }
    if (box && typeof box === 'object') {
        const xmin = Number(box.xmin ?? box.x ?? 0);
        const ymin = Number(box.ymin ?? box.y ?? 0);
        const xmax = Number(box.xmax ?? (xmin + Number(box.width ?? 0)));
        const ymax = Number(box.ymax ?? (ymin + Number(box.height ?? 0)));
        return {
            x: offset.x + ((xmin + xmax) / 2),
            y: offset.y + ((ymin + ymax) / 2)
        };
    }
    return null;
}

async function dragBetween(page, start, end) {
    if (!page?.mouse?.move || !page?.mouse?.down || !page?.mouse?.up) {
        throw new Error('Playwright page.mouse drag primitives are unavailable');
    }
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
}

async function solveUiCaptcha(page, {
    captchaType,
    targetPrompt,
    challengeSelector,
    sliderSelector,
    submitSelector,
    successSelector,
    errorSelector,
    deadline = Date.now() + 60_000,
    logs = []
} = {}) {
    const prompt = targetPrompt || UI_CAPTCHA_PROMPTS[captchaType];
    if (!prompt) {
        throw new Error(`Unsupported UI CAPTCHA type: ${captchaType}`);
    }

    const screenshotTimeout = Math.max(500, Math.min(5000, deadline - Date.now()));
    let offset = { x: 0, y: 0 };
    let imageBuffer;

    if (challengeSelector) {
        const container = await findTargetInPage(page, [challengeSelector]);
        if (!container) {
            throw new Error(`${captchaType} did not expose a visible challenge container`);
        }
        const box = await container.boundingBox().catch(() => null);
        if (box) offset = { x: box.x, y: box.y };
        imageBuffer = await container.screenshot({ type: 'png', timeout: screenshotTimeout });
    } else {
        imageBuffer = await page.screenshot({ type: 'png', timeout: screenshotTimeout });
    }

    const detections = await captchaModelManager.ground(imageBuffer, prompt);
    if (!Array.isArray(detections) || detections.length === 0) {
        throw new Error(`${captchaType} grounding returned no target regions`);
    }

    const points = detections.map((det) => boxCenter(det.box || det, offset)).filter(Boolean);
    if (points.length === 0) {
        throw new Error(`${captchaType} grounding returned invalid bounding boxes`);
    }

    let action = 'click';
    if (DRAG_CAPTCHA_TYPES.has(captchaType)) {
        const sliderSelectors = sliderSelector ? [sliderSelector] : DEFAULT_SLIDER_SELECTORS;
        const handle = await findTargetInPage(page, sliderSelectors);
        const handleBox = handle ? await handle.boundingBox().catch(() => null) : null;
        if (handleBox) {
            const start = { x: handleBox.x + (handleBox.width / 2), y: handleBox.y + (handleBox.height / 2) };
            const target = points[0];
            const end = captchaType === 'drag_end' ? target : { x: target.x, y: start.y };
            await dragBetween(page, start, end);
            action = 'drag';
            logs.push(`Local ${captchaType} dragged slider from (${Math.round(start.x)}, ${Math.round(start.y)}) to (${Math.round(end.x)}, ${Math.round(end.y)})`);
        } else if (points.length >= 2) {
            await dragBetween(page, points[0], points[1]);
            action = 'drag';
            logs.push(`Local ${captchaType} dragged from (${Math.round(points[0].x)}, ${Math.round(points[0].y)}) to (${Math.round(points[1].x)}, ${Math.round(points[1].y)})`);
        } else {
            await page.mouse.click(points[0].x, points[0].y);
            logs.push(`Local ${captchaType} clicked grounded target at (${Math.round(points[0].x)}, ${Math.round(points[0].y)})`);
        }
    } else {
        for (const pt of points) {
            await page.mouse.click(pt.x, pt.y);
            logs.push(`Local ${captchaType} clicked grounded target at (${Math.round(pt.x)}, ${Math.round(pt.y)})`);
        }
    }

    if (submitSelector) {
        const submitLocator = await findTargetInPage(page, [submitSelector]);
        if (submitLocator) await submitLocator.click({ timeout: 2000 });
    }

    if (successSelector || errorSelector) {
        const verifyDeadline = Math.min(deadline, Date.now() + 5000);
        let verified = !successSelector;
        while (Date.now() < verifyDeadline) {
            if (errorSelector) {
                const errEl = await findTargetInPage(page, [errorSelector]);
                if (errEl) {
                    const msg = await errEl.innerText({ timeout: 500 }).catch(() => '');
                    throw new Error(`${captchaType} verification failed${msg ? `: ${msg.trim()}` : ''}`);
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
            throw new Error(`${captchaType} was not confirmed by successSelector`);
        }
    }

    return {
        action,
        points,
        detections
    };
}

module.exports = {
    UI_CAPTCHA_PROMPTS,
    DRAG_CAPTCHA_TYPES,
    DEFAULT_SLIDER_SELECTORS,
    boxCenter,
    dragBetween,
    solveUiCaptcha
};
