const assert = require('assert');
const http = require('http');
const { chromium } = require('playwright');

process.env.SKIP_LOCAL_CAPTCHA_MODEL = 'true';
const { solveLocalCaptcha } = require('..');

const FIXTURE_HOST = 'captcha.test';

const pages = {
  '/recaptcha-v2': `<!doctype html><html><body><div id="widget"></div><script>
    window.__captchaState = { ready: false, token: '', error: '' };
    window.onCaptchaReady = function () {
      grecaptcha.render('widget', {
        sitekey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
        callback: function (token) { window.__captchaState.token = token; },
        'error-callback': function () { window.__captchaState.error = 'error'; }
      });
      window.__captchaState.ready = true;
    };
  </script><script src="https://www.google.com/recaptcha/api.js?onload=onCaptchaReady&render=explicit" async defer></script></body></html>`,
  '/hcaptcha': `<!doctype html><html><body><div id="widget"></div><script>
    window.__captchaState = { ready: false, token: '', error: '' };
    window.onCaptchaReady = function () {
      hcaptcha.render('widget', {
        sitekey: '10000000-ffff-ffff-ffff-000000000001',
        callback: function (token) { window.__captchaState.token = token; },
        'error-callback': function (code) { window.__captchaState.error = String(code); }
      });
      window.__captchaState.ready = true;
    };
  </script><script src="https://js.hcaptcha.com/1/api.js?onload=onCaptchaReady&render=explicit" async defer></script></body></html>`,
  '/turnstile': `<!doctype html><html><body><div id="widget"></div><script>
    window.__captchaState = { ready: false, token: '', error: '' };
    window.onCaptchaReady = function () {
      turnstile.render('#widget', {
        sitekey: '1x00000000000000000000AA',
        callback: function (token) { window.__captchaState.token = token; },
        'error-callback': function (code) { window.__captchaState.error = String(code); }
      });
      window.__captchaState.ready = true;
    };
  </script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onCaptchaReady&render=explicit" async defer></script></body></html>`
};

async function main() {
  const server = http.createServer((request, response) => {
    response.writeHead(pages[request.url] ? 200 : 404, { 'Content-Type': 'text/html' });
    response.end(pages[request.url] || 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1`]
  });
  const cases = [
    ['/recaptcha-v2', 'recaptcha_v2'],
    ['/hcaptcha', 'hcaptcha'],
    ['/turnstile', 'turnstile']
  ];

  try {
    for (const [route, captchaType] of cases) {
      const page = await browser.newPage();
      const browserMessages = [];
      const scrollEvents = [];
      page.on('console', (message) => browserMessages.push(`${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => browserMessages.push(`pageerror: ${error.message}`));
      await page.exposeBinding('recordFiptchaScroll', (_, y) => scrollEvents.push(y));
      await page.addInitScript(() => {
        addEventListener('scroll', () => globalThis.recordFiptchaScroll(scrollY));
      });
      await page.goto(`http://${FIXTURE_HOST}:${server.address().port}${route}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      });
      await page.waitForFunction(() => window.__captchaState?.ready || window.__captchaState?.error, null, {
        timeout: 30_000
      });

      const logs = [];
      try {
        const result = await solveLocalCaptcha(page, { captchaType, timeout: 20_000, logs });
        assert(result.token, `${captchaType} did not return a token`);
        assert.deepStrictEqual(scrollEvents, [], `${captchaType} interaction must not scroll the page`);
      } catch (error) {
        const state = await page.evaluate(() => window.__captchaState);
        throw new Error(`${captchaType}: ${error.message}; logs=${JSON.stringify(logs)}; state=${JSON.stringify(state)}; scrolls=${JSON.stringify(scrollEvents)}; browser=${JSON.stringify(browserMessages)}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('Official reCAPTCHA v2, hCaptcha, and Turnstile browser tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
