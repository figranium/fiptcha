const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MODEL_MANIFESTS } = require('./captcha-model-manifest');
const { downloadModelArtifacts, verifyArtifactDirectory, checksumFile } = require('./captcha-model-downloader');
const { getMemorySnapshot, getResourceSnapshot } = require('./captcha-resources');
const { detectWithCompanion } = require('./captcha-companion-client');

const MODEL_ROOT = path.resolve(process.env.CAPTCHA_MODEL_CACHE_DIR || path.join(process.cwd(), 'data', 'captcha-model'));
const RECONCILE_INTERVAL_MS = 60_000;
const PROBE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGUlEQVR4nO3BMQEAAADCoPVP7WENoAAAAG4MIAABt9NlCQAAAABJRU5ErkJggg==',
    'base64'
);

const parseFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

function normalizedResources(input = getMemorySnapshot()) {
    if (input.memory) return input;
    return { memory: input, accelerators: [], companion: null, onnxBackends: ['cpu'] };
}

function acceleratorCapacity(resources) {
    return (resources.accelerators || []).reduce((best, accelerator) => {
        const totalMb = Number(accelerator.totalMb) || 0;
        const availableMb = Number(accelerator.availableMb) || 0;
        if (totalMb > best.totalMb || (totalMb === best.totalMb && availableMb > best.availableMb)) {
            return { ...accelerator, totalMb, availableMb };
        }
        return best;
    }, { type: null, totalMb: 0, availableMb: 0 });
}

function qualifiesMemory(memory, definition) {
    return Number(memory?.totalMb) >= definition.minimumTotalMb
        && Number(memory?.availableMb) >= definition.minimumAvailableMb;
}

function qualifyingAccelerator(resources, definition) {
    return (resources.accelerators || []).find((accelerator) =>
        Number(accelerator.totalMb) >= definition.minimumTotalMb
        && Number(accelerator.availableMb) >= definition.minimumAvailableMb);
}

function selectModelTier(input = getMemorySnapshot(), env = process.env) {
    if (parseFlag(env.SKIP_LOCAL_CAPTCHA_MODEL)) return null;
    const resources = normalizedResources(input);
    const requested = String(env.CAPTCHA_MODEL_TIER || 'auto').trim().toLowerCase();
    if (!['auto', 'owlvit', 'florence2'].includes(requested)) {
        throw new Error(`Invalid CAPTCHA_MODEL_TIER "${requested}"; expected auto, owlvit, or florence2`);
    }
    const forceCpu = String(env.CAPTCHA_MODEL_DEVICE || 'auto').trim().toLowerCase() === 'cpu';
    const owlQualified = qualifiesMemory(resources.memory, MODEL_MANIFESTS.owlvit)
        || (!forceCpu && Boolean(qualifyingAccelerator(resources, MODEL_MANIFESTS.owlvit)));
    if (!owlQualified) return null;
    const florenceQualified = qualifiesMemory(resources.memory, MODEL_MANIFESTS.florence2)
        || (!forceCpu && Boolean(qualifyingAccelerator(resources, MODEL_MANIFESTS.florence2)));
    if (requested === 'florence2' && !florenceQualified) {
        throw new Error('CAPTCHA_MODEL_TIER=florence2 requires at least 2 GB effective memory and 512 MiB available');
    }
    if (requested === 'owlvit') return 'owlvit';
    return florenceQualified ? 'florence2' : 'owlvit';
}

function selectModelBackend(tier, input) {
    const resources = normalizedResources(input);
    const forceCpu = String(process.env.CAPTCHA_MODEL_DEVICE || 'auto').trim().toLowerCase() === 'cpu';
    const companion = (resources.accelerators || []).find((item) => item.type === 'companion');
    const definition = MODEL_MANIFESTS[tier];
    if (!forceCpu && companion && qualifiesMemory(companion, definition)) {
        return { type: 'companion', device: companion.backend || 'coreml' };
    }
    const device = selectModelDevice(process.env, resources);
    if (qualifiesMemory(resources.memory, definition)) return { type: 'local', device };
    const accelerator = (resources.accelerators || []).find((item) => item.type === device && qualifiesMemory(item, definition));
    if (device !== 'cpu' && accelerator && qualifiesMemory(resources.memory, MODEL_MANIFESTS.florence2)) {
        return { type: 'local', device };
    }
    return null;
}

