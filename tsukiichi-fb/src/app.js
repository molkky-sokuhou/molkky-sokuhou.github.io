/* ===== 月いちモルック 受付の試作（Firebase） =====
   置き場所（BOX＝staff/proto。本番は別の箱にする）
   - staff/{BOX}                         今の開催回（currentEvent）
   - staff/{BOX}/roster/{rid}            名簿。まとめた人は mergedInto に行き先が入る
   - staff/{BOX}/events/{e}              開催回（status: open / closed。締めた回は開け直さない）
   - staff/{BOX}/events/{e}/checkins/{rid}  受付（名簿の番号が鍵。2台で同じ人を押しても1件）
   - staff/{BOX}/events/{e}/ops/{op}     操作の記録（受付・取消・まとめ）。届いたかの確認に使う
   - staff/{BOX}/events/{e}/devices/{d}  各端末の「送信待ち」の件数と最後につながった時刻
   ルール側で：締めた回への書き込み、まとめた人への受付は断る
*/
const VER = '@@VER@@';
const FB_VER = '13.2.0';
const STAFF_EMAIL = 'unei@tsukiichi.example';
const BOX = 'proto';
const ROOT = 'staff/' + BOX;
const firebaseConfig = {
  apiKey: 'AIzaSyAL3fYkM2kFulsnPhNuuAlyeVpIZy2wdSA',
  authDomain: 'tsukiichi-molkky.firebaseapp.com',
  projectId: 'tsukiichi-molkky',
  storageBucket: 'tsukiichi-molkky.firebasestorage.app',
  messagingSenderId: '1094812109659',
  appId: '1:1094812109659:web:1ccc08d729c95f5d31e87e'
};
const FAKE = ['はると', 'ゆい', 'そうた', 'めい', 'けんた', 'あおい', 'りく', 'ひな', 'だいき', 'さくら', 'ゆうと', 'みお',
  'こうき', 'りな', 'しょう', 'なな', 'たくみ', 'えま', 'れん', 'ここ', 'いつき', 'ゆか', 'そら', 'かい'];
const TS = { __ts: 1 };
const STALE_MS = 150000; // これより長く連絡がない端末は「確認できていない」扱い

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
const ls = {
  get(k, d) { try { const v = localStorage.getItem('tk_' + k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tk_' + k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem('tk_' + k); } catch (e) {} }
};
const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();
const pad = (n) => String(n).padStart(2, '0');
const hms = (t) => { if (!t) return ''; const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const hm = (t) => { if (!t) return ''; const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const sec = (ms) => (ms == null || isNaN(ms)) ? '—' : ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + '秒';
const ago = (ms) => (ms == null || !isFinite(ms)) ? '（時刻不明）' : ms < 60000 ? 'いま' : Math.floor(ms / 60000) + '分前';
/* 名前の比べ方：全角半角・空白・カタカナひらがなの違いをそろえる */
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).toLowerCase();

let DEV = ls.get('dev', '');
if (!DEV) { DEV = rid('d'); ls.set('dev', DEV); }
let devName = ls.get('devName', '端末' + DEV.slice(-2).toUpperCase());
const SESSION = rid('s');

/* ---------- 画面の状態 ---------- */
const S = {
  mode: '', cur: '', events: {}, roster: [], checkins: [], devices: [], metrics: [],
  sync: { box: null, events: null, roster: null, checkins: null }, // null=まだ / {cache:true|false, at, err}
  sel: {}, phase: 'entry', offset: null, rtt: null, firstSnap: true, seen: {}, ops: [], verifying: false
};
let B = null;
let unsubCur = [];

function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', !!bad); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, bad ? 4500 : 2200);
}

/* ===== 操作の記録（この端末に残す。届くまで「送信待ち」、断られたら名前つきで残す） ===== */
const OPS_KEY = 'ops_' + BOX;
/* 操作の記録は IndexedDB（Firestore と同じく閉じても残りやすい保存先）と localStorage の両方に置き、開くときに合わせる */
const IDB = {
  db: null,
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open('tk_ops', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('ops', { keyPath: 'id' }); };
        r.onsuccess = () => { IDB.db = r.result; res(true); };
        r.onerror = () => res(false);
      } catch (e) { res(false); }
    });
  },
  all() {
    return new Promise((res) => {
      if (!IDB.db) return res([]);
      try { const q = IDB.db.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); } catch (e) { res([]); }
    });
  },
  put(ops, removed) {
    if (!IDB.db) return;
    try { const tx = IDB.db.transaction('ops', 'readwrite'), st = tx.objectStore('ops'); ops.forEach((o) => st.put(o)); (removed || []).forEach((id) => st.delete(id)); } catch (e) {}
  }
};
const RANK = { sending: 0, unverified: 1, rejected: 2, done: 3 };
async function loadOps() {
  let a = [];
  try { a = JSON.parse(ls.get(OPS_KEY, '[]')) || []; } catch (e) { a = []; }
  await IDB.open();
  const b = await IDB.all();
  const m = {};
  a.concat(b).forEach((o) => { const p = m[o.id]; if (!p || (RANK[o.state] || 0) > (RANK[p.state] || 0)) m[o.id] = o; });
  const gone = JSON.parse(ls.get(OPS_KEY + '_gone', '[]') || '[]');
  S.ops = Object.values(m).filter((o) => gone.indexOf(o.id) < 0).sort((x, y) => x.tapAt - y.tapAt);
  /* 前に開いていたときの送信中は、届いたか分からないので「確かめ待ち」にする */
  S.ops.forEach((o) => { if (o.state === 'sending' && o.session !== SESSION) o.state = 'unverified'; });
  const day = now() - 86400000;
  const old = S.ops.filter((o) => o.state === 'done' && o.tapAt < day).map((o) => o.id);
  S.ops = S.ops.filter((o) => old.indexOf(o.id) < 0);
  saveOps(old);
}
function saveOps(removed) {
  IDB.put(S.ops, removed);
  if (removed && removed.length) { const g = JSON.parse(ls.get(OPS_KEY + '_gone', '[]') || '[]').concat(removed).slice(-300); ls.set(OPS_KEY + '_gone', JSON.stringify(g)); }
  if (!ls.set(OPS_KEY, JSON.stringify(S.ops)) && !IDB.db) toast('この端末に操作の記録を残せません（空き容量・プライベートモードを確かめてください）', true);
}
function dropOp(id) { S.ops = S.ops.filter((o) => o.id !== id); saveOps([id]); }
const unsent = () => S.ops.filter((o) => o.state === 'sending' || o.state === 'unverified');
const rejected = () => S.ops.filter((o) => o.state === 'rejected');

function runOp(op, writes) {
  op.session = SESSION; op.state = 'sending'; op.dev = DEV; op.devName = devName;
  writes.push({ op: 'set', path: ROOT + '/events/' + op.eid + '/ops/' + op.id, data: { type: op.type, names: op.items.map((i) => i.name), ids: op.items.map((i) => i.id), dev: DEV, devName, tapAt: op.tapAt, at: TS } });
  S.ops.push(op); saveOps();
  const p = B.commit(writes);
  p.then(() => { op.state = 'done'; op.doneAt = now(); saveOps(); renderAll(); heartbeat(); },
    (err) => { markRejected(op, err && err.code); });
  renderAll(); heartbeat();
  return p;
}
async function markRejected(op, code) {
  op.state = 'rejected'; op.code = code || 'error'; op.reason = '確かめています…'; saveOps(); renderAll(); heartbeat();
  op.reason = await reasonFor(op); saveOps(); renderAll();
  toast('届かなかった操作があります：' + op.items.map((i) => i.name).join('・'), true);
}
async function reasonFor(op) {
  try {
    const ev = await B.getServer(ROOT + '/events/' + op.eid);
    if (ev && ev.status === 'closed') return '締めた回（' + (ev.name || '') + '）への操作だったため、断られました';
    if (op.type === 'in') {
      for (const it of op.items) {
        const r = await B.getServer(ROOT + '/roster/' + it.id);
        if (r && r.mergedInto) return '「' + it.name + '」さんは別の人とまとめ済みのため、断られました';
      }
    }
  } catch (e) { return '確かめられませんでした（電波を確かめてください）'; }
  return op.code === 'permission-denied' ? '権限がないため断られました' : 'うまく保存できませんでした（' + op.code + '）';
}
/* 前に開いていたときの送信が届いたかを、サーバーの操作記録で確かめる */
async function verifyOps() {
  if (S.verifying || !unsent().some((o) => o.state === 'unverified')) return;
  S.verifying = true;
  try {
    await B.waitPending();
    for (const op of S.ops.filter((o) => o.state === 'unverified')) {
      const d = await B.getServer(ROOT + '/events/' + op.eid + '/ops/' + op.id);
      if (d) { op.state = 'done'; op.doneAt = now(); }
      else { op.state = 'rejected'; op.code = 'not-arrived'; op.reason = await reasonFor(op); }
      saveOps();
    }
  } catch (e) { /* 電波がない。あとでもう一度 */ }
  S.verifying = false; renderAll(); heartbeat();
}

