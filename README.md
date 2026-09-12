# fiptcha

Local CAPTCHA solving for browser automation. Built for Figranium, usable anywhere.

`@figranium/fiptcha` contains Figranium's reusable local CAPTCHA runtime: browser challenge interaction, image-grid solving, model selection and lifecycle, verified model downloads, resource detection, Turnstile interception, and the optional Apple Silicon MLX worker.

## Install

```bash
npm install @figranium/fiptcha
```

## Usage

```js
const { solveLocalCaptcha, captchaModelManager } = require('@figranium/fiptcha');
```

The package operates on an existing Playwright-like page. Application storage, remote-solver credentials, URL policy, and Figranium task orchestration stay outside the package.

## License

GPL-3.0-only.