function selectModelDevice(env = process.env, resources = { onnxBackends: ['cpu'], accelerators: [] }) {
    const requested = String(env.CAPTCHA_MODEL_DEVICE || 'auto').trim().toLowerCase();
    if (!['auto', 'cpu'].includes(requested)) {
        throw new Error(`Invalid CAPTCHA_MODEL_DEVICE "${requested}"; expected auto or cpu`);
    }
    if (requested === 'cpu') return 'cpu';
    if (resources.accelerators?.some((item) => item.type === 'cuda') && resources.onnxBackends?.includes('cuda')) return 'cuda';
    if (resources.accelerators?.some((item) => item.type === 'webgpu') && resources.onnxBackends?.includes('webgpu')) return 'webgpu';
    return 'cpu';
}

function isCapacityFailure(error) {
    return /out of memory|oom|allocation|capacity|execution provider|device.*lost|cuda|coreml|webgpu/i.test(error?.message || '');
}

function modelThreshold(tier, env = process.env) {
    const variable = tier === 'florence2' ? 'CAPTCHA_FLORENCE2_THRESHOLD' : 'CAPTCHA_OWLVIT_THRESHOLD';
    const configured = Number(env[variable]);
    return Number.isFinite(configured) && configured >= 0 && configured <= 1
        ? configured
        : MODEL_MANIFESTS[tier].threshold;
}

class CaptchaModelManager {
    constructor(options = {}) {
        this.activeTier = null;
        this.activeRuntime = null;
        this.activeBackend = null;
        this.reconcilePromise = null;
        this.inferenceQueue = Promise.resolve();
        this.timer = null;
        this.lastError = null;
        this.resourceProvider = options.resourceProvider || (() => getResourceSnapshot({ skipCompanion: parseFlag(process.env.CAPTCHA_COMPANION_MODE) }));
        this.downloader = options.downloader || downloadModelArtifacts;
        this.verifier = options.verifier || verifyArtifactDirectory;
        this.runtimeLoader = options.runtimeLoader || ((tier, modelDir, device) => this._loadLocalRuntime(tier, modelDir, device));
        this.modelRoot = options.modelRoot ? path.resolve(options.modelRoot) : MODEL_ROOT;
    }

    isSkipped() {
        return parseFlag(process.env.SKIP_LOCAL_CAPTCHA_MODEL);
    }

    cachePath(...segments) {
        const target = path.resolve(this.modelRoot, ...segments);
        if (target !== this.modelRoot && !target.startsWith(`${this.modelRoot}${path.sep}`)) throw new Error('Unsafe CAPTCHA cache path');
        return target;
    }

    async start() {
        if (this.isSkipped() || this.timer) return;
        await fs.promises.mkdir(this.modelRoot, { recursive: true });
        const entries = await fs.promises.readdir(this.modelRoot, { withFileTypes: true });
        for (const entry of entries) if (entry.name.startsWith('.staging-')) {
            await fs.promises.rm(this.cachePath(entry.name), { recursive: true, force: true });
        }
        this.timer = setInterval(() => this.reconcile().catch((error) => {
            this.lastError = error;
            console.warn('[CAPTCHA_MODEL] Reconciliation failed:', error.message);
        }), RECONCILE_INTERVAL_MS);
        this.timer.unref?.();
        await this.reconcile();
    }

