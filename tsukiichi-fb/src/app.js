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
const CHUNK = 8; // 1回のまとめ書きで受付する人数。ルールの参照（1人2回＋記録1回）が上限20回に収まるように
const STALE_MS = 150000;

/* ===== 書き込みの組み立て（アプリと「ルールの確認」の両方で同じものを使う） ===== */
const W = {
  opDoc(root, op) { return { op: 'set', path: root + '/events/' + op.eid + '/ops/' + op.id, data: { type: op.type, names: op.items.map((i) => i.name), ids: op.items.map((i) => i.id), dev: DEV, devName, tapAt: op.tapAt, at: TS } }; },
  checkin(root, eid, items, opId, tapAt, tapSrv) {
    const w = [];
    items.forEach((it) => {
      if (it.isNew) w.push({ op: 'set', path: root + '/roster/' + it.id, data: { name: it.name, norm: norm(it.name), exp: !!it.exp, early: !!it.early, pair: it.pair || '', createdAt: TS, createdIn: eid } });
      w.push({ op: 'set', path: root + '/events/' + eid + '/checkins/' + it.id, data: { name: it.name, isNew: !!it.isNew, at: TS, tapAt, tapSrv: tapSrv == null ? null : tapSrv, dev: DEV, devName, batch: opId, n: items.length, op: opId } });
    });
    return w;
  },
  cancel(root, eid, rawIds) { return rawIds.map((r) => ({ op: 'delete', path: root + '/events/' + eid + '/checkins/' + r })); },
  merge(root, eid, keep, drop, opId, needKeepCheckin, tapAt) {
    const w = [
      { op: 'update', path: root + '/roster/' + drop.id, data: { mergedInto: keep.id, mergedAt: TS } },
      { op: 'delete', path: root + '/events/' + eid + '/checkins/' + (drop.rawId || drop.id) }
    ];
    if (needKeepCheckin) w.push({ op: 'set', path: root + '/events/' + eid + '/checkins/' + keep.id, data: { name: keep.name, isNew: !!keep.isNew, at: TS, tapAt: keep.tapAt || tapAt, dev: DEV, devName, batch: opId, n: 1, op: opId } });
    return w;
  },
  distinct(root, a, b) { return [{ op: 'update', path: root + '/roster/' + a.id, data: { ['notSame.' + b.id]: true } }, { op: 'update', path: root + '/roster/' + b.id, data: { ['notSame.' + a.id]: true } }]; },
  newEvent(root, curId, curOpen, newId, name) {
    const w = [];
    if (curId && curOpen) w.push({ op: 'update', path: root + '/events/' + curId, data: { status: 'closed', closedAt: TS } });
    w.push({ op: 'set', path: root + '/events/' + newId, data: { name, status: 'open', createdAt: TS } });
    /* prevEvent：押した端末が見ていた「いまの回」。ルールでサーバーの値と同じときだけ通す（2台が同時に始めても1つだけ） */
    w.push({ op: 'merge', path: root, data: { currentEvent: newId, prevEvent: curId || '', updatedAt: TS } });
    return w;
  }
};
const chunks = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };

