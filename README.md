# fiptcha

Local CAPTCHA solving for browser automation. Built for Figranium, usable anywhere.

Fiptcha is the standalone CAPTCHA solving runtime extracted from Figranium. It provides model selection and lifecycle management, verified model downloads, resource detection, local image-grid solving, browser challenge helpers, and optional Apple Silicon MLX acceleration.

## Install

```bash
npm install @figranium/fiptcha
```

## Usage

```js
const { solveLocalCaptcha } = require('@figranium/fiptcha');

const result = await solveLocalCaptcha(page, {
  captchaType: 'recaptcha_v2',
  timeout: 60_000
});
```

Fiptcha supports the local CAPTCHA runtime used by Figranium for reCAPTCHA v2, hCaptcha, and Turnstile interactions. Model behavior can be configured with the existing `CAPTCHA_*` environment variables.

## License

Apache-2.0.
