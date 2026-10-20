import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeReport,finalizeReport} from '../src/analysis.js';

function analyze(measurement){
  return analyzeReport({inPage:{hook:{found:true},samples:[{measurement}]}});
}

test('GPU timing extraction recognizes mixed nested aliases without pooling their durations',()=>{
  const measurement={
    gpuMs:2,
    'stage.GPUTimeNS':3000000,
    stages:[{gpuFrameMs:4},{nested:{gpuDurationNs:5000000}}],
    durations:{gpuTimeMs:6,gpuDurationMs:7,gpuNs:8000000},
    irrelevant:{durationNs:10,cpuMs:11,'gpuMs.trailing':12,'gpuNs.':13},
    nonfinite:{gpuMs:NaN,gpuNs:Infinity,gpuTimeMs:-Infinity},
    nonnumeric:{gpuMs:'14',gpuNs:15n,gpuDurationMs:null},
    numericArray:{gpuMs:[16,17]}
  };
  const before=structuredClone(measurement);
  const result=analyze(measurement);
  assert.equal(result.diagnostics.signal.gpuTiming.timingCount,7);
  assert.equal(result.diagnostics.signal.gpuTiming.status,'ambiguous');
  assert.equal(result.diagnostics.signal.gpuTimingSamples,0);
  assert.equal(result.summary.gpuFrameMsMean,null);
  assert.equal(result.summary.gpuFrameMsP95,null);
  assert.deepEqual(measurement,before);
});

test('GPU timing extraction retains its depth boundary and counts shared references per occurrence',()=>{
  const nested=(depth,value)=>{
    let result={gpuMs:value};
    for(let i=1;i<depth;i++)result={child:result};
    return result;
  };
  assert.equal(analyze(nested(8,3)).summary.gpuFrameMsMean,3);
  assert.equal(analyze(nested(9,3)).summary.gpuFrameMsMean,null);
  const shared={gpuMs:5};
  const measurement={first:shared,second:shared};
  const result=analyze(measurement);
  assert.equal(result.diagnostics.signal.gpuTiming.timingCount,2);
  assert.equal(result.diagnostics.signal.gpuTimingSamples,0);
  assert.equal(result.summary.gpuFrameMsMean,null);
  const cycle={gpuMs:1}; cycle.self=cycle;
  assert.equal(analyze(cycle).diagnostics.signal.gpuTiming.timingCount,8);
  assert.equal(analyze(cycle).summary.gpuFrameMsMean,null);
});

test('GPU timing extraction ignores inherited and symbol properties and rejects negative durations',()=>{
  const measurement=Object.create({gpuMs:99});
  measurement[Symbol('gpuMs')]=88;
  Object.assign(measurement,{gpuNs:-2000000,gpuDurationMs:0});
  const result=analyze(measurement);
  assert.equal(result.diagnostics.signal.gpuTiming.timingCount,2);
  assert.equal(result.diagnostics.signal.gpuTiming.negativeTimingCount,1);
  assert.equal(result.diagnostics.signal.gpuTiming.status,'invalid');
  assert.equal(result.diagnostics.validity.valid,false);
  assert.equal(result.summary.gpuFrameMsMean,null);
  assert.equal(analyze(12).summary.gpuFrameMsMean,null);
});

test('verbose dispatch diagnostics do not change the primary aggregate GPU scope',()=>{
  const report={options:{samplingMode:'hook',samples:3},inPage:{hook:{found:true},samples:Array.from({length:3},(_,index)=>({
    index,measurement:{gpuTimeNs:1000000*(index+1),dispatchTelemetry:Array.from({length:128},(_,dispatch)=>({
      label:`stage-${dispatch}`,dimensions:{x:32,y:32,z:1},
      resources:{inputBytes:1048576,outputBytes:1048576},costs:{encodeMs:0.02,completedNs:20000}
    }))}
  }))}};
  const finalized=finalizeReport(report);
  assert.equal(finalized.diagnostics.signal.gpuTimingSamples,3);
  assert.equal(finalized.summary.gpuFrameMsMean,2);
  assert.equal(finalized.summary.gpuFrameMsP95,2.9);
  assert.equal(finalized.diagnostics.validity.valid,true);
});
