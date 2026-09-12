# Fiptcha

[![npm version](https://img.shields.io/npm/v/fiptcha.svg)](https://www.npmjs.com/package/fiptcha)

Local CAPTCHA solving for browser automation.

Fiptcha is the CAPTCHA runtime used by Figranium, packaged as a standalone Apache-2.0 Node.js library so it can be embedded in other browser automation projects.

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

## Exported helpers

The package root re-exports the public exports from these modules:

| Module | Purpose |
| --- | --- |
| `captcha-local-solver` | High-level widget/token handling and `solveLocalCaptcha`. |
| `captcha-grid-solver` | Image-grid solving and provider adapters. |
| `captcha-interceptor` | Challenge interception helpers. |
| `captcha-resources` | Host/container memory and resource detection. |
| `captcha-model-manager` | Model selection, readiness, and lifecycle state. |
| `captcha-model-downloader` | Model download and verification. |
| `captcha-model-manifest` | Model metadata and requirements. |
| `captcha-companion-client` | Client for the optional companion process. |
| `captcha-mlx-runtime` | Apple Silicon MLX runtime support. |
| `captcha-benchmark` | Benchmarking helpers. |

For example, lower-level token helpers are also available:

```js
const {
  readToken,
  waitForToken,
  clickCheckbox,
  solveLocalCaptcha
} = require('fiptcha');
```

The high-level solver is the recommended integration boundary. Lower-level exports are useful for custom integrations, but their API should be treated as pre-stable until Fiptcha reaches a stable standalone API release.

## Models and memory requirements

Fiptcha does not bundle large model weights into the npm tarball. Required assets are acquired through the model-management layer when needed.

The runtime chooses an appropriate backend based on available resources. In particular, a provider-advertised **2 GB** machine is interpreted using decimal sizing (2,000,000,000 bytes, about 1907 MiB) rather than incorrectly requiring 2048 MiB.

If your application runs in an ephemeral container, persist the model/cache directory used by your deployment so models do not need to be downloaded again on every container recreation.

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

The companion is optional. Ordinary Node.js integrations do not need to make it part of their architecture unless they use that runtime path.

## Apple Silicon / MLX

Fiptcha contains the MLX worker and runtime integration used for compatible Apple Silicon environments.

The MLX path is optional. Consumers that do not use MLX can ignore the bundled worker and companion requirements.

## Inspect the runtime environment

Run the included resource probe:

```bash
npm run probe
```

This is useful in containers and VMs where cgroup/container limits may differ from the physical host's reported memory.

## Test Fiptcha

```bash
npm test
```

The smoke suite checks the extracted runtime and includes regression coverage for resource selection, including the 2 GB memory threshold.

## Check what npm will publish

Before publishing a release:

```bash
npm pack --dry-run
```

The package intentionally publishes the runtime source, entry point, companion scripts, README, and license—not downloaded model weights.

## Release process

Fiptcha publishes to npm as:

```text
fiptcha
```

The repository uses npm Trusted Publishing through GitHub Actions. Releases are published without a long-lived npm token.

To release a new version:

1. Update `version` in `package.json`.
2. Merge the change to `main`.
3. Create and publish a GitHub Release whose tag matches the package version, for example `v0.2.0`.
4. The release workflow runs the tests and publishes the package to npm through OIDC Trusted Publishing.

Do not manually add an `NPM_TOKEN` secret for the normal release path.

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

## Using Fiptcha in Figranium

Figranium consumes the published `fiptcha` package and keeps only Figranium-specific integration code in the main application.

The standalone Fiptcha repository is the canonical implementation of the local CAPTCHA runtime. Fixes to model handling, resource detection, challenge interaction, or companion behavior should be made here rather than copied back into Figranium.

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

### A lower-level helper changed between releases

Prefer `solveLocalCaptcha` for application integrations. Until the low-level API is declared stable, pin an exact Fiptcha version if you depend directly on internal/model/grid helpers.

## Package contents

The npm package contains:

```text
index.js
src/
scripts/captcha-mlx-worker.py
scripts/captcha-companion-requirements.txt
scripts/captcha-container-probe.js
scripts/install-captcha-companion.js
scripts/captcha-companion.js
README.md
LICENSE
```

## License

Apache-2.0.
