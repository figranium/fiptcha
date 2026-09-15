const { captchaModelManager, checksumBuffer } = require('./captcha-model-manager');

const PROVIDERS = Object.freeze({
    recaptcha_v2: Object.freeze({
        framePatterns: ['/recaptcha/api2/bframe', '/recaptcha/enterprise/bframe'],
        instruction: '.rc-imageselect-desc-wrapper, .rc-imageselect-instructions',
        grid: '.rc-imageselect-table-33, .rc-imageselect-table-44',
        cells: '.rc-imageselect-tile',
        submit: '#recaptcha-verify-button',
        noMatch: '#recaptcha-verify-button',
        // `error-dynamic-more` is also shown while replacement tiles are still
        // expected. Treating it as a rejection aborts valid dynamic challenges.
        error: '.rc-imageselect-error-select-more, .rc-imageselect-incorrect-response',
        cleanPrompt(text) {
            return text.replace(/select all (images|squares) with/ig, '')
                .replace(/click verify once there are none left/ig, '')
                .replace(/if there are none, click skip/ig, '');
        }
    }),
    hcaptcha: Object.freeze({
        // Enterprise integrations may serve the iframe from a first-party
        // asset host, so do not require an hcaptcha.com hostname.
        framePatterns: ['hcaptcha.com', 'hcaptcha.html', 'hcaptcha-checkbox.html', 'frame=challenge', 'frame=checkbox'],
        instruction: '.prompt-text, .challenge-header .prompt-text, .challenge-header h2, h2',
        grid: '.task-grid, [class*="task-grid"]',
        cells: '.task-grid .task-image, [class*="task-grid"] [class*="task-image"]',
        submit: '.button-submit, button[type="submit"]',
        noMatch: '.button-submit, button[type="submit"]',
        error: '.error-text, .challenge-error',
        cleanPrompt(text) {
            return text.replace(/please (click|select) (on )?(all|each) (the )?(images|squares) (containing|with)/ig, '')
                .replace(/if there are none, (click|select) (skip|next)/ig, '');
        }
    })
});

async function findChallengeFrame(page, adapter) {
    for (const frame of page.frames()) {
        const url = String(frame.url?.() || '').toLowerCase();
        if (!adapter.framePatterns.some((pattern) => url.includes(pattern))) continue;
        if (await frame.locator(adapter.grid).first().isVisible({ timeout: 250 }).catch(() => false)) return frame;
    }
    return null;
}

function normalizePrompt(adapter, text) {
    return adapter.cleanPrompt(String(text || '')).replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
}