/* ===== 保存先：Firebase ===== */
async function fireBackend() {
  const base = 'https://www.gstatic.com/firebasejs/' + FB_VER + '/';
  const [A, F, U] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-firestore.js'), import(base + 'firebase-auth.js')]);
  const app = A.initializeApp(firebaseConfig);
  let db, persistent = true;
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
  catch (e) { persistent = false; db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() }); }
  const auth = U.getAuth(app);
  const conv = (o) => { const r = {}; Object.keys(o).forEach((k) => { r[k] = o[k] && o[k].__ts ? F.serverTimestamp() : o[k]; }); return r; };
  const plain = (o) => { const r = {}; Object.keys(o || {}).forEach((k) => { const v = o[k]; r[k] = v && typeof v.toMillis === 'function' ? v.toMillis() : v; }); return r; };
  const docs = (s) => s.docs.map((d) => ({ id: d.id, data: plain(d.data({ serverTimestamps: 'estimate' })), pending: d.metadata.hasPendingWrites }));
  return {
    kind: 'fire', persistent, F, A, app,
    waitUser() { return new Promise((res) => { const off = U.onAuthStateChanged(auth, (u) => { off(); res(u); }); }); },
    login(pass) { return U.signInWithEmailAndPassword(auth, STAFF_EMAIL, pass); },
    logout() { return U.signOut(auth); },
    sub(path, cb, err) {
      return F.onSnapshot(F.collection(db, path), { includeMetadataChanges: true }, (s) => cb(docs(s), s.metadata.fromCache, s.docChanges().filter((c) => c.type !== 'removed').map((c) => c.doc.id)), err);
    },
    subDoc(path, cb, err) { return F.onSnapshot(F.doc(db, path), { includeMetadataChanges: true }, (d) => cb(d.exists() ? plain(d.data({ serverTimestamps: 'estimate' })) : null, d.metadata.fromCache), err); },
    subMetrics(cb) { return F.onSnapshot(F.query(F.collection(db, ROOT + '/metrics'), F.orderBy('tapAt', 'desc'), F.limit(300)), (s) => cb(s.docs.map((d) => plain(d.data()))), () => {}); },
    commit(writes) {
      const b = F.writeBatch(db);
      writes.forEach((w) => {
        const r = F.doc(db, w.path);
        if (w.op === 'delete') b.delete(r);
        else if (w.op === 'update') b.update(r, conv(w.data));
        else if (w.op === 'merge') b.set(r, conv(w.data), { merge: true });
        else b.set(r, conv(w.data));
      });
      return b.commit();
    },
    async getServer(path) { const d = await F.getDocFromServer(F.doc(db, path)); return d.exists() ? plain(d.data()) : null; },
    waitPending() { return F.waitForPendingWrites(db); },
    async clearLocal() { await U.signOut(auth); await F.terminate(db); await F.clearIndexedDbPersistence(db); },
    async ping() {
      const t1 = now();
      await F.setDoc(F.doc(db, ROOT + '/ping/' + DEV), { at: F.serverTimestamp() });
      const t2 = now();
      const d = await F.getDocFromServer(F.doc(db, ROOT + '/ping/' + DEV));
      return { offset: d.data().at.toMillis() - (t1 + t2) / 2, rtt: t2 - t1 };
    },
    /* ログインしていない人から、運営のデータが読めないことを確かめる */
    async anonRead() {
      const a2 = A.initializeApp(firebaseConfig, 'anon' + Date.now());
      const d2 = F.initializeFirestore(a2, { localCache: F.memoryLocalCache() });
      const res = {};
      try { await F.getDocsFromServer(F.collection(d2, ROOT + '/roster')); res.staff = 'read'; } catch (e) { res.staff = e.code || 'error'; }
      try { await F.getDocsFromServer(F.collection(d2, 'public')); res.pub = 'read'; } catch (e) { res.pub = e.code || 'error'; }
      try { await F.setDoc(F.doc(d2, 'public/selftest'), { x: 1 }); res.pubWrite = 'written'; } catch (e) { res.pubWrite = e.code || 'error'; }
      try { await A.deleteApp(a2); } catch (e) {}
      return res;
    }
  };
}

/* ===== 保存先：模擬サーバー（練習モード・自動試験） =====
   window.__FAKE_URL があれば試験用サーバーへ、なければこの端末の中の模擬サーバーへ */
function fakeBackend() {
  const URL0 = window.__FAKE_URL || '';
  const LS_SRV = 'tk_fake_server';
  const rd = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  let cache = { docs: {}, ver: 0 }, queue = [], fromCache = true, offline = false, busy = false;
  /* 端末側の写しと送信待ちは IndexedDB に置く（本物の Firestore と同じ置き場所） */
  let kv = null;
  const kvGet = (k) => new Promise((res) => { try { const q = kv.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); } catch (e) { res(undefined); } });
  const save = (k, v) => { try { kv.transaction('kv', 'readwrite').objectStore('kv').put(JSON.parse(JSON.stringify(v)), k); } catch (e) {} };
  const ready = new Promise((res) => {
    try {
      const r = indexedDB.open('tk_fake', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = async () => { kv = r.result; cache = (await kvGet('cache')) || cache; queue = (await kvGet('queue')) || []; res(); };
      r.onerror = () => res();
    } catch (e) { res(); }
  });
  const waiters = {}; // この画面で出した送信の結果待ち
  const subs = [];
  const local = {
    async state() { await new Promise((r) => setTimeout(r, 80)); if (offline) throw { code: 'unavailable' }; return rd(LS_SRV, { docs: {}, ver: 0 }); },
    async commit(writes) {
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 700));
      if (offline) throw { code: 'unavailable' };
      const db = rd(LS_SRV, { docs: {}, ver: 0 }); const r = fakeServerCommit(db, writes, now()); if (r.ok) wr(LS_SRV, db); return r;
    }
  };
  const http = {
    async state() { const r = await fetch(URL0 + '/state'); if (!r.ok) throw { code: 'unavailable' }; return r.json(); },
    async commit(writes) { const r = await fetch(URL0 + '/commit', { method: 'POST', body: JSON.stringify({ writes }) }); if (!r.ok) throw { code: 'unavailable' }; return r.json(); }
  };
  const T = URL0 ? http : local;
  /* 見えている姿＝サーバーの写し＋まだ届いていない操作 */
  function view() {
    let docs = Object.assign({}, cache.docs); const pend = {};
    queue.forEach((b) => { const a = fakeApply(docs, b.writes, now()); if (a) { docs = a; b.writes.forEach((w) => { pend[w.path] = 1; }); } });
    return { docs, pend };
  }
  let lastSig = {};
  function emit() {
    const v = view();
    subs.forEach((s) => {
      if (s.kind === 'col') {
        const depth = s.path.split('/').length + 1;
        const list = Object.keys(v.docs).filter((k) => k.indexOf(s.path + '/') === 0 && k.split('/').length === depth)
          .map((k) => ({ id: k.split('/').pop(), data: v.docs[k], pending: !!v.pend[k] }));
        const sig = JSON.stringify(list) + fromCache;
        if (lastSig[s.key] === sig) return;
        const prev = s.prev || {}; s.prev = {}; list.forEach((d) => { s.prev[d.id] = JSON.stringify(d); });
        lastSig[s.key] = sig;
        s.cb(list, fromCache, list.filter((d) => prev[d.id] !== s.prev[d.id]).map((d) => d.id));
      } else {
        const d = v.docs[s.path] || null, sig = JSON.stringify(d) + fromCache;
        if (lastSig[s.key] === sig) return; lastSig[s.key] = sig; s.cb(d, fromCache);
      }
    });
  }
  async function tick() {
    if (busy) return; busy = true;
    await ready;
    try {
      while (queue.length) {
        const b = queue[0];
        const r = await T.commit(b.writes);
        queue.shift(); save('queue', queue);
        if (waiters[b.id]) { r.ok ? waiters[b.id].res() : waiters[b.id].rej({ code: r.code }); delete waiters[b.id]; }
      }
      const st = await T.state(); if (st.ver !== cache.ver) { cache = st; save('cache', cache); } fromCache = false;
    } catch (e) { fromCache = true; }
    busy = false; emit();
  }
  const timer = setInterval(tick, 700);
  let k = 0;
  return {
    kind: URL0 ? 'test' : 'demo', persistent: true,
    setOffline(v) { offline = v; tick(); },
    isOffline() { return offline; },
    waitUser() { return Promise.resolve(null); }, login() { return Promise.resolve(); }, logout() { return Promise.resolve(); },
    sub(path, cb) { const s = { kind: 'col', path, cb, key: 'k' + (k++) }; subs.push(s); ready.then(emit); return () => { subs.splice(subs.indexOf(s), 1); }; },
    subDoc(path, cb) { const s = { kind: 'doc', path, cb, key: 'k' + (k++) }; subs.push(s); ready.then(emit); return () => { subs.splice(subs.indexOf(s), 1); }; },
    subMetrics(cb) { return this.sub(ROOT + '/metrics', (l) => cb(l.map((d) => d.data).sort((a, b) => b.tapAt - a.tapAt))); },
    commit(writes) {
      const id = rid('b'); queue.push({ id, writes: JSON.parse(JSON.stringify(writes)) }); save('queue', queue); emit(); tick();
      return new Promise((res, rej) => { waiters[id] = { res, rej }; });
    },
    async getServer(path) { const st = await T.state(); return st.docs[path] || null; },
    waitPending() { return ready.then(() => new Promise((res) => { const f = () => { if (!queue.length) res(); else setTimeout(f, 200); }; f(); })); },
    async clearLocal() { clearInterval(timer); try { kv && kv.close(); indexedDB.deleteDatabase('tk_fake'); } catch (e) {} },
    ping() { return Promise.resolve({ offset: 0, rtt: 0 }); },
    anonRead() { return Promise.resolve(null); }
  };
}

