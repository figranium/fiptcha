# Fiptcha

Local, self-hosted CAPTCHA solving primitives for browser automation. Built for Figranium, designed to be usable by other Node.js browser automation projects.

Fiptcha is the standalone CAPTCHA runtime extracted from Figranium. It contains the local model/runtime layer that Figranium uses to detect resources, manage vision models, solve image grids, interact with browser challenges, and optionally use an Apple Silicon MLX companion.

Fiptcha does **not** require the Figranium application or task format. The package exposes its solver modules directly, so another application can integrate the pieces it needs around its own browser lifecycle.

## Why Fiptcha?

CAPTCHA solving inside a browser automation project tends to grow into its own subsystem: model selection, model downloads, resource checks, image-grid interpretation, challenge interception, browser interaction, platform-specific acceleration, and lifecycle management all need to work together. Fiptcha keeps that subsystem separate from the automation framework using it.

The goals are:

- keep local CAPTCHA solving self-hostable;
- avoid coupling the solver to Figranium's UI, API, task schema, or storage layer;
- expose reusable Node.js modules for other browser automation projects;
- download model assets only when they are needed rather than bundling large weights;
- select an appropriate local backend based on available resources;
- support optional companion runtimes without making them mandatory for every installation.

## Supported challenge families

Fiptcha contains the local runtime used by Figranium for:

- reCAPTCHA v2 image challenges;
- hCaptcha image challenges;
- Cloudflare Turnstile/browser challenge helpers.

Support is intentionally described as challenge/runtime support rather than a guarantee that every CAPTCHA can be solved. Providers change their challenge implementations and may use additional risk signals beyond the visible challenge.

## Features

- Local CAPTCHA solving from a browser automation session.
- Resource-aware model selection.
- Verified, on-demand model downloads and model lifecycle management.
- Image-grid classification and challenge handling.
- Browser challenge interception helpers.
- Companion-process client and runtime support.
- Optional MLX acceleration for compatible Apple Silicon environments.
- Container/resource probing utilities.
- CAPTCHA benchmarking helpers.
- Environment-variable configuration through the `CAPTCHA_*` settings used by the runtime.
- Apache-2.0 licensing for reuse in other applications.

## Requirements

Fiptcha is a Node.js package and expects the host application to provide the browser/page object used for challenge interaction. It does not launch or manage your entire automation application for you.

Model inference can require substantial memory. Fiptcha performs resource detection before selecting a local model. A provider-advertised 2 GB host is treated using decimal gigabyte semantics rather than incorrectly requiring a full 2 GiB/2048 MiB allocation.

Large model files are not intended to be embedded into the npm package. They are fetched by the model-management layer when required.

## Installation

```bash
npm install fiptcha
```

The package entry point is CommonJS, so it can be loaded with `require()` directly.

```js
const fiptcha = require('fiptcha');
```

## Basic usage

The highest-level local solver can be used with a compatible browser page:

```js
const { solveLocalCaptcha } = require('fiptcha');

const result = await solveLocalCaptcha(page, {
  captchaType: 'recaptcha_v2',
  timeout: 60_000
});

console.log(result);
```

Your application remains responsible for creating the browser, navigating to the target page, deciding when a solve should occur, and handling the solve result in its own workflow.

## Integration model

Fiptcha is designed as a runtime library rather than a complete automation framework. A typical integration looks like this:

```text
Your application
    |
    +-- browser lifecycle (Playwright/compatible host)
    |
    +-- challenge detection / solve trigger
    |       |
    |       +-- Fiptcha
    |             +-- resource detection
    |             +-- model manager
    |             +-- model downloader
    |             +-- local solver
    |             +-- grid solver
    |             +-- optional companion / MLX runtime
    |
    +-- application-specific result handling
```

This separation is deliberate. Fiptcha does not know about Figranium Tasks, blocks, Cabinets, executions, authentication, scheduling, or its UI.

## Public API

The root package currently re-exports the public functions from the following modules:

- `captcha-local-solver` — high-level local solving logic;
- `captcha-grid-solver` — image-grid solving primitives;
- `captcha-interceptor` — browser/challenge interception helpers;
- `captcha-resources` — host/container resource detection;
- `captcha-model-manager` — model selection and lifecycle management;
- `captcha-model-downloader` — model acquisition and verification;
- `captcha-model-manifest` — model metadata;
- `captcha-companion-client` — communication with the optional companion process;
- `captcha-mlx-runtime` — MLX runtime integration;
- `captcha-benchmark` — benchmark helpers.

