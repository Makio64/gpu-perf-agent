import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {FastCDPHarness,compareReports,comparisonExitCode,startReportServer} from '../src/index.js';

const enabled=process.env.GPU_PERF_BROWSER_TESTS==='1';
const exec=promisify(execFile);
const fixture=`<!doctype html><script>
let calls=0,rafRequests=0;
const raf=requestAnimationFrame.bind(globalThis);
globalThis.requestAnimationFrame=callback=>{rafRequests++;return raf(callback);};
setTimeout(()=>{
  globalThis.__gpuReportBench=async({phase,sampleIndex})=>{
    calls++;
    const completed=await new Promise(resolve=>setTimeout(()=>resolve(true),25));
    return {calls,phase,sampleIndex,completed,rafRequests,checksum:1+2+3};
  };
},50);
</script>`;

async function withFixture(contents,run){
  const directory=await mkdtemp(path.join(os.tmpdir(),'gpu-hook-mode-'));
  const file=path.join(directory,'index.html');
  await writeFile(file,contents);
  try{return await run({directory,file});}finally{await rm(directory,{recursive:true,force:true});}
}

function assertHookReport(report){
  assert.equal(report.options.samplingMode,'hook');
  assert.equal(report.options.frameObservation,'disabled');
  assert.equal(report.inPage.config.samplingMode,'hook');
  assert.equal(report.diagnostics.validity.valid,true,JSON.stringify(report.diagnostics.validity));
  for(const sample of report.inPage.samples){
    assert.equal(sample.error,null);
    assert.equal(sample.measurement.completed,true);
    assert.equal(sample.measurement.checksum,6);
    assert.equal(sample.measurement.rafRequests,0);
    assert.equal(Object.hasOwn(sample.measurement,'observedFrames'),false);
  }
}

test('hook mode awaits asynchronous readiness and each fixed-work sample without observing rAF', {skip:!enabled,timeout:20000},async()=>{
  await withFixture(fixture,async({file})=>{
    const options={file,waitUntil:'domcontentloaded',api:'webgpu',samples:2,warmup:1,durationMs:1,timeoutMs:4000};
    const harness=await FastCDPHarness.launch(options);
    try{
      const hook=await harness.run({...options,samplingMode:'hook'});
      assertHookReport(hook);
      assert.deepEqual(hook.inPage.samples.map(s=>s.measurement.calls),[2,3]);
      assert.deepEqual(hook.inPage.samples.map(s=>s.measurement.sampleIndex),[0,1]);
      const frames=await harness.run({...options,waitForHook:true,durationMs:60});
      assert.equal(frames.options.samplingMode,'frames');
      assert.equal(frames.options.frameObservation,'wall-clock');
      assert.ok(frames.inPage.samples.every(s=>s.measurement.observedFrames&&s.measurement.rafRequests>0));
      const comparison=compareReports(frames,hook);
      assert.equal(comparison.compatibility.compatible,false);
      assert.equal(comparisonExitCode(comparison),2);
      assert.ok(comparison.compatibility.differences.some(d=>d.key==='samplingMode'));
    }finally{await harness.close();}
  });
});

test('hook mode rejects absent hooks and preserves failed-sample evidence', {skip:!enabled,timeout:20000},async()=>{
  await withFixture('<!doctype html><title>No hook</title>',async({file,directory})=>{
    const options={file,samplingMode:'hook',waitUntil:'domcontentloaded',api:'webgpu',samples:3,warmup:0,durationMs:1,timeoutMs:4000};
    const harness=await FastCDPHarness.launch(options);
    try{
      await assert.rejects(harness.run({...options,waitForHook:false}),/requires benchmark hook/i);
      const failed=path.join(directory,'failed.html');
      await writeFile(failed,'<script>__gpuReportBench=async({sampleIndex})=>{await Promise.resolve();if(sampleIndex===1)throw Error("fixed-work sample failed");return {completed:true};};</script>');
      const report=await harness.run({...options,file:failed});
      assert.equal(report.diagnostics.validity.valid,false);
      assert.equal(report.inPage.samples.length,2);
      assert.equal(report.inPage.samples[0].measurement.completed,true);
      assert.match(report.inPage.samples[1].error.message,/fixed-work sample failed/);
      assert.ok(report.diagnostics.validity.issues.some(issue=>issue.code==='sample-errors'));
    }finally{await harness.close();}
  });
});

test('HTTP captures preserve hook-only sampling and awaited results', {skip:!enabled,timeout:20000},async()=>{
  await withFixture(fixture,async({file})=>{
    const server=await startReportServer({api:'webgpu',samples:2,warmup:0,durationMs:1,waitUntil:'domcontentloaded',timeoutMs:4000});
    try{
      const response=await fetch(`${server.url}/run`,{method:'POST',body:JSON.stringify({file,samplingMode:'hook'})});
      assert.equal(response.status,200);
      assertHookReport(await response.json());
    }finally{await server.close();}
  });
});

test('CLI run and alternating A/B propagate explicit hook sampling mode', {skip:!enabled,timeout:30000},async()=>{
  await withFixture(fixture,async({file,directory})=>{
    const common=['--sampling-mode','hook','--api','webgpu','--samples','2','--warmup','0','--duration-ms','1','--wait-until','domcontentloaded','--timeout','4000','--json'];
    const single=path.join(directory,'single.json');
    await exec(process.execPath,[path.resolve('src/cli.js'),'run','--file',file,'--out',single,...common]);
    assertHookReport(JSON.parse(await readFile(single,'utf8')));
    const abFile=path.join(directory,'ab.json');
    try{
      await exec(process.execPath,[path.resolve('src/cli.js'),'ab','--base-file',file,'--candidate-file',file,'--rounds','2','--out',abFile,...common]);
    }catch(error){
      // This is transport coverage, not a performance gate: incidental heap/timing
      // regressions can exit 1. Invalid or incompatible evidence must still fail.
      if(error.code!==1)throw error;
    }
    const ab=JSON.parse(await readFile(abFile,'utf8'));
    assert.equal(ab.runs.length,4);
    for(const run of ab.runs)assertHookReport(run.report);
    assert.equal(ab.comparison.validity.valid,true);
    assert.equal(ab.comparison.compatibility.compatible,true);
  });
});
