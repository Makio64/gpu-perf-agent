// Real captured runs from ../../reports/ — a three.js Cascaded Shadow Maps
// (WebGPU) demo, profiled before and after a texture-memory optimization.
//   base      = reports/csm-baseline.json
//   candidate = reports/csm-cand1-depth16.json
// Numbers are transcribed verbatim from those report artifacts. VRAM figures are
// derived from diagnostics.resources (bytes / 1048576 = MiB).

export const sampleReport = {
	target: 'three.js · Cascaded Shadow Maps (WebGPU)',
	command: 'gpu-perf-agent run --url http://localhost:3002/demo/csm --auto-instrument --trace --json',
	base: {
		verdict: 'needs-work',
		fps: 119.6,
		frameTimeMeanMs: 8.36,
		worstFrameMs: 33.4,
		heapGrowthMBPerSec: 0.0,
		vram: {
			totalMiB: 111.8,
			textureMiB: 110.1,
			bufferMiB: 1.72,
			textureCount: 21,
			bufferCount: 47,
			leaked: 0,
		},
		warnings: [
			'Texture memory is high: 110.1 MiB across 21 textures. Recommend using compressed textures (KTX2, Basis Universal) and ensuring unused textures are disposed.',
		],
	},
	candidate: {
		verdict: 'excellent',
		fps: 120.0,
		frameTimeMeanMs: 8.33,
		worstFrameMs: 9.4,
		heapGrowthMBPerSec: 0.0,
		vram: {
			totalMiB: 43.7,
			textureMiB: 41.7,
			bufferMiB: 2.0,
			textureCount: 9,
			bufferCount: 34,
			leaked: 0,
		},
		warnings: [],
		resolvedWarnings: [
			'Texture memory is high: 110.1 MiB across 21 textures.',
		],
	},
};

// Canonical example from the README's "Report Structure" digest (an idealized
// excellent run) — used for the hero badge.
export const heroSummary = {
	verdict: 'excellent',
	fps: 60,
	frameTimeMsMean: 16.4,
	frameTimeMsP95: 17.1,
};
