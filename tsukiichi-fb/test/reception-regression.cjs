const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {fakeServerCommit} = require('../src/fakeserver.js');

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {addEventListener() {}, classList: {toggle() {}}});
  return elements.get(id);
}
const ctx = vm.createContext({
  window: {addEventListener() {}}, document: {getElementById: element, addEventListener() {}, querySelectorAll: () => []},
  localStorage: {getItem: () => null, setItem() {}}, setTimeout, clearTimeout, console, setInterval: () => 0, location: { protocol: 'file:' }
});
const source = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
vm.runInContext(source.replace(/boot\(\);\s*$/, ''), ctx);
const run = code => vm.runInContext(code, ctx);
const W = ctx.window.__tk.W, root = 'staff/proto', db = {docs:{}};
const commit = w => fakeServerCommit(db, w, Date.now()).ok;
assert.ok(commit(W.newEvent(root, '', false, 'one', '前回')));
assert.equal(commit(W.newEvent(root, 'one', false, 'two', '今回')), false);
assert.equal(db.docs[root].currentEvent, 'one');
assert.ok(commit(W.newEvent(root, 'one', true, 'two', '今回')));
assert.equal(commit(W.newEvent(root, 'one', true, 'three', '競合')), false);
assert.equal(commit(W.cancel(root, 'one', ['person'])), false);
assert.equal(db.docs[root+'/events/one'].status, 'closed');
run("S.cur='two'; for (const k of ['roster','checkins','box']) S.sync[k]={cache:false}");
assert.ok(!run('canStartEvent()'));
run("S.events.two={status:'open'}; S.sync.events={cache:false}");
assert.ok(run('canStartEvent()'));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function checkCount() {
  run("renderBar=()=>{}; S.lastServer={count:3,at:1}; S.ops=[{eid:'two',state:'sending'}]; B={confirmedCount:async()=>2}; refreshConfirmedCount()");
  await sleep(180);
  assert.equal(run('S.lastServer.count'),3);
  run('S.ops=[]; refreshConfirmedCount()');
  await sleep(180);
  assert.equal(run('S.lastServer.count'),2);
  run("B.confirmedCount=()=>new Promise(r=>globalThis.finish=r);refreshConfirmedCount()");
  await sleep(180);
  run("S.cur='three'; S.lastServer=null; finish(99)");
  await sleep(5);
  assert.equal(run('S.lastServer'),null);
}
async function checkLegacy() {
  ctx.localStorage.getItem = key => key.endsWith('_gone') ? '["gone"]' : '[{"id":"gone"},{"id":"op","state":"sending"}]';
  ctx.indexedDB = {open() {
    const req = {};
    const tx = {objectStore:()=>({getAll:()=>({result:[{id:'op',state:'rejected',items:[{name:'旧名簿'}]}]})})};
    req.result = {transaction:()=>tx, close(){}};
    queueMicrotask(()=>{ req.onsuccess(); tx.oncomplete(); });
    return req;
  }};
  const rows = await run('readLegacy()');
  assert.equal(rows.length,1);
  assert.equal(rows[0].state,'rejected');
  assert.equal(rows[0].items[0].name,'旧名簿');
}
(async()=>{await checkCount(); await checkLegacy(); console.log('PASS: event, delayed list, confirmed count, legacy journal');})().catch(e=>{console.error(e);process.exitCode=1});