/* ===== 起動・ログイン（起動中の選択は1つに確定し、古い処理の結果は使わない） ===== */
let bootToken = 0;
async function boot() {
  await loadOps();
  $('lockForm').onsubmit = async (e) => {
    e.preventDefault();
    const my = ++bootToken;
    const pass = $('passIn').value;
    if (!pass) { $('lockErr').textContent = 'パスコードを入れてください'; return; }
    setLockBusy(true, 'つないでいます…');
    try {
      const b = (B && B.kind === 'fire') ? B : await fireBackend();
      await b.login(pass);
      if (my !== bootToken) return;
      B = b; $('passIn').value = ''; enter('fire');
    } catch (err) {
      if (my !== bootToken) return;
      const c = (err && err.code) || '';
      $('lockErr').textContent = /too-many-requests/.test(c) ? 'パスコードを続けて間違えたため、しばらく入れません。数分〜1時間ほど待ってから試してください。急ぐときは、すでに運営モードの端末で続けてください'
        : /invalid-credential|wrong-password|invalid-login|user-not-found/.test(c) ? 'パスコードが違います'
        : /network|unavailable|import|fetch/i.test(c + ' ' + (err && err.message)) ? '通信できませんでした。電波の良い場所でもう一度押してください'
        : 'うまくいきませんでした（' + (c || (err && err.message) || '不明') + '）';
    } finally { if (my === bootToken) setLockBusy(false, null); }
  };
  $('demoBtn').onclick = () => { ++bootToken; B = fakeBackend(); enter(B.kind); };
  if (window.__FAKE_URL) { B = fakeBackend(); enter('test'); return; }
  if (ls.get('mode', '') === 'fire') {
    const my = ++bootToken;
    setLockBusy(true, '前回のログインを確かめています…');
    try { const b = await fireBackend(); const u = await b.waitUser(); if (my === bootToken && u) { B = b; enter('fire'); return; } } catch (e) {}
    if (my === bootToken) setLockBusy(false, '');
  }
}
function setLockBusy(on, msg) {
  $('passBtn').disabled = on; $('demoBtn').disabled = on;
  if (msg != null) $('lockErr').textContent = msg;
}

function enter(mode) {
  if (S.mode) return;
  S.mode = mode; if (mode === 'fire') ls.set('mode', mode);
  $('lock').hidden = true; $('app').hidden = false; $('bnav').hidden = false;
  $('demoNet').hidden = mode !== 'demo';
  $('anonRow').hidden = mode !== 'fire';
  $('modeLine').textContent = mode === 'fire' ? 'つながっている受付（2台で共有）' + (B.persistent ? '' : '・この端末は送信待ちを画面を閉じると失います')
    : mode === 'demo' ? '練習モード（この端末の中だけ。ほかの端末とはつながりません）' : '自動試験';
  $('devName').value = devName;
  const onErr = (key) => (err) => { S.sync[key] = { cache: true, err: (err && err.code) || 'error', at: S.sync[key] && S.sync[key].at }; renderAll(); };
  const mark = (key, fromCache) => { S.sync[key] = { cache: fromCache, at: fromCache ? (S.sync[key] && S.sync[key].at) : now() }; };
  B.subDoc(ROOT, (d, fc) => { mark('box', fc); const cur = (d && d.currentEvent) || ''; if (cur !== S.cur) switchEvent(cur); renderAll(); }, onErr('box'));
  B.sub(ROOT + '/events', (list, fc) => { mark('events', fc); S.events = {}; list.forEach((d) => { S.events[d.id] = d.data; }); renderAll(); }, onErr('events'));
  B.sub(ROOT + '/roster', (list, fc) => { mark('roster', fc); S.roster = list.map((d) => ({ id: d.id, ...d.data, pending: d.pending })); renderAll(); }, onErr('roster'));
  B.subMetrics((m) => { S.metrics = m; renderMetrics(); });
  clockSync();
  showPhase(ls.get('phase', 'entry'));
  renderAll();
  setInterval(() => { verifyOps(); heartbeat(); renderBar(); }, 15000);
  setTimeout(verifyOps, 500);
}
function switchEvent(cur) {
  unsubCur.forEach((f) => f()); unsubCur = [];
  S.cur = cur; S.checkins = []; S.devices = []; S.sync.checkins = null; S.firstSnap = true; S.seen = {}; S.sel = {};
  if (!cur) return;
  const onErr = (err) => { S.sync.checkins = { cache: true, err: (err && err.code) || 'error' }; renderAll(); };
  unsubCur.push(B.sub(ROOT + '/events/' + cur + '/checkins', (list, fc, changed) => {
    S.sync.checkins = { cache: fc, at: fc ? (S.sync.checkins && S.sync.checkins.at) : now() };
    onCheckins(list.map((d) => ({ id: d.id, ...d.data, pending: d.pending })), changed);
  }, onErr));
  unsubCur.push(B.sub(ROOT + '/events/' + cur + '/devices', (list) => { S.devices = list.map((d) => ({ id: d.id, ...d.data })); renderBar(); }, () => {}));
  hbLast = '';
  heartbeat();
}

async function clockSync() {
  if (S.mode !== 'fire') { S.offset = 0; S.rtt = 0; renderMetrics(); return; }
  $('clockLine').textContent = '時計を合わせています…';
  try {
    let best = null;
    for (let i = 0; i < 3; i++) { const r = await B.ping(); if (!best || r.rtt < best.rtt) best = r; }
    S.offset = best.offset; S.rtt = best.rtt;
  } catch (e) {}
  renderMetrics();
}
const srvNow = () => now() + (S.offset || 0);

