# Fiptcha

[![npm version](https://img.shields.io/npm/v/fiptcha.svg)](https://www.npmjs.com/package/fiptcha)

Local CAPTCHA solving for browser automation.

Fiptcha is the lightweight CAPTCHA runtime used by Figranium, packaged as a standalone Apache-2.0 Node.js library so it can be embedded in other browser automation projects.

## Install

```bash
npm install fiptcha
```

CommonJS:

```js
const { solveLocalCaptcha } = require('fiptcha');
```

Fiptcha does not launch a browser for you. Your application owns the browser lifecycle and passes an active Playwright-compatible `page` into the solver.

## Quick start

```js
const { chromium } = require('playwright');
const { solveLocalCaptcha } = require('fiptcha');

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

await page.goto('https://example.com');

const logs = [];
const result = await solveLocalCaptcha(page, {
  captchaType: 'recaptcha_v2',
  timeout: 60_000,
  logs
});

console.log(result.token);
console.log(result.provider); // "local"
console.log(result.model);    // present when a vision model was used
console.log(result.device);   // "browser", "cpu", or the active inference device

await browser.close();
```

## Supported challenge types

Pass one of these values as `captchaType`:

| Value | Behavior |
| --- | --- |
| `recaptcha_v2` | Interacts with the checkbox and solves supported image-grid challenges locally when required. |
| `hcaptcha` | Interacts with the widget and solves supported image-grid challenges locally when required. |
| `turnstile` | Performs active-browser interaction and waits for a token. It does not use the image-grid vision path. |

> [!WARNING]
> **3×3 image-grid stability is currently not good.** Dynamic 3×3 challenges, particularly those that replace tiles after a selection, may be unreliable. 4×4 static image-grid challenges are currently the more stable path.

Fiptcha cannot guarantee that every challenge will be solvable. CAPTCHA providers can change their UI, challenge format, and risk checks independently of the visible widget.

## `solveLocalCaptcha(page, options)`

This is the main integration API.

```js
const result = await solveLocalCaptcha(page, {
  captchaType: 'hcaptcha',
  timeout: 60_000,
  logs: []
});
```

### Arguments

#### `page`

An active Playwright-compatible page. Fiptcha uses page/frame APIs, locators, mouse interaction, evaluation, and timeouts against this object.

#### `options.captchaType`

Required. One of:

```text
recaptcha_v2
hcaptcha
turnstile
```

#### `options.timeout`

Optional. Maximum solve time in milliseconds.

Default:

```js
60_000
```

#### `options.logs`

Optional array. Fiptcha appends diagnostic messages to it while solving.

```js
const logs = [];

await solveLocalCaptcha(page, {
  captchaType: 'recaptcha_v2',
  logs
});

console.log(logs);
```

### Return value

A successful solve returns an object similar to:

```js
{
  token: '...',
  provider: 'local',
  model: 'owlvit', // only when a vision backend was used
  device: 'cpu'
}
```

`model` is omitted when no vision model was needed.

### Errors

`solveLocalCaptcha` throws when:

- the requested CAPTCHA type is unsupported;
- a challenge never exposes a usable token or image challenge;
- a required vision backend cannot be prepared;
- the challenge ends without producing a token;
- Turnstile does not issue a token after browser interaction.

Wrap solves in your application's normal error handling:

```js
try {
  const result = await solveLocalCaptcha(page, {
    captchaType: 'recaptcha_v2',
    timeout: 60_000
  });

  console.log(result.token);
} catch (error) {
  console.error('CAPTCHA solve failed:', error.message);
}
```

## Browser integration pattern

A typical integration should keep orchestration outside Fiptcha:

```js
const { solveLocalCaptcha } = require('fiptcha');

async function handleCaptcha(page, captchaType) {
  const logs = [];

  const result = await solveLocalCaptcha(page, {
    captchaType,
    timeout: 60_000,
    logs
  });

  return {
    token: result.token,
    diagnostics: logs
  };
}
```

Your application should remain responsible for:

- launching and closing browsers;
- choosing browser contexts and sessions;
- navigation;
- deciding when CAPTCHA handling should run;
- retries at the workflow level;
- proxies and network policy;
- persistence;
- translating Fiptcha errors/results into your own execution model.

Fiptcha is responsible for the CAPTCHA-specific runtime: token detection, widget interaction, grid solving, model selection, model downloads, resource checks, and optional companion runtimes.

## Models and memory requirements

Fiptcha does not bundle large model weights into the npm package. Required assets are acquired when needed.

The runtime chooses an appropriate backend based on available resources. A provider-advertised **2 GB** machine is interpreted using decimal sizing (2,000,000,000 bytes, about 1907 MiB) rather than requiring 2048 MiB.

If your application runs in an ephemeral container, persist the model/cache directory so models do not need to be downloaded again on every container recreation.

## Companion runtime

Fiptcha includes an optional companion process for environments that need it.

Install companion requirements:

```bash
npm run companion:install
```

Start it:

```bash
npm run companion:start
```

Start the Docker-oriented path:

```bash
npm run companion:start:docker
```

The companion is optional. Ordinary Node.js integrations do not need it unless they use that runtime path.

## Apple Silicon / MLX

Fiptcha supports an optional MLX runtime for compatible Apple Silicon environments. Consumers that do not use MLX can ignore it.

## Inspect the runtime environment

Run the included resource probe:

```bash
npm run probe
```

This is useful in containers and VMs where cgroup/container limits may differ from the physical host's reported memory.

## Using Fiptcha from another project

Install it normally:

```bash
npm install fiptcha
```

Then keep the integration at your browser/runtime boundary:

```js
const { solveLocalCaptcha } = require('fiptcha');

async function solve(page) {
  return solveLocalCaptcha(page, {
    captchaType: 'recaptcha_v2',
    timeout: 45_000
  });
}
```

No Figranium task schema, server, UI, database, scheduler, authentication system, or storage layer is required.

## Troubleshooting

### `Local solver does not support ...`

Check that `captchaType` is exactly one of:

```text
recaptcha_v2
hcaptcha
turnstile
```

### `vision backend unavailable`

The challenge requires the image-solving path, but Fiptcha could not prepare a supported vision backend. Check available memory, model availability/downloads, and the output of:

```bash
npm run probe
```

### Challenge appears but no token is returned

Increase the solve timeout and collect the `logs` array. Also verify that the challenge family still matches the provider structure expected by the current Fiptcha version.

### Models download repeatedly in containers

Persist the model/cache storage used by the runtime instead of recreating it with every ephemeral container.

## License

Apache-2.0.
