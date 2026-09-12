# fiptcha

Local CAPTCHA solving for browser automation. Built for Figranium, usable anywhere.

Fiptcha is a standalone local solver service. It owns model selection and lifecycle, verified model downloads, resource detection, local inference, and the optional Apple Silicon MLX runtime. It is **not an npm package**.

## Run

```bash
npm install
npm start
```

By default Fiptcha listens on `127.0.0.1:11438`.

### API

- `GET /health` — reports solver/model status.
- `POST /detect` — accepts `{ "image": "<base64 PNG>", "label": "traffic light", "threshold": 0.12 }` and returns detections.

Set `FIPTCHA_HOST`, `FIPTCHA_PORT`, and optionally `FIPTCHA_TOKEN` to change the listener and protect requests. When `FIPTCHA_TOKEN` is set, clients must send `Authorization: Bearer <token>`.

Figranium keeps browser-session interaction and sends challenge screenshots to Fiptcha for inference.

## License

GPL-3.0-only.