/* ===== 端末の状況（もう1台の送信待ちを、届いた範囲で見せる） ===== */
let hbLast = '', hbAt = 0;
function heartbeat() {
  if (!B || !S.cur || document.hidden) return;
  const sig = S.cur + '|' + unsent().length + '|' + rejected().length + '|' + devName;
  if (sig === hbLast && now() - hbAt < 60000) return;
  hbLast = sig; hbAt = now();
  B.commit([{ op: 'merge', path: ROOT + '/events/' + S.cur + '/devices/' + DEV, data: { name: devName, pending: unsent().length, rejected: rejected().length, at: TS, clientAt: now(), ver: VER } }]).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); verifyOps(); } });

/* ===== データが届いたとき ===== */
function onCheckins(list, changed) {
  const t = now();
  if (!S.firstSnap && document.visibilityState === 'visible' && S.phase === 'entry') {
    const byBatch = {};
    list.forEach((c) => {
      if (S.seen[c.id] || c.pending || c.dev === DEV || changed.indexOf(c.id) < 0) return;
      S.seen[c.id] = 1;
      if (!c.batch || byBatch[c.batch]) return;
      byBatch[c.batch] = 1;
      const seenSrv = S.offset == null ? null : t + S.offset;
      if (seenSrv != null && c.at && seenSrv - c.at > 120000) return;
      metric({ id: 'seen_' + DEV + '_' + c.batch, kind: 'seen', from: c.devName || '', n: num(c.n) || 1, tapAt: t,
        seenFromTap: seenSrv != null && c.tapSrv ? Math.round(seenSrv - c.tapSrv) : null,
        seenFromSave: seenSrv != null && c.at ? Math.round(seenSrv - c.at) : null });
    });
  } else { list.forEach((c) => { S.seen[c.id] = 1; }); }
  if (list.length || !S.sync.checkins.cache) S.firstSnap = false;
  S.checkins = list;
  renderAll();
}
function metric(m) {
  m.dev = DEV; m.devName = devName; m.ver = VER;
  B.commit([{ op: 'set', path: ROOT + '/metrics/' + m.id, data: m }]).catch(() => {});
}

/* ===== 名簿のまとめ（まとめた人は行き先に読み替える） ===== */
const rosterById = () => { const m = {}; S.roster.forEach((r) => { m[r.id] = r; }); return m; };
function resolveId(id, rm) { let x = id, n = 0; while (rm[x] && rm[x].mergedInto && n++ < 10) x = rm[x].mergedInto; return x; }
/* いまの回の受付を、人ごとに1つにまとめた一覧 */
function people() {
  const rm = rosterById(), out = {};
  S.checkins.forEach((c) => {
    const id = resolveId(c.id, rm);
    const prev = out[id];
    const entry = { ...c, id, rawId: c.id, merged: id !== c.id };
    if (!prev || (prev.merged && !entry.merged)) out[id] = entry;
    if (prev && c.pending) out[id].pending = true;
  });
  return Object.values(out);
}

/* ===== 受付する ===== */
function needEvent() {
  if (S.cur && S.events[S.cur] && S.events[S.cur].status === 'open') return false;
  toast(S.cur ? 'この回は締められています。設定タブで新しい回を始めてください' : '開催回がまだありません。受付タブの「最初の回を始める」を押してください', true);
  return true;
}
function doCheckin(items, type) {
  if (needEvent()) return;
  const t0 = performance.now(), tapAt = now();
  const op = { id: rid('o'), type: 'in', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items, tapAt };
  const writes = [];
  items.forEach((it) => {
    if (it.isNew) writes.push({ op: 'set', path: ROOT + '/roster/' + it.id, data: { name: it.name, norm: norm(it.name), exp: !!it.exp, early: !!it.early, pair: it.pair || '', createdAt: TS, createdIn: S.cur } });
    writes.push({ op: 'set', path: ROOT + '/events/' + S.cur + '/checkins/' + it.id, data: { name: it.name, isNew: !!it.isNew, at: TS, tapAt, tapSrv: S.offset == null ? null : Math.round(tapAt + S.offset), dev: DEV, devName, batch: op.id, n: items.length, op: op.id } });
    S.seen[it.id] = 1;
  });
  const p = runOp(op, writes);
  let ready = null;
  requestAnimationFrame(() => { ready = performance.now() - t0; });
  const fin = (ok, code) => metric({ id: 'tap_' + op.id, kind: type, n: items.length, tapAt, readyMs: ready == null ? null : Math.round(ready), saveMs: now() - tapAt, ok, code: code || '' });
  p.then(() => fin(true), (e) => fin(false, e && e.code));
}
$('qAdd').onclick = () => {
  const ids = Object.keys(S.sel);
  if (!ids.length) return;
  const rm = rosterById();
  const items = ids.map((id) => rm[id]).filter(Boolean).map((r) => ({ id: r.id, name: r.name }));
  S.sel = {}; $('eq').value = '';
  doCheckin(items, 'tap');
  renderAll(); $('eq').focus();
  toast(items.map((i) => i.name).join('・') + ' さんを受付');
};
$('newAdd').onclick = () => {
  const name = $('eq').value.trim().replace(/\s+/g, ' ');
  if (!name) { $('eq').focus(); return; }
  if (S.roster.some((r) => !r.mergedInto && r.name === name)) { toast('「' + name + '」さんは名簿にいます。上の候補から選んでください', true); return; }
  doCheckin([{ id: rid('n'), name, isNew: true, exp: $('pExp').checked, early: $('pEarly').checked, pair: $('pPair').value.trim() }], 'new');
  $('eq').value = ''; $('pExp').checked = false; $('pEarly').checked = false; $('pPair').value = '';
  renderAll(); $('eq').focus();
  toast(name + ' さんを受付（はじめて）');
};
$('eq').addEventListener('input', renderRoster);
$('eq').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!$('newBox').hidden && $('newAdd').classList.contains('primary')) $('newAdd').click(); } });

/* ===== 表示 ===== */
function renderAll() { renderBar(); renderEventGate(); renderRoster(); renderDup(); renderList(); renderRejected(); renderPills(); renderEventBox(); }

