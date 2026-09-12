const assert = require('assert');
const { createServer } = require('../server');

async function main() {
  const modelManager = {
    status() {
      return { healthy: true, activeTier: 'test', backend: 'test', device: 'cpu', error: null };
    },
    async detect(image, label, threshold) {
      assert(Buffer.isBuffer(image));
      assert.strictEqual(label, 'traffic light');
      assert.strictEqual(threshold, 0.25);
      return [{ box: [0, 0, 10, 10], score: 0.9 }];
    }
  };

  const server = createServer({ modelManager, token: 'secret' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const unauthorized = await fetch(`${base}/health`);
    assert.strictEqual(unauthorized.status, 401);

    const health = await fetch(`${base}/health`, {
      headers: { Authorization: 'Bearer secret' }
    });
    assert.strictEqual(health.status, 200);
    const healthJson = await health.json();
    assert.strictEqual(healthJson.service, 'fiptcha');
    assert.strictEqual(healthJson.model.healthy, true);

    const detect = await fetch(`${base}/detect`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        image: Buffer.from('png').toString('base64'),
        label: 'traffic light',
        threshold: 0.25
      })
    });
    assert.strictEqual(detect.status, 200);
    const detectJson = await detect.json();
    assert.deepStrictEqual(detectJson.detections, [{ box: [0, 0, 10, 10], score: 0.9 }]);

    const badThreshold = await fetch(`${base}/detect`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image: Buffer.from('png').toString('base64'), label: 'x', threshold: 4 })
    });
    assert.strictEqual(badThreshold.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('fiptcha server tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