For example:

```js
const {
  solveLocalCaptcha,
  // Other model, resource, interception, and grid helpers are
  // exported from the same package entry point.
} = require('fiptcha');
```

Fiptcha is still young, so applications that depend on lower-level helpers should pin the package version while the standalone API is being stabilized.

## Companion runtime

Fiptcha includes the companion tooling that was previously embedded in Figranium.

Install companion requirements:

```bash
npm run companion:install
```

Start the companion:

```bash
npm run companion:start
```

For the Docker-oriented path:

```bash
npm run companion:start:docker
```

The companion is optional. Applications that do not need that backend can use the ordinary Node.js runtime without making the companion part of their own product architecture.

## Resource probing

The package includes a probe command:

```bash
npm run probe
```

This is useful when validating the environment Fiptcha will run in, especially inside containers where reported memory limits may differ from the physical host.

Resource detection is kept inside Fiptcha so applications embedding it do not need to reproduce Figranium-specific hardware checks.

## Model management

Fiptcha separates model metadata, downloading, resource selection, and inference/runtime behavior. This allows the package to choose a suitable backend without forcing every application to ship every supported model.

The model downloader verifies model assets against the package's model manifest. Applications embedding Fiptcha should persist the configured model/cache directory if they do not want model assets to be downloaded again when an ephemeral container is recreated.

## Configuration

Fiptcha uses the `CAPTCHA_*` environment-variable configuration inherited from the standalone runtime extracted from Figranium. Configuration belongs to the process embedding Fiptcha; the package does not require a Figranium settings database.

When integrating Fiptcha into another application, keep CAPTCHA/model configuration at the application boundary and pass browser state through the solver APIs rather than importing Figranium-specific configuration code.

## Using Fiptcha outside Figranium

Fiptcha is intentionally licensed and packaged for this use case. A third-party automation project can install `fiptcha`, provide its own browser page, call the high-level solver or lower-level exported helpers, and keep its own orchestration around the package.

A good integration should generally:

1. let the host application own browser creation and navigation;
2. detect or decide when a CAPTCHA needs to be handled;
3. invoke Fiptcha with the active page/challenge context;
4. allow Fiptcha to manage its local model/runtime concerns;
5. translate the returned result into the host application's own success/error model.

Avoid copying Fiptcha source into the consuming project. Depending on the package keeps fixes to model handling, resource detection, and challenge logic independently upgradeable.

## Figranium integration

Figranium consumes Fiptcha as a dependency. Compatibility shims in Figranium preserve its previous internal CAPTCHA import paths while the implementation itself lives here.

That means Fiptcha is not merely a separately published copy of the solver: this repository is intended to be the canonical implementation of the local CAPTCHA runtime used by Figranium.

## Testing

Run the package smoke tests with:

```bash
npm test
```

The test suite includes regression coverage for resource detection, including the 2 GB host threshold that previously rejected machines advertised as having 2 GB RAM because the check effectively required 2 GiB.

## Current maturity

Fiptcha began as an extraction of a production subsystem rather than a greenfield SDK. The underlying solver has already been exercised through Figranium, but the standalone package API is new.

The high-level integration boundary is usable today. The main area that should be considered pre-stable is the exact shape and naming of lower-level exported helpers. Until a stable standalone API is declared, pinning an exact Fiptcha version is recommended for third-party applications.

## Security and responsible use

CAPTCHA systems are one part of a site's abuse-prevention and access-control strategy. Integrators are responsible for ensuring their automation is authorized and complies with applicable terms, policies, and law.

Do not treat successful CAPTCHA handling as permission to access data or perform actions that the application is otherwise not authorized to perform.

## Relationship to Figranium

Fiptcha is part of the Figranium ecosystem but is independently reusable. Figranium provides the visual browser-automation product and orchestration layer; Fiptcha focuses on the CAPTCHA-solving runtime.

## Contributing

Bug reports and focused improvements are welcome. For solver bugs, include enough environment information to reproduce the issue, particularly:

- operating system and architecture;
- Node.js version;
- container/runtime details if applicable;
- available memory;
- CAPTCHA provider/challenge family;
- whether the ordinary runtime or companion/MLX path was used.

Please avoid attaching sensitive cookies, credentials, or private browsing data to public issues.

## License

Fiptcha is licensed under the Apache License 2.0. See `LICENSE` for the full terms.