    async stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.activeRuntime?.dispose?.().catch?.(() => undefined);
        this.activeRuntime = null;
        this.activeTier = null;
        this.activeBackend = null;
    }

    async reconcile() {
        if (this.reconcilePromise) return this.reconcilePromise;
        this.reconcilePromise = this._reconcile().finally(() => { this.reconcilePromise = null; });
        return this.reconcilePromise;
    }

    async _reconcile() {
        if (this.isSkipped()) {
            await this.stop();
            return null;
        }
        const resources = await this.resourceProvider();
        const targetTier = selectModelTier(resources);
        if (!targetTier) {
            await this.activeRuntime?.dispose?.().catch?.(() => undefined);
            this.activeRuntime = null;
            this.activeTier = null;
            this.activeBackend = null;
            this.lastError = new Error('No local or companion CAPTCHA model has sufficient effective memory');
            return null;
        }
        const targetBackend = selectModelBackend(targetTier, resources);
        if (!targetBackend) {
            await this.activeRuntime?.dispose?.().catch?.(() => undefined);
            this.activeRuntime = null;
            this.activeTier = null;
            this.activeBackend = null;
            this.lastError = new Error('No healthy CAPTCHA inference backend is available');
            return null;
        }
        if (this.activeTier === targetTier
            && this.activeBackend?.type === targetBackend.type
            && this.activeBackend?.device === targetBackend.device
            && this.activeRuntime) return this.activeRuntime;

        let runtime;
        if (targetBackend.type === 'companion') {
            runtime = this._companionRuntime(targetTier, targetBackend.device);
            await runtime.probe();
        } else {
            const stagingDir = this.cachePath(`.staging-${targetTier}`);
            const targetDir = this.cachePath(targetTier);
            let hasCachedModel = await this.verifier(targetTier, targetDir).catch(() => false);
            if (!hasCachedModel) {
                await fs.promises.rm(targetDir, { recursive: true, force: true });
                await fs.promises.rm(stagingDir, { recursive: true, force: true });
                await fs.promises.mkdir(stagingDir, { recursive: true });
                try {
                    await this.downloader(targetTier, stagingDir);
                } catch (error) {
                    const outOfDisk = error?.code === 'ENOSPC' || /no space left|ENOSPC/i.test(error?.message || '');
                    if (!outOfDisk || !this.activeTier || this.activeBackend?.type !== 'local') throw error;
                    await this.activeRuntime?.dispose?.().catch?.(() => undefined);
                    this.activeRuntime = null;
                    const oldTier = this.activeTier;
                    this.activeTier = null;
                    this.activeBackend = null;
                    await fs.promises.rm(this.cachePath(oldTier), { recursive: true, force: true });
                    await fs.promises.rm(stagingDir, { recursive: true, force: true });
                    await fs.promises.mkdir(stagingDir, { recursive: true });
                    await this.downloader(targetTier, stagingDir);
                }
                if (!await this.verifier(targetTier, stagingDir)) throw new Error(`Downloaded ${targetTier} model failed verification`);
                await fs.promises.rename(stagingDir, targetDir);
            }
            try {
                runtime = await this.runtimeLoader(targetTier, targetDir, targetBackend.device);
                await runtime.probe();
            } catch (error) {
                await runtime?.dispose?.().catch?.(() => undefined);
                if (this.activeTier !== targetTier) await fs.promises.rm(targetDir, { recursive: true, force: true });
                throw error;
            }
        }

        const previous = { runtime: this.activeRuntime, tier: this.activeTier };
        this.activeRuntime = runtime;
        this.activeTier = targetTier;
        this.activeBackend = targetBackend;
        this.lastError = null;
        await fs.promises.mkdir(this.modelRoot, { recursive: true });
        const activeFile = this.cachePath('active.json');
        const activeStaging = this.cachePath('.active.json.tmp');
        await fs.promises.writeFile(activeStaging, JSON.stringify({
            tier: targetTier,
            model: MODEL_MANIFESTS[targetTier].id,
            revision: MODEL_MANIFESTS[targetTier].revision,
            backend: targetBackend.type,
            device: targetBackend.device,
            activatedAt: new Date().toISOString()
        }, null, 2), { mode: 0o600 });
        await fs.promises.rename(activeStaging, activeFile);
        await previous.runtime?.dispose?.().catch?.(() => undefined);
        for (const tier of Object.keys(MODEL_MANIFESTS)) {
            if (tier !== targetTier) await fs.promises.rm(this.cachePath(tier), { recursive: true, force: true });
        }
        for (const tier of Object.keys(MODEL_MANIFESTS)) {
            await fs.promises.rm(this.cachePath(`.staging-${tier}`), { recursive: true, force: true });
        }
        console.log(`[CAPTCHA_MODEL] Activated ${targetTier} via ${targetBackend.type}/${targetBackend.device}${previous.tier ? ` (replaced ${previous.tier})` : ''}`);
        return runtime;
    }

    _companionRuntime(tier, device) {
        return {
            tier,
            device,
            async detect(imageBuffer, label, threshold) {
                const result = await detectWithCompanion(imageBuffer, label, tier, threshold);
                return result.detections;
            },
            async probe() {
                await detectWithCompanion(PROBE_PNG, 'object', tier, 0.99, 20_000);
            }
        };
    }

    async _loadLocalRuntime(tier, modelDir, device) {
        const definition = MODEL_MANIFESTS[tier];
        const runtimeDevice = device === 'coreml' ? 'cpu' : device;
        const transformers = await import('@huggingface/transformers');
        transformers.env.allowRemoteModels = false;
        transformers.env.allowLocalModels = true;
        transformers.env.useFSCache = false;
        const common = { dtype: definition.dtype, device: runtimeDevice, local_files_only: true };
        if (definition.kind === 'owlvit') {
            const detector = await transformers.pipeline('zero-shot-object-detection', modelDir, common);
            return {
                tier,
                device,
                async detect(imageBuffer, label, threshold = definition.threshold) {
                    const image = await transformers.RawImage.fromBlob(new Blob([imageBuffer], { type: 'image/png' }));
                    const detections = await detector(image, [label], { threshold });
                    return Array.isArray(detections) ? detections : [];
                },
                async probe() { await this.detect(PROBE_PNG, 'object', 0.99); },
                async dispose() { await detector.dispose?.(); }
            };
        }
        const model = await transformers.Florence2ForConditionalGeneration.from_pretrained(modelDir, common);
        const processor = await transformers.AutoProcessor.from_pretrained(modelDir, { local_files_only: true });
        const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
        return {
            tier,
            device,
            async detect(imageBuffer, label, threshold = definition.threshold) {
                const image = await transformers.RawImage.fromBlob(new Blob([imageBuffer], { type: 'image/png' }));
                const task = '<DENSE_REGION_CAPTION>';
                const prompts = processor.construct_prompts(task);
                const inputs = await processor(image, prompts);
                const generated = await model.generate({ ...inputs, max_new_tokens: 256, num_beams: 1 });
                const decoded = tokenizer.batch_decode(generated, { skip_special_tokens: false })[0];
                const regions = parseFlorenceRegions(decoded, image.size);
                return regions
                    .filter((region) => matchesTargetLabel(region.label, label))
                    .map((region) => ({ box: region.box, label: region.label || label, score: threshold }));
            },
            async recognizeText(imageBuffer) {
                const image = await transformers.RawImage.fromBlob(new Blob([imageBuffer], { type: 'image/png' }));
                const task = '<OCR>';
                const prompts = processor.construct_prompts(task);
                const inputs = await processor(image, prompts);
                const generated = await model.generate({ ...inputs, max_new_tokens: 64, num_beams: 1 });
                const decoded = tokenizer.batch_decode(generated, { skip_special_tokens: false })[0];
                return String(decoded || '').replaceAll('<s>', '').replaceAll('</s>', '').trim();
            },
            async probe() { await this.detect(PROBE_PNG, 'object', 0.99); },
            async dispose() { await model.dispose?.(); }
        };
    }

    async _enqueueInference(operation) {
        if (this.isSkipped()) throw new Error('Local CAPTCHA model disabled by SKIP_LOCAL_CAPTCHA_MODEL');
        const run = async () => {
            const runtime = await this.reconcile();
            if (!runtime) throw this.lastError || new Error('Local CAPTCHA model is unavailable');
            try {
                return await operation(runtime);
            } catch (error) {
                if (isCapacityFailure(error)) {
                    await runtime.dispose?.().catch?.(() => undefined);
                    this.activeRuntime = null;
                    this.activeTier = null;
                    this.activeBackend = null;
                    this.lastError = error;
                    this.reconcile().catch(() => undefined);
                }
                throw error;
            }
        };
        const resultPromise = this.inferenceQueue.then(run, run);
        this.inferenceQueue = resultPromise.catch(() => undefined);
        return resultPromise;
    }

    async detect(imageBuffer, label, threshold) {
        return this._enqueueInference((runtime) =>
            runtime.detect(imageBuffer, label, threshold ?? modelThreshold(this.activeTier)));
    }

    async recognizeText(imageBuffer) {
        return this._enqueueInference((runtime) => {
            if (typeof runtime.recognizeText !== 'function') {
                throw new Error(`OCR is not supported by the active ${this.activeTier || 'unknown'} CAPTCHA backend`);
            }
            return runtime.recognizeText(imageBuffer);
        });
    }

    status() {
        return {
            healthy: Boolean(this.activeRuntime),
            activeTier: this.activeTier,
            backend: this.activeBackend?.type || null,
            device: this.activeBackend?.device || null,
            error: this.lastError?.message || null
        };
    }
}