/* ===== Firestore のルール（運営アカウントの番号＝UIDで判定）。設定タブでUID入りの全文をコピーできる ===== */
const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 運営アカウント（UIDで判定）
    function isStaff() {
      return request.auth != null && request.auth.uid == '__UID__';
    }
    function pathOf(box, coll, id) {
      return /databases/$(database)/documents/staff/$(box)/$(coll)/$(id);
    }
    // 開催回が開いているか（参照1回。回がなければ断る）
    function isOpen(box, e) {
      return getAfter(pathOf(box, 'events', e)).data.status == 'open';
    }
    // 名簿にいて、まとめられていない人か（参照1回。名簿になければ断る）
    function notMerged(box, rid) {
      return getAfter(pathOf(box, 'roster', rid)).data.get('mergedInto', '') == '';
    }
    match /public/{path=**} {
      allow read: if true;
      allow write: if isStaff();
    }
    // いまの回を変えられるのは、押した端末が見ていた回（prevEvent）がサーバーと同じときだけ
    match /staff/{box} {
      allow read: if isStaff();
      allow create: if isStaff() && request.resource.data.get('prevEvent', '') == ''
        && isOpen(box, request.resource.data.currentEvent);
      allow update: if isStaff()
        && request.resource.data.get('prevEvent', '') == resource.data.get('currentEvent', '')
        && request.resource.data.currentEvent != resource.data.get('currentEvent', '')
        && isOpen(box, request.resource.data.currentEvent)
        && (resource.data.get('currentEvent', '') == ''
          || getAfter(pathOf(box, 'events', resource.data.currentEvent)).data.status == 'closed');
    }
    match /staff/{box}/roster/{rid} {
      allow read: if isStaff();
      allow create: if isStaff() && request.resource.data.get('mergedInto', '') == '';
      // まとめた人は二度と変えない。まとめる先は、自分以外の、まとめられていない人だけ
      allow update: if isStaff()
        && resource.data.get('mergedInto', '') == ''
        && (request.resource.data.get('mergedInto', '') == ''
          || (request.resource.data.mergedInto != rid
            && notMerged(box, request.resource.data.mergedInto)));
    }
    match /staff/{box}/events/{e} {
      allow read: if isStaff();
      // 回を作れるのは、同じまとめ書きで「いまの回」をその回にするときだけ（開いている回は1つ）
      allow create: if isStaff() && request.resource.data.status == 'open'
        && getAfter(/databases/$(database)/documents/staff/$(box)).data.currentEvent == e;
      // 締めた回は開け直さない
      allow update: if isStaff() && resource.data.status == 'open';
    }
    match /staff/{box}/events/{e}/checkins/{rid} {
      allow read: if isStaff();
      allow create, update: if isStaff() && isOpen(box, e) && notMerged(box, rid);
      allow delete: if isStaff() && isOpen(box, e);
    }
    match /staff/{box}/events/{e}/ops/{op} {
      allow read: if isStaff();
      allow create: if isStaff() && isOpen(box, e);
    }
    match /staff/{box}/events/{e}/devices/{d} {
      allow read, create, update: if isStaff();
    }
    match /staff/{box}/metrics/{m} {
      allow read, write: if isStaff();
    }
    match /staff/{box}/ping/{p} {
      allow read, write: if isStaff();
    }
  }
}
`;

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
  sel: {}, phase: 'entry', offset: null, rtt: null, firstSnap: true, seen: {}, ops: [], verifying: false,
  lastServer: null, liveServer: false // サーバーで確認できた人数と、その時刻（いつも組で持つ）
};
let B = null;
let unsubCur = [];

function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', !!bad); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, bad ? 4500 : 2200);
}

/* ===== 操作の記録（この端末に残す。届くまで「送信待ち」、断られたら名前つきで残す） ===== */
/* 操作の記録は、本番（fire）・練習（demo）・自動試験（test）で別々の場所に置く。練習で消しても本番の記録は残る */
let OPS_KEY = 'ops_' + BOX + '_none', IDB_NAME = 'tk_ops_none';
/* 操作の記録は IndexedDB（Firestore と同じく閉じても残りやすい保存先）と localStorage の両方に置き、開くときに合わせる */
const IDB = {
  db: null,
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open(IDB_NAME, 1);
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
async function loadOps(mode) {
  OPS_KEY = 'ops_' + BOX + '_' + mode; IDB_NAME = 'tk_ops_' + mode;
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
  writes.push(W.opDoc(ROOT, op));
  S.ops.push(op); saveOps(); refreshConfirmedCount();
  const p = B.commit(writes);
  p.then(() => { op.state = 'done'; op.doneAt = now(); saveOps(); refreshConfirmedCount(); renderAll(); heartbeat(); },
    (err) => { markRejected(op, err && err.code); });
  renderAll(); heartbeat();
  return p;
}
async function markRejected(op, code) {
  op.state = 'rejected'; op.code = code || 'error'; op.reason = '確かめています…'; saveOps(); refreshConfirmedCount(); renderAll(); heartbeat();
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
    if (op.type === 'merge') {
      const [drop, keep] = op.items;
      const rd = await B.getServer(ROOT + '/roster/' + drop.id), rk = await B.getServer(ROOT + '/roster/' + keep.id);
      if (rd && rd.mergedInto) return '「' + drop.name + '」さんは、すでに別の端末でまとめられていました';
      if (rk && rk.mergedInto) return '残す方の「' + keep.name + '」さんが、別の端末でまとめられていました（逆向きのまとめを防ぐため断られました）';
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
  S.verifying = false; refreshConfirmedCount(); renderAll(); heartbeat();
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
      return F.onSnapshot(F.collection(db, path), { includeMetadataChanges: true }, (s) => cb(docs(s), s.metadata.fromCache, s.docChanges().filter((c) => c.type !== 'removed').map((c) => c.doc.id), s.metadata.hasPendingWrites), err);
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
    async confirmedCount(eid) {
      const result = await F.getCountFromServer(F.collection(db, ROOT + '/events/' + eid + '/checkins'));
      return result.data().count;
    },
    waitPending() { return F.waitForPendingWrites(db); },
    uid() { return auth.currentUser ? auth.currentUser.uid : ''; },
    email() { return auth.currentUser ? auth.currentUser.email : ''; },
    /* 端末の写しを消す。消せたかは呼んだ側で IndexedDB の一覧を見て確かめる */
    async clearLocal() { await U.signOut(auth); await F.terminate(db); await F.clearIndexedDbPersistence(db); return ['firestore/']; },
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
      const r = indexedDB.open('tk_fake_' + (URL0 ? 'test' : 'demo'), 1);
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
        const hasPend = Object.keys(v.pend).some((k) => k.indexOf(s.path + '/') === 0 && k.split('/').length === depth);
        const sig = JSON.stringify(list) + fromCache + hasPend;
        if (lastSig[s.key] === sig) return;
        const prev = s.prev || {}; s.prev = {}; list.forEach((d) => { s.prev[d.id] = JSON.stringify(d); });
        lastSig[s.key] = sig;
        s.cb(list, fromCache, list.filter((d) => prev[d.id] !== s.prev[d.id]).map((d) => d.id), hasPend);
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
    uid() { return ''; },
    async clearLocal() { clearInterval(timer); try { kv && kv.close(); } catch (e) {} const n = 'tk_fake_' + (URL0 ? 'test' : 'demo'); await idbDelete(n); return [n]; },
    ping() { return Promise.resolve({ offset: 0, rtt: 0 }); },
    anonRead() { return Promise.resolve(null); }
  };
}

/* ===== 起動・ログイン（起動中の選択は1つに確定し、古い処理の結果は使わない） ===== */
let bootToken = 0;
async function boot() {
  let wiped = '';
  try { wiped = sessionStorage.getItem('tk_wiped') || ''; if (wiped) sessionStorage.removeItem('tk_wiped'); } catch (e) {}
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
  /* 消したあとは自動では入らない。消えたことを画面で知らせる */
  if (wiped) { $('lockErr').classList.add('okmsg'); $('lockErr').textContent = wiped === 'ok' ? 'この端末のデータを消しました（消えたことを確かめました）' : 'この端末のデータを消しました（このブラウザでは一覧で確かめられませんでした）'; return; }
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

async function enter(mode) {
  if (S.mode) return;
  S.mode = mode; if (mode === 'fire') ls.set('mode', mode);
  await loadOps(mode);
  $('lock').hidden = true; $('app').hidden = false; $('bnav').hidden = false;
  $('demoNet').hidden = mode !== 'demo';
  $('anonRow').hidden = mode !== 'fire';
  $('modeLine').textContent = mode === 'fire' ? 'つながっている受付（2台で共有）' + (B.persistent ? '' : '・この端末は送信待ちを画面を閉じると失います')
    : mode === 'demo' ? '練習モード（この端末の中だけ。ほかの端末とはつながりません）' : '自動試験';
  $('devName').value = devName;
  const onErr = (key) => (err) => { S.sync[key] = { cache: true, err: (err && err.code) || 'error', at: S.sync[key] && S.sync[key].at }; renderAll(); };
  const mark = (key, fromCache) => { S.sync[key] = { cache: fromCache, at: fromCache ? (S.sync[key] && S.sync[key].at) : now() }; };
  B.subDoc(ROOT, (d, fc) => {
    mark('box', fc); const cur = (d && d.currentEvent) || '';
    if (cur !== S.cur) {
      switchEvent(cur);
      /* 回を始める画面を開いている間に、ほかの端末が回を変えたら止める */
      if (newEvSheet && !$('ov').hidden && newEvSheet.cur !== cur) { closeSheet(); newEvSheet = null; toast('ほかの端末で回が変わりました。いまの回を表示します', true); }
    }
    renderAll();
  }, onErr('box'));
  B.sub(ROOT + '/events', (list, fc) => { mark('events', fc); S.events = {}; list.forEach((d) => { S.events[d.id] = d.data; }); renderAll(); }, onErr('events'));
  B.sub(ROOT + '/roster', (list, fc) => { mark('roster', fc); S.roster = list.map((d) => ({ id: d.id, ...d.data, pending: d.pending })); renderAll(); }, onErr('roster'));
  B.subMetrics((m) => { S.metrics = m; renderMetrics(); });
  clockSync();
  renderRules();
  if (realUid()) refreshLegacy().catch(() => {});
  showPhase(ls.get('phase', 'entry'));
  renderAll();
  setInterval(() => { verifyOps(); heartbeat(); renderBar(); }, 15000);
  setTimeout(verifyOps, 500);
}
let countVersion = 0, countTimer;
function refreshConfirmedCount() {
  if (!B?.confirmedCount) return;
  const version = ++countVersion, eid = S.cur;
  clearTimeout(countTimer);
  S.liveServer = false;
  if (!eid || !S.sync.checkins || S.sync.checkins.cache || unsent().some(op => op.eid === eid)) return;
  countTimer = setTimeout(async () => {
    try {
      const count = await B.confirmedCount(eid);
      if (version !== countVersion || eid !== S.cur) return;
      S.lastServer = { count, at: now() };
      S.liveServer = count === people().length;
      renderBar();
    } catch { /* 最後に成功した確認時刻・人数を残す。次の受付または再接続で再確認する。 */ }
  }, 150);
}
function switchEvent(cur) {
  unsubCur.forEach((f) => f()); unsubCur = [];
  S.cur = cur; S.checkins = []; S.devices = []; S.sync.checkins = null; S.firstSnap = true; S.seen = {}; S.sel = {}; S.lastServer = null; S.liveServer = false;
  if (!cur) return;
  const onErr = (err) => { S.sync.checkins = { cache: true, err: (err && err.code) || 'error' }; renderAll(); };
  unsubCur.push(B.sub(ROOT + '/events/' + cur + '/checkins', (list, fc, changed, hasPend) => {
    S.sync.checkins = { cache: fc, at: fc ? (S.sync.checkins && S.sync.checkins.at) : now() };
    onCheckins(list.map((d) => ({ id: d.id, ...d.data, pending: d.pending })), changed);
    /* サーバーの人数は、サーバーから届いた最新の姿で、この端末の送信待ちが混ざっていないときだけ更新し、時刻と組で持つ */
    if (B.confirmedCount) refreshConfirmedCount();
    else {
      S.liveServer = !fc && !hasPend;
      if (S.liveServer) S.lastServer = { count: people().length, at: now() };
    }
    renderAll();
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); verifyOps(); refreshConfirmedCount(); } });

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
  const tapSrv = S.offset == null ? null : Math.round(tapAt + S.offset);
  let ready = null;
  requestAnimationFrame(() => { ready = performance.now() - t0; });
  /* 人数が多いときは CHUNK 人ずつ別の操作として送る（ルールの参照上限を超えないように。結果も人ごとに残る） */
  chunks(items, CHUNK).forEach((part) => {
    const op = { id: rid('o'), type: 'in', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: part, tapAt };
    part.forEach((it) => { S.seen[it.id] = 1; });
    const p = runOp(op, W.checkin(ROOT, S.cur, part, op.id, tapAt, tapSrv));
    const fin = (ok, code) => metric({ id: 'tap_' + op.id, kind: type, n: part.length, tapAt, readyMs: ready == null ? null : Math.round(ready), saveMs: now() - tapAt, ok, code: code || '' });
    p.then(() => fin(true), (e) => fin(false, e && e.code));
  });
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
function renderAll() { renderBar(); renderEventGate(); renderRoster(); renderDup(); renderList(); renderRejected(); renderPills(); renderEventBox(); if (S.phase === 'team' && !teamEditing()) renderTeam(); }
/* 入力中（目印・チーム名）は書き換えない */
function teamEditing() { const a = document.activeElement; return !!(a && a.closest && a.closest('#ph-team') && /INPUT|SELECT/.test(a.tagName)); }

function serverState() {
  const s = S.sync;
  if (!S.cur) return s.box && !s.box.cache ? 'ok' : 'wait';
  const c = s.checkins;
  if (!c) return 'wait';
  if (c.err) return 'err';
  return c.cache || !s.roster || s.roster.cache ? 'cache' : 'ok';
}
/* 各端末が最後に報告した時刻と件数（それより後のことは分からない、という前提で出す） */
function devReports() {
  return S.devices.slice().sort((a, b) => (a.id === DEV ? -1 : b.id === DEV ? 1 : 0)).map((d) =>
    (d.id === DEV ? d.name + '（この端末）' : d.name) + '：' + (d.at ? hms(d.at) + '（' + ago(srvNow() - d.at) + '）の報告で送信待ち' + (d.pending || 0) + '件' + (d.rejected ? '・届かなかった' + d.rejected + '件' : '') : '報告なし'));
}
function renderBar() {
  if (!S.mode) return;
  const un = unsent(), rj = rejected().length;
  const demoOff = B && B.isOffline && B.isOffline();
  const st = serverState();
  const online = S.mode === 'fire' ? navigator.onLine && st === 'ok' : !demoOff && st === 'ok';
  const shown = people().length;
  const kinds = { in: 0, out: 0, merge: 0, distinct: 0 }; un.forEach((o) => { kinds[o.type] = (kinds[o.type] || 0) + 1; });
  const kindText = [['in', '受付'], ['out', '取消'], ['merge', 'まとめ'], ['distinct', '別の人の印'], ['edit', '設定'], ['draw', 'チーム']].filter((k) => kinds[k[0]]).map((k) => k[1] + kinds[k[0]] + '件').join('・');
  const LS = S.lastServer;
  /* 1行目：この端末 */
  const mine = rj ? ['off', '届かなかった操作 ' + rj + '件', '受付タブのいちばん上で確かめてください。この端末の表示 ' + shown + '人']
    : un.length ? [online ? 'wait' : 'off', 'この端末の表示 ' + shown + '人・送信待ち ' + un.length + '件', kindText + (online ? '。送っています…' : '。電波なし。この端末に残っています。電波が戻れば自動で送ります')]
    : ['ok', 'この端末の表示 ' + shown + '人・送信待ち 0件', 'この端末で押した操作は、すべてサーバーに届いています'];
  /* 2行目：サーバー（人数と確認時刻はいつも組で出す） */
  const srv = !S.cur ? ['info', st === 'ok' ? 'サーバーにつながっています' : 'サーバーを確認中…', '開催回がまだありません']
    : st === 'err' ? ['off', 'サーバーの受付を読めません', '（' + S.sync.checkins.err + '）' + (LS ? '最後に確認できた受付 ' + LS.count + '人（' + hms(LS.at) + '）' : '')]
    : !LS ? ['wait', 'サーバーの受付人数を確認中…', '']
    : ['' + (S.liveServer ? 'ok' : 'wait'), '最後にサーバーで確認できた受付 ' + LS.count + '人', hms(LS.at) + ' 時点' + (S.liveServer && LS.count === shown ? '（いまの表示と同じ）' : un.length ? '。この端末の送信待ちが届くと変わります' : st === 'cache' ? '。電波なしのため、その後の変化は分かりません' : '')];
  /* 3行目：各端末の最後の報告（全員分の確定とは言わない） */
  const reps = devReports();
  const others = S.devices.filter((d) => d.id !== DEV);
  const anyOther = others.some((d) => (d.pending || 0) > 0 || (d.rejected || 0) > 0 || !d.at || srvNow() - d.at > STALE_MS);
  const all = [others.length ? (anyOther ? 'wait' : 'info') : 'info', others.length ? '各端末の最後の報告' : 'この回に報告しているのはこの端末だけです',
    (reps.join('／') || '') + '。抽選の前に、使ったすべての端末の画面で送信待ち0件を確かめてください'];
  const row = (r) => '<div class="sb-row ' + r[0] + '"><span class="big"><span class="dot"></span>' + esc(r[1]) + '</span>' + (r[2] ? '<span class="sub">' + esc(r[2]) + '</span>' : '') + '</div>';
  const short = !S.cur ? (st === 'ok' ? '開催回なし' : 'サーバー確認中') : LS ? 'サーバー ' + LS.count + '人（' + hm(LS.at) + '）' : 'サーバー確認中';
  $('saveBar').innerHTML = '<div class="sb-row ' + (rj ? 'off' : un.length ? (online ? 'wait' : 'off') : st === 'ok' ? 'ok' : 'wait') + '"><span class="big"><span class="dot"></span>' +
    esc(rj ? '届かなかった操作 ' + rj + '件' : '送信待ち ' + un.length + '件・表示 ' + shown + '人') + '</span><span class="sub">' + esc(short) + '</span></div>';
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
  const synced = canStartEvent();
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
  const need = keep.rawId !== keep.id || !S.checkins.some((c) => c.id === keep.id);
  runOp(op, W.merge(ROOT, S.cur, keep, drop, op.id, need, op.tapAt));
  toast(keep.name + ' さんにまとめました（送信待ち）');
}
function markDistinct(pair) {
  const [a, b] = pair;
  const op = { id: rid('o'), type: 'distinct', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], tapAt: now() };
  runOp(op, W.distinct(ROOT, a, b));
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
  const label = { in: '受付', out: '受付の取消', merge: 'まとめ', distinct: '別の人の印', edit: '設定の変更', draw: 'チームの決定' };
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
    runOp(op, W.cancel(ROOT, S.cur, raws));
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
let newEvSheet = null;
function canStartEvent() {
  return serverState() === 'ok' && S.sync.box && !S.sync.box.cache &&
    S.sync.events && !S.sync.events.cache && (!S.cur || S.events[S.cur]?.status === 'open');
}
function openNewEvent() {
  newEvSheet = { cur: S.cur };
  const un = unsent().length, synced = canStartEvent();
  const others = S.devices.filter((d) => d.id !== DEV);
  const worry = others.filter((d) => (d.pending || 0) > 0 || (d.rejected || 0) > 0 || !d.at || srvNow() - d.at > STALE_MS);
  const cur = S.events[S.cur];
  const ok = synced && !un;
  $('sheet').innerHTML = '<h2 id="sheetTitle">' + (cur ? '新しい回を始める' : '最初の回を始める') + '</h2>' +
    (cur ? '<p>いまの回「' + esc(cur.name) + '」を締めて、新しい回を始めます。締めた回への受付・取消は、あとで圏外の端末から届いても受け付けません（その端末に「届かなかった操作」として名前つきで残ります）。</p>' : '<p>受付は開催回ごとに分けて保存します。</p>') +
    '<p>締める前に、使ったすべての端末の画面で「この端末の送信待ち 0件」を確かめてください。各端末の最後の報告：' + esc(devReports().join('／') || 'この端末だけ') + '</p>' +
    (worry.length ? '<p class="err">' + esc(worry.map((d) => d.name + 'の最後の報告は' + ago(srvNow() - (d.at || 0)) + '（送信待ち' + (d.pending || 0) + '件）').join('／')) + '。その後に圏外で押した分は、この画面からは分かりません。</p>' : '') +
    (!ok ? '<p class="err">' + (un ? 'この端末に送信待ちがあります。届いてから始めてください。' : 'サーバーで確認できていません。電波を確かめてください。') + '</p>' : '') +
    '<div class="field"><label for="evNameIn">回の名前</label><input class="input" id="evNameIn" maxlength="30" value="' + esc(defaultEventName()) + '"></div>' +
    '<div class="actions"><button class="btn primary" id="evYes" type="button"' + (ok ? '' : ' disabled') + '>始める</button><button class="btn ghost" id="evNo" type="button">やめる</button></div>';
  $('ov').hidden = false;
  $('evNo').onclick = () => { newEvSheet = null; closeSheet(); };
  $('evYes').onclick = () => {
    const seen = newEvSheet ? newEvSheet.cur : S.cur;
    newEvSheet = null;
    if (seen !== S.cur) { closeSheet(); toast('ほかの端末で回が変わりました。いまの回を表示します', true); return; }
    if (!canStartEvent() || unsent().length) { closeSheet(); toast('開催回と送信状況を確認してから、もう一度開いてください', true); return; }
    const name = $('evNameIn').value.trim() || defaultEventName();
    const d = new Date(), e = 'e' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + Math.random().toString(36).slice(2, 6);
    const writes = W.newEvent(ROOT, seen, Boolean(seen), e, name);
    closeSheet();
    B.commit(writes).then(() => toast('「' + name + '」を始めました'), (err) => {
      toast((err && err.code) === 'permission-denied' ? 'ほかの端末で先に回が始まったため、始めませんでした。いまの回を表示します' : '始められませんでした（' + ((err && err.code) || '') + '）', true);
    });
  };
}
function defaultEventName() { const d = new Date(); return (d.getMonth() + 1) + '/' + d.getDate() + ' 第' + (Object.keys(S.events).length + 1) + '回（テスト）'; }
$('evNew').onclick = openNewEvent;

/* ===== チーム抽選 =====
   - 対象：いまの回で受付済みの人（サーバーで確認できてから）
   - 同じチーム希望の目印（受付ごとに付ける）が同じ人は、その人たちだけで1チーム
   - 残りは人数差1人以内（1チーム2〜4人）。経験豊富の人数を各チームでそろえ、評価（1〜10）の合計の差が小さくなるようにする
   - 結果は開催回の記録に保存（運営だけが見る場所）。チーム名の初期値は A, B, C…
*/
const TEAM_MIN = 2, TEAM_MAX = 4, LV_DEFAULT = 5;
const EVEN_ONLY = true; // 月いちモルックはチーム数を偶数にする（総当たりで休みのチームを出さない）
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const T = { count: 0, preview: null, msg: '', draft: {} }; // draft：入力中の目印（描き直しても消えないように）
function rint(n) { const a = new Uint32Array(1); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : (a[0] = Math.floor(Math.random() * 4294967296)); return a[0] % n; }
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = rint(i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; }
/* 抽選に使う参加者（受付済み＋名簿の経験豊富・評価・早帰り＋受付の目印） */
function drawPeople() {
  const rm = rosterById();
  return people().map((p) => { const r = rm[p.id] || {}; return { id: p.id, rawId: p.rawId, name: p.name, exp: !!r.exp, level: r.exp ? (num(r.level) || LV_DEFAULT) : 0, early: !!r.early, pair: String(p.pair || '').trim(), pending: p.pending }; });
}
/* 目印ごとのまとまり（2人以上）と、目印が1人だけの人 */
function pairGroups(ps) {
  const by = {};
  ps.forEach((p) => { if (p.pair) (by[norm(p.pair)] = by[norm(p.pair)] || { label: p.pair, members: [] }).members.push(p); });
  const groups = [], lonely = [];
  Object.values(by).forEach((g) => { if (g.members.length >= 2) groups.push(g); else lonely.push(g.members[0]); });
  return { groups, lonely };
}
/* 選べるチーム数と、そのときの人数の内訳 */
function teamOptions(ps) {
  const { groups } = pairGroups(ps);
  const G = groups.length, inG = groups.reduce((s, g) => s + g.members.length, 0), R = ps.length - inG;
  const out = [];
  if (groups.some((g) => g.members.length > TEAM_MAX)) return { groups, out, why: '同じ目印の人が' + TEAM_MAX + '人より多いまとまりがあります（' + groups.filter((g) => g.members.length > TEAM_MAX).map((g) => g.label + '：' + g.members.length + '人').join('・') + '）' };
  for (let K = 1; K <= R; K++) {
    const base = Math.floor(R / K), extra = R % K;
    if (base < TEAM_MIN || base + (extra ? 1 : 0) > TEAM_MAX) continue;
    if (EVEN_ONLY && (G + K) % 2) continue;
    out.push({ T: G + K, K, base, extra, fixed: groups.map((g) => g.members.length) });
  }
  return { groups, out, why: out.length ? '' : '人数が足りないか、目印の組み方で、偶数のチーム数（1チーム' + TEAM_MIN + '〜' + TEAM_MAX + '人）に分けられません' };
}
function sizesText(o) {
  const parts = o.fixed.map((n) => '希望' + n + '人');
  if (o.extra) parts.push((o.base + 1) + '人×' + o.extra);
  if (o.K - o.extra) parts.push(o.base + '人×' + (o.K - o.extra));
  return parts.join('＋');
}
/* 残りの人を K チームに分ける。経験豊富を蛇行順で配って人数をそろえ、入れ替えで評価の合計の差を小さくする。
   何通りも作って、いちばん良いものに近い結果の中から1つを選ぶ（毎回同じにならないように） */
function balance(rest, K) {
  const R = rest.length, base = Math.floor(R / K), extra = R % K;
  const score = (teams) => {
    const sums = teams.map((t) => t.reduce((s, p) => s + p.level, 0)), exps = teams.map((t) => t.filter((p) => p.exp).length);
    const early = teams.reduce((s, t) => s + Math.max(0, t.filter((p) => p.early).length - 1), 0);
    return (Math.max(...sums) - Math.min(...sums)) * 10 + (Math.max(...exps) - Math.min(...exps)) * 100 + early * 30;
  };
  const tries = [];
  for (let n = 0; n < 300; n++) {
    const caps = shuffle(Array.from({ length: K }, (_, i) => base + (i < extra ? 1 : 0)));
    const teams = caps.map(() => []);
    const exps = shuffle(rest.filter((p) => p.exp)).sort((a, b) => b.level - a.level);
    const order = shuffle(Array.from({ length: K }, (_, i) => i));
    let k = 0, dir = 1;
    exps.forEach((p) => {
      let guard = 0;
      while (teams[order[k]].length >= caps[order[k]] && guard++ < K * 2) { k += dir; if (k >= K || k < 0) { dir = -dir; k += dir; } }
      teams[order[k]].push(p);
      k += dir; if (k >= K || k < 0) { dir = -dir; k += dir; }
    });
    /* 経験豊富でない人：早帰りの人を先に、早帰りがいない・人数の多いチームへ */
    const others = shuffle(rest.filter((p) => !p.exp)).sort((a, b) => (b.early ? 1 : 0) - (a.early ? 1 : 0));
    others.forEach((p) => {
      const open = teams.map((t, i) => i).filter((i) => teams[i].length < caps[i]);
      const pick = p.early ? open.sort((a, b) => teams[a].filter((x) => x.early).length - teams[b].filter((x) => x.early).length || caps[b] - caps[a] || rint(3) - 1)[0] : open[rint(open.length)];
      teams[pick].push(p);
    });
    /* 経験豊富どうしの入れ替えで評価の合計をそろえる */
    let best = score(teams), improved = true, loops = 0;
    while (improved && loops++ < 20) {
      improved = false;
      for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) {
        for (let i = 0; i < teams[a].length; i++) for (let j = 0; j < teams[b].length; j++) {
          const x = teams[a][i], y = teams[b][j];
          if (x.exp !== y.exp || x.level === y.level) continue;
          teams[a][i] = y; teams[b][j] = x;
          const s = score(teams);
          if (s < best) { best = s; improved = true; } else { teams[a][i] = x; teams[b][j] = y; }
        }
      }
    }
    tries.push({ teams, s: best });
  }
  const min = Math.min(...tries.map((t) => t.s));
  const near = tries.filter((t) => t.s <= min + 10);
  return near[rint(near.length)].teams;
}
function drawTeams(ps, opt) {
  const { groups } = pairGroups(ps);
  const inG = {}; groups.forEach((g) => g.members.forEach((m) => { inG[m.id] = 1; }));
  const rest = ps.filter((p) => !inG[p.id]);
  const teams = groups.map((g) => ({ fixed: g.label, members: g.members })).concat(balance(rest, opt.K).map((m) => ({ fixed: '', members: m })));
  return shuffle(teams).map((t, i) => ({ name: LETTERS[i] || ('T' + (i + 1)), fixed: t.fixed, members: shuffle(t.members) }));
}
/* 結果の点検：全員が1回ずつ・目印のまとまり・人数・経験豊富の偏り */
function checkTeams(teams, ps) {
  const seen = {}, dup = [], res = [];
  teams.forEach((t) => t.members.forEach((m) => { if (seen[m.id]) dup.push(m.name); seen[m.id] = 1; }));
  const missing = ps.filter((p) => !seen[p.id]).map((p) => p.name);
  const extra = Object.keys(seen).filter((id) => !ps.some((p) => p.id === id));
  res.push([!dup.length && !missing.length && !extra.length, ps.length + '人全員が、重複なく1回ずつ入っています' + (dup.length ? '（重複：' + dup.join('・') + '）' : '') + (missing.length ? '（入っていない：' + missing.join('・') + '）' : '') + (extra.length ? '（受付にいない人が' + extra.length + '人）' : '')]);
  const { groups } = pairGroups(ps);
  groups.forEach((g) => {
    const t = teams.find((x) => x.members.some((m) => m.id === g.members[0].id));
    const ok = t && t.members.length === g.members.length && g.members.every((m) => t.members.some((x) => x.id === m.id));
    res.push([ok, '目印「' + g.label + '」の' + g.members.length + '人だけで ' + (t ? t.name : '?') + ' チーム']);
  });
  const normal = teams.filter((t) => !t.fixed), sz = normal.map((t) => t.members.length);
  if (normal.length) res.push([Math.max(...sz) - Math.min(...sz) <= 1 && Math.min(...sz) >= TEAM_MIN, 'ほかのチームは ' + [...new Set(sz)].sort().join('〜') + '人（人数差1人以内）']);
  const ex = normal.map((t) => t.members.filter((m) => m.exp).length), lv = normal.map((t) => t.members.reduce((s, m) => s + m.level, 0));
  if (normal.length) res.push([Math.max(...ex) - Math.min(...ex) <= 1, '経験豊富は各チーム ' + Math.min(...ex) + (Math.max(...ex) !== Math.min(...ex) ? '〜' + Math.max(...ex) : '') + '人・評価の合計 ' + Math.min(...lv) + '〜' + Math.max(...lv)]);
  return res;
}
function teamReady() {
  if (!S.cur || !S.events[S.cur] || S.events[S.cur].status !== 'open') return '開催回がまだありません。受付タブで回を始めてください';
  if (serverState() !== 'ok') return 'サーバーで受付を確認できていません。電波を確かめてください';
  if (unsent().length) return 'この端末に送信待ちが ' + unsent().length + ' 件あります。届いてから抽選してください';
  return '';
}
function renderTeam() {
  if (!S.mode) return;
  const ev = S.events[S.cur] || {};
  const ps = drawPeople();
  const { groups, lonely } = pairGroups(ps);
  $('tmEv').textContent = ev.name || '';
  $('tmEv').hidden = !ev.name;
  const exN = ps.filter((p) => p.exp).length;
  $('tmTarget').textContent = '対象：受付済み ' + ps.length + '人（経験豊富 ' + exN + '人' + (groups.length ? '・同じチーム希望 ' + groups.map((g) => '「' + g.label + '」' + g.members.length + '人').join('・') : '') + '）';
  const why = teamReady();
  const others = S.devices.filter((d) => d.id !== DEV && ((d.pending || 0) > 0 || !d.at || srvNow() - d.at > STALE_MS));
  $('tmGate').hidden = !why && !others.length && !lonely.length;
  $('tmGate').innerHTML = (why ? '<b>' + esc(why) + '</b>' : '') +
    (others.length ? '<p style="margin:4px 0 0">' + esc(others.map((d) => d.name + 'の最後の報告：' + ago(srvNow() - (d.at || 0)) + '・送信待ち' + (d.pending || 0) + '件').join('／')) + '。抽選の前に、その端末の送信待ちが0件か確かめてください。</p>' : '') +
    (lonely.length ? '<p style="margin:4px 0 0">目印が1人だけ：' + esc(lonely.map((p) => p.name + '（' + p.pair + '）').join('・')) + '。この人は普通に抽選します。</p>' : '');
  const { out, why: optWhy } = teamOptions(ps);
  if (!out.some((o) => o.T === T.count)) {
    /* はじめは、2人のチームができない数のうち、1チーム3人にいちばん近い数を選んでおく */
    const pick = out.slice().sort((a, b) => (a.base < 3) - (b.base < 3) || Math.abs(a.base + a.extra / a.K - 3) - Math.abs(b.base + b.extra / b.K - 3))[0];
    T.count = pick ? pick.T : 0;
  }
  const cur = out.find((o) => o.T === T.count);
  $('tmCounts').innerHTML = out.length ? '<b>チーム数</b><div class="tm-count" role="group" aria-label="チーム数">' +
    out.map((o) => '<button type="button" data-tc="' + o.T + '" aria-pressed="' + (o.T === T.count) + '">' + o.T + '<small>チーム</small></button>').join('') + '</div>' +
    (cur ? '<div class="tm-sizes">' + esc(sizesText(cur)) + '</div>' : '') + (EVEN_ONLY ? '<p class="muted" style="margin:4px 0 0">チーム数は偶数だけです（総当たりで休みのチームを出さないため）。</p>' : '')
    : '<p class="err">' + esc(optWhy) + '</p>';
  $('tmCounts').querySelectorAll('[data-tc]').forEach((b) => { b.onclick = () => { T.count = +b.dataset.tc; T.preview = null; renderTeam(); }; });
  $('tmDraw').disabled = !!why || !cur;
  $('tmMsg').textContent = T.msg;
  renderTeamResult(ps);
  renderTeamPeople(ps);
}
function teamCard(t, i, edit) {
  const lv = t.members.reduce((s, m) => s + (m.level || 0), 0), ex = t.members.filter((m) => m.exp).length;
  return '<div class="tcard' + (t.fixed ? ' fixed' : '') + '"><div class="thd">' +
    (edit ? '<input class="input tm-name" data-tn="' + i + '" value="' + esc(t.name) + '" maxlength="12" aria-label="チーム名">' : '<span class="tm-name">' + esc(t.name) + '</span>') + '</div>' +
    '<div class="tm-meta">' + t.members.length + '人' + (t.fixed ? '・同じチーム希望「' + esc(t.fixed) + '」' : '') + '・経験豊富 ' + ex + '人・評価計 ' + lv + '</div>' +
    '<ul class="tm-mem">' + t.members.map((m) => '<li>' + esc(m.name) + (m.exp ? '<span class="lv">経験' + m.level + '</span>' : '') + (m.early ? '<span class="tag early">早帰り</span>' : '') + '</li>').join('') + '</ul></div>';
}
function renderTeamResult(ps) {
  const ev = S.events[S.cur] || {};
  const saved = ev.teams && ev.teams.length ? ev.teams : null;
  const show = T.preview || saved;
  $('tmResult').hidden = !show;
  if (!show) return;
  /* 保存した結果は、いまの名簿の経験豊富・評価で表示し直す */
  const byId = {}; ps.forEach((p) => { byId[p.id] = p; });
  const teams = show.map((t) => ({ ...t, members: t.members.map((m) => ({ ...(byId[m.id] || { exp: false, level: 0 }), id: m.id, name: m.name })) }));
  const checks = checkTeams(teams, ps);
  $('tmResH').textContent = T.preview ? '抽選の結果（まだ保存していません）' : '決まったチーム';
  $('tmResSt').textContent = T.preview ? '' : '保存 ' + hm(ev.drawnAt) + (ev.drawBy ? '・' + ev.drawBy : '');
  $('tmChecks').innerHTML = checks.map((c) => '<li>' + (c[0] ? '✓ ' : '✗ ') + esc(c[1]) + '</li>').join('') +
    (!T.preview && !checks[0][0] ? '<li><b>抽選のあとに受付が変わりました。抽選し直すか、チームを直してください。</b></li>' : '');
  $('tmTeams').innerHTML = teams.map((t, i) => teamCard(t, i, !!T.preview)).join('');
  $('tmTeams').querySelectorAll('[data-tn]').forEach((inp) => { inp.oninput = () => { T.preview[+inp.dataset.tn].name = inp.value.trim() || LETTERS[+inp.dataset.tn]; }; });
  $('tmResAct').innerHTML = T.preview
    ? '<button class="btn primary" id="tmSave" type="button">この結果で決める</button><button class="btn" id="tmAgain" type="button">もう一度抽選</button><button class="btn ghost" id="tmCancel" type="button">やめる</button>'
    : '';
  if (T.preview) {
    $('tmSave').onclick = saveTeams;
    $('tmAgain').onclick = doDraw;
    $('tmCancel').onclick = () => { T.preview = null; renderTeam(); };
  }
}
function renderTeamPeople(ps) {
  const LV = Array.from({ length: 10 }, (_, i) => i + 1);
  const a = document.activeElement, keep = a && a.dataset && a.dataset.pair ? { id: a.dataset.pair, s: a.selectionStart, e: a.selectionEnd } : null;
  setTimeout(() => { if (!keep) return; const n = $('tmPeople').querySelector('[data-pair="' + keep.id + '"]'); if (n && document.activeElement !== n) { n.focus(); try { n.setSelectionRange(keep.s, keep.e); } catch (e) {} } }, 0);
  $('tmPeople').innerHTML = ps.length ? ps.slice().sort((a, b) => (b.exp - a.exp) || b.level - a.level || (a.name < b.name ? -1 : 1)).map((p) =>
    '<li class="tmrow"><span class="nm">' + esc(p.name) + (p.pending ? ' <small class="muted">送信待ち</small>' : '') + '</span><span class="ctl">' +
    '<button type="button" class="tg" data-exp="' + esc(p.id) + '" aria-pressed="' + p.exp + '">経験豊富</button>' +
    (p.exp ? '<select data-lv="' + esc(p.id) + '" aria-label="' + esc(p.name) + 'の評価">' + LV.map((v) => '<option' + (v === p.level ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>' : '') +
    '<input data-pair="' + esc(p.rawId) + '" value="' + esc(p.rawId in T.draft ? T.draft[p.rawId] : p.pair) + '" maxlength="10" placeholder="目印" aria-label="' + esc(p.name) + 'の同じチーム希望の目印"></span></li>').join('')
    : '<li class="muted">まだ受付済みの人がいません</li>';
  $('tmPeople').querySelectorAll('[data-exp]').forEach((b) => { b.onclick = () => { const p = ps.find((x) => x.id === b.dataset.exp); editRoster(p, { exp: !p.exp, level: !p.exp ? LV_DEFAULT : null }); }; });
  $('tmPeople').querySelectorAll('[data-lv]').forEach((s) => { s.onchange = () => { const p = ps.find((x) => x.id === s.dataset.lv); editRoster(p, { level: +s.value }); }; });
  $('tmPeople').querySelectorAll('[data-pair]').forEach((inp) => {
    inp.oninput = () => { T.draft[inp.dataset.pair] = inp.value; };
    inp.onchange = () => {
      const p = ps.find((x) => x.rawId === inp.dataset.pair), v = inp.value.trim();
      delete T.draft[inp.dataset.pair];
      if (p && v !== p.pair) editPair(p, v);
    };
  });
}
function editRoster(p, data) {
  if (!p || needEvent()) return;
  const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: p.id, name: p.name }], tapAt: now() };
  runOp(op, [{ op: 'update', path: ROOT + '/roster/' + p.id, data }]);
  T.preview = null;
}
function editPair(p, label) {
  if (!p || needEvent()) return;
  const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: p.id, name: p.name }], tapAt: now() };
  runOp(op, [{ op: 'update', path: ROOT + '/events/' + S.cur + '/checkins/' + p.rawId, data: { pair: label } }]);
  T.preview = null;
}
function doDraw() {
  T.msg = '';
  const why = teamReady();
  if (why) { T.msg = why; renderTeam(); return; }
  const ps = drawPeople();
  const opt = teamOptions(ps).out.find((o) => o.T === T.count);
  if (!opt) { T.msg = 'このチーム数では分けられません'; renderTeam(); return; }
  T.preview = drawTeams(ps, opt);
  renderTeam();
  $('tmResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('tmDraw').onclick = () => {
  const ev = S.events[S.cur] || {};
  if (ev.teams && ev.teams.length && !T.preview) {
    $('sheet').innerHTML = '<h2 id="sheetTitle">抽選し直しますか？</h2><p>決まったチームがあります。抽選し直して「この結果で決める」を押すと、いまのチームは置き換わります。</p>' +
      '<div class="actions"><button class="btn primary" id="rdYes" type="button">抽選し直す</button><button class="btn ghost" id="rdNo" type="button">やめる</button></div>';
    $('ov').hidden = false; $('rdNo').onclick = closeSheet; $('rdYes').onclick = () => { closeSheet(); doDraw(); };
    return;
  }
  doDraw();
};
function saveTeams() {
  if (!T.preview || needEvent()) return;
  const why = teamReady(); if (why) { T.msg = why; renderTeam(); return; }
  const ps = drawPeople();
  if (!checkTeams(T.preview, ps)[0][0]) { T.msg = '抽選のあとに受付が変わりました。もう一度抽選してください'; T.preview = null; renderTeam(); return; }
  const teams = T.preview.map((t) => ({ name: t.name, fixed: t.fixed || '', members: t.members.map((m) => ({ id: m.id, name: m.name })) }));
  const op = { id: rid('o'), type: 'draw', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: teams.map((t) => ({ id: t.name, name: t.name + '（' + t.members.length + '人）' })), tapAt: now() };
  runOp(op, [{ op: 'update', path: ROOT + '/events/' + S.cur, data: { teams, drawnAt: TS, drawBy: devName, drawCount: teams.length } }]);
  T.preview = null; T.msg = '';
  toast(teams.length + 'チームに決めました（送信待ち）');
  renderTeam();
}

/* ===== タブ ===== */
function showPhase(ph) {
  S.phase = ph; ls.set('phase', ph);
  $('ph-entry').hidden = ph !== 'entry';
  $('ph-set').hidden = ph !== 'set';
  $('ph-team').hidden = ph !== 'team';
  $('ph-other').hidden = ph === 'entry' || ph === 'set' || ph === 'team';
  $('otherH').textContent = { game: '試合', rec: '記録' }[ph] || '';
  if (ph === 'team') renderTeam();
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
  const out = $('selfOut');
  if (serverState() !== 'ok' || unsent().length) { out.innerHTML = '<li>' + (unsent().length ? 'この端末に送信待ちがあります。届いてから試してください。' : 'サーバーにつながっていません。電波を確かめてから試してください。') + '</li>'; return; }
  $('selfBtn').disabled = true;
  out.innerHTML = '<li>確かめています…（1分ほどかかります）</li>';
  const t = rid('t'), R = 'staff/st' + t, res = [];
  /* 断られた（permission-denied）だけを「断られた」とする。通信の失敗や時間切れは「判定不能」 */
  const run = (writes) => Promise.race([B.commit(writes).then(() => 'ok', (e) => (e && e.code) === 'permission-denied' ? 'denied' : 'error:' + ((e && e.code) || 'unknown')),
    new Promise((r) => setTimeout(() => r('error:timeout'), 15000))]);
  const tryW = async (label, writes, expect) => {
    const r = await run(writes);
    if (r.indexOf('error') === 0) res.push([label, null, '判定不能（' + r.slice(6) + '）']);
    else res.push([label, (r === 'ok') === (expect === 'ok'), r === 'ok' ? '書けた' : '断られた']);
    return r;
  };
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + pad(i + 1) + t, name: '試験' + (i + 1) }));
  try {
    const e1 = 'e1' + t, e2 = 'e2' + t;
    await tryW('回を始める（アプリと同じ書き込み）', W.newEvent(R, null, false, e1, '試験の回1'), 'ok');
    await tryW('同時に別の端末も「最初の回」（断られるはず）', W.newEvent(R, null, false, 'ex' + t, '試験の回X'), 'denied');
    await tryW('回だけを作る（断られるはず）', [{ op: 'set', path: R + '/events/ey' + t, data: { name: 'Y', status: 'open' } }], 'denied');
    await tryW('前の回を締め忘れた切り替え（断られるはず）', W.newEvent(R, e1, false, 'skip' + t, '試験'), 'denied');
    const ppl = mk(24);
    await tryW('名簿24人を入れる', ppl.map((p) => ({ op: 'set', path: R + '/roster/' + p.id, data: { name: p.name, norm: norm(p.name) } })), 'ok');
    for (const [k, part] of chunks(ppl, CHUNK).entries()) {
      const op = { id: 'oi' + k + t, type: 'in', eid: e1, items: part, tapAt: now() };
      await tryW('24人の受付：' + (k + 1) + '回目（' + part.length + '人・アプリと同じ）', W.checkin(R, e1, part, op.id, now(), null).concat([W.opDoc(R, op)]), 'ok');
    }
    const nw = { id: 'n' + t, name: '新しい人', isNew: true }, opn = { id: 'on' + t, type: 'in', eid: e1, items: [nw], tapAt: now() };
    await tryW('はじめての人の受付（名簿と受付を同時に）', W.checkin(R, e1, [nw], opn.id, now(), null).concat([W.opDoc(R, opn)]), 'ok');
    const opc = { id: 'oc' + t, type: 'out', eid: e1, items: [ppl[0]], tapAt: now() };
    await tryW('受付の取消（アプリと同じ）', W.cancel(R, e1, [ppl[0].id]).concat([W.opDoc(R, opc)]), 'ok');
    /* まとめ：AにBをまとめる→逆向き（AをBに）は断られる */
    const A = { ...ppl[1], rawId: ppl[1].id }, Bp = { ...ppl[2], rawId: ppl[2].id };
    const om = { id: 'om' + t, type: 'merge', eid: e1, items: [Bp, A], tapAt: now() };
    await tryW('BをAにまとめる（アプリと同じ）', W.merge(R, e1, A, Bp, om.id, false, now()).concat([W.opDoc(R, om)]), 'ok');
    const om2 = { id: 'om2' + t, type: 'merge', eid: e1, items: [A, Bp], tapAt: now() };
    await tryW('同時に逆向き：AをBにまとめる（断られるはず）', W.merge(R, e1, Bp, A, om2.id, true, now()).concat([W.opDoc(R, om2)]), 'denied');
    await tryW('まとめたBを元に戻す（断られるはず）', [{ op: 'update', path: R + '/roster/' + Bp.id, data: { mergedInto: '' } }], 'denied');
    await tryW('まとめたBを古い新規登録で上書き（断られるはず）', [{ op: 'set', path: R + '/roster/' + Bp.id, data: { name: Bp.name } }], 'denied');
    await tryW('まとめたBに受付（断られるはず）', W.checkin(R, e1, [Bp], 'ob' + t, now(), null), 'denied');
    await tryW('自分自身にまとめる（断られるはず）', [{ op: 'update', path: R + '/roster/' + ppl[3].id, data: { mergedInto: ppl[3].id } }], 'denied');
    await tryW('まとめ済みのBへまとめる（断られるはず）', [{ op: 'update', path: R + '/roster/' + ppl[3].id, data: { mergedInto: Bp.id } }], 'denied');
    await tryW('名簿にない人だけの受付（断られるはず）', [{ op: 'set', path: R + '/events/' + e1 + '/checkins/zz' + t, data: { name: 'Z' } }], 'denied');
    { const r = await run(W.checkin(R, e1, ppl.slice(4), 'oz' + t, now(), null).concat([W.opDoc(R, { id: 'oz' + t, type: 'in', eid: e1, items: ppl.slice(4), tapAt: now() })]));
      res.push(['（参考）20人を分けずに1回で受付', 'info', r === 'ok' ? '書けた（この環境では上限に届かなかった）' : r === 'denied' ? '断られた（だから' + CHUNK + '人ずつに分けています）' : '判定不能（' + r.slice(6) + '）']); }
    /* 回を締める→旧回への操作は断られる */
    await tryW('新しい回を始める（いまの回を締める）', W.newEvent(R, e1, true, e2, '試験の回2'), 'ok');
    await tryW('古い画面から新しい回を始める（断られるはず）', W.newEvent(R, e1, false, 'ez' + t, '試験の回Z'), 'denied');
    const old = { id: 'oo' + t, type: 'in', eid: e1, items: [ppl[5]], tapAt: now() };
    await tryW('締めた回への受付（断られるはず）', W.checkin(R, e1, [ppl[5]], old.id, now(), null).concat([W.opDoc(R, old)]), 'denied');
    await tryW('締めた回での取消（断られるはず）', W.cancel(R, e1, [ppl[6].id]), 'denied');
    await tryW('締めた回を開け直す（断られるはず）', [{ op: 'update', path: R + '/events/' + e1, data: { status: 'open' } }], 'denied');
    const op2 = { id: 'o2' + t, type: 'distinct', eid: e2, items: [ppl[8]], tapAt: now() };
    await tryW('新しい回に操作の記録を書く', [W.opDoc(R, op2)], 'ok');
    await tryW('操作の記録の書き換え（断られるはず）', [W.opDoc(R, op2)], 'denied');
    await tryW('名簿を消す（断られるはず）', [{ op: 'delete', path: R + '/roster/' + ppl[7].id }], 'denied');
    if (B.anonRead) {
      const a = await B.anonRead();
      if (a) {
        const judge = (label, v, wantOk) => { if (v !== 'read' && v !== 'written' && v !== 'permission-denied') res.push([label, null, '判定不能（' + v + '）']); else res.push([label, (v === 'read' || v === 'written') === wantOk, v === 'permission-denied' ? '断られた' : '読めた/書けた']); };
        judge('ログインなしで運営の名簿を読む（断られるはず）', a.staff, false);
        judge('ログインなしで公開データを読む', a.pub, true);
        judge('ログインなしで公開データに書く（断られるはず）', a.pubWrite, false);
      }
    }
  } catch (e) { res.push(['途中で止まりました', null, '判定不能（' + ((e && e.code) || String(e)) + '）']); }
  const ng = res.filter((r) => r[1] === false).length, un = res.filter((r) => r[1] === null).length;
  out.innerHTML = res.map((r) => '<li>' + (r[1] === 'info' ? '・ ' : r[1] === null ? '？ ' : r[1] ? '✓ ' : '✗ ') + esc(r[0]) + '：' + esc(r[2]) + '</li>').join('') +
    '<li><b>' + (ng ? '想定と違うものが ' + ng + ' 件あります。' : '') + (un ? '判定できなかったものが ' + un + ' 件あります（電波の良い場所でもう一度）。' : '') + (!ng && !un ? 'すべて想定どおりです' : '') + '</b></li>';
  $('selfBtn').disabled = false;
};

/* ===== テスト用 ===== */
$('seedBtn').onclick = () => {
  if (S.roster.filter((r) => /^r\d\d$/.test(r.id)).length >= FAKE.length) { toast('架空の名簿はもう入っています'); return; }
  B.commit(FAKE.map((n, i) => ({ op: 'set', path: ROOT + '/roster/r' + pad(i + 1), data: { name: n, norm: norm(n), exp: i % 4 === 0, level: i % 4 === 0 ? [9, 7, 6, 5, 4, 2][i / 4] : null, early: i % 9 === 5, pair: '', createdAt: TS } })))
    .then(() => toast('架空の名簿24人を入れました'), (e) => toast('入れられませんでした（' + ((e && e.code) || '') + '）', true));
};
$('demoOffline').onchange = () => { if (B && B.setOffline) B.setOffline($('demoOffline').checked); renderBar(); };
$('logout').onclick = async () => { try { await B.logout(); } catch (e) {} ls.set('mode', ''); location.reload(); };
/* この端末からデータを消す：送信待ち・届かなかった操作があるあいだは消さない */
function idbDelete(name) {
  return new Promise((res, rej) => {
    try { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => res(true); r.onerror = () => rej(r.error || new Error('error')); r.onblocked = () => rej(new Error('blocked')); }
    catch (e) { rej(e); }
  });
}
async function idbNames() { try { return indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name || '') : null; } catch (e) { return null; } }
// 旧版の共有記録は本番・練習の区別が付かないため、端末内で確認だけできるようにする。
const legacyKey = 'ops_' + BOX;
async function readLegacy() {
  const saved = JSON.parse(localStorage.getItem('tk_' + legacyKey) || '[]');
  const gone = new Set(JSON.parse(localStorage.getItem('tk_' + legacyKey + '_gone') || '[]'));
  const rows = await new Promise((resolve, reject) => {
    const req = indexedDB.open('tk_ops');
    let missing = false;
    req.onupgradeneeded = () => { missing = true; req.transaction.abort(); };
    req.onerror = () => missing ? resolve([]) : reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('ops');
        const q = tx.objectStore('ops').getAll();
        tx.oncomplete = () => { db.close(); resolve(q.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      } catch (error) { db.close(); reject(error); }
    };
  });
  const records = new Map();
  for (const op of saved.concat(rows)) {
    const previous = records.get(op.id);
    if (!gone.has(op.id) && (!previous || RANK[op.state] > RANK[previous.state])) records.set(op.id, op);
  }
  return [...records.values()];
}
async function refreshLegacy() {
  const panel = $('legacyBox');
  try {
    const rows = await readLegacy();
    panel.hidden = !rows.length;
    $('legacyRows').textContent = rows.map(op => {
      const state = {done:'保存済み', rejected:'届かなかった', sending:'送信確認が必要', unverified:'送信確認が必要'};
      return [op.ename, (op.items || []).map(i => i.name).join('・'), state[op.state] || '要確認'].filter(Boolean).join(' ／ ');
    }).join('\n');
    return rows;
  } catch (error) {
    panel.hidden = false;
    $('legacyRows').textContent = '旧版の記録を読み取れません。消去する前に別のタブを閉じ、開き直してください。';
    throw error;
  }
}
$('wipeBtn').onclick = async () => {
  const msg = $('wipeMsg');
  if (unsent().length) { msg.textContent = 'この端末に送信待ちが ' + unsent().length + ' 件あります。電波の良い場所で届くのを待ってから消してください。'; return; }
  if (rejected().length) { msg.textContent = '届かなかった操作が ' + rejected().length + ' 件あります。受付タブで確かめて「消す」か「受付し直す」をしてからにしてください。'; return; }
  msg.textContent = 'サーバーに全部届いているか確かめています…';
  const ok = await Promise.race([B.waitPending().then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))]);
  if (!ok || serverState() !== 'ok') { msg.textContent = 'サーバーで確認できませんでした。電波の良い場所でもう一度押してください。'; return; }
  let legacyRows = [];
  if (realUid()) {
    try { legacyRows = await refreshLegacy(); } catch { msg.textContent = '旧版の記録を確認できないため消去を中止しました。'; return; }
  }
  $('sheet').innerHTML = '<h2 id="sheetTitle">この端末からデータを消す</h2><p>送信待ちは0件で、サーバーに全部届いています。この端末に残っている名簿・受付の写しと、運営モードのログインを消します。サーバーのデータは消えません。ほかのタブでこのページを開いているときは、先に閉じてください。</p>' +
    (legacyRows.length ? '<label><input type="checkbox" id="wpLegacy">旧版の記録 ' + legacyRows.length + ' 件を確認し、未確定分を含めて端末から消去します</label>' : '') +
    '<div class="actions"><button class="btn primary" id="wpYes" type="button">消す</button><button class="btn ghost" id="wpNo" type="button">やめる</button></div>';
  $('ov').hidden = false; $('wpNo').onclick = closeSheet;
  $('wpYes').onclick = async () => {
    closeSheet();
    if (unsent().length) { msg.textContent = '送信待ちができたので、消すのをやめました。'; return; }
    if (legacyRows.length && !$('wpLegacy').checked) { msg.textContent = '設定の旧版記録を確認してください。'; return; }
    if (rejected().length) { msg.textContent = '届かなかった操作を先に確認してください。'; return; }
    const clearLegacy = Boolean(realUid());
    msg.textContent = '消しています…';
    let prefixes = [], err = '';
    if (clearLegacy) {
      try {
        await idbDelete('tk_ops');
        localStorage.removeItem('tk_' + legacyKey);
        localStorage.removeItem('tk_' + legacyKey + '_gone');
      } catch { msg.textContent = '旧版の記録を消せませんでした。旧版を開いているタブを閉じてください。'; return; }
    }
    try { prefixes = await B.clearLocal(); } catch (e) { err = (e && (e.code || e.message)) || 'error'; }
    try { IDB.db && IDB.db.close(); await idbDelete(IDB_NAME); } catch (e) { err = err || IDB_NAME + ':' + ((e && e.message) || 'error'); }
    [OPS_KEY, OPS_KEY + '_gone', 'mode', 'phase'].forEach((k) => ls.del(k));
    /* 消えたかを確かめる（IndexedDB の一覧と、この端末の記録） */
    const names = await idbNames();
    const left = names == null ? null : names.filter((n) => n === IDB_NAME || (clearLegacy && n === 'tk_ops') || (prefixes || []).some((p) => n.indexOf(p) === 0));
    const lsLeft = ls.get(OPS_KEY, null) != null || ls.get('mode', null) != null;
    if (err || lsLeft || (left && left.length)) {
      msg.textContent = '消しきれませんでした（' + (err || (left || []).join('・') || '端末の記録') + '）。ほかのタブを閉じて、もう一度押してください。';
      return;
    }
    try { sessionStorage.setItem('tk_wiped', names == null ? 'partial' : 'ok'); } catch (e) {}
    location.reload();
  };
};
window.addEventListener('online', () => { renderBar(); verifyOps(); refreshConfirmedCount(); });
window.addEventListener('offline', renderBar);
window.addEventListener('beforeunload', (e) => { if (unsent().length && (!B || !B.persistent)) { e.preventDefault(); e.returnValue = ''; } });
/* ルールの表示・コピーは、本番の運営アカウントでログインしているときだけ（練習の仮のUIDを公開すると運営が入れなくなるため） */
function realUid() {
  if (S.mode !== 'fire' || !B || B.kind !== 'fire' || !B.uid) return '';
  const u = B.uid();
  return u && B.email && B.email() === STAFF_EMAIL ? u : '';
}
function renderRules() {
  const uid = realUid();
  $('rulesBody').hidden = !uid;
  $('rulesNote').textContent = uid ? 'この運営アカウントのUID：' + uid : '本番の運営モード（運営パスコードでログイン）のときだけ表示します。練習モードでは表示しません。';
  $('rulesTa').value = uid ? RULES.replace('__UID__', uid) : '';
}
$('rulesCopy').onclick = () => {
  renderRules();
  if (!realUid()) { toast('本番の運営モードでだけコピーできます', true); return; }
  const ta = $('rulesTa'), done = () => toast('ルールの全文をコピーしました');
  const fb = () => { ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} toast(ok ? 'ルールの全文をコピーしました' : '全文を選択しました。コピーしてください', !ok); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, fb); else fb();
};
window.__tk = { S, unsent, rejected, people, dupGroups, W, RULES, T, drawPeople, teamOptions, drawTeams, checkTeams, pairGroups };

boot();