function serverState() {
  const s = S.sync;
  if (!S.cur) return s.box && !s.box.cache ? 'ok' : 'wait';
  const c = s.checkins;
  if (!c) return 'wait';
  if (c.err) return 'err';
  return c.cache || !s.roster || s.roster.cache ? 'cache' : 'ok';
}
function renderBar() {
  if (!S.mode) return;
  const un = unsent().length, rj = rejected().length;
  const demoOff = B && B.isOffline && B.isOffline();
  const st = serverState();
  const online = S.mode === 'fire' ? navigator.onLine && st === 'ok' : !demoOff && st === 'ok';
  const confirmed = people().filter((p) => !p.pending).length;
  const lastAt = S.sync.checkins && S.sync.checkins.at;
  /* 1行目：この端末 */
  const mine = rj ? ['off', '届かなかった操作 ' + rj + '件', '受付タブのいちばん上で確かめてください']
    : un ? [online ? 'wait' : 'off', 'この端末の送信待ち ' + un + '件', online ? '送っています…' : '電波なし。この端末に残っています。電波が戻れば自動で送ります']
    : ['ok', 'この端末の送信待ち 0件', 'この端末で押した受付・取消は、すべてサーバーに届いています'];
  /* 2行目：サーバー */
  const srv = !S.cur && st === 'ok' ? ['info', 'サーバーにつながっています', '開催回がまだありません']
    : st === 'ok' ? ['ok', 'サーバーで確認できた受付 ' + confirmed + '人', hms(lastAt) + ' 時点']
    : st === 'wait' ? ['wait', 'サーバーの受付人数を確認中…', '']
    : st === 'err' ? ['off', 'サーバーの受付を読めません', '（' + S.sync.checkins.err + '）電波とログインを確かめてください']
    : ['off', 'サーバー未確認', lastAt ? '最後に確認できたのは ' + hms(lastAt) + '（' + confirmed + '人）' : 'まだ一度も確認できていません'];
  /* 3行目：ほかの端末 */
  const others = S.devices.filter((d) => d.id !== DEV);
  const stale = others.filter((d) => !d.at || srvNow() - d.at > STALE_MS);
  const othersPend = others.filter((d) => (d.pending || 0) > 0 || (d.rejected || 0) > 0);
  let all;
  if (!others.length) all = ['info', 'この回に参加しているのはこの端末だけです', 'もう1台を使うときは、その端末で一度開くとここに出ます'];
  else if (stale.length) all = ['off', '全員分の確定はまだ言えません', stale.map((d) => d.name + '：最後の連絡は' + ago(srvNow() - d.at) + '（そのときの送信待ち' + (d.pending || 0) + '件）。その後に圏外で押した分は分かりません').join('／')];
  else if (othersPend.length) all = ['wait', 'ほかの端末に送信待ちがあります', othersPend.map((d) => d.name + '：送信待ち' + (d.pending || 0) + '件' + (d.rejected ? '・届かなかった' + d.rejected + '件' : '')).join('／')];
  else all = [un || rj || st !== 'ok' ? 'wait' : 'ok', un || rj || st !== 'ok' ? 'ほかの端末の送信待ちは 0件' : '全端末の送信待ち 0件（全員分が確定）', others.map((d) => d.name + '：' + ago(srvNow() - d.at) + '確認').join('／')];
  const row = (r) => '<div class="sb-row ' + r[0] + '"><span class="big"><span class="dot"></span>' + esc(r[1]) + '</span>' + (r[2] ? '<span class="sub">' + esc(r[2]) + '</span>' : '') + '</div>';
  /* いつも見える1行：この端末の送信待ち＋サーバーの人数（短く） */
  const short = !S.cur ? (st === 'ok' ? '開催回なし' : 'サーバー確認中') : st === 'ok' ? 'サーバー ' + confirmed + '人（' + hm(lastAt) + '確認）' : st === 'wait' ? 'サーバー確認中' : 'サーバー未確認';
  const worst = mine[0] === 'ok' && st !== 'ok' ? 'wait' : mine[0];
  $('saveBar').innerHTML = '<div class="sb-row ' + worst + '"><span class="big"><span class="dot"></span>' + esc(rj ? '届かなかった操作 ' + rj + '件' : 'この端末の送信待ち ' + un + '件') + '</span><span class="sub">' + esc(short) + '</span></div>';
  $('statusBox').innerHTML = row(mine) + row(srv) + row(all);
}

function renderPills() {
  const ps = people(), rm = rosterById();
  const ex = ps.filter((c) => rm[c.id] && rm[c.id].exp).length;
  $('pills').innerHTML = '<span class="pill"><b class="num">' + ps.length + '</b><small>受付（この端末の表示）</small></span><span class="pill"><b class="num">' + ex + '</b><small>経験豊富</small></span>';
  const bd = $('bd-entry'); if (bd) { bd.hidden = !ps.length; bd.textContent = ps.length; bd.classList.add('ok'); }
}

function renderEventGate() {
  const ev = S.events[S.cur];
  const gate = $('evGate');
  const synced = S.sync.box && !S.sync.box.cache;
  $('evName').hidden = !(S.cur && ev && ev.status === 'open'); $('evName').textContent = ev ? ev.name || '' : '';
  if (S.cur && ev && ev.status === 'open') { gate.hidden = true; return; }
  gate.hidden = false;
  if (!synced && !S.cur) { gate.innerHTML = '<b>開催回を確認しています…</b><p class="muted" style="margin:4px 0 0">電波が弱いと時間がかかります。</p>'; return; }
  gate.innerHTML = S.cur && ev && ev.status === 'closed'
    ? '<b>「' + esc(ev.name) + '」は締められています。</b><p style="margin:4px 0 8px">受付するには新しい回を始めてください。</p><button class="btn primary" type="button" data-newev>新しい回を始める</button>'
    : '<b>開催回がまだありません。</b><p style="margin:4px 0 8px">受付は開催回ごとに分けて保存します。</p><button class="btn primary" type="button" data-newev>最初の回を始める</button>';
  gate.querySelector('[data-newev]').onclick = openNewEvent;
}

function renderRoster() {
  const q = $('eq').value.trim();
  const rm = rosterById(), done = {};
  people().forEach((c) => { done[c.id] = 1; });
  const list = S.roster.filter((r) => !r.mergedInto && !done[r.id]).sort((a, b) => (a.id < b.id ? -1 : 1));
  Object.keys(S.sel).forEach((id) => { if (!list.some((r) => r.id === id)) delete S.sel[id]; });
  const nq = norm(q);
  const shown = q ? list.filter((r) => norm(r.name).indexOf(nq) >= 0) : list;
  const sameIn = q && people().find((c) => norm(c.name) === nq);
  const sameRoster = q && S.roster.find((r) => !r.mergedInto && norm(r.name) === nq);
  $('newBox').hidden = !q || !!(sameRoster && sameRoster.name === q);
  $('newMsg').innerHTML = sameIn ? '<b>「' + esc(sameIn.name) + '」さんは受付済みです。</b>別の人なら、名前を区別できるように入れて受付してください。'
    : sameRoster ? '名簿に<b>「' + esc(sameRoster.name) + '」</b>さんがいます。同じ人なら上の候補から選んでください。別の人のときだけ、下のボタンで受付します。'
    : shown.length ? '上の候補に当てはまる人がいなければ、<b>「' + esc(q) + '」</b>さんを、はじめての人として受付できます。名前を最後まで入れてから押してください。'
    : '<b>「' + esc(q) + '」</b>さんは名簿にいません。はじめての人として受付します。';
  $('newAdd').textContent = (sameIn || sameRoster ? '別の人として「' : '「') + q + '」さんを、はじめての人として受付';
  $('newAdd').classList.toggle('primary', !shown.length && !sameIn && !sameRoster && nq.length >= 2);
  const evOk = !!(S.cur && S.events[S.cur] && S.events[S.cur].status === 'open');
  $('rList').innerHTML = !evOk ? '' : shown.map((r) => '<label class="rc"><input type="checkbox" data-q="' + esc(r.id) + '"' + (S.sel[r.id] ? ' checked' : '') + '><span>' + esc(r.name) +
      '<small>' + (r.exp ? '経験豊富' : '名簿') + (r.early ? '・早帰り' : '') + '</small></span></label>').join('')
    || '<span class="muted">' + (q ? (sameIn ? '「' + esc(sameIn.name) + '」さんは受付済みです' : '名簿に「' + esc(q) + '」に当てはまる人はいません')
      : S.roster.length ? '名簿の人は全員受付済みです' : S.sync.roster && !S.sync.roster.cache ? 'まだ名簿がありません。設定タブの「架空の名簿24人を入れる」で入れられます' : '名簿を読み込んでいます…') + '</span>';
  $('rList').querySelectorAll('[data-q]').forEach((c) => { c.onchange = () => { if (c.checked) S.sel[c.dataset.q] = 1; else delete S.sel[c.dataset.q]; updateQ(); }; });
  $('rNote').hidden = !list.length || !evOk;
  $('entryBox').hidden = !evOk;
  updateQ();
}
function updateQ() { const n = Object.keys(S.sel).length; $('qBar').hidden = !n; $('qAdd').textContent = 'チェックした' + n + '人を受付'; }