const captchaModelManager = new CaptchaModelManager();

const LABEL_SYNONYMS = Object.freeze({
    car: ['car', 'automobile', 'sedan', 'suv', 'van', 'minivan', 'cab', 'taxi', 'pickup truck', 'jeep', 'land vehicle', 'vehicle'],
    vehicle: ['vehicle', 'land vehicle', 'car', 'bus', 'truck', 'van', 'motorcycle', 'suv'],
    bus: ['bus', 'coach', 'school bus', 'transit bus', 'trolleybus', 'double decker bus'],
    bicycle: ['bicycle', 'bike', 'cycle', 'mountain bike', 'road bike'],
    motorcycle: ['motorcycle', 'motorbike', 'scooter', 'moped', 'dirt bike'],
    'traffic light': ['traffic light', 'traffic signal', 'stoplight', 'stop light', 'signal light'],
    'fire hydrant': ['fire hydrant', 'hydrant', 'fireplug'],
    crosswalk: ['crosswalk', 'zebra crossing', 'pedestrian crossing', 'cross walk', 'street crossing', 'road crossing', 'white stripe', 'painted line', 'road marking', 'street marking'],
    stair: ['stair', 'stairs', 'staircase', 'stairway', 'step', 'steps'],
    boat: ['boat', 'ship', 'sailboat', 'motorboat', 'yacht', 'ferry', 'canoe', 'kayak', 'vessel', 'watercraft'],
    bridge: ['bridge', 'overpass', 'viaduct', 'footbridge'],
    chimney: ['chimney', 'smokestack', 'flue'],
    'palm tree': ['palm tree', 'palm', 'coconut tree'],
    tree: ['tree', 'palm tree', 'pine tree', 'oak tree'],
    tractor: ['tractor', 'farm vehicle'],
    'parking meter': ['parking meter', 'meter'],
    truck: ['truck', 'lorry', 'pickup', 'semi', 'van'],
    taxi: ['taxi', 'cab', 'taxicab', 'yellow cab'],
    airplane: ['airplane', 'plane', 'aircraft', 'jet', 'airliner'],
    train: ['train', 'locomotive', 'subway', 'tram', 'streetcar'],
    mountain: ['mountain', 'hill', 'peak', 'ridge']
});