function normalizeModelLabel(label) {
    return String(label || '').replace(/\b[a-z]+\b/gi, (word) => {
        const lower = word.toLowerCase();
        if (lower === 'buses') return 'bus';
        if (lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
        if (/(?:ches|shes|xes|zes)$/.test(lower)) return lower.slice(0, -2);
        if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us')) return lower.slice(0, -1);
        return lower;
    });
}

function normalizeBox(detection) {
    const box = detection?.box || detection?.bbox;
    if (Array.isArray(box) && box.length >= 4) {
        const [xmin, ymin, xmax, ymax] = box.map(Number);
        return { xmin, ymin, xmax, ymax };
    }
    if (box && typeof box === 'object') {
        const xmin = Number(box.xmin ?? box.x ?? box.left);
        const ymin = Number(box.ymin ?? box.y ?? box.top);
        const xmax = Number(box.xmax ?? box.right ?? (Number.isFinite(xmin) ? xmin + Number(box.width) : NaN));
        const ymax = Number(box.ymax ?? box.bottom ?? (Number.isFinite(ymin) ? ymin + Number(box.height) : NaN));
        if ([xmin, ymin, xmax, ymax].every(Number.isFinite)) return { xmin, ymin, xmax, ymax };
    }
    return null;
}

function pngDimensions(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function mapDetectionsToCells(detections, gridBox, cellBoxes, imageSize = null) {
    const indexes = new Set();
    const scaleX = imageSize?.width ? gridBox.width / imageSize.width : 1;
    const scaleY = imageSize?.height ? gridBox.height / imageSize.height : 1;
    for (const detection of detections) {
        const box = normalizeBox(detection);
        if (!box) continue;
        const projected = {
            left: gridBox.x + (box.xmin * scaleX),
            top: gridBox.y + (box.ymin * scaleY),
            right: gridBox.x + (box.xmax * scaleX),
            bottom: gridBox.y + (box.ymax * scaleY)
        };
        const centerX = (projected.left + projected.right) / 2;
        const centerY = (projected.top + projected.bottom) / 2;
        cellBoxes.forEach((cell, index) => {
            if (!cell) return;
            const intersectionWidth = Math.max(0, Math.min(projected.right, cell.x + cell.width) - Math.max(projected.left, cell.x));
            const intersectionHeight = Math.max(0, Math.min(projected.bottom, cell.y + cell.height) - Math.max(projected.top, cell.y));
            const coverage = (intersectionWidth * intersectionHeight) / Math.max(1, cell.width * cell.height);
            const containsCenter = centerX >= cell.x && centerX <= cell.x + cell.width
                && centerY >= cell.y && centerY <= cell.y + cell.height;
            // reCAPTCHA asks for every square containing part of an object, not
            // merely the square containing the detector box's center.
            if (containsCenter || coverage >= 0.08) indexes.add(index);
        });
    }
    return [...indexes];
}

async function classifyGrid(frame, adapter, cells, label, seenTiles) {
    const modelLabel = normalizeModelLabel(label);
    const mapped = new Set();
    const grid = frame.locator(adapter.grid).first();
    const gridBox = await grid.boundingBox().catch(() => null);
    if (gridBox) {
        const image = await grid.screenshot({ type: 'png' });
        const detections = await captchaModelManager.detect(image, modelLabel);
        const cellBoxes = [];
        for (let index = 0; index < await cells.count(); index += 1) cellBoxes.push(await cells.nth(index).boundingBox().catch(() => null));
        for (const index of mapDetectionsToCells(detections, gridBox, cellBoxes, pngDimensions(image))) mapped.add(index);
    }

    const selected = [];
    for (let index = 0; index < await cells.count(); index += 1) {
        const cell = cells.nth(index);
        const image = await cell.screenshot({ type: 'png' });
        const fingerprint = checksumBuffer(image);
        if (seenTiles.get(index) === fingerprint) continue;
        seenTiles.set(index, fingerprint);
        // A whole-grid pass is fast and preserves objects spanning cell edges,
        // while a tile pass retains detail on dense 4x4 grids. Fuse both: a
        // partial grid result must not suppress tile-level matches elsewhere.
        if (mapped.has(index) || (await captchaModelManager.detect(image, modelLabel)).length) selected.push(index);
    }
    return selected;
}

async function rememberClickedTile(cells, index, seenTiles, beforeFingerprint = null) {
    // Clicking a CAPTCHA tile changes its rendered appearance (selection overlay,
    // border, checkmark, etc.). Remember that post-click state immediately so the
    // next sweep does not mistake the selection UI itself for a replacement image
    // and toggle an already-correct tile back off. A genuinely replaced tile will
    // still produce a different fingerprint on the next sweep.
    const cell = cells.nth(index);
    const currentFingerprint = await tileFingerprint(cell);
    // A fast replacement may already be present by the time click() resolves.
    // Do not mark that unseen image as processed.
    if (beforeFingerprint && currentFingerprint && currentFingerprint !== beforeFingerprint) return;
    const image = await cell.screenshot({ type: 'png' }).catch(() => null);
    if (image) seenTiles.set(index, checksumBuffer(image));
}

async function tileFingerprint(cell) {
    const source = typeof cell.evaluate === 'function' ? await cell.evaluate((element) => {
        const images = [...element.querySelectorAll('img')];
        if (images.length) return images.map((image) => [image.currentSrc, image.src, image.style.transform].join('|')).join('\n');
        const styled = [element, ...element.querySelectorAll('*')]
            .map((candidate) => getComputedStyle(candidate).backgroundImage)
            .filter((value) => value && value !== 'none');
        return styled.join('\n');
    }).catch(() => '') : '';
    if (source) return checksumBuffer(Buffer.from(source));
    const image = await cell.screenshot({ type: 'png' }).catch(() => null);
    return image ? checksumBuffer(image) : null;
}

async function tileFingerprints(cells, indexes) {
    const fingerprints = new Map();
    for (const index of indexes) {
        const fingerprint = await tileFingerprint(cells.nth(index));
        if (fingerprint) fingerprints.set(index, fingerprint);
    }
    return fingerprints;
}

async function waitForTileReplacement(page, cells, before, deadline, timeout = 2500) {
    const replacementDeadline = Math.min(deadline, Date.now() + timeout);
    const pending = new Map(before);
    let changed = false;
    while (Date.now() < replacementDeadline) {
        for (const [index, fingerprint] of pending) {
            const current = await tileFingerprint(cells.nth(index));
            if (current && current !== fingerprint) {
                pending.delete(index);
                changed = true;
            }
        }
        if (!pending.size) {
            // Let the replacement animation finish before inference.
            await page.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now())));
            return true;
        }
        await page.waitForTimeout(Math.min(100, Math.max(1, replacementDeadline - Date.now())));
    }
    return changed;
}