/* 同じ名前かもしれない人（運営が確かめたときだけまとめる） */
function dupGroups() {
  const rm = rosterById(), by = {};
  people().forEach((p) => { const k = norm(p.name); (by[k] = by[k] || []).push(p); });
  const out = [];
  Object.values(by).forEach((g) => {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = rm[g[i].id] || {}, b = rm[g[j].id] || {};
      if ((a.notSame && a.notSame[g[j].id]) || (b.notSame && b.notSame[g[i].id])) continue;
      out.push([g[i], g[j]]);
    }
  });
  return out;
}
function renderDup() {
  const ds = dupGroups();
  $('dupBox').hidden = !ds.length;
  if (!ds.length) return;
  const synced = serverState() === 'ok';
  $('dupList').innerHTML = ds.map((d, i) => {
    const can = synced && !d[0].pending && !d[1].pending;
    const who = (p) => esc(p.name) + '<small>（' + (p.isNew ? 'はじめて' : '名簿') + '・' + esc(p.devName || '') + ' ' + hm(p.tapAt) + '）</small>';
    return '<div class="subbox"><div>' + who(d[0]) + ' と ' + who(d[1]) + '</div>' +
      (can ? '<div class="actions"><button class="btn small primary" type="button" data-merge="' + i + '">同じ人なのでまとめる</button><button class="btn small" type="button" data-same="' + i + '">別の人</button></div>'
        : '<small class="muted">サーバーで確認できてから、まとめられます（' + (synced ? '保存待ちがあります' : '電波を確かめてください') + '）</small>') + '</div>';
  }).join('');
  $('dupList').querySelectorAll('[data-merge]').forEach((b) => { b.onclick = () => openMerge(ds[+b.dataset.merge]); });
  $('dupList').querySelectorAll('[data-same]').forEach((b) => { b.onclick = () => markDistinct(ds[+b.dataset.same]); });
}
function openMerge(pair) {
  /* 名簿にもともといた人・先に受付した人を残す */
  let [keep, drop] = pair;
  if ((keep.isNew && !drop.isNew) || (keep.isNew === drop.isNew && (drop.tapAt || 0) < (keep.tapAt || 0))) [keep, drop] = [drop, keep];
  const show = () => {
    $('sheet').innerHTML = '<h2 id="sheetTitle">同じ人としてまとめる</h2>' +
      '<p>残す方：<b>' + esc(keep.name) + '</b>（' + (keep.isNew ? 'はじめて' : '名簿') + '・' + esc(keep.devName || '') + ' ' + hm(keep.tapAt) + '）<br>' +
      'まとめて消す方：<b>' + esc(drop.name) + '</b>（' + (drop.isNew ? 'はじめて' : '名簿') + '・' + esc(drop.devName || '') + ' ' + hm(drop.tapAt) + '）</p>' +
      '<p class="muted">まとめたあと、消す方への受付がほかの端末から遅れて届いても、受け付けません（人数は増えません）。</p>' +
      '<div class="actions"><button class="btn primary" id="mgYes" type="button">まとめる</button><button class="btn small" id="mgSwap" type="button">残す方を入れ替える</button><button class="btn ghost" id="mgNo" type="button">やめる</button></div>';
    $('ov').hidden = false;
    $('mgNo').onclick = closeSheet;
    $('mgSwap').onclick = () => { [keep, drop] = [drop, keep]; show(); };
    $('mgYes').onclick = () => { closeSheet(); doMerge(keep, drop); };
  };
  show();
}
function doMerge(keep, drop) {
  if (needEvent()) return;
  const op = { id: rid('o'), type: 'merge', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: drop.id, name: drop.name }, { id: keep.id, name: keep.name }], tapAt: now() };
  const writes = [
    { op: 'update', path: ROOT + '/roster/' + drop.id, data: { mergedInto: keep.id, mergedAt: TS } },
    { op: 'delete', path: ROOT + '/events/' + S.cur + '/checkins/' + drop.rawId }
  ];
  if (keep.rawId !== keep.id || !S.checkins.some((c) => c.id === keep.id)) writes.push({ op: 'set', path: ROOT + '/events/' + S.cur + '/checkins/' + keep.id, data: { name: keep.name, isNew: !!keep.isNew, at: TS, tapAt: keep.tapAt || now(), dev: DEV, devName, batch: op.id, n: 1, op: op.id } });
  runOp(op, writes);
  toast(keep.name + ' さんにまとめました');
}
function markDistinct(pair) {
  const [a, b] = pair;
  const op = { id: rid('o'), type: 'distinct', eid: S.cur, ename: '', items: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], tapAt: now() };
  runOp(op, [{ op: 'update', path: ROOT + '/roster/' + a.id, data: { ['notSame.' + b.id]: true } }, { op: 'update', path: ROOT + '/roster/' + b.id, data: { ['notSame.' + a.id]: true } }]);
  toast('別の人として残しました');
}

function renderList() {
  const cs = people().sort((a, b) => (b.tapAt || 0) - (a.tapAt || 0));
  const rm = rosterById();
  const exN = cs.filter((c) => rm[c.id] && rm[c.id].exp).length;
  const outPend = unsent().filter((o) => o.type === 'out' && o.eid === S.cur);
  $('pCount').innerHTML = '<span class="stat">' + cs.length + '人</span><span class="stat">経験豊富 ' + exN + '</span>';
  $('plist').innerHTML = (cs.length ? cs.map((c) => {
    const r = rm[c.id] || {};
    const st = c.pending ? '<span class="st wait">送信待ち</span>' : '<span class="st ok">確認済み ' + hms(c.at) + '</span>';
    return '<li><button class="prow" data-c="' + esc(c.id) + '"><span class="pname">' + esc(c.name) + '</span>' +
      (c.isNew ? '<span class="tag cy">はじめて</span>' : '') + (r.exp ? '<span class="tag">経験豊富</span>' : '') + (r.early ? '<span class="tag early">早帰り</span>' : '') +
      (c.dev && c.dev !== DEV ? '<span class="by">' + esc(c.devName || '別の端末') + '</span>' : '') + st + '</button></li>';
  }).join('') : '<li class="muted">' + (S.sync.checkins && !S.sync.checkins.cache ? 'まだ誰も受付していません' : '受付を読み込んでいます…') + '</li>') +
    outPend.map((o) => '<li><div class="prow" style="opacity:.75"><span class="pname">' + esc(o.items[0].name) + '</span><span class="st wait">取消の送信待ち</span></div></li>').join('');
  $('plist').querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => openCheckin(b.dataset.c); });
}

/* 届かなかった操作（名前と内容つきで残す。送り直す・消すを選ぶ） */
function renderRejected() {
  const rj = rejected();
  $('rjBox').hidden = !rj.length;
  if (!rj.length) return;
  const label = { in: '受付', out: '受付の取消', merge: 'まとめ', distinct: '別の人の印' };
  $('rjList').innerHTML = rj.map((o) => '<div class="subbox"><div><b>' + esc(o.items.map((i) => i.name).join('・')) + '</b> の' + (label[o.type] || '操作') +
    '<br><small class="muted">' + esc(o.ename || '') + '・' + esc(o.devName || '') + ' ' + hms(o.tapAt) + '</small><br><small>' + esc(o.reason || '') + '</small></div>' +
    '<div class="actions">' + (o.type === 'in' ? '<button class="btn small primary" type="button" data-rs="' + esc(o.id) + '">いまの回で受付し直す</button>' : '') +
    '<button class="btn small ghost" type="button" data-rx="' + esc(o.id) + '">確かめたので消す</button></div></div>').join('');
  $('rjList').querySelectorAll('[data-rs]').forEach((b) => { b.onclick = () => resend(b.dataset.rs); });
  $('rjList').querySelectorAll('[data-rx]').forEach((b) => { b.onclick = () => { dropOp(b.dataset.rx); renderAll(); heartbeat(); }; });
}
function resend(id) {
  const o = S.ops.find((x) => x.id === id); if (!o || needEvent()) return;
  const rm = rosterById(), here = {}; people().forEach((p) => { here[p.id] = 1; });
  const items = o.items.map((it) => {
    const to = resolveId(it.id, rm);
    if (to !== it.id) return { id: to, name: (rm[to] || {}).name || it.name };
    return rm[it.id] ? { id: it.id, name: it.name } : it; // 名簿に入らなかった新しい人は、もう一度名簿ごと作る
  }).filter((it) => !here[it.id]);
  dropOp(id);
  if (items.length) doCheckin(items, items.some((i) => i.isNew) ? 'new' : 'tap'); else toast('もう受付済みでした');
  renderAll();
}

