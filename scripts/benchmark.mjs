#!/usr/bin/env node
// Reproducible CPU/tool-overhead benchmark; no GPU speed claim is implied.
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { baseline: {type:'string'} } });
const root = path.resolve(new URL('..', import.meta.url).pathname);
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const mock = `
class Pass { draw() {} drawIndexed() {} executeBundles() {} }
class Encoder { beginRenderPass() { return new Pass(); } }
class BufferResource { destroy() {} }
class Device { createBuffer() { return new BufferResource(); } createCommandEncoder() { return new Encoder(); } }
navigator={gpu:{async requestAdapter(){return {async requestDevice(){return new Device();}}}}};
`;
async function measure(directory) {
  const { autoInstrumentationSource } = await import(pathToFileURL(path.join(directory, 'src/browser/auto-instrument.js')));
  const {createTracker} = await import(pathToFileURL(path.join(directory, 'src/browser/allocation-tracker.js')));
  const tracker = createTracker('benchmark');
  for (let i=0;i<10000;i++) tracker.track({kind:'buffer',bytes:256});
  const manualSnapshotMs = Array.from({length:7},()=>{
    const start=performance.now();
    for(let i=0;i<1000;i++) tracker.snapshot({includeHistory:false,includeResources:false});
    return performance.now()-start;
  });
  const context = vm.createContext({ performance });
  vm.runInContext(mock, context);
  vm.runInContext(autoInstrumentationSource({historyLimit:0}), context);
  await vm.runInContext(`(async()=>{ device=await (await navigator.gpu.requestAdapter()).requestDevice(); for(let i=0;i<10000;i++)device.createBuffer({size:256}); })()`,context);
  const snapshots = new vm.Script('for(let i=0;i<1000;i++)__gpuReportInstrumentation.snapshot({includeHistory:false});');
  const encoders = new vm.Script('for(let i=0;i<10000;i++)device.createCommandEncoder().beginRenderPass().draw(3);');
  const sample = script => {
    script.runInContext(context); // warm JIT
    return Array.from({length:7},()=>{const start=performance.now();script.runInContext(context);return performance.now()-start;});
  };
  const snapshotMs = sample(snapshots);
  const encodeMs = sample(encoders);
  const helpMs = Array.from({length:7},()=>{
    const start=performance.now();
    const result=spawnSync(process.execPath,[path.join(directory,'src/cli.js'),'--help'],{encoding:'utf8'});
    if(result.status!==0)throw Error(result.stderr);
    return performance.now()-start;
  });
  return {snapshotMs:median(snapshotMs),manualSnapshotMs:median(manualSnapshotMs),encodeMs:median(encodeMs),helpMs:median(helpMs),raw:{snapshotMs,manualSnapshotMs,encodeMs,helpMs}};
}
const baseline = values.baseline ? await measure(path.resolve(values.baseline)) : null;
const current = await measure(root);
console.log(JSON.stringify({
  environment: { node:process.version,platform:process.platform,arch:process.arch },
  workload: {liveResources:10000,snapshots:1000,encodersAndPasses:10000,repetitions:7},
  baseline,current,
  speedup: baseline ? Object.fromEntries(['snapshotMs','manualSnapshotMs','encodeMs','helpMs'].map(key=>[key,baseline[key]/current[key]])) : null
},null,2));