async function challengeSignature(frame, adapter) {
    const grid = frame?.locator(adapter.grid).first();
    const image = await grid?.screenshot({ type: 'png' }).catch(() => null);
    if (!image) return null;
    const prompt = normalizePrompt(adapter, await visibleText(frame, adapter.instruction));
    const count = await frame.locator(adapter.cells).count().catch(() => 0);
    return `${prompt}\n${count}\n${checksumBuffer(image)}`;
}

async function waitForSubmission(page, adapter, captchaType, previousSignature, deadline, waitForToken) {
    const transitionDeadline = Math.min(deadline, Date.now() + 5000);
    while (Date.now() < transitionDeadline) {
        const token = await waitForToken(page, captchaType, 0);
        if (token) return { token, transitioned: false };
        const frame = await findChallengeFrame(page, adapter);
        if (frame) {
            const signature = await challengeSignature(frame, adapter);
            if (previousSignature && signature && signature !== previousSignature) return { token: null, transitioned: true };
        }
        await page.waitForTimeout(Math.min(125, Math.max(1, transitionDeadline - Date.now())));
    }
    return { token: null, transitioned: false };
}

async function visibleText(frame, selector) {
    const matches = frame.locator(selector);
    for (let index = 0; index < await matches.count().catch(() => 0); index += 1) {
        const locator = matches.nth(index);
        if (!await locator.isVisible({ timeout: 250 }).catch(() => false)) continue;
        return locator.innerText({ timeout: 1500 }).catch(() => '');
    }
    return '';
}

async function solveImageGrid(page, { captchaType, deadline, waitForToken, logs = [] }) {
    const adapter = PROVIDERS[captchaType];
    if (!adapter) throw new Error(`No image-grid adapter for ${captchaType}`);
    const seenTiles = new Map();
    let previousPrompt = '';
    for (let round = 0; round < 12 && Date.now() < deadline; round += 1) {
        const frame = await findChallengeFrame(page, adapter);
        if (!frame) throw new Error(`${captchaType} image challenge frame disappeared`);
        const rejection = await visibleText(frame, adapter.error);
        if (rejection && round > 0) {
            throw new Error(`${captchaType} rejected the previous selection: ${rejection.replace(/\s+/g, ' ').trim()}`);
        }
        const instruction = await visibleText(frame, adapter.instruction);
        const prompt = normalizePrompt(adapter, instruction);
        const dynamic = captchaType === 'recaptcha_v2'
            && /(?:none left|new images|replaced)/i.test(instruction);
        if (!prompt) throw new Error(`${captchaType} solver could not read the image challenge instruction`);
        if (prompt !== previousPrompt) {
            seenTiles.clear();
            previousPrompt = prompt;
        }
        let totalSelections = 0;
        for (let sweep = 0; sweep < 12 && Date.now() < deadline; sweep += 1) {
            const cells = frame.locator(adapter.cells);
            const count = await cells.count();
            if (![9, 16].includes(count)) throw new Error(`Unsupported ${captchaType} grid size (${count} cells)`);
            const selected = await classifyGrid(frame, adapter, cells, prompt, seenTiles);
            // Grid cells live inside a provider iframe. Let Playwright target the
            // element in that frame instead of sending a page-level mouse click:
            // the latter can miss the cell when iframe coordinates change.
            const before = await tileFingerprints(cells, selected);
            for (const index of selected) {
                await cells.nth(index).click({ timeout: 2000 });
                await rememberClickedTile(cells, index, seenTiles, before.get(index));
            }
            totalSelections += selected.length;
            if (!selected.length) break;
            // Dynamic 3x3 challenges replace selected tiles. Static and 4x4
            // challenges do not, so stop sweeping once no replacement occurs.
            if (!dynamic || !await waitForTileReplacement(page, cells, before, deadline)) break;
        }
        logs.push(`Local ${captchaType} grid round ${round + 1}: selected ${totalSelections} cells for "${prompt}"`);
        const signature = await challengeSignature(frame, adapter);
        await frame.locator(totalSelections ? adapter.submit : adapter.noMatch).first().click({ timeout: 2000 });
        const result = await waitForSubmission(page, adapter, captchaType, signature, deadline, waitForToken);
        if (result.token) return result.token;
        if (!result.transitioned) await page.waitForTimeout(Math.min(350, Math.max(0, deadline - Date.now())));
    }
    return null;
}

module.exports = { PROVIDERS, normalizePrompt, normalizeModelLabel, normalizeBox, pngDimensions, mapDetectionsToCells, classifyGrid, rememberClickedTile, visibleText, tileFingerprint, tileFingerprints, waitForTileReplacement, challengeSignature, waitForSubmission, solveImageGrid };
