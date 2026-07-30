// Probe: can onnxruntime-web's wasm backend host the SDK wake engine outside a browser?
import { readFileSync } from 'node:fs';
import * as ort from '/tmp/claude-1000/-home-buzzkill-Projects-goodvibes-tui/e28eaafb-93e7-424b-bdf0-a697efc3d908/scratchpad/ortprobe/node_modules/onnxruntime-web/dist/ort.node.min.mjs';
import { WakeWordEngine } from '/home/buzzkill/Projects/.gv-worktrees/wake-capture-sdk/packages/sdk/src/platform/voice/wake/engine.ts';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const load = async (path: string) => {
  const bytes = new Uint8Array(readFileSync(path));
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    async run(feeds: Record<string, { data: Float32Array; dims: readonly number[] }>) {
      const mapped: Record<string, ort.Tensor> = {};
      for (const [name, t] of Object.entries(feeds)) {
        mapped[name] = new ort.Tensor('float32', t.data, [...t.dims]);
      }
      const out = await session.run(mapped);
      const result: Record<string, { data: Float32Array; dims: readonly number[] }> = {};
      for (const [name, t] of Object.entries(out)) {
        result[name] = { data: t.data as Float32Array, dims: t.dims };
      }
      return result;
    },
  };
};

const embedding = await load('/tmp/claude-1000/-home-buzzkill-Projects-goodvibes-tui/e28eaafb-93e7-424b-bdf0-a697efc3d908/scratchpad/ortprobe/embed.onnx');
const classifier = await load('/tmp/claude-1000/-home-buzzkill-Projects-goodvibes-tui/e28eaafb-93e7-424b-bdf0-a697efc3d908/scratchpad/ortprobe/wake.onnx');
console.log('embedding io', embedding.inputNames, embedding.outputNames);
console.log('classifier io', classifier.inputNames, classifier.outputNames);

const engine = new WakeWordEngine({
  embedding,
  models: [{ id: 'hey_goodvibes', session: classifier }],
  tuning: { threshold: 0.9, patienceFrames: 2, cooldownMs: 2000 },
});

// 4 seconds of low-level noise: expect scores far below threshold and no detections.
const frames = 50;
let maxScore = 0;
let detections = 0;
const t0 = performance.now();
for (let i = 0; i < frames; i += 1) {
  const samples = new Float32Array(engine.chunkSamples);
  for (let s = 0; s < samples.length; s += 1) samples[s] = (Math.random() - 0.5) * 600;
  const result = await engine.pushFrame(samples);
  const score = result.scores.get('hey_goodvibes');
  if (score !== undefined) maxScore = Math.max(maxScore, score);
  detections += result.detections.length;
}
const perFrame = (performance.now() - t0) / frames;
console.log(`frames=${frames} maxScore=${maxScore.toFixed(6)} detections=${detections} msPerFrame=${perFrame.toFixed(2)} (80ms budget)`);
console.log('VERDICT', perFrame < 80 ? 'REAL TIME OK' : 'TOO SLOW');