function normalizePhrase(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .replace(/\b(?:a|an|the)\b/g, ' ')
        .replace(/\b[a-z]+\b/g, (word) => {
            if (word === 'buses') return 'bus';
            if (word.endsWith('ies') && word.length > 3) return `${word.slice(0, -3)}y`;
            if (/(?:ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
            if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && word.length > 2) return word.slice(0, -1);
            return word;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesTargetLabel(detectedLabel, targetLabel) {
    const detected = normalizePhrase(detectedLabel);
    const target = normalizePhrase(targetLabel);
    if (!detected || !target) return false;
    const candidates = new Set([target, ...(LABEL_SYNONYMS[target] || [])]);
    for (const candidate of candidates) {
        const normalizedCandidate = normalizePhrase(candidate);
        if (!normalizedCandidate) continue;
        if (new RegExp(`(?:^|\\s)${escapeRegExp(normalizedCandidate)}(?:$|\\s)`).test(detected)) {
            return true;
        }
    }
    return false;
}

function parseFlorenceRegions(decoded, imageSize) {
    const text = String(decoded || '').replaceAll('<s>', '').replaceAll('</s>', '');
    const [width, height] = Array.isArray(imageSize)
        ? [Number(imageSize[0]), Number(imageSize[1])]
        : [Number(imageSize?.width), Number(imageSize?.height)];
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    const regex = /([^<]+)?<loc_(\d+)><loc_(\d+)><loc_(\d+)><loc_(\d+)>/g;
    const regions = [];
    let lastLabel = '';
    for (const match of text.matchAll(regex)) {
        const rawLabel = (match[1] || '').trim();
        if (rawLabel) lastLabel = rawLabel;
        const box = [
            ((Number(match[2]) + 0.5) / 1000) * width,
            ((Number(match[3]) + 0.5) / 1000) * height,
            ((Number(match[4]) + 0.5) / 1000) * width,
            ((Number(match[5]) + 0.5) / 1000) * height
        ];
        if (box.every(Number.isFinite)) regions.push({ box, label: lastLabel });
    }
    return regions;
}

function checksumBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
    MODEL_DEFINITIONS: MODEL_MANIFESTS,
    MODEL_MANIFESTS,
    CaptchaModelManager,
    captchaModelManager,
    getMemorySnapshot,
    selectModelTier,
    selectModelBackend,
    selectModelDevice,
    qualifiesMemory,
    checksumBuffer,
    checksumFile,
    parseFlag,
    modelThreshold,
    isCapacityFailure,
    parseFlorenceRegions,
    matchesTargetLabel
};
