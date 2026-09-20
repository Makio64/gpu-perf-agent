import assert from "node:assert/strict";
import test from "node:test";
import { createTracker, trackWebGPUDevice } from "../src/browser/allocation-tracker.js";

test("pipeline-tracker: createTracker tracks pipelines and bind groups", () => {
  const tracker = createTracker("webgpu");

  tracker.recordPipeline("render", false, { label: "hero-mesh-pipeline" });
  tracker.recordPipeline("compute", true, { label: "cull-pipeline" });
  tracker.recordShaderModule({ code: "@vertex fn main() {}" });
  tracker.recordBindGroup({ label: "frame-uniforms" });
  tracker.recordBindGroupLayout({ label: "frame-layout" });

  const snap = tracker.snapshot();
  assert.equal(snap.pipelines.syncCount, 1);
  assert.equal(snap.pipelines.asyncCount, 1);
  assert.equal(snap.pipelines.shaderModules, 1);
  assert.equal(snap.pipelines.syncPipelines.length, 1);
  assert.equal(snap.pipelines.syncPipelines[0].label, "hero-mesh-pipeline");
  assert.equal(snap.pipelines.syncPipelines[0].type, "render");

  assert.equal(snap.bindGroups.createdCount, 1);
  assert.equal(snap.bindGroups.layoutCount, 1);
});

test("pipeline-tracker: trackWebGPUDevice wraps device methods and records calls", () => {
  let syncRenderCalled = 0;
  let asyncComputeCalled = 0;
  let bindGroupCalled = 0;

  const fakeDevice = {
    createBuffer: (desc) => ({ destroy: () => {} }),
    createTexture: (desc) => ({ destroy: () => {} }),
    createRenderPipeline: (desc) => {
      syncRenderCalled++;
      return { label: desc.label };
    },
    createRenderPipelineAsync: async (desc) => {
      return { label: desc.label };
    },
    createComputePipeline: (desc) => {
      return { label: desc.label };
    },
    createComputePipelineAsync: async (desc) => {
      asyncComputeCalled++;
      return { label: desc.label };
    },
    createShaderModule: (desc) => ({ desc }),
    createBindGroup: (desc) => {
      bindGroupCalled++;
      return { desc };
    },
    createBindGroupLayout: (desc) => ({ desc })
  };

  const tracker = trackWebGPUDevice(fakeDevice);

  fakeDevice.createRenderPipeline({ label: "shadow-pass" });
  fakeDevice.createComputePipelineAsync({ label: "particle-sim" });
  fakeDevice.createBindGroup({ label: "material-bg" });

  assert.equal(syncRenderCalled, 1);
  assert.equal(asyncComputeCalled, 1);
  assert.equal(bindGroupCalled, 1);

  const snap = tracker.snapshot();
  assert.equal(snap.pipelines.syncCount, 1);
  assert.equal(snap.pipelines.asyncCount, 1);
  assert.equal(snap.bindGroups.createdCount, 1);
  assert.equal(snap.pipelines.syncPipelines[0].label, "shadow-pass");
});
