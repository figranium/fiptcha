async function viewportSize(page) {
    const configured = page.viewportSize?.();
    if (configured?.width && configured?.height) return configured;
    return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null);
}

function isInsideViewport(box, viewport) {
    if (!box || !viewport) return false;
    const x = box.x + (box.width / 2);
    const y = box.y + (box.height / 2);
    return Number.isFinite(x) && Number.isFinite(y)
        && x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
}

/**
 * Dispatch a trusted pointer click without Playwright's scroll-into-view step.
 * CAPTCHA widgets should already be visible to a human; scrolling the page to
 * satisfy a locator can move or invalidate the challenge between tile clicks.
 */
async function clickVisibleTarget(page, locator) {
    if (!page?.mouse?.click) return false;
    const [box, viewport] = await Promise.all([
        locator.boundingBox().catch(() => null),
        viewportSize(page)
    ]);
    if (!isInsideViewport(box, viewport)) return false;
    await page.mouse.click(box.x + (box.width / 2), box.y + (box.height / 2));
    return true;
}

module.exports = { clickVisibleTarget, isInsideViewport };
