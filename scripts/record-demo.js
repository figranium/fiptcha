#!/usr/bin/env node
const http = require('http');
const { chromium } = require('playwright');
const { solveLocalCaptcha, captchaModelManager } = require('..');

const FIXTURE_HOST = 'captcha.test';
const OCR_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="80">'
  + '<rect width="220" height="80" fill="#f4f4f0"/>'
  + '<path d="M5 25 Q60 55 120 20 T215 45" stroke="#888" stroke-width="2" fill="none"/>'
  + '<path d="M10 55 Q80 15 140 50 T210 25" stroke="#aaa" stroke-width="1.5" fill="none"/>'
  + '<text x="25" y="48" font-family="monospace" font-size="30" font-weight="bold" fill="#222" transform="rotate(-10 25 48)">A</text>'
  + '<text x="60" y="54" font-family="monospace" font-size="30" font-weight="bold" fill="#222" transform="rotate(10 60 54)">7</text>'
  + '<text x="95" y="46" font-family="monospace" font-size="30" font-weight="bold" fill="#222" transform="rotate(-10 95 46)">K</text>'
  + '<text x="130" y="54" font-family="monospace" font-size="30" font-weight="bold" fill="#222" transform="rotate(10 130 54)">9</text>'
  + '<text x="165" y="48" font-family="monospace" font-size="30" font-weight="bold" fill="#222" transform="rotate(-10 165 48)">P</text>'
  + '</svg>'
);

const PAGES = {
  '/hcaptcha': `<!doctype html><html><body style="font-family:sans-serif;padding:40px"><h2>hCaptcha</h2><div id="w"></div><script>window.__ready=false;window.onLoad=()=>{hcaptcha.render("w",{sitekey:"20000000-ffff-ffff-ffff-000000000002"});window.__ready=true;};</script><script src="https://js.hcaptcha.com/1/api.js?onload=onLoad&render=explicit" async defer></script></body></html>`,
  '/turnstile': `<!doctype html><html><body style="font-family:sans-serif;padding:40px"><h2>Turnstile</h2><div id="w"></div><script>window.__ready=false;window.onLoad=()=>{turnstile.render("#w",{sitekey:"1x00000000000000000000AA"});window.__ready=true;};</script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onLoad&render=explicit" async defer></script></body></html>`,
  '/distorted-text': `<!doctype html><html><body style="font-family:sans-serif;padding:40px"><h2>Distorted Text</h2><img alt="captcha" src="data:image/svg+xml,${OCR_SVG}" style="display:block;margin-bottom:12px;border:1px solid #ccc"/><input name="captcha" placeholder="Enter captcha" style="padding:8px;font-size:16px"/><button id="sub" onclick="const v=document.querySelector('input').value.trim();document.getElementById('out').textContent=v==='A7K9P'?'Verified: '+v:'';document.getElementById('err').textContent=v==='A7K9P'?'':'Incorrect';">Verify</button><p id="out" style="color:green"></p><p id="err" style="color:red"></p><script>window.__ready=true;</script></body></html>`
};

async function main() {
  console.log('Preparing Florence-2 model...');
  await captchaModelManager.start();
  console.log('Model ready:', captchaModelManager.status());

  const server = http.createServer((request, response) => {
    response.writeHead(PAGES[request.url] ? 200 : 404, { 'Content-Type': 'text/html' });
    response.end(PAGES[request.url] || 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://${FIXTURE_HOST}:${server.address().port}`;

  const browser = await chromium.launch({
    headless: false,
    args: [`--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1`]
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: './videos', size: { width: 1280, height: 720 } }
  });
  const page = await context.newPage();

  const cases = [
    ['https://www.google.com/recaptcha/api2/demo', 'recaptcha_v2', {}],
    [`${base}/hcaptcha`, 'hcaptcha', {}],
    [`${base}/turnstile`, 'turnstile', {}],
    [`${base}/distorted-text`, 'distorted_text', { submitSelector: '#sub', successSelector: '#out', errorSelector: '#err' }]
  ];

  try {
    for (const [url, captchaType, extra] of cases) {
      const logs = [];
      const logger = new Proxy(logs, {
        set(target, key, value) {
          target[key] = value;
          if (key !== 'length') console.log(`[${captchaType}]`, value);
          return true;
        }
      });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (url.startsWith(base)) {
          await page.waitForFunction(() => window.__ready, null, { timeout: 30_000 });
        }
        const result = await solveLocalCaptcha(page, {
          captchaType,
          timeout: 180_000,
          logs: logger,
          ...extra
        });
        console.log(captchaType, 'RESULT:', result);
      } catch (error) {
        console.error(captchaType, 'FAILED:', error.message);
      }
      await page.waitForTimeout(1000);
    }
  } finally {
    const videoPath = await page.video().path();
    await context.close();
    await browser.close();
    await captchaModelManager.stop();
    await new Promise((resolve) => server.close(resolve));
    console.log('Saved video:', videoPath);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