/* 受付の取り消し */
function openCheckin(id) {
  const c = people().find((x) => x.id === id); if (!c) return;
  $('sheet').innerHTML = '<h2 id="sheetTitle">' + esc(c.name) + 'さん</h2>' +
    '<p>' + (c.pending ? 'まだ送信待ちです。電波が戻れば自動で送られます。' : esc(hms(c.at)) + 'に' + esc(c.devName || '') + 'で受付済み（サーバーで確認済み）。') + '</p>' +
    '<div class="actions"><button class="btn primary" id="cxYes" type="button">受付を取り消す</button><button class="btn ghost" id="cxNo" type="button">閉じる</button></div>';
  $('ov').hidden = false;
  $('cxNo').onclick = closeSheet;
  $('cxYes').onclick = () => {
    closeSheet();
    if (needEvent()) return;
    const raws = S.checkins.filter((x) => resolveId(x.id, rosterById()) === c.id).map((x) => x.id);
    const op = { id: rid('o'), type: 'out', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: c.id, name: c.name }], tapAt: now() };
    runOp(op, raws.map((r) => ({ op: 'delete', path: ROOT + '/events/' + S.cur + '/checkins/' + r })));
    toast(c.name + ' さんの受付を取り消しました（送信待ち）');
  };
}
function closeSheet() { $('ov').hidden = true; }
$('ov').addEventListener('click', (e) => { if (e.target === $('ov')) closeSheet(); });

/* ===== 開催回 ===== */
function renderEventBox() {
  const ev = S.events[S.cur];
  const list = Object.keys(S.events).map((k) => ({ id: k, ...S.events[k] })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
  $('evNow').innerHTML = ev ? 'いまの回：<b>' + esc(ev.name) + '</b>（' + (ev.status === 'open' ? '受付中' : '締め済み') + '）' : 'いまの回：まだありません';
  $('evList').innerHTML = list.map((e) => '<li>' + esc(e.name) + '・' + (e.status === 'open' ? '受付中' : '締め済み ' + hm(e.closedAt)) + '</li>').join('');
}
function openNewEvent() {
  const un = unsent().length, synced = serverState() === 'ok';
  const others = S.devices.filter((d) => d.id !== DEV);
  const worry = others.filter((d) => (d.pending || 0) > 0 || !d.at || srvNow() - d.at > STALE_MS);
  const cur = S.events[S.cur];
  const ok = synced && !un;
  $('sheet').innerHTML = '<h2 id="sheetTitle">' + (cur ? '新しい回を始める' : '最初の回を始める') + '</h2>' +
    (cur ? '<p>いまの回「' + esc(cur.name) + '」を締めて、新しい回を始めます。締めた回への受付・取消は、あとで圏外の端末から届いても受け付けません（その端末に「届かなかった操作」として名前つきで残ります）。</p>' : '<p>受付は開催回ごとに分けて保存します。</p>') +
    (worry.length ? '<p class="err">' + esc(worry.map((d) => d.name + (d.pending ? 'に送信待ち' + d.pending + '件' : 'と' + ago(srvNow() - (d.at || 0)) + 'から連絡なし')).join('／')) + '。締める前にその端末の電波を確かめてください。</p>' : '') +
    (!ok ? '<p class="err">' + (un ? 'この端末に送信待ちがあります。届いてから始めてください。' : 'サーバーで確認できていません。電波を確かめてください。') + '</p>' : '') +
    '<div class="field"><label for="evNameIn">回の名前</label><input class="input" id="evNameIn" maxlength="30" value="' + esc(defaultEventName()) + '"></div>' +
    '<div class="actions"><button class="btn primary" id="evYes" type="button"' + (ok ? '' : ' disabled') + '>始める</button><button class="btn ghost" id="evNo" type="button">やめる</button></div>';
  $('ov').hidden = false;
  $('evNo').onclick = closeSheet;
  $('evYes').onclick = () => {
    const name = $('evNameIn').value.trim() || defaultEventName();
    const d = new Date(), e = 'e' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + Math.random().toString(36).slice(2, 6);
    const writes = [];
    if (cur && cur.status === 'open') writes.push({ op: 'update', path: ROOT + '/events/' + S.cur, data: { status: 'closed', closedAt: TS } });
    writes.push({ op: 'set', path: ROOT + '/events/' + e, data: { name, status: 'open', createdAt: TS } });
    writes.push({ op: 'merge', path: ROOT, data: { currentEvent: e, updatedAt: TS } });
    closeSheet();
    B.commit(writes).then(() => toast('「' + name + '」を始めました'), (err) => toast('始められませんでした（' + ((err && err.code) || '') + '）', true));
  };
}
function defaultEventName() { const d = new Date(); return (d.getMonth() + 1) + '/' + d.getDate() + ' 第' + (Object.keys(S.events).length + 1) + '回（テスト）'; }
$('evNew').onclick = openNewEvent;

/* ===== タブ ===== */
function showPhase(ph) {
  S.phase = ph; ls.set('phase', ph);
  $('ph-entry').hidden = ph !== 'entry';
  $('ph-set').hidden = ph !== 'set';
  $('ph-other').hidden = ph === 'entry' || ph === 'set';
  $('otherH').textContent = { team: 'チーム', game: '試合', rec: '記録' }[ph] || '';
  document.querySelectorAll('.nb').forEach((b) => b.setAttribute('aria-current', b.dataset.ph === ph ? 'page' : 'false'));
  window.scrollTo(0, 0);
}
document.querySelectorAll('.nb').forEach((b) => { b.onclick = () => showPhase(b.dataset.ph); });

/* ===== 計測 ===== */
function stats(arr) {
  const v = arr.filter((x) => x != null && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, med: v[Math.floor((v.length - 1) / 2)], max: v[v.length - 1] };
}
function renderMetrics() {
  const ms = S.metrics;
  $('clockLine').textContent = S.mode !== 'fire' ? '練習モードでは、通信の時間はまねをした値です。'
    : S.offset == null ? '時計を合わせられていません（電波を確かめて「時計を合わせ直す」）。「もう1台」の時間は合わせてから測れます。'
    : 'この端末の時計合わせ：誤差 ±' + Math.round(S.rtt / 2) + 'ms 以内';
  const taps = ms.filter((m) => m.kind === 'tap' || m.kind === 'new'), seens = ms.filter((m) => m.kind === 'seen');
  const fails = taps.filter((m) => m.ok === false).length;
  const box = (title, st, note) => '<div class="sum"><b>' + title + '</b>' + (st ? '<span class="v">' + sec(st.med) + '</span><small>ふつう（中央値）・いちばん遅い ' + sec(st.max) + '・' + st.n + '回</small>' : '<span class="v">—</span><small>' + note + '</small>') + '</div>';
  $('mSum').innerHTML = box('画面が次の入力を受け付けるまで', stats(taps.map((m) => num(m.readyMs))), 'まだ記録がありません') +
    box('保存確定（届いたもの）', stats(taps.filter((m) => m.ok !== false).map((m) => num(m.saveMs))), 'まだ記録がありません') +
    box('もう1台に出る', stats(seens.map((m) => num(m.seenFromTap))), 'もう1台で受付タブを開いておくと記録されます') +
    '<div class="sum"><b>届かなかった受付</b><span class="v">' + fails + '回</span><small>断られた・届かなかった受付の数</small></div>';
  $('mBody').innerHTML = ms.slice(0, 40).map((m) => '<tr><td>' + esc(m.devName || '') + '・' + (m.kind === 'seen' ? '見えた' : m.kind === 'new' ? 'はじめて' : '受付') + (m.ok === false ? '（届かず）' : '') + '<br><small class="muted">' + hms(num(m.tapAt)) + '</small></td><td>' + esc(num(m.n) || '') + '</td><td>' +
    (m.kind === 'seen' ? '' : sec(num(m.readyMs))) + '</td><td>' + (m.kind === 'seen' ? '' : sec(num(m.saveMs))) + '</td><td>' + (m.kind === 'seen' ? sec(num(m.seenFromTap)) : '') + '</td></tr>').join('')
    || '<tr><td colspan="5" class="muted">まだ記録がありません</td></tr>';
  const head = 'time,device,kind,ok,people,next_ms,save_ms,seen_from_tap_ms,seen_from_save_ms,from,code';
  $('csv').value = '月いちモルック 受付の試作 計測結果（版 ' + VER + '・' + (S.mode === 'fire' ? 'Firebase' : '練習モード') + '）\n' + head + '\n' +
    ms.slice().reverse().map((m) => [new Date(num(m.tapAt) || 0).toISOString(), m.devName, m.kind, m.ok === false ? 'NG' : 'OK', num(m.n), num(m.readyMs), num(m.saveMs), num(m.seenFromTap), num(m.seenFromSave), m.from, m.code].map((x) => x == null ? '' : String(x).replace(/[,\n]/g, ' ')).join(',')).join('\n') +
    '\n\n# この端末の操作の記録\n' + S.ops.map((o) => [new Date(o.tapAt).toISOString(), o.devName, o.type, o.state, o.items.map((i) => i.name).join('/'), o.ename, o.reason || ''].join(',')).join('\n');
}
$('syncBtn').onclick = clockSync;
$('csvCopy').onclick = () => {
  renderMetrics();
  const ta = $('csv'), done = () => toast('計測結果をコピーしました');
  const fb = () => { ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} toast(ok ? '計測結果をコピーしました' : '全文を選択しました。コピーしてください', !ok); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, fb); else fb();
};
$('devSave').onclick = () => { const v = $('devName').value.trim().slice(0, 12); if (!v) return; devName = v; ls.set('devName', v); hbLast = ''; heartbeat(); toast('この端末を「' + v + '」にしました'); };

