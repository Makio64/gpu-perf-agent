import assert from 'node:assert/strict';
import test from 'node:test';
import {createWebGL2Timer} from '../src/browser/timing.js';

function context() {
  const gl = {
    QUERY_RESULT_AVAILABLE:1, QUERY_RESULT:2, CURRENT_QUERY:3,
    available:true,disjoint:false,lost:false,active:null,queries:[],ended:0,
    getExtension:()=>({TIME_ELAPSED_EXT:4,GPU_DISJOINT_EXT:5}),
    createQuery(){const q={deleted:0};this.queries.push(q);return q;},
    beginQuery(target,q){this.active=q;},endQuery(){this.active=null;this.ended++;},
    getQuery(){return this.active;}, getParameter(){return this.disjoint;},
    getQueryParameter(q,key){return key===this.QUERY_RESULT_AVAILABLE?this.available:42;},
    deleteQuery(q){q.deleted++;}, isContextLost(){return this.lost;}
  };
  return gl;
}

test('WebGL timer ends and deletes queries even when drawing throws', async()=>{
  const gl=context(), timer=createWebGL2Timer(gl);
  await assert.rejects(timer.measure(()=>{throw Error('draw failed');}),/draw failed/);
  assert.equal(gl.active,null);assert.equal(gl.ended,1);assert.equal(gl.queries[0].deleted,1);
  assert.equal(await timer.measure(()=>{}),42);
  assert.equal(timer.pendingCount,0);
  assert.equal(gl.queries[1].deleted,1);
});

test('query timeout works without requestAnimationFrame and releases the pending slot', async()=>{
  const gl=context();gl.available=false;
  const timer=createWebGL2Timer(gl,{timeoutMs:10,pollIntervalMs:1,maxPending:1});
  const first=timer.measure(()=>{});
  await assert.rejects(timer.measure(()=>{}),/pending queries/);
  await assert.rejects(first,/timed out/);
  assert.equal(timer.pendingCount,0);assert.equal(gl.queries[0].deleted,1);
  gl.available=true;assert.equal(await timer.measure(()=>{}),42);
});

test('disjoint rejects all outstanding queries instead of reporting invalid data',async()=>{
  const gl=context();gl.available=false;
  const timer=createWebGL2Timer(gl);
  const first=timer.measure(()=>{}),second=timer.measure(()=>{});
  gl.disjoint=true;
  const results=await Promise.allSettled([first,second]);
  assert.ok(results.every(r=>r.status==='rejected'&&/disjoint/.test(r.reason.message)));
  assert.deepEqual(gl.queries.map(q=>q.deleted),[1,1]);assert.equal(timer.pendingCount,0);
});

test('context loss and explicit destruction reject pending queries and clean up once',async()=>{
  const gl=context();gl.available=false;
  const timer=createWebGL2Timer(gl);
  const first=timer.measure(()=>{});gl.lost=true;
  await assert.rejects(first,/context was lost/);
  gl.lost=false;
  const second=timer.measure(()=>{});timer.destroy();timer.destroy();
  await assert.rejects(second,/destroyed/);
  await assert.rejects(timer.measure(()=>{}),/destroyed/);
  assert.deepEqual(gl.queries.map(q=>q.deleted),[1,1]);
});

test('async callbacks and pre-existing elapsed-time queries fail without damaging the caller query',async()=>{
  const gl=context(),timer=createWebGL2Timer(gl);
  await assert.rejects(timer.measure(async()=>{}),/synchronous/);
  const existing={};gl.active=existing;
  await assert.rejects(timer.measure(()=>{}),/already active/);
  assert.equal(gl.active,existing);assert.equal(gl.ended,1);
  assert.deepEqual(gl.queries.map(q=>q.deleted),[1,1]);
});

test('destroy during draw cannot leave a new pending query behind',async()=>{
  const gl=context(),timer=createWebGL2Timer(gl);
  await assert.rejects(timer.measure(()=>timer.destroy()),/destroyed/);
  assert.equal(timer.pendingCount,0);assert.equal(gl.active,null);assert.equal(gl.queries[0].deleted,1);
});