/* ===== ルールの確認（本物のサーバーで、断るべき書き込みが断られるかを試す。別の箱 staff/selftest を使う） ===== */
$('selfBtn').onclick = async () => {
  const out = $('selfOut'); out.innerHTML = '<li>確かめています…</li>';
  const R = 'staff/selftest', t = rid('t'), res = [];
  const tryW = async (label, writes, expectOk) => {
    try { await B.commit(writes); res.push([label, expectOk, expectOk ? '書けた' : '書けてしまった']); }
    catch (e) { res.push([label, !expectOk, expectOk ? '断られた（' + (e && e.code) + '）' : '断られた']); }
  };
  try {
    const eo = 'eo' + t, ec = 'ec' + t;
    await tryW('開いた回を作る', [{ op: 'set', path: R + '/events/' + eo, data: { name: 'test', status: 'open', createdAt: TS } }, { op: 'set', path: R + '/events/' + ec, data: { name: 'test', status: 'open', createdAt: TS } }, { op: 'set', path: R + '/roster/a' + t, data: { name: 'A' } }, { op: 'set', path: R + '/roster/b' + t, data: { name: 'B' } }], true);
    await tryW('開いた回に受付する', [{ op: 'set', path: R + '/events/' + eo + '/checkins/a' + t, data: { name: 'A' } }], true);
    await tryW('回を締める', [{ op: 'update', path: R + '/events/' + ec, data: { status: 'closed' } }], true);
    await tryW('締めた回に受付する（断られるはず）', [{ op: 'set', path: R + '/events/' + ec + '/checkins/a' + t, data: { name: 'A' } }], false);
    await tryW('締めた回で取り消す（断られるはず）', [{ op: 'delete', path: R + '/events/' + ec + '/checkins/a' + t }], false);
    await tryW('締めた回を開け直す（断られるはず）', [{ op: 'update', path: R + '/events/' + ec, data: { status: 'open' } }], false);
    await tryW('BをAにまとめる', [{ op: 'update', path: R + '/roster/b' + t, data: { mergedInto: 'a' + t } }], true);
    await tryW('まとめたBに受付する（断られるはず）', [{ op: 'set', path: R + '/events/' + eo + '/checkins/b' + t, data: { name: 'B' } }], false);
    await tryW('名簿にない人だけの受付（断られるはず）', [{ op: 'set', path: R + '/events/' + eo + '/checkins/zz' + t, data: { name: 'Z' } }], false);
    await tryW('操作の記録を書く', [{ op: 'set', path: R + '/events/' + eo + '/ops/o' + t, data: { x: 1 } }], true);
    await tryW('操作の記録を書き換える（断られるはず）', [{ op: 'set', path: R + '/events/' + eo + '/ops/o' + t, data: { x: 2 } }], false);
    await tryW('名簿を消す（断られるはず）', [{ op: 'delete', path: R + '/roster/a' + t }], false);
    if (B.anonRead) {
      const a = await B.anonRead();
      if (a) {
        res.push(['ログインなしで運営の名簿を読む（断られるはず）', a.staff !== 'read', a.staff === 'read' ? '読めてしまった' : '断られた']);
        res.push(['ログインなしで公開データを読む', a.pub === 'read', a.pub === 'read' ? '読めた' : '読めない（' + a.pub + '）']);
        res.push(['ログインなしで公開データに書く（断られるはず）', a.pubWrite !== 'written', a.pubWrite === 'written' ? '書けてしまった' : '断られた']);
      }
    }
  } catch (e) { res.push(['途中で止まりました', false, (e && e.code) || String(e)]); }
  const ng = res.filter((r) => !r[1]).length;
  out.innerHTML = res.map((r) => '<li>' + (r[1] ? '✓ ' : '✗ ') + esc(r[0]) + '：' + esc(r[2]) + '</li>').join('') + '<li><b>' + (ng ? '合わないものが ' + ng + ' 件あります' : 'すべて想定どおりです') + '</b></li>';
};

/* ===== テスト用 ===== */
$('seedBtn').onclick = () => {
  if (S.roster.filter((r) => /^r\d\d$/.test(r.id)).length >= FAKE.length) { toast('架空の名簿はもう入っています'); return; }
  B.commit(FAKE.map((n, i) => ({ op: 'set', path: ROOT + '/roster/r' + pad(i + 1), data: { name: n, norm: norm(n), exp: i % 4 === 0, early: i % 9 === 5, pair: '', createdAt: TS } })))
    .then(() => toast('架空の名簿24人を入れました'), (e) => toast('入れられませんでした（' + ((e && e.code) || '') + '）', true));
};
$('demoOffline').onchange = () => { if (B && B.setOffline) B.setOffline($('demoOffline').checked); renderBar(); };
$('logout').onclick = async () => { try { await B.logout(); } catch (e) {} ls.set('mode', ''); location.reload(); };
/* この端末からデータを消す：送信待ち・届かなかった操作があるあいだは消さない */
$('wipeBtn').onclick = async () => {
  const msg = $('wipeMsg');
  if (unsent().length) { msg.textContent = 'この端末に送信待ちが ' + unsent().length + ' 件あります。電波の良い場所で届くのを待ってから消してください。'; return; }
  if (rejected().length) { msg.textContent = '届かなかった操作が ' + rejected().length + ' 件あります。受付タブで確かめて「消す」か「受付し直す」をしてからにしてください。'; return; }
  msg.textContent = 'サーバーに全部届いているか確かめています…';
  const ok = await Promise.race([B.waitPending().then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))]);
  if (!ok || serverState() !== 'ok') { msg.textContent = 'サーバーで確認できませんでした。電波の良い場所でもう一度押してください。'; return; }
  $('sheet').innerHTML = '<h2 id="sheetTitle">この端末からデータを消す</h2><p>送信待ちは0件で、サーバーに全部届いています。この端末に残っている名簿・受付の写しと、運営モードのログインを消します。サーバーのデータは消えません。</p>' +
    '<div class="actions"><button class="btn primary" id="wpYes" type="button">消す</button><button class="btn ghost" id="wpNo" type="button">やめる</button></div>';
  $('ov').hidden = false; $('wpNo').onclick = closeSheet;
  $('wpYes').onclick = async () => {
    if (unsent().length) { closeSheet(); msg.textContent = '送信待ちができたので、消すのをやめました。'; return; }
    try { await B.clearLocal(); } catch (e) {}
    try { IDB.db && IDB.db.close(); indexedDB.deleteDatabase('tk_ops'); } catch (e) {}
    ls.del(OPS_KEY); ls.del(OPS_KEY + '_gone'); ls.del('mode'); ls.del('phase'); location.reload();
  };
};
window.addEventListener('online', () => { renderBar(); verifyOps(); });
window.addEventListener('offline', renderBar);
window.addEventListener('beforeunload', (e) => { if (unsent().length && (!B || !B.persistent)) { e.preventDefault(); e.returnValue = ''; } });
window.__tk = { S, unsent, rejected, people, dupGroups };

boot();
