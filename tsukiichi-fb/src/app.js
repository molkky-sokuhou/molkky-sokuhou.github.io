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
const CHUNK = 4; // 1回のまとめ書きで受付する人数。ルールの参照（1人4回＋記録1回）が上限20回に収まるように
const STALE_MS = 150000;

/* ===== 書き込みの組み立て（アプリと「ルールの確認」の両方で同じものを使う） ===== */
const W = {
  opDoc(root, op) { return { op: 'set', path: root + '/events/' + op.eid + '/ops/' + op.id, data: { type: op.type, names: op.items.map((i) => i.name), ids: op.items.map((i) => i.id), dev: DEV, devName, tapAt: op.tapAt, at: TS } }; },
  checkin(root, eid, items, opId, tapAt, tapSrv) {
    const w = [];
    items.forEach((it) => {
      /* 経験豊富・評価・初心者は名簿に（次の回にも残る）。早帰り・目印はその回の受付に */
      if (it.isNew) w.push({ op: 'set', path: root + '/roster/' + it.id, data: { name: it.name, norm: norm(it.name), exp: !!it.exp, level: it.exp ? (it.level || 5) : null, beg: !it.exp && !!it.beg, createdAt: TS, createdIn: eid } });
      else if (it.upd) w.push({ op: 'update', path: root + '/roster/' + it.id, data: it.upd });
      w.push({ op: 'set', path: root + '/events/' + eid + '/checkins/' + it.id, data: { name: it.name, isNew: !!it.isNew, early: !!it.early, pair: String(it.pair || '').trim(), at: TS, tapAt, tapSrv: tapSrv == null ? null : tapSrv, dev: DEV, devName, batch: opId, n: items.length, op: opId } });
    });
    return W.rev(root, eid, w);
  },
  cancel(root, eid, rawIds) { return rawIds.map((r) => ({ op: 'delete', path: root + '/events/' + eid + '/checkins/' + r })); },
  /* まとめる：まとめるごとに番号（mergeId）を付ける（元に戻すときにこの番号を確かめる）。
     o.carry があれば、その回の早帰り・目印・チームをまとめ先へ引き継ぐ（抽選のあとにまとめても記録から漏れないように）。
     o.base（画面を開いたときの開催回の rev）があれば、その間にチームや結果が変わったときは断られる（解散したチームを割り当てないように）。
     その回に受付していた人をまとめるときは、元に戻せるように、消す方の受付とチームを名簿の mergeCk・mergeTeam に残す */
  merge(root, eid, keep, drop, opId, needKeepCheckin, tapAt, o) {
    o = o || {};
    const extra = o.keepNameBefore != null ? { keepNameBefore: o.keepNameBefore, keepNameAfter: o.keepNameAfter } : {};
    const c = o.carry, dropIn = o.dropIn !== false;
    const undo = dropIn && c && o.dropCk ? { mergeEv: eid, mergeCk: o.dropCk, mergeTeam: o.dropTeam || 0, mergeKeep: { team: o.keepTeam || 0, early: !!o.keepEarly, pair: o.keepPair || '', had: !needKeepCheckin, carried: c.team || 0, cEarly: !!c.early, cPair: c.pair || '' } } : { mergeEv: '', mergeCk: null, mergeTeam: 0, mergeKeep: null };
    const w = [{ op: 'update', path: root + '/roster/' + drop.id, data: { mergedInto: keep.id, mergedAt: TS, mergeId: o.mergeId || ('g' + opId), ...undo, ...extra } }];
    if (dropIn) w.push({ op: 'delete', path: root + '/events/' + eid + '/checkins/' + (drop.rawId || drop.id) });
    if (needKeepCheckin) w.push({ op: 'set', path: root + '/events/' + eid + '/checkins/' + keep.id, data: { name: keep.name, isNew: !!keep.isNew, early: !!(c && c.early), pair: (c && c.pair) || '', at: TS, tapAt: keep.tapAt || tapAt, dev: DEV, devName, batch: opId, n: 1, op: opId } });
    else if (c && c.fix) w.push({ op: 'update', path: root + '/events/' + eid + '/checkins/' + (keep.rawId || keep.id), data: c.fix });
    if (c && c.team !== undefined) w.push({ op: 'update', path: root + '/events/' + eid, data: { ['assign.' + keep.id]: c.team || null, ['assign.' + drop.id]: null, ...(o.base != null ? { chk: { base: o.base, op: opId } } : {}) } });
    return w;
  },
  rev(root, eid, writes) {
    const evPath = root + '/events/' + eid, ckPath = evPath + '/checkins/';
    if (!writes.some((w) => (w.path === evPath && w.op === 'update') || w.path.startsWith(ckPath) || w.path.startsWith(root + '/hist/') || w.path.startsWith(root + '/roster/'))) return writes;
    const rev = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ew = writes.find((w) => w.path === evPath && w.op === 'update');
    if (ew) ew.data.rev = rev; else writes.push({ op: 'update', path: evPath, data: { rev } });
    return writes;
  },
  distinct(root, a, b) { return [{ op: 'update', path: root + '/roster/' + a.id, data: { ['notSame.' + b.id]: true } }, { op: 'update', path: root + '/roster/' + b.id, data: { ['notSame.' + a.id]: true } }]; },
  newEvent(root, curId, curOpen, newId, name, courts, close) {
    const w = [];
    /* 締めるときは、その回の順位（final）と、1人1件の大会の記録（hist）を同じまとめ書きで残す（11/22版のリセットと同じ中身） */
    if (curId && curOpen) w.push({ op: 'update', path: root + '/events/' + curId, data: { status: 'closed', closedAt: TS, ...((close && close.ev) || {}) } });
    ((close && close.hist) || []).forEach((h) => w.push({ op: 'set', path: root + '/hist/' + h.id, data: h.data }));
    w.push({ op: 'set', path: root + '/events/' + newId, data: { name, status: 'open', createdAt: TS, date: jstDate(Date.now()), ...(courts ? { courts } : {}) } });
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
    // 開催回の更新番号（rev）が、この書き込みで変わるか（参照2回。同じ文書なので数え方は実際には1回のことが多い）
    function revBumped(box, e) {
      return getAfter(pathOf(box, 'events', e)).data.get('rev', '') != get(pathOf(box, 'events', e)).data.get('rev', '');
    }
    // テストのデータの片付けの間（conf/cleanup の until が今より後）だけ、削除を通す。
    // until を書けるのは、システムのパスワード（conf/sysKey のハッシュ。運営の画面からも読めない）を知っている人だけで、長さは16分まで
    function cleaning(box) {
      return get(/databases/$(database)/documents/staff/$(box)/conf/cleanup).data.get('until', 0) > request.time.toMillis();
    }
    function sysHash(box) {
      return get(/databases/$(database)/documents/staff/$(box)/conf/sysKey).data.hash;
    }
    // この書き込みで変わる項目か
    function changes(k) {
      return k in request.resource.data.diff(resource.data).affectedKeys();
    }
    match /public/{path=**} {
      allow read: if true;
    }
    match /public/{id} {
      allow create, update: if isStaff()
        && request.resource.data.keys().hasOnly(['body', 'updatedAt', 'at', 'box', 'event', 'rev', 'seq'])
        && id == 'tsukiichi_' + request.resource.data.box
        && request.resource.data.at == request.time
        && request.resource.data.seq == (resource == null ? 1 : resource.data.get('seq', 0) + 1)
        && get(/databases/$(database)/documents/staff/$(request.resource.data.box)).data.currentEvent == request.resource.data.event
        && get(pathOf(request.resource.data.box, 'events', request.resource.data.event)).data.get('rev', '') == request.resource.data.rev;
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
      // 片付けで消せるのは、スプレッドシートから取り込んでいない人だけ
      allow delete: if isStaff() && cleaning(box) && resource.data.get('createdIn', '') != 'sheet';
      // まとめた人は変えない。まとめる先は、自分以外の、まとめられていない人だけ
      // ただし「まとめを元に戻す」操作（mergedInto を空にして unmergedAt を書く。ほかは変えない）だけは通す。
      // 版12までのまとめ（mergeId なし）は、unmergeOf を空にして戻せる
      // 名前を戻すときは nameChk.v（押した画面で見えていた名前）が、いまの名前と同じときだけ
      allow update: if isStaff()
        && ((resource.data.get('mergedInto', '') == ''
          && (request.resource.data.get('mergedInto', '') == ''
            || (request.resource.data.mergedInto != rid
              && notMerged(box, request.resource.data.mergedInto)))
          && (!changes('nameChk') || request.resource.data.nameChk.v == resource.data.get('name', '')))
        || (resource.data.get('mergedInto', '') != ''
          && request.resource.data.get('mergedInto', '') == ''
          && request.resource.data.get('unmergedAt', null) == request.time
          && request.resource.data.get('unmergeOf', '') == resource.data.get('mergeId', '')
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['mergedInto', 'unmergedAt', 'unmergeOf'])));
    }
    // 大会の記録（1人1大会で1件）。消さない。移すときは「いまの持ち主」と移した回数（mv）を確かめ、移す先はまとめられていない名簿の人だけ
    match /staff/{box}/hist/{h} {
      allow read: if isStaff();
      // 作るのは締めるときに全員分をまとめて（参照回数の上限に当たらないよう、ここでは名簿を見ない）
      allow create: if isStaff();
      allow delete: if isStaff() && cleaning(box) && resource.data.get('src', '') != 'sheet';
      allow update: if isStaff()
        && request.resource.data.movedFrom == resource.data.rid
        && request.resource.data.rid != resource.data.rid
        && request.resource.data.get('mv', 0) == resource.data.get('mv', 0) + 1
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['rid', 'movedFrom', 'movedAt', 'mv'])
        && notMerged(box, request.resource.data.rid)
        // 覇王戦の記録を直すのは、直す画面で見ていた版（editOf）がいまの版（ver）と同じときだけ（2台が同じ回を同時に書いても上書きしない）
        || isStaff() && resource.data.get('kind', '') == 'haoh' && request.resource.data.get('kind', '') == 'haoh'
          && request.resource.data.no == resource.data.no
          && request.resource.data.get('editOf', '') == resource.data.get('ver', '');
    }
    // 大会の案内（info）など。パスワードのハッシュが入る sysKey・sysCheck・cleanup は、運営の画面からも読めない
    match /staff/{box}/conf/{doc} {
      allow read: if isStaff() && !(doc in ['sysKey', 'sysCheck', 'cleanup', 'sys']);
      allow write: if isStaff() && !(doc in ['sysKey', 'sysCheck', 'cleanup', 'sysMeta', 'sys']);
    }
    // システムのパスワードのハッシュ。だれも読めない。初めは作るだけ（版20までの conf/sys が残っている箱では作れない。
    // そのハッシュは読めた時期があるので、Firebase のコンソールで conf/sys を消してから決め直す）。変えるときは今のハッシュ（old）を添える
    match /staff/{box}/conf/sysKey {
      allow create: if isStaff() && request.resource.data.hash is string && request.resource.data.hash.size() == 64
        && !exists(/databases/$(database)/documents/staff/$(box)/conf/sys);
      allow update: if isStaff() && request.resource.data.get('old', '') == resource.data.hash && request.resource.data.hash.size() == 64;
    }
    // salt（読める）。変えられるのは、同じまとめ書きで sysKey を作る・変えるときだけ
    match /staff/{box}/conf/sysMeta {
      allow create, update: if isStaff()
        && ((!exists(/databases/$(database)/documents/staff/$(box)/conf/sysKey) && existsAfter(/databases/$(database)/documents/staff/$(box)/conf/sysKey))
          || getAfter(/databases/$(database)/documents/staff/$(box)/conf/sysKey).data.hash != get(/databases/$(database)/documents/staff/$(box)/conf/sysKey).data.hash);
    }
    // パスワードの確かめ：ハッシュが合うときだけ書ける（書けたら正しい）
    match /staff/{box}/conf/sysCheck {
      allow write: if isStaff() && request.resource.data.key == sysHash(box);
    }
    // 片付けの時間：始めるのはパスワードを知っている人だけ・16分まで。終えるのはだれでも
    match /staff/{box}/conf/cleanup {
      allow write: if isStaff() && (request.resource.data.get('until', 0) == 0
        || (request.resource.data.get('key', '') == sysHash(box)
          && request.resource.data.until is number && request.resource.data.until <= request.time.toMillis() + 960000));
    }
    match /staff/{box}/events/{e} {
      allow read: if isStaff();
      // 回を作れるのは、同じまとめ書きで「いまの回」をその回にするときだけ（開いている回は1つ）
      allow create: if isStaff() && request.resource.data.status == 'open'
        && getAfter(/databases/$(database)/documents/staff/$(box)).data.currentEvent == e;
      // 片付けで消せるのは、いまの回ではない回だけ
      allow delete: if isStaff() && cleaning(box)
        && get(/databases/$(database)/documents/staff/$(box)).data.get('currentEvent', '') != e;
      // 締めた回は開け直さない。開いている回を書き換えるときは、毎回 rev を新しくする（旧版の端末の書き込みは断る）。
      // chk.base があれば、押した画面が見ていた rev がいまと同じときだけ（その間にほかの端末の変更があれば断る）。
      // 参加者画面にチームを出す（shown を true）のは、押した画面の抽選（shownDraw）がいまの抽選（drawId）と同じときだけ。
      // 締めるときは、順位を計算したときの rev（closeRev）がいまの rev と同じときだけ
      allow update: if isStaff() && resource.data.status == 'open'
        && ((request.resource.data.status == 'open'
            && request.resource.data.get('rev', '') != resource.data.get('rev', '')
            && (!changes('drawnAt') || (changes('drawId') && changes('chk')))
            && (!changes('chk') || request.resource.data.chk.base == resource.data.get('rev', ''))
            && (!changes('shown') || request.resource.data.shown != true
              || request.resource.data.get('shownDraw', '') == resource.data.get('drawId', '')))
          || (request.resource.data.status == 'closed'
            && request.resource.data.get('closeRev', '') == resource.data.get('rev', '')));
    }
    match /staff/{box}/events/{e}/checkins/{rid} {
      allow read: if isStaff();
      allow create, update: if isStaff() && isOpen(box, e) && notMerged(box, rid) && revBumped(box, e);
      // 取り消し・まとめで受付を消すときは、同じまとめ書きで開催回の rev も新しくする（締めの計算と食い違わないように）
      // 片付けでも、開いている回の受付を消すときは rev を変える（締めの計算と食い違わないように）。締めた回の受付は片付けの間だけ
      allow delete: if isStaff() && ((isOpen(box, e) && revBumped(box, e))
        || (cleaning(box) && get(pathOf(box, 'events', e)).data.status == 'closed'));
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
  mode: '', cur: '', events: {}, roster: [], checkins: [], devices: [], metrics: [], hist: [],
  sync: { box: null, events: null, roster: null, checkins: null }, // null=まだ / {cache:true|false, at, err}
  sel: {}, selFlags: {}, phase: 'entry', offset: null, rtt: null, firstSnap: true, seen: {}, ops: [], verifying: false,
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
  bumpRev(op, writes);
  op.session = SESSION; op.state = 'sending'; op.dev = DEV; op.devName = devName;
  writes.push(W.opDoc(ROOT, op));
  S.ops.push(op); saveOps(); refreshConfirmedCount();
  const p = B.commit(writes);
  p.then(() => { op.state = 'done'; op.doneAt = now(); saveOps(); refreshConfirmedCount(); renderAll(); heartbeat(); },
    (err) => { markRejected(op, err && err.code); });
  renderAll(); heartbeat();
  return p;
}
/* 順位や記録に関わる変更（開催回のチーム・試合・所属、受付の書き換え・取り消し）では、開催回の rev を新しくする（W.rev）。
   ルールで、開いている回の書き換えは毎回 rev が変わること、受付を消すときは同じまとめ書きで rev が変わることを確かめる。
   締めるときは、順位を計算したときの rev を closeRev として送り、ルールで同じときだけ通す（直前に届いた得点の訂正と食い違わないように） */
function bumpRev(op, writes) { if (op.eid) W.rev(ROOT, op.eid, writes); }
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
    if (op.guard) return '画面を開いたあとに、ほかの端末でチームや結果が変わったため、断られました。いまの表示を確かめて、もう一度操作してください';
    if (op.hint) return op.hint;
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
    async getServerCol(path) { const q = await F.getDocsFromServer(F.collection(db, path)); return q.docs.map((d) => ({ id: d.id, ...plain(d.data()) })); },
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
    async getServerCol(path) { const st = await T.state(), depth = path.split('/').length + 1; return Object.keys(st.docs).filter((k) => k.indexOf(path + '/') === 0 && k.split('/').length === depth).map((k) => ({ id: k.split('/').pop(), ...st.docs[k] })); },
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
  B.subDoc(PUB, (d, fc) => { S.sync.pub = { cache: fc }; S.pub = d; schedulePublish(); }, () => {});
  B.sub(ROOT + '/hist', (list, fc) => { mark('hist', fc); S.hist = list.map((d) => ({ id: d.id, ...d.data })); renderAll(); }, onErr('hist'));
  B.subDoc(INFO, (d, fc) => { mark('info', fc); S.info = d; renderInfo(); schedulePublish(); }, onErr('info'));
  B.subDoc(ROOT + '/conf/sysMeta', (d, fc) => { S.sysConf = d; S.sysLoaded = !fc || !!d; renderSys(); }, () => {});
  bkLoad();
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
/* いまの回の受付を、人ごとに1つにまとめた一覧。名前は名簿の名前（記録タブで名前を直したときも、当日の表示と合うように） */
function peopleOf(checkins, ev, rm) {
  const out = {};
  checkins.forEach((c) => {
    const id = resolveId(c.id, rm);
    const prev = out[id];
    const entry = { ...c, id, rawId: c.id, merged: id !== c.id, name: (rm[id] && rm[id].name) || c.name };
    if (!prev || (prev.merged && !entry.merged)) out[id] = entry;
    if (prev && c.pending) out[id].pending = true;
  });
  const asg = evAssign(ev, rm);
  return Object.values(out).map((p) => ({ ...p, team: asg[p.id] || 0 }));
}
function people() { return peopleOf(S.checkins, S.events[S.cur], rosterById()); }
/* ===== チーム（決まったあと）：開催回の tm（t番号→名前）と assign（名簿の番号→チーム番号）。
   付け替えは1人の欄だけを書き換えるので、2台で別々の人を動かしても消し合わない ===== */
function teamLabel(no) { let s = ''; for (let n = Math.floor(no); n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
function evTeams(ev) {
  ev = ev || {};
  if (ev.tm) return Object.keys(ev.tm).filter((k) => ev.tm[k] && !ev.tm[k].gone).map((k) => { const no = +k.slice(1); return { no, name: ev.tm[k].name || teamLabel(no), fixed: ev.tm[k].fixed || '', mark: ev.tm[k].mark || '' }; }).sort((a, b) => a.no - b.no);
  if (ev.teams && ev.teams.length) return ev.teams.map((t, i) => ({ no: i + 1, name: t.name, fixed: t.fixed || '', mark: t.mark || '', legacy: true })); // 版8までの保存形式（表示だけ）
  return [];
}
function evAssign(ev, rm) {
  ev = ev || {}; rm = rm || rosterById();
  const out = {}, live = {};
  evTeams(ev).forEach((t) => { live[t.no] = 1; });
  if (ev.tm) Object.keys(ev.assign || {}).forEach((k) => { const n = ev.assign[k]; if (n && live[n]) out[resolveId(k, rm)] = n; });
  else if (ev.teams) ev.teams.forEach((t, i) => (t.members || []).forEach((m) => { out[resolveId(m.id, rm)] = i + 1; }));
  return out;
}
function teamName(no) { const t = evTeams(S.events[S.cur]).find((x) => x.no === no); return t ? t.name : teamLabel(no); }

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
  const items = ids.map((id) => rm[id]).filter(Boolean).map((r) => {
    const f = S.selFlags[r.id] || {}, it = { id: r.id, name: r.name, early: !!f.early, pair: String(f.pair || '').trim() };
    const upd = rosterDiff(r, f); if (upd) it.upd = upd;
    return it;
  });
  S.sel = {}; S.selFlags = {}; $('eq').value = '';
  doCheckin(items, 'tap');
  renderAll(); $('eq').focus();
  toast(items.map((i) => i.name).join('・') + ' さんを受付');
};
$('newAdd').onclick = () => {
  const name = $('eq').value.trim().replace(/\s+/g, ' ');
  if (!name) { $('eq').focus(); return; }
  if (S.roster.some((r) => !r.mergedInto && r.name === name)) { toast('「' + name + '」さんは名簿にいます。上の候補から選んでください', true); return; }
  const exp = $('pExp').checked;
  doCheckin([{ id: rid('n'), name, isNew: true, exp, level: exp ? +$('pLv').value : null, beg: !exp && $('pBeg').checked, early: $('pEarly').checked, pair: $('pPair').value.trim() }], 'new');
  $('eq').value = ''; $('pExp').checked = false; $('pBeg').checked = false; $('pEarly').checked = false; $('pPair').value = ''; $('pLv').value = String(LV_DEFAULT); syncNewFlags();
  renderAll(); $('eq').focus();
  toast(name + ' さんを受付（はじめて）');
};
$('eq').addEventListener('input', renderRoster);
/* はじめての人の印：経験豊富と初心者はどちらか一方。経験豊富なら評価を選ぶ */
function syncNewFlags() { $('pLvBox').hidden = !$('pExp').checked; }
$('pExp').addEventListener('change', () => { if ($('pExp').checked) $('pBeg').checked = false; syncNewFlags(); });
$('pBeg').addEventListener('change', () => { if ($('pBeg').checked) { $('pExp').checked = false; syncNewFlags(); } });
/* 名簿の値と違うところだけ、名簿の更新にする（同じなら書かない） */
function rosterDiff(r, f) {
  if (!('exp' in f)) return null;
  const exp = !!f.exp, beg = !exp && !!f.beg, level = exp ? (num(f.level) || LV_DEFAULT) : null;
  const d = {};
  if (exp !== !!r.exp) d.exp = exp;
  if (beg !== !!r.beg) d.beg = beg;
  if (exp && level !== (num(r.level) || (r.exp ? LV_DEFAULT : null))) d.level = level;
  if (!exp && r.exp) d.level = null;
  return Object.keys(d).length ? d : null;
}
const LVS = Array.from({ length: 10 }, (_, i) => i + 1);
const lvSelect = (attr, v, label) => '<select ' + attr + ' aria-label="' + esc(label) + '">' + LVS.map((n) => '<option' + (n === v ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>';
/* チェックした人の印（受付と同時に付ける）。名簿の経験豊富・初心者を最初の値にする */
let selSig = '';
function renderSel() {
  const rm = rosterById(), ids = Object.keys(S.sel).filter((id) => rm[id]);
  Object.keys(S.selFlags).forEach((id) => { if (!S.sel[id]) delete S.selFlags[id]; });
  ids.forEach((id) => { if (!S.selFlags[id]) { const r = rm[id]; S.selFlags[id] = { exp: !!r.exp, level: r.exp ? (num(r.level) || LV_DEFAULT) : LV_DEFAULT, beg: !r.exp && !!r.beg, early: false, pair: '' }; } });
  const sig = JSON.stringify(ids.map((id) => [id, S.selFlags[id].exp, S.selFlags[id].beg, S.selFlags[id].early, S.selFlags[id].level]));
  $('selBox').hidden = !ids.length;
  if (sig === selSig) return; selSig = sig;
  $('selList').innerHTML = ids.map((id) => { const f = S.selFlags[id], nm = rm[id].name; return '<li class="tmrow"><span class="nm">' + esc(nm) + '</span><span class="ctl">' +
    '<button type="button" class="tg" data-sf="exp" data-id="' + esc(id) + '" aria-pressed="' + f.exp + '">経験豊富</button>' +
    (f.exp ? lvSelect('data-slv="' + esc(id) + '"', f.level, nm + 'の評価') : '') +
    '<button type="button" class="tg" data-sf="beg" data-id="' + esc(id) + '" aria-pressed="' + f.beg + '">初心者</button>' +
    '<button type="button" class="tg" data-sf="early" data-id="' + esc(id) + '" aria-pressed="' + f.early + '">早帰り</button>' +
    '<input data-spair="' + esc(id) + '" value="' + esc(f.pair) + '" maxlength="10" placeholder="目印" aria-label="' + esc(nm) + 'の同じチーム希望の目印"></span></li>'; }).join('');
  $('selList').querySelectorAll('[data-sf]').forEach((b) => { b.onclick = () => {
    const f = S.selFlags[b.dataset.id], k = b.dataset.sf; f[k] = !f[k];
    if (k === 'exp' && f.exp) f.beg = false; if (k === 'beg' && f.beg) f.exp = false;
    renderSel();
  }; });
  $('selList').querySelectorAll('[data-slv]').forEach((x) => { x.onchange = () => { S.selFlags[x.dataset.slv].level = +x.value; }; });
  $('selList').querySelectorAll('[data-spair]').forEach((x) => { x.oninput = () => { S.selFlags[x.dataset.spair].pair = x.value; }; });
}
$('eq').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!$('newBox').hidden && $('newAdd').classList.contains('primary')) $('newAdd').click(); } });

/* ===== 表示 ===== */
function renderAll() { renderBar(); renderEventGate(); renderRoster(); renderDup(); renderList(); renderRejected(); renderPills(); renderEventBox(); if (S.phase === 'team' && !teamEditing()) renderTeam(); if (S.phase === 'game') renderGame(); if (S.phase === 'rec') renderRec(); if (S.phase === 'sys' && sysOk()) renderImport(); schedulePublish(); }
/* 入力中（目印・チーム名）は書き換えない */
function teamEditing() { const a = document.activeElement; return !!(a && a.closest && a.closest('#ph-team') && (a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type !== 'checkbox'))); }

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
  /* 古い版のままの端末（その端末からの変更はルールで断られる）と、参加者画面への反映 */
  const old = others.filter((d) => d.ver && d.ver !== VER && d.at && srvNow() - d.at < 6 * 3600000);
  const oldRow = old.length ? row(['off', '古い版のままの端末があります：' + old.map((d) => d.name + '（版 ' + d.ver + '）').join('・'), 'その端末でページを閉じて開き直してください（運営画面の下に 版 ' + VER + ' と出れば最新です）。古い版からのチームや結果の変更は断られます']) : '';
  const pe = PUBST.err;
  const pubRow = pe ? row(['off', pe === 'size' ? '参加者画面の中身が大きすぎて書けません' : pe === 'flip' ? '参加者画面の中身を、2台が交互に書き直しています' : '参加者画面に反映できていません（' + pe + '）',
    pe === 'size' ? '記録が増えすぎました（' + Math.round(PUBST.size / 1000) + 'KB）。開発担当に連絡してください' : pe === 'flip' ? 'どちらかの端末の表示が古いままです。ほかの端末でページを開き直してください' : '電波が戻れば自動でやり直します']) : '';
  $('statusBox').innerHTML = row(mine) + row(srv) + row(all) + oldRow + pubRow;
  if (old.length || pe) $('saveBar').insertAdjacentHTML('beforeend', '<div class="sb-row off"><span class="big"><span class="dot"></span>' + esc(old.length ? '古い版の端末があります' : '参加者画面に反映できていません') + '</span></div>');
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
  const cnt = personStats(false);
  const list = S.roster.filter((r) => !r.mergedInto && !done[r.id]).sort((a, b) => ((cnt[b.id] || {}).n || 0) - ((cnt[a.id] || {}).n || 0) || (a.id < b.id ? -1 : 1));
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
      '<small>' + (r.exp ? '経験豊富' : r.beg ? '初心者' : '名簿') + ((cnt[r.id] || {}).n ? '・参加' + cnt[r.id].n + '回' : '') + '</small></span></label>').join('')
    || '<span class="muted">' + (q ? (sameIn ? '「' + esc(sameIn.name) + '」さんは受付済みです' : '名簿に「' + esc(q) + '」に当てはまる人はいません')
      : S.roster.length ? '名簿の人は全員受付済みです' : S.sync.roster && !S.sync.roster.cache ? 'まだ名簿がありません。設定タブの「架空の名簿24人を入れる」で入れられます' : '名簿を読み込んでいます…') + '</span>';
  $('rList').querySelectorAll('[data-q]').forEach((c) => { c.onchange = () => { if (c.checked) S.sel[c.dataset.q] = 1; else delete S.sel[c.dataset.q]; updateQ(); }; });
  $('rNote').hidden = !list.length || !evOk;
  $('entryBox').hidden = !evOk;
  updateQ();
}
function updateQ() { const n = Object.keys(S.sel).length; $('qBar').hidden = !n; $('qAdd').textContent = 'チェックした' + n + '人を受付'; renderSel(); }

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
  const base = (S.events[S.cur] || {}).rev || '';
  if ((keep.isNew && !drop.isNew) || (keep.isNew === drop.isNew && (drop.tapAt || 0) < (keep.tapAt || 0))) [keep, drop] = [drop, keep];
  const show = () => {
    $('sheet').innerHTML = '<h2 id="sheetTitle">同じ人としてまとめる</h2>' +
      '<p>残す方：<b>' + esc(keep.name) + '</b>（' + (keep.isNew ? 'はじめて' : '名簿') + '・' + esc(keep.devName || '') + ' ' + hm(keep.tapAt) + '）<br>' +
      'まとめて消す方：<b>' + esc(drop.name) + '</b>（' + (drop.isNew ? 'はじめて' : '名簿') + '・' + esc(drop.devName || '') + ' ' + hm(drop.tapAt) + '）</p>' +
      '<p class="muted">まとめたあと、消す方への受付がほかの端末から遅れて届いても、受け付けません（人数は増えません）。早帰り・目印・チームは残す方へ引き継ぎます。</p>' +
      teamChoiceHtml(teamChoice(people().find((x) => x.id === keep.id), people().find((x) => x.id === drop.id)), keep.name, drop.name) +
      '<div class="actions"><button class="btn primary" id="mgYes" type="button">まとめる</button><button class="btn small" id="mgSwap" type="button">残す方を入れ替える</button><button class="btn ghost" id="mgNo" type="button">やめる</button></div>';
    $('ov').hidden = false;
    $('mgNo').onclick = closeSheet;
    $('mgSwap').onclick = () => { [keep, drop] = [drop, keep]; show(); };
    $('mgYes').onclick = () => { const t = $('mgTeam') ? +$('mgTeam').value : undefined; closeSheet(); doMerge(keep, drop, t, base); };
  };
  show();
}
/* まとめるときに、その回の早帰り・目印・チームをどう引き継ぐか（keepP・dropP は people() の人。受付していなければ null） */
function mergeCarry(keepP, dropP, team) {
  if (!dropP) return null;
  const early = !!((keepP && keepP.early) || dropP.early), pair = (keepP && keepP.pair) || dropP.pair || '';
  const t = team !== undefined ? team : ((keepP && keepP.team) || dropP.team || 0);
  const c = { early, pair, team: t };
  if (keepP) { const fix = {}; if (early !== !!keepP.early) fix.early = early; if (pair !== (keepP.pair || '')) fix.pair = pair; if (Object.keys(fix).length) c.fix = fix; }
  return c;
}
/* 2人とも別々のチームに入っているときだけ、残すチームを選んでもらう */
function teamChoice(keepP, dropP) { return keepP && dropP && keepP.team && dropP.team && keepP.team !== dropP.team ? [keepP.team, dropP.team] : null; }
function teamChoiceHtml(ch, keepName, dropName) {
  return ch ? '<div class="field"><label for="mgTeam">残すチーム（2人が別々のチームに入っています）</label><select class="input" id="mgTeam">' +
    '<option value="' + ch[0] + '">' + esc(teamName(ch[0])) + '（' + esc(keepName) + 'さんのチーム）</option><option value="' + ch[1] + '">' + esc(teamName(ch[1])) + '（' + esc(dropName) + 'さんのチーム）</option></select></div>' : '';
}
/* まとめの書き込みに渡すもの。チームが決まったあとは、画面を開いたときの rev（base）を付けて、その後にチームや結果が変われば断られるようにする */
function mergeOpts(keepP, dropP, team, base) {
  if (!dropP) return { carry: null };
  const carry = mergeCarry(keepP, dropP, team), teamsNow = evTeams(S.events[S.cur]).length > 0;
  return { carry, base: teamsNow ? base : null, dropCk: { name: dropP.name, early: !!dropP.early, pair: dropP.pair || '', isNew: !!dropP.isNew, tapAt: dropP.tapAt || null },
    dropTeam: dropP.team || 0, keepTeam: keepP ? keepP.team || 0 : 0, keepEarly: !!(keepP && keepP.early), keepPair: (keepP && keepP.pair) || '' };
}
function teamAlive(no) { return !no || evTeams(S.events[S.cur]).some((t) => t.no === no); }
function doMerge(keep, drop, team, base) {
  if (needEvent()) return;
  if (!teamAlive(team)) { toast('選んだチームは、ほかの端末で解散されていました。もう一度まとめてください', true); return; }
  const op = { id: rid('o'), type: 'merge', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: drop.id, name: drop.name }, { id: keep.id, name: keep.name }], tapAt: now() };
  const need = keep.rawId !== keep.id || !S.checkins.some((c) => c.id === keep.id);
  const ps = people(), keepP = ps.find((x) => x.id === keep.id) || null, dropP = ps.find((x) => x.id === drop.id) || null;
  const o = mergeOpts(keepP, dropP, team, base); op.guard = o.base != null;
  runOp(op, W.merge(ROOT, S.cur, keep, drop, op.id, need, op.tapAt, o));
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
  const exN = cs.filter((c) => rm[c.id] && rm[c.id].exp).length, bgN = cs.filter((c) => rm[c.id] && !rm[c.id].exp && rm[c.id].beg).length;
  const outPend = unsent().filter((o) => o.type === 'out' && o.eid === S.cur);
  $('pCount').innerHTML = '<span class="stat">' + cs.length + '人</span><span class="stat">経験豊富 ' + exN + '</span><span class="stat">初心者 ' + bgN + '</span>';
  $('plist').innerHTML = (cs.length ? cs.map((c) => {
    const r = rm[c.id] || {};
    const st = c.pending ? '<span class="st wait">送信待ち</span>' : '<span class="st ok">確認済み ' + hms(c.at) + '</span>';
    return '<li><button class="prow" data-c="' + esc(c.id) + '"><span class="pname">' + esc(c.name) + '</span>' +
      (c.isNew ? '<span class="tag cy">はじめて</span>' : '') + (r.exp ? '<span class="tag">経験豊富</span>' : r.beg ? '<span class="tag beg">初心者</span>' : '') + (c.early ? '<span class="tag early">早帰り</span>' : '') + (c.pair ? '<span class="tag pod">目印 ' + esc(c.pair) + '</span>' : '') + (c.team ? '<span class="tag cy">チーム ' + esc(teamName(c.team)) + '</span>' : '') +
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
    if (to !== it.id) return { id: to, name: (rm[to] || {}).name || it.name, early: it.early, pair: it.pair };
    return rm[it.id] ? { id: it.id, name: it.name, early: it.early, pair: it.pair } : it; // 名簿に入らなかった新しい人は、もう一度名簿ごと作る
  }).filter((it) => !here[it.id]);
  dropOp(id);
  if (items.length) doCheckin(items, items.some((i) => i.isNew) ? 'new' : 'tap'); else toast('もう受付済みでした');
  renderAll();
}

/* 受付の取り消し */
function openCheckin(id) {
  const c = people().find((x) => x.id === id); if (!c) return;
  const r = rosterById()[c.id] || {};
  const ev = S.events[S.cur] || {}, teams = evTeams(ev), canTeam = teams.length && !teams[0].legacy;
  const f = { exp: !!r.exp, level: r.exp ? (num(r.level) || LV_DEFAULT) : LV_DEFAULT, beg: !r.exp && !!r.beg, early: !!c.early, pair: String(c.pair || '') };
  const sw = (k, label) => '<label class="switch"><input type="checkbox" id="cf_' + k + '"' + (f[k] ? ' checked' : '') + '><span class="tr"></span>' + label + '</label>';
  const cnt = {}; people().forEach((p) => { if (p.team) cnt[p.team] = (cnt[p.team] || 0) + 1; });
  $('sheet').innerHTML = '<h2 id="sheetTitle">' + esc(c.name) + 'さん</h2>' +
    '<p>' + (c.pending ? 'まだ送信待ちです。電波が戻れば自動で送られます。' : esc(hms(c.at)) + 'に' + esc(c.devName || '') + 'で受付済み（サーバーで確認済み）。') + '</p>' +
    '<div class="field"><label for="cf_name">名前</label><input class="input" id="cf_name" maxlength="30" autocomplete="off" value="' + esc(c.name) + '"></div>' +
    '<div class="cf-grid">' + sw('exp', '経験豊富') + '<label class="cf-lv" id="cfLvBox"' + (f.exp ? '' : ' hidden') + '>評価 ' + lvSelect('id="cf_level"', f.level, c.name + 'の評価') + '<small class="muted">10がいちばん強い</small></label>' +
    sw('beg', '初心者') + sw('early', '早めに帰る') + '</div>' +
    '<div class="field"><label for="cf_pair">同じチーム希望の目印</label><input class="input" id="cf_pair" maxlength="10" autocomplete="off" value="' + esc(f.pair) + '" placeholder="空にすると解除"></div>' +
    (canTeam ? '<div class="field"><label for="cf_team">チーム</label><select class="input" id="cf_team"><option value="0">チームなし</option>' +
      teams.map((t) => '<option value="' + t.no + '"' + (t.no === c.team ? ' selected' : '') + '>' + esc(t.name) + '（' + (cnt[t.no] || 0) + '人）</option>').join('') + '</select></div>' : '') +
    '<p class="muted" style="margin:0">経験豊富・評価・初心者は名簿に残り、次の回にも使います。早めに帰る・目印・チームはこの回だけです。参加者の画面には出ません。</p>' +
    '<p class="err" id="cfErr" aria-live="polite"></p>' +
    '<div class="actions"><button class="btn primary" id="cfSave" type="button">保存</button><button class="btn ghost" id="cxNo" type="button">閉じる</button></div>' +
    '<div class="actions cf-danger"><button class="btn small ghost" id="cxYes" type="button">この人の受付を取り消す</button></div>';
  $('ov').hidden = false;
  const ex = $('cf_exp'), bg = $('cf_beg');
  ex.onchange = () => { if (ex.checked) bg.checked = false; $('cfLvBox').hidden = !ex.checked; };
  bg.onchange = () => { if (bg.checked) { ex.checked = false; $('cfLvBox').hidden = true; } };
  $('cxNo').onclick = closeSheet;
  $('cfSave').onclick = () => {
    const nn = $('cf_name').value.trim().replace(/\s+/g, ' ').slice(0, 30);
    const err = (m) => { $('cfErr').textContent = m; };
    if (!nn) return err('名前を入れてください');
    if (nn !== c.name) {
      if (people().some((x) => x.id !== c.id && norm(x.name) === norm(nn))) return err('「' + nn + '」さんはもう受付されています。別の名前にしてください');
      if (S.roster.some((x) => !x.mergedInto && x.id !== c.id && norm(x.name) === norm(nn))) return err('名簿に「' + nn + '」さんがすでにいます。同じ人なら、この受付を取り消して名簿から受付し直してください');
    }
    const nf = { exp: ex.checked, level: +$('cf_level').value, beg: bg.checked, early: $('cf_early').checked, pair: $('cf_pair').value.trim() };
    const nt = canTeam ? +$('cf_team').value : c.team;
    if (needEvent()) return;
    const w = [], upd = rosterDiff(r, nf) || {}, cu = {};
    if (nn !== c.name) { upd.name = nn; upd.norm = norm(nn); cu.name = nn; }
    if (Object.keys(upd).length) w.push({ op: 'update', path: ROOT + '/roster/' + c.id, data: upd });
    if (nf.early !== !!c.early) cu.early = nf.early;
    if (nf.pair !== String(c.pair || '').trim()) cu.pair = nf.pair;
    if (Object.keys(cu).length) w.push({ op: 'update', path: ROOT + '/events/' + S.cur + '/checkins/' + c.rawId, data: cu });
    if (nt !== c.team) w.push({ op: 'update', path: ROOT + '/events/' + S.cur, data: { ['assign.' + c.id]: nt || null } });
    closeSheet();
    if (!w.length) { toast('変更はありませんでした'); return; }
    const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: ev.name || '', items: [{ id: c.id, name: nn }], tapAt: now() };
    runOp(op, w); T.preview = null;
    toast(nn + ' さんを直しました' + (nt !== c.team ? '（' + (nt ? teamName(nt) + 'チームへ' : 'チームなし') + '）' : ''));
  };
  /* 取り消しは2回押して確定（11/22版と同じ。印を直したい人と押し間違えないように） */
  let armed = false;
  $('cxYes').onclick = () => {
    if (!armed) { armed = true; $('cxYes').textContent = 'もう一度押すと取り消します'; $('cxYes').classList.remove('ghost'); $('cxYes').classList.add('primary'); return; }
    closeSheet();
    if (needEvent()) return;
    const raws = S.checkins.filter((x) => resolveId(x.id, rosterById()) === c.id).map((x) => x.id);
    const op = { id: rid('o'), type: 'out', eid: S.cur, ename: ev.name || '', items: [{ id: c.id, name: c.name }], tapAt: now() };
    const w = W.cancel(ROOT, S.cur, raws);
    if (c.team) w.push({ op: 'update', path: ROOT + '/events/' + S.cur, data: { ['assign.' + c.id]: null } });
    runOp(op, w);
    toast(c.name + ' さんの受付を取り消しました（送信待ち）');
  };
}
function closeSheet() { $('ov').hidden = true; clearInterval(revealTimer); }
$('ov').addEventListener('click', (e) => { if (e.target === $('ov')) closeSheet(); });

/* ===== 開催回 ===== */
$('courtSave').onclick = () => {
  const n = Math.floor(Number($('courtIn').value.normalize('NFKC')));
  if (!(n >= 1 && n <= 50)) { toast('コート数は1〜50の数字で入れてください', true); return; }
  teamOp('コート数 ' + n + '面', { courts: n }); toast('コート数を' + n + '面にしました');
};
function renderEventBox() {
  if (document.activeElement !== $('courtIn')) $('courtIn').value = courtsOf(S.events[S.cur]);
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
    (cur ? '<p><b id="evSum">' + esc(closingSummary()) + '</b></p><p class="err" id="evErr" aria-live="polite"></p>' : '') +
    '<div class="field"><label for="evNameIn">回の名前</label><input class="input" id="evNameIn" maxlength="30" value="' + esc(defaultEventName()) + '"></div>' +
    '<div class="actions"><button class="btn primary" id="evYes" type="button"' + (ok ? '' : ' disabled') + '>始める</button><button class="btn ghost" id="evNo" type="button">やめる</button></div>';
  $('ov').hidden = false;
  $('evNo').onclick = () => { newEvSheet = null; closeSheet(); };
  $('evYes').onclick = async () => {
    const seen = newEvSheet ? newEvSheet.cur : S.cur;
    if (seen !== S.cur) { newEvSheet = null; closeSheet(); toast('ほかの端末で回が変わりました。いまの回を表示します', true); return; }
    if (!canStartEvent() || unsent().length) { newEvSheet = null; closeSheet(); toast('開催回と送信状況を確認してから、もう一度開いてください', true); return; }
    const name = $('evNameIn').value.trim() || defaultEventName();
    let close = null;
    if (seen) {
      const btn = $('evYes'), label = btn.textContent;
      btn.disabled = true; btn.textContent = 'サーバーで確かめています…';
      try { close = await serverClosing(seen); } catch (e) { close = undefined; }
      if (!newEvSheet || $('ov').hidden) return; // 待つ間に閉じられた
      btn.disabled = false; btn.textContent = label;
      if (close === undefined) { $('evErr').textContent = 'サーバーで確かめられませんでした。電波の良い場所でもう一度押してください'; return; }
      if (!close) { newEvSheet = null; closeSheet(); toast('この回は、ほかの端末で締められていました', true); return; }
      /* 画面に出していた内容と違えば、サーバーの内容に直して、もう一度押してもらう */
      const fresh = closingSummary(close);
      if (fresh !== $('evSum').textContent) { $('evSum').textContent = fresh; $('evErr').textContent = 'サーバーの最新の内容で計算し直しました。上の内容を確かめて、もう一度押してください'; return; }
    }
    newEvSheet = null;
    const d = new Date(), e = 'e' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + Math.random().toString(36).slice(2, 6);
    const writes = W.newEvent(ROOT, seen, Boolean(seen), e, name, seen && S.events[seen] ? courtsOf(S.events[seen]) : 0, close);
    closeSheet();
    B.commit(writes).then(() => { toast('「' + name + '」を始めました'); if (seen) setTimeout(() => saveBackup(true), 3000); }, async (err) => {
      if ((err && err.code) === 'permission-denied' && seen) {
        try { const now2 = await B.getServer(ROOT + '/events/' + seen); if (now2 && now2.status === 'open') { toast('締める直前に、ほかの端末から結果やチームの変更が届きました。最新の順位で、もう一度「新しい回を始める」を押してください', true); return; } } catch (e) {}
      }
      toast((err && err.code) === 'permission-denied' ? 'ほかの端末で先に回が始まったため、始めませんでした。いまの回を表示します' : '始められませんでした（' + ((err && err.code) || '') + '）', true);
    });
  };
}
function defaultEventName() { const d = new Date(); return (d.getMonth() + 1) + '/' + d.getDate() + ' 第' + (Object.keys(S.events).length + 1) + '回（テスト）'; }
$('evNew').onclick = openNewEvent;

/* ===== チーム抽選 =====
   - 対象：いまの回で受付済みの人（サーバーで確認できてから）
   - 同じチーム希望の目印（受付ごとに付ける）が同じ人は、その人たちだけで1チーム
   - 残りは人数差1人以内（1チーム2〜4人）。条件がぶつかったときの優先順（2026-11-24 丸岡さん確認）：
     早帰りの人が抜けると1人だけ残るチームを作らない ＞ 経験豊富の人数をそろえる ＞ 実績上位を別々のチームへ ＞ 初心者を散らす ＞ 早帰りを散らす ＞ 評価（1〜10）の合計をそろえる
     全員が早帰りのチーム（帰るときにチームごと解散）は避けない
   - 結果は開催回の記録に保存（運営だけが見る場所）。チーム名の初期値は A, B, C…
*/
const TEAM_MIN = 2, TEAM_MAX = 4, LV_DEFAULT = 5;
const EVEN_ONLY = true; // 月いちモルックはチーム数を偶数にする（総当たりで休みのチームを出さない）
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const T = { count: 0, preview: null, msg: '', draft: {} }; // draft：入力中の目印（描き直しても消えないように）
function rint(n) { const a = new Uint32Array(1); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : (a[0] = Math.floor(Math.random() * 4294967296)); return a[0] % n; }
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = rint(i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; }
/* 実績上位：前回の覇王戦より後の大会で、優勝を2点・3位以内（優勝以外）を1点として数え、
   受付済みの人のうち点の多い順にチーム数と同じ人数（同点は含める）。覇王戦がまだなければ、すべての記録で数える。
   1チームに1人ずつになるように散らす（経験豊富の人数をそろえるのが先） */
function lastHaohDate() { return S.hist.filter((h) => h.kind === 'haoh').reduce((m, h) => ((h.date || '') > m ? h.date : m), ''); }
function topPoints() {
  const st = personStats(false, lastHaohDate()), out = {};
  Object.keys(st).forEach((id) => { const o = st[id]; out[id] = o.win * 2 + (o.top3 - o.win); });
  return out;
}
function markTop(ps, K) {
  const pts = ps.map((p) => p.pts).filter((x) => x > 0).sort((a, b) => b - a);
  const cut = K > 0 && pts.length ? pts[Math.min(K, pts.length) - 1] : Infinity;
  ps.forEach((p) => { p.top = p.pts > 0 && p.pts >= cut; });
  return ps;
}
/* 抽選に使う参加者（受付済み＋名簿の経験豊富・評価・初心者＋その回の受付の早帰り・目印＋実績） */
function drawPeople() {
  const rm = rosterById(), pts = topPoints();
  return people().map((p) => { const r = rm[p.id] || {}; return { id: p.id, rawId: p.rawId, name: p.name, exp: !!r.exp, level: r.exp ? (num(r.level) || LV_DEFAULT) : 0, beg: !r.exp && !!r.beg, early: !!p.early, pair: String(p.pair || '').trim(), pending: p.pending, team: p.team || 0, pts: pts[p.id] || 0, top: false }; });
}
/* 目印ごとのまとまり（2人以上）と、目印が1人だけの人。
   「ほかの人が入ってもよい」（本人に確認済み）にした2〜3人のまとまりは open：同じチームに入れたうえで、ほかの人で埋める */
const OPEN_MAX = 3;
function openMarks() { return (S.events[S.cur] || {}).openMarks || {}; }
function pairGroups(ps, opens) {
  const om = opens || openMarks(), by = {};
  ps.forEach((p) => { if (p.pair) (by[norm(p.pair)] = by[norm(p.pair)] || { key: norm(p.pair), label: p.pair, members: [] }).members.push(p); });
  const groups = [], lonely = [];
  Object.values(by).forEach((g) => { if (g.members.length >= 2) { g.open = !!om[g.key] && g.members.length <= OPEN_MAX; groups.push(g); } else lonely.push(g.members[0]); });
  return { groups, closed: groups.filter((g) => !g.open), opened: groups.filter((g) => g.open), lonely };
}
/* 選べるチーム数と、そのときの人数の内訳 */
function teamOptions(ps, opens) {
  const { groups, closed, opened } = pairGroups(ps, opens);
  const G = closed.length, inG = closed.reduce((s, g) => s + g.members.length, 0), R = ps.length - inG;
  const out = [];
  if (groups.some((g) => g.members.length > TEAM_MAX)) return { groups, out, why: '同じ目印の人が' + TEAM_MAX + '人より多いまとまりがあります（' + groups.filter((g) => g.members.length > TEAM_MAX).map((g) => g.label + '：' + g.members.length + '人').join('・') + '）' };
  const osz = opened.map((g) => g.members.length);
  /* 全員が「その人たちだけのチーム」の目印のとき（残りの人がいない）も、偶数ならそのまま組める */
  if (R === 0 && !osz.length && G >= 2 && (!EVEN_ONLY || G % 2 === 0)) out.push({ T: G, K: 0, base: 0, extra: 0, fixed: closed.map((g) => g.members.length), opened: [] });
  for (let K = 1; K <= R; K++) {
    const base = Math.floor(R / K), extra = R % K;
    if (base < TEAM_MIN || base + (extra ? 1 : 0) > TEAM_MAX) continue;
    if (EVEN_ONLY && (G + K) % 2) continue;
    /* ほかの人も可のまとまりが、それぞれ別のチームに収まるか */
    if (osz.length > K || osz.some((n) => n > base + (extra ? 1 : 0)) || osz.filter((n) => n > base).length > extra) continue;
    out.push({ T: G + K, K, base, extra, fixed: closed.map((g) => g.members.length), opened: opened.map((g) => ({ label: g.label, n: g.members.length })) });
  }
  return { groups, out, why: out.length ? '' : '人数が足りないか、目印の組み方で、偶数のチーム数（1チーム' + TEAM_MIN + '〜' + TEAM_MAX + '人）に分けられません' };
}
function sizesText(o) {
  const parts = o.fixed.map((n) => '希望' + n + '人');
  if (o.extra) parts.push((o.base + 1) + '人×' + o.extra);
  if (o.K - o.extra) parts.push(o.base + '人×' + (o.K - o.extra));
  return parts.join('＋') + ((o.opened || []).length ? '（' + o.opened.map((g) => '目印「' + g.label + '」の' + g.n + '人').join('・') + 'は、ほかの人と同じチーム）' : '');
}
/* 残りの人を K チームに分ける。経験豊富を蛇行順で配って人数をそろえ、入れ替えで評価の合計の差を小さくする。
   何通りも作って、いちばん良いものに近い結果の中から1つを選ぶ（毎回同じにならないように） */
function balance(rest, K, seeds) {
  seeds = seeds || [];
  const R = rest.length, base = Math.floor(R / K), extra = R % K;
  const locked = {}; seeds.forEach((g) => g.forEach((p) => { locked[p.id] = 1; }));
  /* 優先順どおりに、上の条件が1つでも悪くなる組み方は、下の条件がどれだけ良くても選ばない（桁を分けて足す） */
  const spread = (arr) => Math.max(...arr) - Math.min(...arr);
  const score = (teams) => {
    const stay = teams.reduce((s, t) => { const e = t.filter((p) => p.early).length; return s + (e && t.length - e === 1 ? 1 : 0); }, 0);
    const exps = spread(teams.map((t) => t.filter((p) => p.exp).length));
    const tops = spread(teams.map((t) => t.filter((p) => p.top).length));
    const begs = spread(teams.map((t) => t.filter((p) => p.beg).length));
    const early = teams.reduce((s, t) => s + Math.max(0, t.filter((p) => p.early).length - 1), 0);
    const lv = spread(teams.map((t) => t.reduce((s, p) => s + p.level, 0)));
    return stay * 1e10 + exps * 1e8 + tops * 1e6 + begs * 1e4 + Math.min(early, 99) * 100 + Math.min(lv, 99);
  };
  const tries = [];
  for (let n = 0; n < 300; n++) {
    const caps = shuffle(Array.from({ length: K }, (_, i) => base + (i < extra ? 1 : 0)));
    const teams = caps.map(() => []);
    /* ほかの人も可のまとまりを、先に別々のチームへ（大きいまとまりから、入る余地のあるチームへ） */
    seeds.slice().sort((a, b) => b.length - a.length).forEach((g) => {
      const fit = teams.map((t, i) => i).filter((i) => !teams[i].length && caps[i] >= g.length);
      teams[fit[rint(fit.length)]].push(...g);
    });
    const exps = shuffle(rest.filter((p) => p.exp && !locked[p.id])).sort((a, b) => b.level - a.level);
    const order = shuffle(Array.from({ length: K }, (_, i) => i));
    let k = 0, dir = 1;
    exps.forEach((p) => {
      let guard = 0;
      while (teams[order[k]].length >= caps[order[k]] && guard++ < K * 2) { k += dir; if (k >= K || k < 0) { dir = -dir; k += dir; } }
      teams[order[k]].push(p);
      k += dir; if (k >= K || k < 0) { dir = -dir; k += dir; }
    });
    /* 経験豊富でない人：早帰り・実績上位・初心者の人を先に、同じ印の人が少ない・人数の多いチームへ */
    const w = (p) => (p.early ? 4 : 0) + (p.top ? 2 : 0) + (p.beg ? 1 : 0);
    const others = shuffle(rest.filter((p) => !p.exp && !locked[p.id])).sort((a, b) => w(b) - w(a));
    others.forEach((p) => {
      const open = teams.map((t, i) => i).filter((i) => teams[i].length < caps[i]);
      const cnt = (i) => teams[i].filter((x) => (p.early && x.early) || (p.top && x.top) || (p.beg && x.beg)).length;
      const pick = w(p) ? open.sort((a, b) => cnt(a) - cnt(b) || caps[b] - caps[a] || rint(3) - 1)[0] : open[rint(open.length)];
      teams[pick].push(p);
    });
    /* 経験豊富どうしの入れ替えで実績上位と評価の合計を、それ以外どうしの入れ替えで実績上位・初心者・早帰りの散らばりをそろえる */
    let best = score(teams), improved = true, loops = 0;
    while (improved && loops++ < 20) {
      improved = false;
      for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) {
        for (let i = 0; i < teams[a].length; i++) for (let j = 0; j < teams[b].length; j++) {
          const x = teams[a][i], y = teams[b][j];
          if (locked[x.id] || locked[y.id]) continue;
          if (x.exp === y.exp && x.level === y.level && x.beg === y.beg && x.early === y.early && x.top === y.top) continue;
          teams[a][i] = y; teams[b][j] = x;
          const s = score(teams);
          if (s < best) { best = s; improved = true; } else { teams[a][i] = x; teams[b][j] = y; }
        }
      }
    }
    /* 人数の多いチームから1人少ないチームへ、経験豊富でない人を動かす（チームの人数の組み合わせは変わらない） */
    for (let guard = 0; guard < 30; guard++) {
      let moved = false;
      for (let a = 0; a < K && !moved; a++) for (let b = 0; b < K && !moved; b++) {
        if (a === b || teams[a].length - teams[b].length !== 1) continue;
        for (let i = 0; i < teams[a].length && !moved; i++) {
          const x = teams[a][i]; if (locked[x.id]) continue;
          teams[a].splice(i, 1); teams[b].push(x);
          const sc = score(teams);
          if (sc < best) { best = sc; moved = true; } else { teams[b].pop(); teams[a].splice(i, 0, x); }
        }
      }
      if (!moved) break;
    }
    tries.push({ teams, s: best });
  }
  const min = Math.min(...tries.map((t) => t.s));
  const near = tries.filter((t) => t.s <= min + 2); // 評価の合計の差が2点以内の違いだけなら、毎回同じにならないよう選び分ける
  return near[rint(near.length)].teams;
}
function drawTeams(ps, opt, opens) {
  const { closed, opened } = pairGroups(ps, opens);
  const inG = {}; closed.forEach((g) => g.members.forEach((m) => { inG[m.id] = 1; }));
  const rest = ps.filter((p) => !inG[p.id]);
  const mark = (m) => { const g = opened.find((x) => x.members.some((p) => m.some((q) => q.id === p.id))); return g ? g.label : ''; };
  const teams = closed.map((g) => ({ fixed: g.label, mark: '', members: g.members }))
    .concat(opt.K ? balance(rest, opt.K, opened.map((g) => g.members)).map((m) => ({ fixed: '', mark: mark(m), members: m })) : []);
  return shuffle(teams).map((t, i) => ({ name: LETTERS[i] || ('T' + (i + 1)), fixed: t.fixed, mark: t.mark, members: shuffle(t.members) }));
}
/* 結果の点検：全員が1回ずつ・目印のまとまり・人数・経験豊富の偏り */
function checkTeams(teams, ps, opens) {
  const seen = {}, dup = [], res = [];
  teams.forEach((t) => t.members.forEach((m) => { if (seen[m.id]) dup.push(m.name); seen[m.id] = 1; }));
  const missing = ps.filter((p) => !seen[p.id]).map((p) => p.name);
  const extra = Object.keys(seen).filter((id) => !ps.some((p) => p.id === id));
  res.push([!dup.length && !missing.length && !extra.length, ps.length + '人全員が、重複なく1回ずつ入っています' + (dup.length ? '（重複：' + dup.join('・') + '）' : '') + (missing.length ? '（入っていない：' + missing.join('・') + '）' : '') + (extra.length ? '（受付にいない人が' + extra.length + '人）' : '')]);
  const { groups } = pairGroups(ps, opens);
  groups.forEach((g) => {
    const t = teams.find((x) => x.members.some((m) => m.id === g.members[0].id));
    const together = t && g.members.every((m) => t.members.some((x) => x.id === m.id));
    if (g.open) res.push([together, '目印「' + g.label + '」の' + g.members.length + '人は ' + (t ? t.name : '?') + ' チームに一緒（ほかの人も可）']);
    else res.push([together && t.members.length === g.members.length, '目印「' + g.label + '」の' + g.members.length + '人だけで ' + (t ? t.name : '?') + ' チーム']);
  });
  const normal = teams.filter((t) => !t.fixed), sz = normal.map((t) => t.members.length);
  if (normal.length) res.push([Math.max(...sz) - Math.min(...sz) <= 1 && Math.min(...sz) >= TEAM_MIN, 'ほかのチームは ' + Math.min(...sz) + (Math.max(...sz) !== Math.min(...sz) ? '〜' + Math.max(...sz) : '') + '人（人数差1人以内' + (Math.min(...sz) < TEAM_MIN ? '・1チーム' + TEAM_MIN + '人以上' : '') + '）']);
  const ex = normal.map((t) => t.members.filter((m) => m.exp).length), lv = normal.map((t) => t.members.reduce((s, m) => s + m.level, 0));
  const lv2 = teams.map((t) => { const e = t.members.filter((m) => m.early).length; return { name: t.name, e, stay: t.members.length - e }; }).filter((x) => x.e);
  if (lv2.length) {
    const bad = lv2.filter((x) => x.stay === 1), dis = lv2.filter((x) => x.stay === 0);
    res.push([!bad.length, (bad.length ? '早めに帰る人が抜けると1人になるチームがあります：' + bad.map((x) => x.name).join('・') + '。入れ替えてください'
      : '早めに帰る人が抜けても、どのチームも2人以上残ります') + (dis.length ? '（' + dis.map((x) => x.name).join('・') + 'は全員が早めに帰るので、帰るときにチームごと解散）' : ''), 'warn']);
  }
  const tp = normal.map((t) => t.members.filter((m) => m.top).length);
  if (normal.length && Math.max(...tp)) res.push([Math.max(...tp) - Math.min(...tp) <= 1, '実績上位は各チーム ' + Math.min(...tp) + (Math.max(...tp) !== Math.min(...tp) ? '〜' + Math.max(...tp) : '') + '人']);
  const bg = normal.map((t) => t.members.filter((m) => m.beg).length);
  if (normal.length && Math.max(...bg)) res.push([Math.max(...bg) - Math.min(...bg) <= 1, '初心者は各チーム ' + Math.min(...bg) + (Math.max(...bg) !== Math.min(...bg) ? '〜' + Math.max(...bg) : '') + '人']);
  if (normal.length) res.push([Math.max(...ex) - Math.min(...ex) <= 1, '経験豊富は各チーム ' + Math.min(...ex) + (Math.max(...ex) !== Math.min(...ex) ? '〜' + Math.max(...ex) : '') + '人・評価の合計 ' + Math.min(...lv) + '〜' + Math.max(...lv)]);
  return res;
}
/* 抽選に使った条件（受付の顔ぶれ・経験豊富と評価・初心者・早帰り・目印・ほかの人も可）。表示中の結果は、これが変わったら使わない */
function drawSig(ps) { return JSON.stringify([ps.map((p) => [p.id, p.exp, p.level, p.beg, p.early, p.pts, norm(p.pair || '')].join('|')).sort(), Object.keys(openMarks()).sort()]); }
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
  if (T.preview && drawSig(ps) !== T.sig) { T.preview = null; T.msg = '抽選のあとに受付や印（経験豊富・評価・初心者・早帰り・目印）が変わったので、表示していた結果は取り消しました。もう一度抽選してください'; }
  const { groups, lonely } = pairGroups(ps);
  $('tmEv').textContent = ev.name || '';
  $('tmEv').hidden = !ev.name;
  const exN = ps.filter((p) => p.exp).length;
  const why = teamReady();
  const others = S.devices.filter((d) => d.id !== DEV && ((d.pending || 0) > 0 || !d.at || srvNow() - d.at > STALE_MS));
  $('tmGate').hidden = !why && !others.length && !lonely.length;
  $('tmGate').innerHTML = (why ? '<b>' + esc(why) + '</b>' : '') +
    (others.length ? '<p style="margin:4px 0 0">' + esc(others.map((d) => d.name + 'の最後の報告：' + ago(srvNow() - (d.at || 0)) + '・送信待ち' + (d.pending || 0) + '件').join('／')) + '。抽選の前に、その端末の送信待ちが0件か確かめてください。</p>' : '') +
    (lonely.length ? '<p style="margin:4px 0 0">目印が1人だけ：' + esc(lonely.map((p) => p.name + '（' + p.pair + '）').join('・')) + '。この人は普通に抽選します。</p>' : '');
  $('tmMarks').innerHTML = groups.map((g) => '<li>目印「' + esc(g.label) + '」' + g.members.length + '人（' + esc(g.members.map((m) => m.name).join('・')) + '）' +
    (g.members.length <= OPEN_MAX ? '<br><label class="switch" style="margin-top:4px"><input type="checkbox" data-open="' + esc(g.key) + '"' + (g.open ? ' checked' : '') + '><span class="tr"></span>ほかの人が入ってもよい（本人に確認済み）</label>' : '') +
    '<br><small class="muted">' + (g.open ? 'この人たちを同じチームに入れ、ほかの人で人数をそろえます' : 'この人たちだけで1チームにします') + '</small></li>').join('');
  $('tmMarks').hidden = !groups.length;
  $('tmMarks').querySelectorAll('[data-open]').forEach((c) => { c.onchange = () => setOpenMark(c.dataset.open, c.checked); });
  const { out, why: optWhy } = teamOptions(ps);
  if (!out.some((o) => o.T === T.count)) {
    /* はじめは、2人のチームができない数のうち、1チーム3人にいちばん近い数を選んでおく */
    const two = (o) => (o.K && o.base < 3) || o.fixed.some((n) => n < 3);
    const pick = out.slice().sort((a, b) => two(a) - two(b) || Math.abs(ps.length / a.T - 3) - Math.abs(ps.length / b.T - 3))[0];
    T.count = pick ? pick.T : 0;
  }
  const cur = out.find((o) => o.T === T.count);
  const savedN = evTeams(ev).length;
  markTop(ps, T.preview ? T.preview.length : savedN || T.count);
  const topN = ps.filter((p) => p.top).length, hd = lastHaohDate();
  $('tmTarget').textContent = '対象：受付済み ' + ps.length + '人（経験豊富 ' + exN + '人' + (topN ? '・実績上位 ' + topN + '人' : '') + (groups.length ? '・同じチーム希望 ' + groups.map((g) => '「' + g.label + '」' + g.members.length + '人').join('・') : '') + '）。' +
    '実績上位は、' + (hd ? '前回の覇王戦（' + fmtDate(hd) + '）以降' : 'これまで') + 'の大会の成績（優勝2点・3位以内1点）が多い順に、チーム数と同じ人数です';
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
    '<div class="tm-meta">' + t.members.length + '人' + (t.fixed ? '・同じチーム希望「' + esc(t.fixed) + '」' : '') + (t.mark ? '・目印「' + esc(t.mark) + '」の人とほかの人' : '') + '・経験豊富 ' + ex + '人・評価計 ' + lv + '</div>' +
    '<ul class="tm-mem">' + t.members.map((m) => '<li>' + esc(m.name) + (m.exp ? '<span class="lv">経験' + m.level + '</span>' : m.beg ? '<span class="tag beg">初心者</span>' : '') + (m.top ? '<span class="tag top">実績</span>' : '') + (m.early ? '<span class="tag early">早帰り</span>' : '') + '</li>').join('') + '</ul></div>';
}
function checkLine(c) { return '<li>' + (c[0] ? '✓ ' : c[2] === 'warn' ? '⚠ ' : '✗ ') + esc(c[1]) + '</li>'; }
function renderTeamResult(ps) {
  const ev = S.events[S.cur] || {};
  const saved = evTeams(ev);
  $('tmResult').hidden = !T.preview && !saved.length;
  if ($('tmResult').hidden) { $('tmResAct').innerHTML = ''; $('tmTeams').innerHTML = ''; $('tmChecks').innerHTML = ''; return; }
  if (T.preview) {
    const byId = {}; ps.forEach((p) => { byId[p.id] = p; });
    const teams = T.preview.map((t) => ({ ...t, members: t.members.map((m) => ({ ...(byId[m.id] || { exp: false, level: 0 }), id: m.id, name: m.name })) }));
    $('tmResH').textContent = '抽選の結果（まだ保存していません）';
    $('tmResSt').textContent = '';
    $('tmChecks').innerHTML = checkTeams(teams, ps).map(checkLine).join('');
    $('tmTeams').innerHTML = teams.map((t, i) => teamCard(t, i, true)).join('');
    $('tmTeams').querySelectorAll('[data-tn]').forEach((inp) => { inp.oninput = () => { T.preview[+inp.dataset.tn].name = inp.value.trim() || LETTERS[+inp.dataset.tn]; }; });
    $('tmResAct').innerHTML = '<button class="btn primary" id="tmSave" type="button">この結果で決める</button><button class="btn" id="tmAgain" type="button">もう一度抽選</button><button class="btn ghost" id="tmCancel" type="button">やめる</button>';
    $('tmSave').onclick = saveTeams;
    $('tmAgain').onclick = doDraw;
    $('tmCancel').onclick = () => { T.preview = null; renderTeam(); };
    return;
  }
  if (saved.length) renderTeamAdjust(ps, ev, saved);
}
/* 決まったチームの調整（11/22版と同じ：チーム名・メンバーの付け替え・解散は2回押し・まだ入っていない人・チームの追加） */
function renderTeamAdjust(ps, ev, saved) {
  const legacy = saved[0].legacy;
  const teams = saved.map((t) => ({ ...t, members: ps.filter((p) => p.team === t.no) }));
  const none = ps.filter((p) => !p.team);
  $('tmResH').textContent = '決まったチーム';
  $('tmResSt').textContent = saved.length + 'チーム・' + ps.length + '人' + (ev.drawnAt ? '・抽選 ' + hm(ev.drawnAt) + (ev.drawBy ? ' ' + ev.drawBy : '') : '');
  const checks = checkTeams(teams, ps);
  $('tmChecks').innerHTML = (saved.length % 2 ? '<li><b class="warnline">いま ' + saved.length + 'チーム（奇数）です。1つ追加するか解散して、偶数にしてください。</b></li>' : '') +
    (none.length ? '<li><b class="warnline">まだチームに入っていない人が ' + none.length + '人います。名前を押してチームを選んでください。</b></li>' : '') +
    checks.slice(1).map((c) => checkLine([c[0], c[1], 'warn'])).join('') + // 確定後の調整は運営の判断なので、外れても⚠（確かめる）にする
    (legacy ? '<li><b>前の版の形式で保存されたチームです。直すときは抽選し直してください。</b></li>' : '');
  const mem = (m) => '<button type="button" class="mem" data-pc="' + esc(m.id) + '">' + esc(m.name) +
    (m.exp ? '<span class="lv">経験' + m.level + '</span>' : m.beg ? '<span class="tag beg">初心者</span>' : '') + (m.top ? '<span class="tag top">実績</span>' : '') + (m.early ? '<span class="tag early">早帰り</span>' : '') + (m.pending ? '<span class="tag">送信待ち</span>' : '') + '</button>';
  $('tmTeams').innerHTML = teams.map((t) => {
    const e = t.members.filter((m) => m.early).length, stay = t.members.length - e, lv = t.members.reduce((s, m) => s + (m.level || 0), 0);
    return '<div class="tcard' + (t.members.length < 2 || (e && stay === 1) ? ' solo' : '') + (t.fixed ? ' fixed' : '') + '"><div class="thd">' +
      (legacy ? '<span class="tm-name">' + esc(t.name) + '</span>' : '<input class="input tm-name" data-rn="' + t.no + '" value="' + esc(t.name) + '" maxlength="12" aria-label="' + esc(t.name) + 'チームの名前">') +
      '<span class="tm-meta">' + t.members.length + '人</span></div>' +
      '<div class="tm-meta">' + (t.fixed ? '同じチーム希望「' + esc(t.fixed) + '」・' : '') + '経験豊富 ' + t.members.filter((m) => m.exp).length + '人・評価計 ' + lv + '</div>' +
      '<div class="mems">' + (t.members.length ? t.members.map(mem).join('') : '<span class="muted">メンバーがいません</span>') + '</div>' +
      (e ? '<div class="tm-meta">' + (stay === 1 ? '<span class="warnline">早めに帰る人が抜けると1人になります</span>' : '早めに帰る人が抜けた後は' + stay + '人' + (stay === 0 ? '（チームごと解散）' : '')) + '</div>' : '') +
      (legacy ? '' : '<div><button type="button" class="btn small ' + (T.rm === t.no ? 'primary' : 'ghost') + '" data-rm="' + t.no + '">' + (T.rm === t.no ? '本当に解散' : 'このチームを解散') + '</button></div>') + '</div>';
  }).join('') + (none.length ? '<div class="tcard none"><b>まだチームに入っていない人</b><div class="mems">' + none.map(mem).join('') + '</div><span class="muted" style="font-size:.85rem">名前を押してチームを選んでください</span></div>' : '');
  $('tmTeams').querySelectorAll('[data-pc]').forEach((b) => { b.onclick = () => openCheckin(b.dataset.pc); });
  $('tmTeams').querySelectorAll('[data-rn]').forEach((inp) => { inp.onchange = () => { const no = +inp.dataset.rn, v = inp.value.trim().slice(0, 12) || teamLabel(no); teamOp('チーム名「' + v + '」', { ['tm.t' + no + '.name']: v }); toast('チーム名を変えました'); }; });
  $('tmTeams').querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => {
    const no = +b.dataset.rm;
    if (T.rm !== no) { T.rm = no; renderTeam(); return; }
    T.rm = 0;
    const d = { ['tm.t' + no + '.gone']: true }; ps.filter((p) => p.team === no).forEach((p) => { d['assign.' + p.id] = null; });
    teamOp(teamName(no) + 'の解散', d);
    toast('解散しました。メンバーをほかのチームに入れてください');
  }; });
  const ms = evMatches(ev), sync = inSync(saved, ms);
  if (!legacy) $('tmChecks').insertAdjacentHTML('afterbegin', ev.shown ? '<li>✓ 参加者画面にチームと対戦表を出しています</li>' : '<li><b class="warnline">参加者画面にはまだチームを出していません（発表の「チームを見る」で出ます）。</b> <button type="button" class="btn small" id="tmShow">発表画面を開く</button></li>');
  if ($('tmShow')) $('tmShow').onclick = () => {
    const order = teams.flatMap((t) => t.members.map((m) => ({ name: m.name, team: t.name })));
    showReveal(shuffle(order), [], S.cur, ev.drawId || '');
  };
  $('tmChecks').insertAdjacentHTML('afterbegin', ms.length ? (sync ? '<li>✓ 対戦表はいまのチームに合っています</li>' : '<li><b class="warnline">対戦表が古いままです。調整が終わったら「対戦表を作り直す」を押してください（入力済みの試合はそのまま残ります）。</b></li>') : '');
  $('tmResAct').innerHTML = legacy ? '' : '<button class="btn" id="tmAdd" type="button">チームを1つ追加</button>' + (ms.length ? '<button class="btn' + (sync ? ' ghost' : ' primary') + '" id="tmRebuild" type="button"' + (saved.length % 2 ? ' disabled' : '') + '>対戦表を作り直す</button>' : '');
  if ($('tmRebuild')) $('tmRebuild').onclick = rebuildNow;
  if (!legacy) $('tmAdd').onclick = () => {
    const nos = Object.keys(ev.tm || {}).map((k) => +k.slice(1)), no = (nos.length ? Math.max(...nos) : 0) + 1;
    teamOp('チーム' + teamLabel(no) + 'の追加', { ['tm.t' + no]: { name: teamLabel(no) } });
    toast('チーム' + teamLabel(no) + 'を追加しました。メンバーを入れてください');
  };
}
/* 開催回のチームの書き換え（1つの操作として送る） */
function teamOp(label, data, hint) {
  if (needEvent()) return;
  const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: 'team', name: label }], tapAt: now(), hint: hint || '' };
  runOp(op, [{ op: 'update', path: ROOT + '/events/' + S.cur, data }]);
}
function renderTeamPeople(ps) {
  const LV = Array.from({ length: 10 }, (_, i) => i + 1);
  const a = document.activeElement, keep = a && a.dataset && a.dataset.pair ? { id: a.dataset.pair, s: a.selectionStart, e: a.selectionEnd } : null;
  setTimeout(() => { if (!keep) return; const n = $('tmPeople').querySelector('[data-pair="' + keep.id + '"]'); if (n && document.activeElement !== n) { n.focus(); try { n.setSelectionRange(keep.s, keep.e); } catch (e) {} } }, 0);
  $('tmPeople').innerHTML = ps.length ? ps.slice().sort((a, b) => (b.exp - a.exp) || b.level - a.level || (a.name < b.name ? -1 : 1)).map((p) =>
    '<li class="tmrow"><span class="nm">' + esc(p.name) + (p.pending ? ' <small class="muted">送信待ち</small>' : '') + '</span><span class="ctl">' +
    '<button type="button" class="tg" data-exp="' + esc(p.id) + '" aria-pressed="' + p.exp + '">経験豊富</button>' +
    (p.exp ? '<select data-lv="' + esc(p.id) + '" aria-label="' + esc(p.name) + 'の評価">' + LV.map((v) => '<option' + (v === p.level ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>' : '') +
    '<button type="button" class="tg" data-beg="' + esc(p.id) + '" aria-pressed="' + p.beg + '">初心者</button>' +
    '<button type="button" class="tg" data-early="' + esc(p.rawId) + '" aria-pressed="' + p.early + '">早帰り</button>' +
    '<input data-pair="' + esc(p.rawId) + '" value="' + esc(p.rawId in T.draft ? T.draft[p.rawId] : p.pair) + '" maxlength="10" placeholder="目印" aria-label="' + esc(p.name) + 'の同じチーム希望の目印"></span></li>').join('')
    : '<li class="muted">まだ受付済みの人がいません</li>';
  $('tmPeople').querySelectorAll('[data-exp]').forEach((b) => { b.onclick = () => { const p = ps.find((x) => x.id === b.dataset.exp); editRoster(p, !p.exp ? { exp: true, level: LV_DEFAULT, beg: false } : { exp: false, level: null }); }; });
  $('tmPeople').querySelectorAll('[data-beg]').forEach((b) => { b.onclick = () => { const p = ps.find((x) => x.id === b.dataset.beg); editRoster(p, !p.beg ? { beg: true, exp: false, level: null } : { beg: false }); }; });
  $('tmPeople').querySelectorAll('[data-early]').forEach((b) => { b.onclick = () => { const p = ps.find((x) => x.rawId === b.dataset.early); editCheckin(p, { early: !p.early }); }; });
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
function setOpenMark(key, on) {
  if (needEvent()) return;
  const m = Object.assign({}, openMarks()); if (on) m[key] = true; else delete m[key];
  const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: 'mark', name: '目印「' + key + '」' }], tapAt: now() };
  runOp(op, [{ op: 'update', path: ROOT + '/events/' + S.cur, data: { openMarks: m } }]);
  T.preview = null; T.count = 0;
}
function editRoster(p, data) {
  if (!p || needEvent()) return;
  const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: p.id, name: p.name }], tapAt: now() };
  runOp(op, [{ op: 'update', path: ROOT + '/roster/' + p.id, data }]);
  T.preview = null;
}
function editPair(p, label) { editCheckin(p, { pair: label }); }
function editCheckin(p, data) {
  if (!p || needEvent()) return;
  const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: p.id, name: p.name }], tapAt: now() };
  runOp(op, [{ op: 'update', path: ROOT + '/events/' + S.cur + '/checkins/' + p.rawId, data }]);
  T.preview = null;
}
function doDraw() {
  T.msg = '';
  const why = teamReady();
  if (why) { T.msg = why; renderTeam(); return; }
  const ps = markTop(drawPeople(), T.count);
  const opt = teamOptions(ps).out.find((o) => o.T === T.count);
  if (!opt) { T.msg = 'このチーム数では分けられません'; renderTeam(); return; }
  const ev = S.events[S.cur] || {};
  T.preview = drawTeams(ps, opt); T.sig = drawSig(ps); T.base = ev.rev || ''; T.eid = S.cur;
  renderTeam();
  $('tmResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('tmDraw').onclick = () => {
  const ev = S.events[S.cur] || {};
  if (evTeams(ev).length && !T.preview) {
    const nres = evMatches(ev).filter(hasRes).length;
    $('sheet').innerHTML = '<h2 id="sheetTitle">抽選し直しますか？</h2><p>決まったチームがあります。抽選し直して「この結果で決める」を押すと、いまのチームと対戦表は置き換わります。</p>' +
      (nres ? '<p class="warnline">試合の結果が ' + nres + '件 入っています。やり直すと結果も消えます。</p><label class="switch"><input type="checkbox" id="rdForce"><span class="tr"></span>入力済みの結果を消してやり直す</label>' : '') +
      '<div class="actions"><button class="btn primary" id="rdYes" type="button"' + (nres ? ' disabled' : '') + '>抽選し直す</button><button class="btn ghost" id="rdNo" type="button">やめる</button></div>';
    $('ov').hidden = false; $('rdNo').onclick = closeSheet; $('rdYes').onclick = () => { closeSheet(); doDraw(); };
    if (nres) $('rdForce').onchange = () => { $('rdYes').disabled = !$('rdForce').checked; };
    return;
  }
  doDraw();
};
function saveTeams() {
  if (!T.preview || needEvent()) return;
  const why = teamReady(); if (why) { T.msg = why; renderTeam(); return; }
  const ps = markTop(drawPeople(), T.preview.length);
  if (drawSig(ps) !== T.sig || !checkTeams(T.preview, ps)[0][0]) { T.msg = '抽選のあとに受付や印が変わりました。もう一度抽選してください'; T.preview = null; renderTeam(); return; }
  /* 抽選したあとに、ほかの端末で結果・チーム・対戦表などが変わっていたら決めない（入った結果を黙って消さないように） */
  const ev0 = S.events[S.cur] || {};
  if (T.eid !== S.cur || (ev0.rev || '') !== T.base) { T.msg = '抽選したあとに、ほかの端末で試合の結果やチームが変わりました。いまの状態を確かめて、もう一度抽選してください'; T.preview = null; renderTeam(); return; }
  const tm = {}, assign = {}, order = [];
  T.preview.forEach((t, i) => {
    tm['t' + (i + 1)] = { name: t.name, fixed: t.fixed || '', mark: t.mark || '' };
    t.members.forEach((m) => { assign[m.id] = i + 1; order.push({ name: m.name, team: t.name }); });
  });
  const op = { id: rid('o'), type: 'draw', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: T.preview.map((t) => ({ id: t.name, name: t.name + '（' + t.members.length + '人）' })), tapAt: now(), guard: true };
  /* 抽選と同時に総当たりの対戦表を作る（11/22版と同じ）。やり直しのときは前の対戦表と結果を置き換える */
  const mt = {}; buildMatches(T.preview.map((t, i) => i + 1), 1).forEach((m) => { const { id, ...d } = m; mt[id] = d; });
  runOp(op, [{ op: 'update', path: ROOT + '/events/' + S.cur, data: { tm, assign, mt, teams: null, shown: false, drawId: op.id, date: jstDate(srvNow()), drawnAt: TS, drawBy: devName, drawCount: T.preview.length, chk: { base: T.base, op: op.id } } }]);
  const bad = checkTeams(T.preview, ps).filter((c) => c[2] === 'warn' && !c[0]).map((c) => c[1]);
  T.preview = null; T.msg = ''; T.rm = 0;
  renderTeam();
  showReveal(shuffle(order), bad, S.cur, op.id);
}
/* 発表：順番から経験豊富の人が分からないよう、全員をまぜて1人ずつ出す（11/22版と同じ） */
let revealTimer = null;
function showReveal(order, notes, eid, drawId) {
  $('sheet').innerHTML = '<h2 id="sheetTitle">抽選結果</h2>' + (notes.length ? '<p class="warnline">' + esc(notes.join('／')) + '</p>' : '') +
    '<ul class="reveal" id="rv"></ul><div class="actions"><button class="btn ghost" id="rvAll" type="button">すぐに全部見る</button><button class="btn primary" id="rvClose" type="button">チームを見る</button></div>';
  $('ov').hidden = false;
  let i = 0;
  const step = () => { if (i >= order.length || !$('rv')) { clearInterval(revealTimer); return; } const o = order[i++], li = document.createElement('li'); li.innerHTML = '<span>' + esc(o.name) + '</span><b>' + esc(o.team) + '</b>'; $('rv').appendChild(li); $('rv').scrollTop = $('rv').scrollHeight; };
  const all = () => { clearInterval(revealTimer); while (i < order.length) step(); };
  clearInterval(revealTimer);
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) all(); else revealTimer = setInterval(step, 280);
  $('rvAll').onclick = all;
  /* 発表が終わったら（「チームを見る」を押したら）参加者画面にもチームと対戦表を出す */
  /* 出すのは、この画面で発表した抽選だけ（ほかの端末で抽選し直した・回が変わったときは出さない。ルールでも drawId を確かめる） */
  $('rvClose').onclick = () => {
    closeSheet(); window.scrollTo(0, 0);
    const ev = S.events[S.cur] || {};
    if (S.cur !== eid || (ev.drawId || '') !== drawId) { toast('この発表のあとに、ほかの端末で抽選し直された（または回が変わった）ので、参加者画面には出しませんでした。チームタブで確かめてください', true); return; }
    if (!ev.shown) setShown(true, drawId);
  };
}


/* ===== 試合（11/22版から移植）：総当たり・コート・合計点・順位・巡。
   試合は開催回の mt（試合番号→内容）に入れる。結果は試合ごとの欄だけを書き換えるので、2台で別々の試合を入れても消し合わない ===== */
const MT = { filter: 'todo' };
function courtsOf(ev) { const n = Math.floor(Number((ev || {}).courts)); return n >= 1 && n <= 50 ? n : 6; }
function evMatches(ev) { const mt = (ev || {}).mt || {}; return Object.keys(mt).filter((k) => mt[k] && mt[k].a && mt[k].b).map((k) => ({ id: k, ...mt[k] })).sort((x, y) => x.c - y.c || x.r - y.r || x.k - y.k); }
const okTotal = (v) => Number.isInteger(v) && v >= 0 && v <= 100;
const hasRes = (m) => okTotal(m.ta) && okTotal(m.tb);
const resKey = (m) => hasRes(m) ? m.ta + ',' + m.tb : '';
/* 総当たり（サークル方式）。同じチーム構成なら毎回同じ表になる */
function rrList(nos) {
  const list = nos.slice().sort((a, b) => a - b);
  if (list.length % 2) list.push(0);
  const M = list.length, rounds = []; let arr = list.slice();
  for (let r = 0; r < M - 1; r++) {
    const pairs = [];
    for (let k = 0; k < M / 2; k++) { const a = arr[k], b = arr[M - 1 - k]; if (a && b) pairs.push(a < b ? [a, b] : [b, a]); }
    pairs.sort((x, y) => x[0] - y[0]); rounds.push(pairs);
    arr = [arr[0], arr[M - 1]].concat(arr.slice(1, M - 1));
  }
  return rounds;
}
function newMatch(c, r, k, a, b) { return { id: 'm' + c + '_' + r + '_' + k + '_' + Math.random().toString(36).slice(2, 7), c, r, k, a, b, ta: null, tb: null, by: '', at: null }; }
function buildMatches(nos, c) { const out = []; rrList(nos).forEach((pairs, r) => pairs.forEach((q, k) => out.push(newMatch(c, r + 1, k + 1, q[0], q[1])))); return out; }
/* 大会の途中でチームが変わったとき：結果の入った試合は残し、まだ当たっていない組み合わせだけで続きのラウンドを組む */
function rebuildMatches(nos, ms) {
  const kept = ms.filter(hasRes), last = ms.reduce((mx, m) => Math.max(mx, m.c || 1), 1), has = {};
  nos.forEach((n) => { has[n] = 1; });
  const out = kept.slice();
  ms.forEach((m) => { if (!hasRes(m) && m.c < last && has[m.a] && has[m.b]) out.push(m); });
  return out.concat(rebuildCycle(nos, kept, last, ms));
}
function rebuildCycle(nos, kept, c, old) {
  const key = (a, b) => Math.min(a, b) + '-' + Math.max(a, b), oldId = {}, played = {};
  old.forEach((m) => { if (!hasRes(m) && m.c === c) oldId[key(m.a, m.b)] = m.id; }); // 同じ2チームのまだの試合は、もとの試合番号を引き継ぐ
  kept.forEach((m) => { if (m.c === c) played[key(m.a, m.b)] = 1; });
  let remaining = [];
  rrList(nos).forEach((pairs) => pairs.forEach((q) => { if (!played[q[0] + '-' + q[1]]) remaining.push(q); }));
  let round = kept.filter((m) => m.c === c).reduce((mx, m) => Math.max(mx, m.r), 0);
  const out = [], sorted = nos.slice().sort((a, b) => a - b);
  /* 1ラウンドで全チームが試合できる組み方を探す。見つからなければできるだけ多く組む */
  const perfect = (pool) => {
    const used = {}, pick = []; let tries = 0;
    const dfs = () => {
      if (++tries > 20000) return false;
      const t = sorted.find((n) => !used[n]); if (t === undefined) return true;
      for (let i = 0; i < pool.length; i++) { const q = pool[i];
        if ((q[0] === t || q[1] === t) && !used[q[0]] && !used[q[1]]) { used[q[0]] = used[q[1]] = 1; pick.push(i); if (dfs()) return true; used[q[0]] = used[q[1]] = 0; pick.pop(); } }
      return false;
    };
    return dfs() ? pick : null;
  };
  while (remaining.length) {
    round++;
    const idxs = perfect(remaining), take = {};
    if (idxs) idxs.forEach((i) => { take[i] = 1; });
    else { const used = {}; remaining.forEach((q, i) => { if (!used[q[0]] && !used[q[1]]) { used[q[0]] = used[q[1]] = 1; take[i] = 1; } }); }
    const next = []; let k = 0;
    remaining.forEach((q, i) => {
      if (take[i]) { const nm = newMatch(c, round, ++k, q[0], q[1]), id = oldId[q[0] + '-' + q[1]]; if (id) nm.id = id; out.push(nm); } else next.push(q);
    });
    remaining = next;
  }
  return out;
}
/* 対戦表が今のチームとずれていないか（まだの試合に、いないチームが入っている／当たる予定のないチームがいる） */
function inSync(teams, ms) {
  if (!teams.length || !ms.length) return true;
  const nos = {}; teams.forEach((t) => { nos[t.no] = 1; });
  const c = ms.reduce((mx, m) => Math.max(mx, m.c || 1), 1), seen = {};
  for (const m of ms) { if (!hasRes(m) && (!nos[m.a] || !nos[m.b])) return false; if (m.c === c) { seen[m.a] = 1; seen[m.b] = 1; } }
  return teams.every((t) => seen[t.no]);
}
/* 会場掲示の8チーム表。Aを固定し、各ラウンドの両端から1〜4コートに置く */
function boardOrder(group, nos, courts) {
  if (courts < 4 || nos.length !== 8 || group.length !== 4) return null;
  const round = group[0].r; if (!(round >= 1 && round <= 7)) return null;
  const ring = nos.slice().sort((a, b) => a - b);
  for (let r = 1; r < round; r++) ring.splice(1, 0, ring.pop());
  const ordered = [];
  for (let c = 0; c < 4; c++) { const a = ring[c], b = ring[7 - c]; const m = group.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a)); if (!m) return null; ordered.push(m); }
  return ordered;
}
function assignCourts(ms, courts) {
  const groups = {}, sets = {}, out = {};
  ms.forEach((m) => { (groups[m.c + '-' + m.r] = groups[m.c + '-' + m.r] || []).push(m); (sets[m.c] = sets[m.c] || new Set()).add(m.a).add(m.b); });
  Object.values(groups).forEach((g) => {
    const ordered = boardOrder(g, Array.from(sets[g[0].c]), courts) || g.slice().sort((x, y) => x.k - y.k);
    ordered.forEach((m, i) => { out[m.id] = { court: (i % courts) + 1, wave: Math.floor(i / courts) + 1 }; });
  });
  return out;
}
/* 順位：合計点の多い順。同点は同じ順位にして、次の番号を飛ばす（100・100・90 → 1・1・3位） */
function standings(teams, ms, ps) {
  const st = {}; teams.forEach((t) => { st[t.no] = { no: t.no, name: t.name, played: 0, total: 0 }; });
  ms.forEach((m) => { if (!hasRes(m)) return; if (st[m.a]) { st[m.a].played++; st[m.a].total += m.ta; } if (st[m.b]) { st[m.b].played++; st[m.b].total += m.tb; } });
  const arr = Object.values(st).sort((x, y) => y.total - x.total || x.no - y.no);
  let rank = 0, prev = null;
  arr.forEach((s, i) => { if (s.total !== prev) { rank = i + 1; prev = s.total; } s.rank = rank; s.avg = s.played ? Math.round(s.total / s.played * 10) / 10 : 0; s.members = ps.filter((p) => p.team === s.no).map((p) => p.name); });
  return arr;
}
/* 名前の途中で改行しない（区切りの「・」でだけ折り返す） */
const nameList = (arr) => arr.map((n) => '<span class="nm1">' + esc(n) + '</span>').join('・');
const mtFields = (list) => { const o = {}; list.forEach((m) => { const { id, ...d } = m; o['mt.' + id] = d; }); return o; };
function renderGame() {
  if (!S.mode) return;
  const ev = S.events[S.cur] || {}, teams = evTeams(ev), ms = evMatches(ev), ps = people(), courts = courtsOf(ev);
  const pos = assignCourts(ms, courts), done = ms.filter(hasRes).length;
  const mem = (no) => nameList(ps.filter((p) => p.team === no).map((p) => p.name));
  $('gProg').innerHTML = '<div class="actions" style="justify-content:space-between"><b>入力済み <span class="num">' + done + ' / ' + ms.length + '</span></b><span class="muted">' + esc(ev.name || '') + '</span></div>' +
    '<div class="bar"><i style="width:' + (ms.length ? Math.round(done / ms.length * 100) : 0) + '%"></i></div>' +
    (teams.length && !inSync(teams, ms) ? '<p class="warnline" style="margin:6px 0 0">対戦表がいまのチームと合っていません。チームタブで調整が終わったら「対戦表を作り直す」を押してください。</p>' : '');
  document.querySelectorAll('#gFilter [data-f]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.f === MT.filter ? 'true' : 'false'));
  if (!ms.length) $('gBody').innerHTML = '<div class="box plain empty"><b>対戦表はまだありません</b>チームタブで抽選して「この結果で決める」を押すと、総当たりの対戦表が自動で作られます。</div>';
  else {
    const groups = [], gk = {}, cycles = ms.reduce((mx, m) => Math.max(mx, m.c), 1);
    ms.forEach((m) => { const k = m.c + '-' + m.r; if (!gk[k]) { gk[k] = { c: m.c, r: m.r, list: [] }; groups.push(gk[k]); } gk[k].list.push({ ...m, ...(pos[m.id] || { court: 1, wave: 1 }) }); });
    const side = (no, t, win, d) => '<div class="t' + (win ? ' win' : '') + '">' + esc(teamName(no)) + '<small>' + mem(no) + '</small>' + (d ? '<span class="tot num">' + t + '点</span>' : '') + '</div>';
    const card = (m) => { const d = hasRes(m); return '<button type="button" class="mt' + (d ? ' done' : '') + '" data-m="' + esc(m.id) + '" aria-label="' + esc(teamName(m.a)) + '対' + esc(teamName(m.b)) + (d ? ' 入力済み' : ' 未入力') + '">' +
      side(m.a, m.ta, d && m.ta > m.tb, d) + '<div class="mid"><span class="court">コート' + m.court + (m.wave > 1 ? '<small>' + m.wave + '組目</small>' : '') + '</span><span class="vs">VS</span><span class="state">' + (d ? '修正・取り消し' : '結果を入力') + '</span></div>' +
      side(m.b, m.tb, d && m.tb > m.ta, d) + '</button>'; };
    $('gBody').innerHTML = groups.map((g) => {
      const shown = g.list.slice().sort((a, b) => a.wave - b.wave || a.court - b.court).filter((m) => MT.filter === 'all' || !hasRes(m));
      if (!shown.length) return '';
      return '<div class="round"><div class="round-h"><h3>' + (cycles > 1 ? g.c + '巡目・' : '') + '第' + g.r + 'ラウンド</h3><span class="bye">' + g.list.filter(hasRes).length + '/' + g.list.length + '試合 入力済み</span></div>' + shown.map(card).join('') + '</div>';
    }).join('') || '<div class="box plain empty"><b>全試合の結果が入りました</b>お疲れさまでした。順位を確認して表彰へ。</div>';
    $('gBody').querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => openScore(b.dataset.m); });
  }
  const st = standings(teams, ms, ps);
  $('gRank').innerHTML = st.length ? st.map((x) => '<li><span class="r num">' + x.rank + '</span><span><b>' + esc(x.name) + '</b> <span class="muted">' + nameList(x.members) + '</span></span><span class="p num">' + x.total + '<small class="muted">点・' + x.played + '試合</small></span></li>').join('') : '<li class="muted">チームが決まると出ます</li>';
  const cyc = ms.reduce((mx, m) => Math.max(mx, m.c), 0), per = Math.floor(teams.length / 2);
  $('cycleInfo').textContent = (ms.length ? cyc + '巡ぶん・全' + ms.length + '試合。' : 'まだ対戦表がありません。') + 'コートは' + courts + '面' + (per > courts ? '。1ラウンド' + per + '試合なので、コートが空いた順に2組目が入ります（設定タブでコート数を変えられます）' : '') + '。';
  $('addCycle').disabled = !teams.length || !ms.length;
  $('rmCycle').disabled = cyc <= 1;
}
document.querySelectorAll('#gFilter [data-f]').forEach((b) => { b.onclick = () => { MT.filter = b.dataset.f; renderGame(); }; });
function openScore(id) {
  const ev = S.events[S.cur] || {}, m = evMatches(ev).find((x) => x.id === id); if (!m) return;
  const prev = resKey(m), ps = people(), pos = assignCourts(evMatches(ev), courtsOf(ev))[id] || { court: 1 };
  const field = (side, no) => '<label class="field"><strong>' + esc(teamName(no)) + '</strong><small>' + nameList(ps.filter((p) => p.team === no).map((p) => p.name)) +
    '</small><input class="input" id="sc_' + side + '" inputmode="numeric" autocomplete="off" aria-label="' + esc(teamName(no)) + 'の2セット合計点" placeholder="0〜100" value="' + (prev ? m['t' + side] : '') + '"></label>';
  $('sheet').innerHTML = '<h2 id="sheetTitle">第' + m.r + 'ラウンド・コート' + pos.court + '</h2><p>各チームの2セット合計点を入力してください。</p>' + field('a', m.a) + field('b', m.b) +
    '<div class="err" id="scErr" role="alert"></div><div class="actions"><button class="btn primary" id="scSave" type="button">保存する</button><button class="btn ghost" id="scCancel" type="button">閉じる</button></div>' +
    (prev ? '<button class="btn small ghost" id="scClear" type="button">この試合の結果を取り消す</button>' : '');
  $('ov').hidden = false;
  const read = () => { const a = $('sc_a').value.normalize('NFKC').trim(), b = $('sc_b').value.normalize('NFKC').trim(); return { a: +a, b: +b, bad: ![a, b].every((v) => /^\d{1,3}$/.test(v) && Number(v) <= 100) }; };
  $('scCancel').onclick = closeSheet;
  const send = (force) => {
    const v = read();
    if (v.bad) { $('scErr').textContent = '両チームの2セット合計点を0〜100の整数で入力してください'; return; }
    if (needEvent()) return;
    const cur = evMatches(S.events[S.cur]).find((x) => x.id === id);
    if (!cur || cur.a !== m.a || cur.b !== m.b) { $('scErr').textContent = '対戦表が作り直されたため保存しませんでした。最新の対戦表から入れ直してください'; return; }
    /* 画面を開いたあとに、ほかの端末がこの試合の結果を入れた・取り消したとき */
    if (resKey(cur) !== prev && !force) {
      $('scErr').textContent = resKey(cur) ? 'この試合は、先にほかの人が結果を入れていました（' + teamName(cur.a) + ' ' + cur.ta + '点、' + teamName(cur.b) + ' ' + cur.tb + '点' + (cur.by ? '・' + cur.by : '') + '）。確かめて、直す必要があるときだけ上書きしてください' : 'この試合の結果は、ほかの端末で取り消されました。入れ直す必要があるときだけ上書きしてください';
      if (!$('scForce')) { const b = document.createElement('button'); b.className = 'btn small'; b.id = 'scForce'; b.type = 'button'; b.textContent = '今のマスの数字で上書きする'; b.onclick = () => send(true); $('scErr').after(b); }
      return;
    }
    if (resKey(cur) === v.a + ',' + v.b) { closeSheet(); toast('同じ結果が入っています'); return; }
    const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id, name: teamName(m.a) + ' 対 ' + teamName(m.b) + '（' + v.a + '対' + v.b + '）' }], tapAt: now() };
    runOp(op, [{ op: 'update', path: ROOT + '/events/' + S.cur, data: { ['mt.' + id + '.ta']: v.a, ['mt.' + id + '.tb']: v.b, ['mt.' + id + '.by']: devName, ['mt.' + id + '.at']: TS } }]);
    closeSheet(); toast('保存しました（' + teamName(m.a) + ' ' + v.a + '点・' + teamName(m.b) + ' ' + v.b + '点）');
  };
  $('scSave').onclick = () => send(false);
  if ($('scClear')) {
    let armed = false;
    $('scClear').onclick = () => {
      if (!armed) { armed = true; $('scClear').textContent = 'もう一度押すと取り消します'; $('scClear').classList.remove('ghost'); $('scClear').classList.add('primary'); return; }
      if (needEvent()) return;
      const cur = evMatches(S.events[S.cur]).find((x) => x.id === id);
      if (!cur || resKey(cur) !== prev) { $('scErr').textContent = '画面を開いたあとに、この試合の結果が変わりました。閉じて確かめてください'; return; }
      const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id, name: teamName(m.a) + ' 対 ' + teamName(m.b) + 'の結果の取り消し' }], tapAt: now() };
      runOp(op, [{ op: 'update', path: ROOT + '/events/' + S.cur, data: { ['mt.' + id + '.ta']: null, ['mt.' + id + '.tb']: null, ['mt.' + id + '.by']: '', ['mt.' + id + '.at']: null } }]);
      closeSheet(); toast('結果を取り消しました');
    };
  }
}
$('addCycle').onclick = () => {
  const ev = S.events[S.cur] || {}, teams = evTeams(ev), ms = evMatches(ev);
  if (!teams.length || !ms.length) return toast('先にチーム抽選をしてください', true);
  if (teams.length % 2) return toast('チーム数が奇数です。偶数にしてから追加してください', true);
  const c = ms.reduce((mx, m) => Math.max(mx, m.c), 0) + 1;
  teamOp(c + '巡目の追加', mtFields(buildMatches(teams.map((t) => t.no), c)));
  toast('対戦表をもう1巡追加しました');
};
$('rmCycle').onclick = () => {
  const ms = evMatches(S.events[S.cur]), last = ms.reduce((mx, m) => Math.max(mx, m.c), 0);
  if (last <= 1) return toast('1巡目は消せません', true);
  if (ms.some((m) => m.c === last && hasRes(m))) return toast(last + '巡目には結果が入っているので消せません', true);
  const d = {}; ms.filter((m) => m.c === last).forEach((m) => { d['mt.' + m.id] = null; });
  teamOp(last + '巡目の削除', d);
  toast('最後の巡を消しました');
};
function rebuildNow() {
  const ev = S.events[S.cur] || {}, teams = evTeams(ev), ms = evMatches(ev);
  if (teams.length < 2) return toast('チームが2つ以上必要です', true);
  if (teams.length % 2) return toast('チーム数が奇数です。1つ追加するか解散して偶数にしてください', true);
  const next = rebuildMatches(teams.map((t) => t.no), ms), d = {}, keep = {};
  next.forEach((m) => { keep[m.id] = 1; const o = ms.find((x) => x.id === m.id); if (!o || o.c !== m.c || o.r !== m.r || o.k !== m.k || o.a !== m.a || o.b !== m.b) { const { id, ...x } = m; d['mt.' + id] = { ...x, ta: o ? o.ta : null, tb: o ? o.tb : null, by: o ? o.by || '' : '', at: o ? o.at || null : null }; } });
  ms.forEach((m) => { if (!keep[m.id]) d['mt.' + m.id] = null; });
  if (!Object.keys(d).length) return toast('対戦表はいまのチームに合っています');
  teamOp('対戦表の作り直し', d);
  toast('対戦表を作り直しました（入力済みの試合はそのまま）');
}


/* ===== 締めと記録（11/22版のリセットと記録から移植）=====
   締めるとき：結果が1件でもあれば、その回の順位（events.final）と、チームに入っていた人の1人1件の記録（hist）を残す。結果がない回は記録を作らない。
   記録は名簿の番号（rid）に結び付く。まとめた人（mergedInto）の記録は、まとめ先の人の記録として数える（記録そのものは書き換えない）。 */
const SEASON_START = '2025-11-22';
function jstDate(ms) { const d = new Date(ms + 9 * 3600000); return d.toISOString().slice(0, 10); }
function evDate(ev) { return (ev && ev.date) || (ev && num(ev.createdAt) ? jstDate(num(ev.createdAt)) : jstDate(Date.now())); }
const fmtDate = (d) => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d || ''); return m ? m[1] + '/' + (+m[2]) + '/' + (+m[3]) : (d || ''); };
/* 締めの中身。ctx（サーバーから読み直した開催回・受付・名簿）を渡せばそれで、なければこの端末の表示で計算する */
function closingData(eid, ctx) {
  if (!ctx) { if (eid !== S.cur) return null; ctx = { ev: S.events[eid], checkins: S.checkins, rm: rosterById() }; }
  const ev = ctx.ev || {}, teams = evTeams(ev), ms = evMatches(ev), ps = peopleOf(ctx.checkins, ev, ctx.rm);
  const closeRev = ev.rev || '', nres = ms.filter(hasRes).length;
  if (!nres) return { ev: { final: null, noResult: true, closeRev }, hist: [], n: ps.length, missing: [], nres: 0 };
  const st = standings(teams, ms, ps), date = evDate(ev), by = {};
  st.forEach((x) => { by[x.no] = x; });
  return {
    ev: { final: { date, teams: st.length, standings: st.map((x) => ({ no: x.no, rank: x.rank, name: x.name, members: x.members, played: x.played, total: x.total, avg: x.avg })) }, noResult: false, closeRev },
    n: ps.length, nres, missing: ps.filter((p) => !p.team || !by[p.team]).map((p) => p.name),
    hist: ps.filter((p) => p.team && by[p.team]).map((p) => { const x = by[p.team]; return { id: eid + '_' + p.id, data: { eid, ename: ev.name || '', date, rid: p.id, name: p.name, team: x.name, teamNo: x.no, members: x.members, rank: x.rank, teams: st.length, played: x.played, total: x.total, at: TS } }; })
  };
}
function closingSummary(c) {
  c = c === undefined ? closingData(S.cur) : c; if (!c) return '';
  if (!c.nres) return 'この回は試合の結果が1件もないので、順位や参加の記録は作りません（受付 ' + c.n + '人）。';
  const top = c.ev.final.standings.filter((x) => x.rank === 1);
  const miss = c.missing.length ? 'チームに入っていない ' + c.missing.join('・') + ' さんは記録に入りません。入れるなら、先にチームに入れてください。' : '';
  if (!c.hist.length) return '試合の結果は ' + c.nres + '件ありますが、チームに入っている人がいないため、参加の記録は0人になります（受付 ' + c.n + '人）。' + miss;
  return 'この回の順位と、' + c.hist.length + '人の参加の記録を残します（受付 ' + c.n + '人／記録 ' + c.hist.length + '人。1位：' + top.map((x) => x.name + '［' + x.members.join('・') + '］').join('／') + '）。' + miss;
}
/* 締める直前に、サーバーから開催回→受付→名簿の順に読み直して計算する。読んだあとに rev が変わる変更が届けば、ルールが締めを断る */
async function serverClosing(eid) {
  const ev = await B.getServer(ROOT + '/events/' + eid);
  if (!ev || ev.status !== 'open') return null;
  const checkins = await B.getServerCol(ROOT + '/events/' + eid + '/checkins'), roster = await B.getServerCol(ROOT + '/roster');
  const rm = {}; roster.forEach((r) => { rm[r.id] = r; });
  return closingData(eid, { ev, checkins, rm });
}
function histRows() { const rm = rosterById(); return S.hist.filter((h) => !h.kind).map((h) => ({ ...h, pid: resolveId(h.rid, rm) })); }
/* 人ごとの数（参加は大会の日付で数える。同じ日が2件あっても1回） */
function personStats(season, after) {
  const out = {};
  histRows().forEach((h) => {
    if (season && (h.date || '') < SEASON_START) return;
    if (after && (h.date || '') < after) return; // 覇王戦の日の優勝も入れる（出場資格と同じ）
    const o = out[h.pid] || (out[h.pid] = { n: 0, win: 0, top3: 0, dates: {}, dup: [] });
    const prev = o.dates[h.date];
    if (prev === undefined) { o.dates[h.date] = h.rank; return; }
    /* 同じ日に2件（まとめた2人が同じ日に出ていた）：参加は1回、順位は良い方で数え、要確認として出す（読み込み順で数が変わらないように） */
    if (!o.dup.includes(h.date)) o.dup.push(h.date);
    o.dates[h.date] = Math.min(prev, h.rank);
  });
  Object.values(out).forEach((o) => { const r = Object.values(o.dates); o.n = r.length; o.win = r.filter((x) => x === 1).length; o.top3 = r.filter((x) => x <= 3).length; });
  return out;
}
const REC = { scope: 'all', q: '' };
function liveRoster() { return S.roster.filter((r) => !r.mergedInto); }
function renderRec() {
  if (!S.mode) return;
  const st = personStats(REC.scope === 'season'), rm = rosterById(), q = norm(REC.q);
  const mergedBy = {}; S.roster.forEach((r) => { if (r.mergedInto) (mergedBy[resolveId(r.id, rm)] = mergedBy[resolveId(r.id, rm)] || []).push(r.name); });
  const list = liveRoster().filter((r) => !q || norm(r.name).includes(q) || (mergedBy[r.id] || []).some((n) => norm(n).includes(q)))
    .map((r) => ({ r, s: st[r.id] || { n: 0, win: 0, top3: 0 } })).sort((a, b) => b.s.n - a.s.n || b.s.win - a.s.win || (a.r.name < b.r.name ? -1 : 1));
  document.querySelectorAll('#recScope [data-sc]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.sc === REC.scope ? 'true' : 'false'));
  $('recCount').textContent = '記録 ' + new Set(S.hist.map((h) => h.date)).size + '大会・' + liveRoster().length + '人';
  $('recList').innerHTML = list.length ? list.map((x) => '<li><button type="button" class="prow" data-pp="' + esc(x.r.id) + '"><span class="pname">' + esc(x.r.name) + '</span>' +
    (mergedBy[x.r.id] ? '<span class="tag cy">' + esc('まとめた人：' + mergedBy[x.r.id].join('・')) + '</span>' : '') + ((x.s.dup || []).length ? '<span class="tag early">要確認</span>' : '') +
    '<span class="rstat"><span>参加 ' + x.s.n + '回</span>' + (x.s.win ? '<span>優勝 ' + x.s.win + '</span>' : '') + (x.s.top3 ? '<span>3位以内 ' + x.s.top3 + '</span>' : '') + '</span></button></li>').join('')
    : '<li class="muted">' + (q ? '「' + esc(REC.q) + '」に当てはまる人はいません' : 'まだ名簿がありません') + '</li>';
  $('recList').querySelectorAll('[data-pp]').forEach((b) => { b.onclick = () => openPerson(b.dataset.pp); });
  renderHaoh(); renderBackup();
}
$('recQ').addEventListener('input', () => { REC.q = $('recQ').value; renderRec(); });
document.querySelectorAll('#recScope [data-sc]').forEach((b) => { b.onclick = () => { REC.scope = b.dataset.sc; renderRec(); }; });
function recOp(label, w, guard) {
  if (needEvent()) return null;
  const op = { id: rid('o'), type: 'edit', eid: S.cur, ename: (S.events[S.cur] || {}).name || '', items: [{ id: 'rec', name: label }], tapAt: now(), guard: !!guard };
  return runOp(op, w);
}
/* 1人の記録：まとめる・まとめを元に戻す・記録を分ける */
function openPerson(pid) {
  const rm = rosterById(), me = rm[pid]; if (!me || me.mergedInto) return;
  const rows = histRows().filter((h) => h.pid === pid).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const s = personStats(false)[pid] || { n: 0, win: 0, top3: 0 };
  const merged = S.roster.filter((r) => r.mergedInto === pid);
  const others = liveRoster().filter((r) => r.id !== pid).sort((a, b) => (a.name < b.name ? -1 : 1));
  const opt = (r) => '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>';
  $('sheet').innerHTML = '<h2 id="sheetTitle">' + esc(me.name) + 'さんの記録</h2>' +
    '<p>参加 ' + s.n + '回・優勝 ' + s.win + '回・3位以内 ' + s.top3 + '回（通算）</p>' +
    ((s.dup || []).length ? '<p class="warnline">同じ日の記録が2件あります（' + esc(s.dup.map(fmtDate).join('・')) + '）。いまは良い方の順位で数えています。別の人の記録なら、チェックして別の人へ移してください。</p>' : '') +
    (rows.length ? '<ul class="hrows">' + rows.map((h) => '<li><label><input type="checkbox" data-hr="' + esc(h.id) + '"><span><b>' + esc(fmtDate(h.date)) + '</b> ' + esc(h.ename || '') +
      '<br><small>' + esc(h.team || '') + '・' + h.rank + '位' + (h.teams ? '／' + h.teams + 'チーム' : '') + (h.total != null ? '・' + h.total + '点' : '') + (h.rid !== pid ? '・記録の名前「' + esc((rm[h.rid] || {}).name || h.name) + '」' : '') + '</small></span></label></li>').join('') + '</ul>'
      : '<p class="muted">まだ大会の記録がありません。</p>') +
    (rows.length ? '<div class="subbox"><b>チェックした記録を、別の人の記録にする</b><p class="muted" style="margin:2px 0 6px">同じ名前の別の人の記録が混ざっていたときに使います。</p>' +
      '<div class="field"><label for="spTo">移す先</label><select class="input" id="spTo"><option value="">（選んでください）</option><option value="_new">新しい人として名簿に入れる</option>' + others.map(opt).join('') + '</select></div>' +
      '<div class="field" id="spNewBox" hidden><label for="spNew">新しい人の名前</label><input class="input" id="spNew" maxlength="30" autocomplete="off"></div>' +
      '<p class="err" id="spErr"></p><button class="btn small" id="spGo" type="button">記録を移す</button></div>' : '') +
    '<div class="subbox"><b>ほかの人とまとめる（同じ人だったとき）</b><p class="muted" style="margin:2px 0 6px">名前を間違えて登録したなどで、同じ人の記録が2人に分かれているときに使います。あとで元に戻せます。</p>' +
      '<div class="field"><label for="mgWith">まとめる相手</label><select class="input" id="mgWith"><option value="">（選んでください）</option>' + others.map(opt).join('') + '</select></div>' +
      '<div id="mgMore" hidden></div></div>' +
    (merged.length ? '<div class="subbox"><b>まとめた人</b><ul class="hrows">' + merged.map((r) => '<li><span><b>' + esc(r.name) + '</b>' + (num(r.mergedAt) ? ' <small class="muted">' + esc(fmtDate(jstDate(num(r.mergedAt)))) + 'にまとめた</small>' : '') + '</span>' +
      (r.keepNameBefore && r.keepNameBefore !== me.name && (!r.keepNameAfter || r.keepNameAfter === me.name) ? '<label class="switch" style="margin-top:4px"><input type="checkbox" data-rn="' + esc(r.id) + '" checked><span class="tr"></span>' + esc(me.name) + 'さんの名前を「' + esc(r.keepNameBefore) + '」に戻す</label>' : '') +
      (r.mergeEv && r.mergeEv === S.cur && r.mergeCk ? '<small class="muted" style="display:block">いまの回の受付中にまとめた人です。元に戻すと、' + esc(r.name) + 'さんの受付とチームも元に戻します。</small>' : '') +
      '<button class="btn small ghost" type="button" data-um="' + esc(r.id) + '">元に戻す（別の人にする）</button></li>').join('') + '</ul></div>' : '') +
    '<div class="actions"><button class="btn ghost" id="ppClose" type="button">閉じる</button></div>';
  $('ov').hidden = false;
  $('ppClose').onclick = closeSheet;
  const checked = () => [...$('sheet').querySelectorAll('[data-hr]:checked')].map((c) => rows.find((h) => h.id === c.dataset.hr));
  /* 記録を分ける */
  if ($('spGo')) {
    let armed = false;
    const disarm = () => { if (!armed) return; armed = false; $('spGo').textContent = '記録を移す'; $('spGo').classList.remove('primary'); $('spErr').textContent = ''; };
    $('spTo').onchange = () => { $('spNewBox').hidden = $('spTo').value !== '_new'; disarm(); };
    $('spNew').oninput = disarm;
    $('sheet').querySelectorAll('[data-hr]').forEach((c) => { c.onchange = disarm; });
    $('spGo').onclick = () => {
      const sel = checked(), to = $('spTo').value, err = (m) => { $('spErr').textContent = m; armed = false; $('spGo').textContent = '記録を移す'; };
      if (!sel.length) return err('移す記録にチェックを入れてください');
      if (!to) return err('移す先を選んでください');
      let target = to, w = [], tname;
      if (to === '_new') {
        tname = $('spNew').value.trim().replace(/\s+/g, ' ').slice(0, 30);
        if (!tname) return err('新しい人の名前を入れてください');
        if (liveRoster().some((r) => norm(r.name) === norm(tname))) return err('名簿に「' + tname + '」さんがいます。移す先の一覧から選んでください');
        target = rid('n'); w.push({ op: 'set', path: ROOT + '/roster/' + target, data: { name: tname, norm: norm(tname), exp: false, beg: false, createdAt: TS, createdIn: 'split' } });
      } else tname = rm[to].name;
      const theirDates = new Set(histRows().filter((h) => h.pid === target).map((h) => h.date)), clash = sel.filter((h) => theirDates.has(h.date));
      if (!armed) { armed = true; $('spErr').textContent = clash.length ? '注意：' + tname + 'さんには同じ日の記録がすでにあります（' + clash.map((h) => fmtDate(h.date)).join('・') + '）。それでもよければ、もう一度押してください' : ''; $('spGo').textContent = 'もう一度押すと ' + sel.length + '件を' + tname + 'さんへ移します'; $('spGo').classList.add('primary'); return; }
      /* 1件ごとにルールで移す先・いまの持ち主・移した回数（mv）を確かめるので、15件ずつ別の操作にする。
         結果は、全部の返事が届いてから出す（一部だけ断られたときは、何件移ったかを出す） */
      const moves = sel.map((h) => ({ op: 'update', path: ROOT + '/hist/' + h.id, data: { rid: target, movedFrom: h.rid, movedAt: TS, mv: (num(h.mv) || 0) + 1 } }));
      const parts = chunks(moves, 15), ps = [];
      for (const [i, part] of parts.entries()) { const pr = recOp(me.name + 'さんの記録を' + tname + 'さんへ（' + part.length + '件）', (i ? [] : w).concat(part)); if (!pr) return; ps.push(pr.then(() => part.length, () => 0)); }
      closeSheet(); toast(sel.length + '件の記録を' + tname + 'さんへ送っています…');
      Promise.all(ps).then((ns) => { const ok = ns.reduce((a, n) => a + n, 0); toast(ok === sel.length ? sel.length + '件の記録を' + tname + 'さんへ移しました' : sel.length + '件のうち ' + ok + '件を移しました。' + (sel.length - ok) + '件は断られました（ほかの端末で先に移された、など）。受付タブの「届かなかった操作」で確かめてください', ok !== sel.length); });
    };
  }
  /* まとめる */
  $('mgWith').onchange = () => {
    const other = rm[$('mgWith').value];
    if (!other) { $('mgMore').hidden = true; return; }
    const base = (S.events[S.cur] || {}).rev || '';
    const myDates = new Set(rows.map((h) => h.date)), clash = histRows().filter((h) => h.pid === other.id && myDates.has(h.date));
    $('mgMore').hidden = false;
    $('mgMore').innerHTML = (clash.length ? '<p class="warnline">' + esc(me.name) + 'さんと' + esc(other.name) + 'さんは、同じ日の大会に両方の記録があります（' + esc([...new Set(clash.map((h) => fmtDate(h.date)))].join('・')) + '）。同じ人なら起きないはずなので、別の人かもしれません。</p>' : '') +
      '<p style="margin:6px 0 4px"><b>残す名前</b></p><div class="mg-names">' +
      '<label><input type="radio" name="mgName" value="me" checked> ' + esc(me.name) + '</label><label><input type="radio" name="mgName" value="other"> ' + esc(other.name) + '</label>' +
      '<label><input type="radio" name="mgName" value="new"> ほかの名前：<input class="input" id="mgNew" maxlength="30" autocomplete="off"></label></div>' +
      teamChoiceHtml(teamChoice(people().find((x) => x.id === pid), people().find((x) => x.id === other.id)), me.name, other.name) +
      '<p class="err" id="mgErr"></p><button class="btn small" id="mgGo" type="button">' + esc(other.name) + 'さんを' + esc(me.name) + 'さんとまとめる</button>';
    let armed = false;
    $('mgMore').querySelectorAll('input,select').forEach((x) => { x.addEventListener('change', () => { if (armed) { armed = false; $('mgGo').classList.remove('primary'); $('mgGo').textContent = other.name + 'さんを' + me.name + 'さんとまとめる'; } }); });
    $('mgGo').onclick = () => {
      const pick = (($('sheet').querySelector('[name=mgName]:checked') || {}).value) || 'me';
      const nn = pick === 'me' ? me.name : pick === 'other' ? other.name : $('mgNew').value.trim().replace(/\s+/g, ' ').slice(0, 30);
      if (!nn) { $('mgErr').textContent = '残す名前を入れてください'; return; }
      if (nn !== me.name && nn !== other.name && liveRoster().some((r) => r.id !== pid && r.id !== other.id && norm(r.name) === norm(nn))) { $('mgErr').textContent = '名簿に「' + nn + '」さんがほかにもいます。別の名前にしてください'; return; }
      if (!armed) { armed = true; $('mgGo').textContent = 'もう一度押すとまとめます（残す名前「' + nn + '」）'; $('mgGo').classList.add('primary'); return; }
      /* いまの回に、まとめられる側（other）が受付済みなら、受付のまとめと同じ書き込みにして、早帰り・目印・チームも引き継ぐ */
      const ps = people(), keepP = ps.find((x) => x.id === pid) || null, dropP = ps.find((x) => x.id === other.id) || null;
      const inNow = !!(S.cur && S.checkins.some((c) => c.id === other.id));
      const t = $('mgTeam') ? +$('mgTeam').value : undefined;
      if (!teamAlive(t)) { $('mgErr').textContent = '選んだチームは、ほかの端末で解散されていました。閉じて開き直してください'; return; }
      const live = rosterById()[pid];
      if (!live || live.name !== me.name || live.mergedInto) { $('mgErr').textContent = 'ほかの端末で、' + me.name + 'さんの名前やまとめが変わりました。閉じて開き直してください'; return; }
      const opId = rid('o'), o = inNow ? mergeOpts(keepP, dropP, t, base) : { carry: null };
      const w = W.merge(ROOT, S.cur, { id: pid, name: nn, isNew: false, rawId: keepP ? keepP.rawId : pid }, { id: other.id, name: other.name, rawId: other.id }, opId, inNow && !keepP, now(),
        { ...o, keepNameBefore: me.name, keepNameAfter: nn, dropIn: inNow });
      if (nn !== me.name) w.push({ op: 'update', path: ROOT + '/roster/' + pid, data: { name: nn, norm: norm(nn), nameChk: { v: me.name, op: opId } } });
      if (recOp(other.name + 'さんを' + nn + 'さんとまとめる', w, o.base != null)) { closeSheet(); toast(other.name + 'さんを' + nn + 'さんとまとめました。記録は合わせて数えます'); }
    };
  };
  /* まとめを元に戻す。いまの回の受付中にまとめた人なら、消した受付とチームも元に戻す */
  $('sheet').querySelectorAll('[data-um]').forEach((b) => {
    let armed = false;
    b.onclick = () => {
      const r = rm[b.dataset.um], current = rosterById()[b.dataset.um]; if (!r || !current || current.mergedInto !== pid || current.mergeId !== r.mergeId) { closeSheet(); toast('ほかの端末で、まとめが変わっていました。開き直してください', true); return; }
      if (!armed) { armed = true; b.textContent = 'もう一度押すと、' + r.name + 'さんを別の人に戻します'; b.classList.remove('ghost'); b.classList.add('primary'); return; }
      const opId = rid('o');
      const w = [{ op: 'update', path: ROOT + '/roster/' + r.id, data: { mergedInto: '', unmergedAt: TS, unmergeOf: r.mergeId || '' } }];
      const back = $('sheet').querySelector('[data-rn="' + r.id + '"]');
      if (back && back.checked) {
        const cur = (rosterById()[pid] || {}).name;
        if (r.keepNameAfter && cur !== r.keepNameAfter) { toast('ほかの端末で' + cur + 'さんの名前が直されていたので、名前は戻しませんでした', true); }
        else w.push({ op: 'update', path: ROOT + '/roster/' + pid, data: { name: r.keepNameBefore, norm: norm(r.keepNameBefore), nameChk: { v: cur, op: opId } } });
      }
      const restore = unmergeRestore(r, pid);
      w.push(...restore.w);
      if (recOp(r.name + 'さんのまとめを元に戻す', w)) { closeSheet(); toast(r.name + 'さんを別の人に戻しました。' + (restore.note || '記録も分かれて数えます')); }
    };
  });
}
/* まとめを元に戻すとき、いまの回の受付中にまとめていれば、消した受付・チームと、引き継いだ印を戻す書き込み */
function unmergeRestore(r, pid) {
  const ev = S.events[S.cur];
  if (!r.mergeEv || r.mergeEv !== S.cur || !ev || ev.status !== 'open' || !r.mergeCk) return { w: [] };
  const ps = people(), keepP = ps.find((x) => x.id === pid), w = [], asg = {};
  if (ps.some((x) => x.id === r.id)) return { w: [] };
  const ck = r.mergeCk;
  w.push({ op: 'set', path: ROOT + '/events/' + S.cur + '/checkins/' + r.id, data: { name: ck.name || r.name, isNew: !!ck.isNew, early: !!ck.early, pair: ck.pair || '', at: TS, tapAt: ck.tapAt || now(), dev: DEV, devName, batch: 'u' + r.id, n: 1, op: 'unmerge' } });
  const mk = r.mergeKeep || {};
  if (teamAlive(r.mergeTeam) && r.mergeTeam) asg['assign.' + r.id] = r.mergeTeam;
  /* 残した人の受付・チーム：まとめたときに引き継いだままなら、まとめる前に戻す */
  if (keepP && (mk.had || (r.mergeId && r.mergeId === 'g' + keepP.op))) {
    if (keepP.team === (mk.carried || 0) && (mk.team || 0) !== keepP.team && teamAlive(mk.team)) asg['assign.' + pid] = mk.team || null;
    if (!mk.had) w.push({ op: 'delete', path: ROOT + '/events/' + S.cur + '/checkins/' + keepP.rawId });
    else {
      const fix = {};
      if (!!keepP.early === !!mk.cEarly && !!keepP.early !== !!mk.early) fix.early = !!mk.early;
      if ((keepP.pair || '') === (mk.cPair || '') && (keepP.pair || '') !== (mk.pair || '')) fix.pair = mk.pair || '';
      if (Object.keys(fix).length) w.push({ op: 'update', path: ROOT + '/events/' + S.cur + '/checkins/' + keepP.rawId, data: fix });
    }
  }
  if (Object.keys(asg).length || w.length) w.push({ op: 'update', path: ROOT + '/events/' + S.cur, data: { ...asg, chk: { base: ev.rev || '', op: rid('u') } } });
  return { w, note: 'いまの回の受付' + (r.mergeTeam && teamAlive(r.mergeTeam) ? 'とチーム' : '') + 'も元に戻しました' };
}
/* テスト用：架空の過去の記録（3大会分）と、名前を間違えて登録した人（ハルト＝はると） */
function seedHistory() {
  const live = liveRoster().filter((r) => /^r\d\d$/.test(r.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (live.length < 16) { toast('先に架空の名簿24人を入れてください', true); return; }
  if (S.hist.some((h) => /^past/.test(h.eid))) { toast('架空の記録はもう入っています'); return; }
  const w = [{ op: 'set', path: ROOT + '/roster/r90', data: { name: 'ハルト', norm: norm('ハルト'), exp: false, beg: false, createdAt: TS } }];
  [['2026-08-02', 0], ['2026-09-06', 1], ['2026-10-04', 2]].forEach(([date, k]) => {
    const ps = [live[0]].concat(live.slice(1 + k * 2, 16 + k * 2)), teams = 4; // はると（r01）は毎回出る
    ps.forEach((r, i) => {
      const t = i % teams, rank = ((t + k) % teams) + 1, id = (k === 1 && r.id === 'r01') ? 'r90' : r.id; // 9月は「はると」を「ハルト」と間違えて登録した
      w.push({ op: 'set', path: ROOT + '/hist/past' + k + '_' + id, data: { eid: 'past' + k, ename: (8 + k) + '月の月いち（架空）', date, rid: id, name: id === 'r90' ? 'ハルト' : r.name, team: 'チーム' + (t + 1), members: [], rank, teams, played: 3, total: 300 - rank * 20, at: TS } });
    });
  });
  B.commit(S.cur ? W.rev(ROOT, S.cur, w) : w).then(() => toast('架空の過去の記録（3大会）を入れました'), (e) => toast('入れられませんでした（' + ((e && e.code) || '') + '）', true));
}


/* ===== 参加者画面への公開（11/22版の参加者ページと同じ形のデータ）=====
   運営の端末が public/tsukiichi_{箱} に1件だけ書く。ログインなしで読める場所なので、
   名前・チーム・コート・得点・順位・記録だけを入れる（経験豊富・評価・初心者・早帰り・目印・UID・端末の記録は入れない）。
   チームと対戦表は、抽選の発表が終わる（開催回の shown）まで出さない。出すまでは前回の結果を出す */
const PUB = 'public/tsukiichi_' + BOX;
const INFO = ROOT + '/conf/info';
const SETTINGS = { '大会名': '月いちモルック', '時間': '12時〜17時', '場所': '香川県高松市国分寺 B&G海洋センター ゲートボールコート', '住所': '香川県高松市国分寺町新名2069-1', '参加費': '1人200円', 'お知らせ': '指導員6名在籍なので初心者の方も大歓迎！小学生もガンガン投げてますよ。家族で参加大歓迎。', 'インスタ': 'izumi_molkky' };
function stamp(ms) { const d = new Date(ms + 9 * 3600000); return d.toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '/'); }
/* 記録（hist）を大会ごとにまとめる：前回の結果と、これまでの優勝チーム。
   チームは番号（teamNo。版15から記録に入れる）で分け、ない記録はチーム名・順位・合計点で分ける（同じ名前の別チームを1行にまぜない）。
   同じ日に2回締めたときも、締めた時刻（at）で新しい方を前にする */
function histEvents() {
  const rm = rosterById(), by = {};
  S.hist.filter((h) => !h.kind).forEach((h) => {
    const k = h.eid || h.date, e = by[k] || (by[k] = { eid: k, date: h.date, at: 0, teams: {} });
    e.at = Math.max(e.at, num(h.at) || 0);
    const tk = h.teamNo != null ? 'n' + h.teamNo : h.team + '|' + h.rank + '|' + h.total;
    const t = e.teams[tk] || (e.teams[tk] = { name: h.team, rank: h.rank, total: h.total, played: h.played, members: [] });
    t.members.push((rm[resolveId(h.rid, rm)] || {}).name || h.name);
  });
  return Object.values(by).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.at - a.at || (a.eid < b.eid ? 1 : -1));
}
/* 前回の結果：締めた回に保存した順位（final）のうち、いちばん新しく締めた回。なければ記録から */
function lastResult(evs) {
  const closed = Object.keys(S.events).filter((k) => k !== S.cur && S.events[k].status === 'closed' && S.events[k].final && (S.events[k].final.standings || []).length)
    .map((k) => S.events[k]).sort((a, b) => (num(b.closedAt) || 0) - (num(a.closedAt) || 0));
  if (closed.length) { const f = closed[0].final; return { date: f.date, standings: f.standings.map((t) => ({ name: t.name, total: t.total, members: (t.members || []).join('・'), rank: t.rank, played: t.played == null ? '―' : t.played })) }; }
  const last = evs.find((e) => Object.values(e.teams).some((t) => t.total != null));
  return last ? { date: last.date, standings: Object.values(last.teams).sort((a, b) => a.rank - b.rank).map((t) => ({ name: t.name, total: t.total, members: t.members.join('・'), rank: t.rank, played: t.played == null ? '―' : t.played })) } : null;
}
function publicData() {
  const ev = S.events[S.cur] || {}, shown = !!ev.shown, teams = shown ? evTeams(ev) : [], ms = shown ? evMatches(ev) : [], ps = people();
  const pos = assignCourts(ms, courtsOf(ev)), rm = rosterById();
  const evs = histEvents();
  const state = {
    /* 開催日：チームを出している回（当日）はその回の日、それ以外は案内に書いた次回の開催日 */
    settings: { ...infoNow(), '開催日': shown || !infoNow()['開催日'] ? evDate(ev) : infoNow()['開催日'] }, courts: courtsOf(ev),
    players: shown ? ps.filter((p) => p.team).map((p) => ({ name: p.name, team: p.team })) : [],
    teams: teams.map((t) => ({ no: t.no, name: t.name })),
    matches: ms.map((m) => ({ id: m.id, cycle: m.c, round: m.r, a: m.a, b: m.b, totalA: hasRes(m) ? m.ta : '', totalB: hasRes(m) ? m.tb : '', court: (pos[m.id] || {}).court || 1, wave: (pos[m.id] || {}).wave || 1 })),
    standings: shown ? standings(teams, ms, ps).map((x) => ({ no: x.no, name: x.name, rank: x.rank, played: x.played, total: x.total, avg: x.avg, members: x.members.join('・') })) : [],
    champions: evs.map((e) => { const w = Object.values(e.teams).filter((t) => t.rank === 1); return w.length ? { date: e.date, members: w.map((t) => t.members.join('・')).join('／'), total: w[0].total } : null; }).filter(Boolean),
    previousResult: lastResult(evs)
  };
  const live = {}; histRows().forEach((h) => { live[h.pid] = 1; });
  const records = {
    rows: histRows().map((h) => ({ name: (rm[h.pid] || {}).name || h.name, mid: h.pid, rank: h.rank, date: h.date, team: h.team, total: h.total == null ? null : h.total, teams: h.teams || null })),
    roster: liveRoster().filter((r) => live[r.id]).map((r) => ({ id: r.id, name: r.name })),
    haoh: S.hist.filter((h) => h.kind === 'haoh').map((h) => ({ no: h.no, name: (rm[resolveId(h.rid, rm)] || {}).name || h.name, date: h.date, mid: h.rid ? resolveId(h.rid, rm) : '' })).sort((a, b) => a.no - b.no)
  };
  return { state, records };
}
/* 参加者画面への書き込み。送っている間に変わったら、届いたあとにもう一度送る。断られた・届かないときは運営画面に出して、少し待ってやり直す。
   ほかの端末が古い内容を書いたとき（参加者画面の中身が、この端末で作る中身と違うとき）は、この端末が新しい内容で書き直す */
const PUB_MAX = 900000; // Firestore の1文書の上限（約1MB）より少し小さく
let pubTimer = null, pubBusy = false, pubAgain = false, pubFlips = [];
const PUBST = { err: '', size: 0, at: 0 };
function schedulePublish(delay) {
  if (!S.mode || !B || serverState() !== 'ok' || !S.sync.hist || S.sync.hist.cache || !S.sync.pub) return;
  clearTimeout(pubTimer); pubTimer = setTimeout(publishNow, delay == null ? 1200 : delay);
}
function publishNow() {
  if (!S.cur || !S.events[S.cur] || !['events', 'box', 'roster', 'checkins', 'hist', 'pub', 'info'].every((k) => S.sync[k] && !S.sync[k].cache) || unsent().length) return;
  if (pubBusy) { pubAgain = true; return; }
  const body = JSON.stringify(publicData());
  const rev = S.events[S.cur].rev || '';
  PUBST.size = new TextEncoder().encode(body).byteLength;
  if (S.pub && !('by' in S.pub) && S.pub.event === S.cur && S.pub.rev === rev && S.pub.body === body) { if (PUBST.err !== 'size') PUBST.err = ''; return; }
  if (PUBST.size > PUB_MAX) { if (PUBST.err !== 'size') { PUBST.err = 'size'; renderBar(); } return; }
  /* 2台が違う中身を書き合うのが続くとき（片方の表示が古いまま）は、1分に20回までにする */
  const t = now(); pubFlips = pubFlips.filter((x) => t - x < 60000);
  if (pubFlips.length >= 20) { PUBST.err = 'flip'; renderBar(); schedulePublish(20000); return; }
  pubFlips.push(t);
  pubBusy = true; pubAgain = false;
  B.commit([{ op: 'set', path: PUB, data: { body, updatedAt: stamp(Date.now()), at: TS, box: BOX, event: S.cur, rev, seq: (S.pub?.seq || 0) + 1 } }]).then(() => {
    pubBusy = false; PUBST.at = now(); if (PUBST.err) { PUBST.err = ''; renderBar(); }
    if (pubAgain) schedulePublish(300);
  }, (e) => {
    pubBusy = false; PUBST.err = (e && e.code) || 'error'; renderBar();
    schedulePublish(pubAgain ? 1000 : 15000);
  });
}
function setShown(on, drawId) { teamOp(on ? '参加者画面にチームを出す' : '参加者画面からチームを下げる', on ? { shown: true, shownDraw: drawId || '' } : { shown: false }, on ? 'ほかの端末で抽選し直されていたため、参加者画面には出しませんでした。チームタブで、いまのチームを確かめてください' : ''); }
/* ===== 現行のスプレッドシート（月いちモルック 運営シート）からの取り込み =====
   名簿（名簿ID・経験豊富）、大会ごとの順位と参加者、覇王戦、大会の案内。build.py が src/past.json の中身を入れる。
   すでにある人（同じ名簿ID・同じ名前）と、すでにある記録（同じ日・同じ人）・覇王戦（同じ回）は飛ばすので、何度押しても重ならない */
const PAST = /*@@PAST@@*/ { roster: [], events: [], haoh: [], info: {} };
/* 経験豊富の印は運営だけの情報なので、公開されるページの中に入れない。取り込むときに運営が名前を貼り付ける */
function importExp() { const el = $('impExp'); return new Set(String((el && el.value) || '').split(/[・,、\s]+/).map(norm).filter(Boolean)); }
function importPlan() {
  const rm = rosterById(), byNorm = {}, idMap = {}, w = [], names = {}, ex = importExp();
  liveRoster().forEach((r) => { (byNorm[norm(r.name)] = byNorm[norm(r.name)] || []).push(r.id); });
  let newP = 0, expN = 0, rows = 0, skip = 0, haoh = 0;
  const amb = [];
  PAST.roster.forEach((p) => {
    names[p.id] = p.name; // 飛ばす人の名前も、同じチームの人の記録（members）には要る
    /* 同じ名前の人が名簿に2人以上いるときは、どちらか分からないので取り込まない（別人に成績が付かないように） */
    const cand = byNorm[norm(p.name)] || [];
    if (!rm[p.id] && cand.length > 1) { amb.push(p.name); return; }
    let id = rm[p.id] ? resolveId(p.id, rm) : cand[0];
    const isExp = ex.has(norm(p.name));
    if (!id) { id = p.id; newP++; if (isExp) expN++; w.push({ op: 'set', path: ROOT + '/roster/' + id, data: { name: p.name, norm: norm(p.name), exp: isExp, beg: false, first: p.first || '', createdAt: TS, createdIn: 'sheet' } }); }
    else if (isExp && !(rm[id] || {}).exp) { expN++; w.push({ op: 'update', path: ROOT + '/roster/' + id, data: { exp: true } }); }
    idMap[p.id] = id;
  });
  /* 取り込んだ記録は、あとで持ち主を移したり、持ち主がまとめられたりしても、文書の名前（imp-日付_元の名簿ID）は変わらない。元の名簿IDをいまの人にたどって比べる */
  const have = {}; histRows().forEach((h) => { have[h.date + '|' + h.pid] = 1; });
  S.hist.forEach((h) => { const m = /^imp-(\d{4}-\d\d-\d\d)_(.+)$/.exec(h.id); if (m) have[m[1] + '|' + resolveId(m[2], rm)] = 1; });
  PAST.events.forEach((e) => {
    e.standings.forEach((t, i) => {
      t.members.forEach((m) => {
        const pid = idMap[m];
        if (!pid) return;
        if (have[e.date + '|' + pid]) { skip++; return; } // 取り込んだあと持ち主を直した・まとめた記録も飛ばす
        have[e.date + '|' + pid] = 1; rows++;
        w.push({ op: 'set', path: ROOT + '/hist/imp-' + e.date + '_' + pid, data: { eid: 'imp-' + e.date, ename: '月いちモルック（' + fmtDate(e.date) + '）', date: e.date, rid: pid, name: names[m], team: t.team, teamNo: i + 1,
          members: t.members.map((x) => names[x]), rank: t.rank, teams: e.teams || null, played: t.played == null ? null : t.played, total: t.total == null ? null : t.total, src: 'sheet', at: TS } });
      });
    });
  });
  PAST.haoh.forEach((h) => {
    if (S.hist.some((x) => x.kind === 'haoh' && num(x.no) === h.no)) return;
    haoh++; w.push({ op: 'set', path: ROOT + '/hist/haoh_' + h.no, data: { kind: 'haoh', no: h.no, date: h.date, rid: idMap[h.rid] || h.rid, name: h.name, entrants: [], src: 'sheet', ver: 'sheet-' + h.no, at: TS } });
  });
  const info = !S.info;
  if (info) w.push({ op: 'set', path: INFO, data: { ...PAST.info, updatedAt: TS } });
  return { w, newP, expN, rows, skip, haoh, info, amb, total: PAST.roster.length, events: PAST.events.length };
}
function renderImport() {
  if (!$('impBox')) return;
  const pl = importPlan(), none = !pl.w.length;
  $('impSum').textContent = '取り込み元：' + (PAST.src || '') + '。名簿 ' + pl.total + '人・大会 ' + pl.events + '回分・覇王戦 ' + PAST.haoh.length + '回。' +
    (none ? 'すべて取り込み済みです。' : '新しく入るもの：名簿 ' + pl.newP + '人' + (pl.expN ? '（経験豊富の印 ' + pl.expN + '人）' : '') + '・記録 ' + pl.rows + '件' + (pl.skip ? '（すでにある ' + pl.skip + '件は飛ばします）' : '') + '・覇王戦 ' + pl.haoh + '件' + (pl.info ? '・大会の案内' : '') + '。') + (pl.amb.length ? '名簿に同じ名前の人が2人以上いるため、' + pl.amb.join('・') + ' さんの分は取り込みません（名前を直すか、まとめてから）。' : '');
  $('impGo').hidden = none;
}
function importSheet(btn) {
  if (needEvent()) return;
  if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'もう一度押すと取り込みます'; btn.classList.add('primary'); return; }
  delete btn.dataset.armed; btn.textContent = '取り込む'; btn.classList.remove('primary');
  const pl = importPlan(); if (!pl.w.length) { toast('すべて取り込み済みです'); return; }
  btn.disabled = true;
  /* 名簿を先に（記録より前に人がいるように）。1回のまとめ書きは400件まで */
  const ros = pl.w.filter((x) => x.path.indexOf('/roster/') > 0), rest = pl.w.filter((x) => x.path.indexOf('/roster/') < 0);
  const send = (parts) => parts.reduce((pr, part) => pr.then(() => B.commit(S.cur ? W.rev(ROOT, S.cur, part) : part)), Promise.resolve());
  send(chunks(ros, 400)).then(() => send(chunks(rest, 400))).then(() => { btn.disabled = false; toast('取り込みました（名簿 ' + pl.newP + '人・記録 ' + pl.rows + '件・覇王戦 ' + pl.haoh + '件）'); },
    (e) => { btn.disabled = false; toast('取り込めませんでした（' + ((e && e.code) || '') + '）。もう一度押すと、まだの分だけ入れます', true); });
}

/* ===== 大会の案内（参加者画面に出す。運営画面の設定タブで直す） ===== */
const INFO_KEYS = [['大会名', 'text'], ['開催日', 'date'], ['時間', 'text'], ['場所', 'text'], ['住所', 'text'], ['参加費', 'text'], ['お知らせ', 'area'], ['インスタ', 'text']];
function infoNow() { const o = { ...SETTINGS }; if (S.info) INFO_KEYS.forEach(([k]) => { if (S.info[k] != null) o[k] = String(S.info[k]); }); return o; }
/* 案内の入力欄：開いたときの値（INFO_BASE）を覚え、直した欄だけを保存する。ほかの端末が直した欄は、こちらで触っていなければ入力欄も新しくする */
let INFO_BASE = {};
function renderInfo(force) {
  const box = $('infoFields'); if (!box) return;
  const o = infoNow();
  if (box.dataset.ready && !force) {
    INFO_KEYS.forEach(([k]) => { const el = $('if_' + k); if (el && el.value === (INFO_BASE[k] || '') && (o[k] || '') !== (INFO_BASE[k] || '')) { el.value = o[k] || ''; INFO_BASE[k] = o[k] || ''; } });
    $('infoMsg').textContent = S.info && S.info.updatedAt ? '最後に保存：' + hm(S.info.updatedAt) + (S.info.by ? '（' + S.info.by + '）' : '') : ''; return;
  }
  INFO_BASE = {}; INFO_KEYS.forEach(([k]) => { INFO_BASE[k] = o[k] || ''; });
  box.innerHTML = INFO_KEYS.map(([k, t]) => '<div class="field"><label for="if_' + k + '">' + esc(k) + (k === 'インスタ' ? '（@なし）' : '') + '</label>' +
    (t === 'area' ? '<textarea class="input" id="if_' + k + '" rows="3">' + esc(o[k] || '') + '</textarea>' : '<input class="input" id="if_' + k + '" type="' + t + '" value="' + esc(o[k] || '') + '">') + '</div>').join('');
  box.dataset.ready = '1';
  $('infoMsg').textContent = '';
}
function saveInfo() {
  const data = {}; INFO_KEYS.forEach(([k]) => { const v = $('if_' + k).value.trim(); if (v !== (INFO_BASE[k] || '').trim()) data[k] = v; });
  if (data['開催日'] && !/^\d{4}-\d\d-\d\d$/.test(data['開催日'])) { $('infoMsg').textContent = '開催日は日付で選んでください'; return; }
  if (!Object.keys(data).length) { $('infoMsg').textContent = '直したところはありません'; return; }
  $('infoSave').disabled = true; $('infoMsg').textContent = '保存しています…';
  B.commit([{ op: 'merge', path: INFO, data: { ...data, updatedAt: TS, by: devName } }]).then(() => { Object.assign(INFO_BASE, data); $('infoSave').disabled = false; $('infoMsg').textContent = '保存しました（' + Object.keys(data).join('・') + '）。参加者画面にも出ます'; schedulePublish(); },
    (e) => { $('infoSave').disabled = false; $('infoMsg').textContent = '保存できませんでした（' + ((e && e.code) || '') + '）。電波を確かめて、もう一度押してください'; });
}

/* ===== 覇王戦：記録と、次の出場資格（前回の覇王戦の日以降に優勝した覇者。同じ日の優勝も入れる。2026-11-25 丸岡さん確認） ===== */
function haohList() { return S.hist.filter((h) => h.kind === 'haoh').map((h) => ({ ...h, no: num(h.no) })).sort((a, b) => a.no - b.no); }
function haohEligible() {
  const hs = haohList(), last = hs.reduce((a, h) => (!a || (h.date || '') > (a.date || '') || ((h.date || '') === (a.date || '') && h.no > a.no) ? h : a), null);
  const cut = last ? last.date || '' : '', rm = rosterById(), by = {};
  histRows().forEach((h) => {
    if (h.rank !== 1 || !h.date || (cut && h.date < cut)) return;
    const e = by[h.pid] || (by[h.pid] = { id: h.pid, name: (rm[h.pid] || {}).name || h.name, dates: {} });
    e.dates[h.date] = 1;
  });
  const list = Object.values(by).map((e) => ({ id: e.id, name: e.name, wins: Object.keys(e.dates).length, dates: Object.keys(e.dates).sort() }))
    .sort((a, b) => b.wins - a.wins || (a.name < b.name ? -1 : 1));
  return { last, cut, nextNo: hs.reduce((m, h) => Math.max(m, h.no || 0), 0) + 1, list };
}
function renderHaoh() {
  if (!$('hoBox')) return;
  const hs = haohList(), el = haohEligible(), rm = rosterById();
  $('hoPast').innerHTML = hs.length ? hs.slice().reverse().map((h) => '<li><span><b>第' + h.no + '回</b> ' + esc(fmtDate(h.date)) + '　覇王 <b>' + esc((rm[resolveId(h.rid, rm)] || {}).name || h.name) + '</b>' +
    ((h.entrants || []).length ? '<small class="muted">（出場 ' + h.entrants.length + '人）</small>' : '') + '</span><button class="btn small ghost" type="button" data-ho="' + h.no + '">直す</button></li>').join('') : '<li class="muted">まだ覇王戦の記録がありません</li>';
  $('hoElH').textContent = '第' + el.nextNo + '回 覇王戦に出られる覇者 ' + el.list.length + '人';
  $('hoElNote').textContent = el.cut ? '前回（第' + el.last.no + '回 ' + fmtDate(el.cut) + '）の覇王戦の日以降に、月いちで優勝したチームのメンバーです。' : 'まだ覇王戦の記録がないので、これまでの優勝チームのメンバー全員です。';
  $('hoEl').innerHTML = el.list.length ? el.list.map((e) => '<li><div class="ho-top"><span class="pname">' + esc(e.name) + '</span><span class="ho-n">優勝 ' + e.wins + '回</span></div><div class="ho-dates">' + e.dates.map((d) => '<span>' + esc(fmtDate(d)) + '</span>').join('') + '</div></li>').join('') : '<li class="muted">まだいません</li>';
  $('hoPast').querySelectorAll('[data-ho]').forEach((b) => { b.onclick = () => openHaoh(+b.dataset.ho); });
}
function haohText() {
  const el = haohEligible();
  return '第' + el.nextNo + '回 覇王戦 出場資格（' + (el.cut ? fmtDate(el.cut) + '以降の覇者' : 'これまでの覇者') + '）' + el.list.length + '人\n' + el.list.map((e) => '・' + e.name + (e.wins > 1 ? '（優勝' + e.wins + '回）' : '')).join('\n');
}
function openHaoh(no) {
  const el = haohEligible(), old = no ? haohList().find((h) => h.no === no) : null, rm = rosterById();
  const live = liveRoster().slice().sort((a, b) => (a.name < b.name ? -1 : 1));
  const entr = old ? (old.entrants || []).map((id) => resolveId(id, rm)) : el.list.map((e) => e.id);
  const pool = old ? live.filter((r) => entr.includes(r.id)) : el.list.map((e) => rm[e.id]).filter(Boolean);
  const king = old ? resolveId(old.rid, rm) : '';
  $('sheet').innerHTML = '<h2 id="sheetTitle">' + (old ? '第' + old.no + '回 覇王戦の記録を直す' : '覇王戦の結果を記録する') + '</h2>' +
    '<div class="field"><label for="hoNo">何回目</label><input class="input" id="hoNo" inputmode="numeric" maxlength="3" value="' + (old ? old.no : el.nextNo) + '"' + (old ? ' disabled' : '') + ' style="max-width:6em"></div>' +
    '<div class="field"><label for="hoDate">開催日</label><input class="input" id="hoDate" type="date" value="' + esc(old ? old.date : jstDate(srvNow())) + '"></div>' +
    '<div class="field"><b>出場した人</b>' + (old ? '' : '<small class="muted" style="display:block">出場資格のある覇者 ' + el.list.length + '人を最初からチェックしています。出なかった人は外してください。</small>') +
    '<ul class="checks" id="hoEnt">' + pool.map((r) => '<li><label><input type="checkbox" value="' + esc(r.id) + '"' + (entr.includes(r.id) ? ' checked' : '') + '> ' + esc(r.name) + '</label></li>').join('') + '</ul>' +
    '<div class="field"><label for="hoAdd">ほかの人を出場者に足す</label><select class="input" id="hoAdd"><option value="">（選ぶと上に足します）</option>' + live.filter((r) => !pool.includes(r)).map((r) => '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>').join('') + '</select></div></div>' +
    '<div class="field"><label for="hoKing">覇王（優勝した人）</label><select class="input" id="hoKing"></select></div>' +
    '<p class="err" id="hoErr" aria-live="polite"></p>' +
    '<div class="actions"><button class="btn primary" id="hoSave" type="button">記録する</button><button class="btn ghost" id="hoCancel" type="button">やめる</button></div>';
  const fillKing = () => {
    /* 覇王は出場した人から選ぶ。取り込んだ記録など出場者が分からないときも、記録されている覇王は選べるようにする */
    const ids = [...$('hoEnt').querySelectorAll('input:checked')].map((x) => x.value), cur = $('hoKing').value || king;
    if (king && !((old && old.entrants) || []).length && !ids.includes(king)) ids.unshift(king); // 出場者の記録がない回（取り込んだ記録）だけ
    $('hoKing').innerHTML = '<option value="">（選んでください）</option>' + ids.map((id) => '<option value="' + esc(id) + '"' + (id === cur ? ' selected' : '') + '>' + esc((rm[id] || {}).name || id) + '</option>').join('');
  };
  fillKing();
  $('hoEnt').onchange = fillKing;
  $('hoAdd').onchange = () => {
    const id = $('hoAdd').value; if (!id) return;
    $('hoEnt').insertAdjacentHTML('beforeend', '<li><label><input type="checkbox" value="' + esc(id) + '" checked> ' + esc((rm[id] || {}).name || id) + '</label></li>');
    $('hoAdd').querySelector('option[value="' + CSS.escape(id) + '"]').remove(); $('hoAdd').value = ''; fillKing();
  };
  $('hoCancel').onclick = closeSheet;
  $('hoSave').onclick = () => {
    const n = old ? old.no : parseInt($('hoNo').value, 10), date = $('hoDate').value, k = $('hoKing').value;
    const ids = [...$('hoEnt').querySelectorAll('input:checked')].map((x) => x.value);
    if (!(n > 0)) { $('hoErr').textContent = '何回目かを数字で入れてください'; return; }
    if (!old && haohList().some((h) => h.no === n)) { $('hoErr').textContent = '第' + n + '回はもう記録があります。直すときは一覧の「直す」から'; return; }
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) { $('hoErr').textContent = '開催日を選んでください'; return; }
    if (!k) { $('hoErr').textContent = '覇王を選んでください'; return; }
    /* ver：この記録の版。直すときは見ていた版（editOf）を添え、ルールで同じときだけ通す（2台が同じ回を同時に書いても上書きしない） */
    const opv = rid('hv');
    const data = { kind: 'haoh', no: n, date, rid: k, name: (rm[k] || {}).name || '', entrants: ids, src: old ? old.src || 'app' : 'app', ver: opv, editOf: old ? old.ver || '' : 'new', at: TS }; // 新しく記録するときの 'new' は、どの版とも合わない（同じ回がもうあれば断られる）
    if (recOp('第' + n + '回 覇王戦の記録', [{ op: 'set', path: ROOT + '/hist/haoh_' + n, data }])) { closeSheet(); toast('第' + n + '回 覇王戦を記録しました。次の出場資格は ' + fmtDate(date) + ' 以降の覇者になります'); }
  };
  $('ov').hidden = false;
}

/* ===== バックアップ（自宅NASのフォルダへ）=====
   パソコンの Chrome・Edge では、保存先のフォルダ（NASの共有フォルダ）を一度選べば、ボタン1つと「回を締めたとき」に、日付つきのファイルをそこへ保存する。
   選べない端末（iPhone など）は、ファイルとして保存（「ファイル」アプリから NAS へ入れる）。中身は名簿・記録・開催回（受付つき）・大会の案内 */
const BK = { dir: null, last: ls.get('bk_last', 0), busy: false };
const bkIdb = () => new Promise((res, rej) => { const r = indexedDB.open('tk_backup', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function bkGet(k) { const db = await bkIdb(); return new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); }
async function bkPut(k, v) { const db = await bkIdb(); return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); }
async function bkLoad() { try { BK.dir = window.showDirectoryPicker ? await bkGet('dir_' + BOX) : null; } catch (e) { BK.dir = null; } renderBackup(); }
async function backupData() {
  const docs = {}, put = (path, d) => { docs[path] = d; };
  const ev = await B.getServerCol(ROOT + '/events'), ro = await B.getServerCol(ROOT + '/roster'), hi = await B.getServerCol(ROOT + '/hist');
  put(ROOT, await B.getServer(ROOT)); put(INFO, await B.getServer(INFO));
  ro.forEach((d) => put(ROOT + '/roster/' + d.id, strip(d))); hi.forEach((d) => put(ROOT + '/hist/' + d.id, strip(d)));
  for (const e of ev) { put(ROOT + '/events/' + e.id, strip(e)); (await B.getServerCol(ROOT + '/events/' + e.id + '/checkins')).forEach((c) => put(ROOT + '/events/' + e.id + '/checkins/' + c.id, strip(c))); }
  return { app: 'tsukiichi-fb', ver: VER, box: BOX, savedAt: srvNow(), savedBy: devName, counts: { roster: ro.length, hist: hi.length, events: ev.length }, docs };
}
function strip(d) { const o = { ...d }; delete o.id; return o; }
function bkName(auto) { const d = new Date(srvNow() + 9 * 3600000).toISOString(); return 'tsukiichi_' + d.slice(0, 10) + '_' + d.slice(11, 13) + d.slice(14, 16) + d.slice(17, 19) + (auto ? '_締め' : '') + '_' + (devName || 'pc').replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]/g, '').slice(0, 8) + Math.random().toString(36).slice(2, 5) + '.json'; } // 2台が同じ秒に保存しても上書きしない
async function saveBackup(auto) {
  if (BK.busy || !B) return;
  if (S.mode === 'demo' && auto) return; // 練習モードの締めでは保存しない
  BK.busy = true; renderBackup('バックアップを作っています…');
  try {
    const data = await backupData(), text = JSON.stringify(data), name = bkName(auto);
    let where = '';
    if (BK.dir) {
      let perm = await BK.dir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && !auto) perm = await BK.dir.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        const fh = await BK.dir.getFileHandle(name, { create: true }), wr = await fh.createWritable();
        await wr.write(text); await wr.close(); where = '「' + BK.dir.name + '」フォルダ';
      } else if (auto) { BK.busy = false; renderBackup('締めたときの自動保存は、フォルダへの書き込みの許可が切れていたためできませんでした。「いま保存する」を押してください'); return; }
    }
    if (!where) {
      if (auto) { BK.busy = false; renderBackup(); return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); where = 'この端末の「ダウンロード」';
    }
    BK.last = srvNow(); ls.set('bk_last', BK.last); BK.busy = false;
    renderBackup('保存しました：' + where + 'に ' + name + '（名簿 ' + data.counts.roster + '人・記録 ' + data.counts.hist + '件・開催回 ' + data.counts.events + '回）');
  } catch (e) { BK.busy = false; renderBackup('保存できませんでした（' + ((e && (e.code || e.name)) || '') + '）。電波とフォルダを確かめて、もう一度押してください'); }
}
function renderBackup(msg) {
  if (!$('bkBox')) return;
  const can = !!window.showDirectoryPicker;
  $('bkDirLine').textContent = can ? (BK.dir ? '保存先：「' + BK.dir.name + '」フォルダ（この端末で選んだもの）。回を締めたときも自動で保存します。' : '保存先のフォルダがまだ選ばれていません。NASの共有フォルダを選んでください。')
    : 'この端末ではフォルダを選べないので、ファイルとして保存します。iPhone は「ファイル」アプリで NAS（サーバへ接続）に移してください。パソコンの Chrome で開くと、NAS のフォルダへ直接保存できます。';
  $('bkPick').hidden = !can;
  $('bkPick').textContent = BK.dir ? '保存先を選び直す' : '保存先のフォルダを選ぶ';
  $('bkSave').disabled = BK.busy;
  const days = BK.last ? Math.floor((srvNow() - BK.last) / 86400000) : null;
  $('bkLast').textContent = BK.last ? 'この端末からの最後の保存：' + fmtDate(jstDate(BK.last)) + ' ' + hm(BK.last) + (days > 31 ? '（1か月以上たっています）' : '') : 'この端末からはまだ保存していません。';
  if (msg != null) $('bkMsg').textContent = msg;
}
async function pickBackupDir() {
  try { const d = await window.showDirectoryPicker({ id: 'tsukiichi-backup', mode: 'readwrite' }); BK.dir = d; await bkPut('dir_' + BOX, d); renderBackup('保存先を「' + d.name + '」にしました'); }
  catch (e) { if (e && e.name !== 'AbortError') renderBackup('フォルダを選べませんでした（' + e.name + '）'); }
}
/* バックアップから戻す：サーバーにない名簿・記録・大会の案内だけを足す（あるものは書き換えない）。開催回と受付は戻さない */
/* 戻す計画：サーバーから名簿・記録・案内を読み直して、ないものだけ足す。押したときにもう一度読み直すので、その間にほかの端末が作ったものは書き換えない。
   戻した人（restoredAt あり）のまとめ（mergedInto）がまだなら、もう一度押したときにも続きを入れる */
async function restorePlan(data) {
  const ro = await B.getServerCol(ROOT + '/roster'), hi = await B.getServerCol(ROOT + '/hist'), info = await B.getServer(INFO);
  const rm = {}, hid = {}; ro.forEach((r) => { rm[r.id] = r; }); hi.forEach((h) => { hid[h.id] = 1; });
  const add = [], mergeLater = [];
  Object.keys(data.docs).forEach((path) => {
    const d = data.docs[path], parts = path.split('/'); if (!d || parts.length !== 4 || parts[1] !== data.box) return;
    const p = ROOT + '/' + parts[2] + '/' + parts[3];
    if (parts[2] === 'roster') {
      const cur = rm[parts[3]], { mergedInto, ...rest } = d;
      /* まとめは、戻した人に restoreMerge（まとめ先）を付けておき、まとめ終えたら消す。あとで運営が「元に戻す」をした人は、もう一度戻してもまとめ直さない */
      if (!cur) add.push({ op: 'set', path: p, data: { ...rest, restoredAt: TS, ...(mergedInto ? { restoreMerge: mergedInto } : {}) } });
      if (mergedInto && (!cur || (cur.restoreMerge === mergedInto && !cur.mergedInto))) mergeLater.push({ op: 'update', path: p, data: { mergedInto, restoreMerge: null }, src: parts[3], dst: mergedInto });
    }
    if (parts[2] === 'hist' && !hid[parts[3]]) add.push({ op: 'set', path: p, data: { ...d, restoredAt: TS } });
    if (parts[2] === 'conf' && parts[3] === 'info' && !info) add.push({ op: 'set', path: INFO, data: d });
  });
  return { add, mergeLater };
}
async function restoreBackup(file) {
  let data; try { data = JSON.parse(await file.text()); } catch (e) { renderBackup('ファイルを読めませんでした（バックアップのファイルを選んでください）'); return; }
  if (!data || data.app !== 'tsukiichi-fb' || !data.docs) { renderBackup('月いちのバックアップのファイルではありません'); return; }
  let pl; try { pl = await restorePlan(data); } catch (e) { renderBackup('サーバーを読めませんでした（' + ((e && e.code) || '') + '）。電波を確かめてください'); return; }
  const n = pl.add.length + pl.mergeLater.length;
  if (!n) { BK.data = null; $('bkRestoreGo').hidden = true; renderBackup('このバックアップの名簿・記録は、すべてサーバーにあります。戻すものはありません'); return; }
  BK.data = data;
  $('bkRestoreGo').hidden = false; $('bkRestoreGo').textContent = 'サーバーにない ' + pl.add.length + '件を足す' + (pl.mergeLater.length ? '（まとめ ' + pl.mergeLater.length + '人）' : '');
  renderBackup('バックアップ（' + fmtDate(jstDate(data.savedAt || 0)) + ' 保存）に、サーバーにない名簿・記録・案内が ' + pl.add.length + '件あります。足すときは下のボタンを押してください（あるものは書き換えません）。');
}
async function applyRestore() {
  if (!BK.data || needEvent()) return;
  $('bkRestoreGo').disabled = true;
  try {
    const pl = await restorePlan(BK.data);
    for (const part of chunks(pl.add, 400)) await B.commit(S.cur ? W.rev(ROOT, S.cur, part) : part);
    /* A→B と B→C があるときは、A→B を先に（B がまとめられる前に）別のまとめ書きで */
    let rest = pl.mergeLater.slice();
    while (rest.length) {
      const now = rest.filter((m) => !rest.some((o) => o.dst === m.src)); // まとめ先にもなっている人は後の回へ
      const round = now.length ? now : rest;
      for (const part of chunks(round.map(({ src, dst, ...w }) => w), 15)) await B.commit(S.cur ? W.rev(ROOT, S.cur, part) : part);
      rest = rest.filter((m) => !round.includes(m));
    }
    BK.data = null; $('bkRestoreGo').hidden = true; renderBackup('バックアップから ' + pl.add.length + '件を戻しました' + (pl.mergeLater.length ? '（まとめ ' + pl.mergeLater.length + '人）' : ''));
  } catch (e) { renderBackup('戻せませんでした（' + ((e && e.code) || '') + '）。もう一度押すと、まだの分だけ戻します'); }
  $('bkRestoreGo').disabled = false;
}

/* ===== システム（もう1段階のパスワード。パスワードは名簿などと同じ運営だけの場所に、ハッシュで置く） ===== */
const SYSKEY = 'tk_sys_' + BOX;
let sysMode = ''; // '' 入る / 'set' 初めて決める / 'change' 変える
function sysOk() { if (S.mode !== 'fire' && !window.__SYS_GATE) return true; /* 鍵は本番だけ（練習モードと自動試験では開けておく。鍵そのものは v18.py で試す） */ return !!(S.sysConf && S.sysConf.salt && sysKey()); }
function sysKey() { try { const v = JSON.parse(sessionStorage.getItem(SYSKEY) || 'null'); return v && S.sysConf && v.salt === S.sysConf.salt ? v.hash : ''; } catch (e) { return ''; } }
async function sha(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function renderSys() {
  if (!$('sysLock')) return;
  const has = !!(S.sysConf && S.sysConf.salt), open = sysOk() && sysMode !== 'change';
  const mode = sysMode === 'change' ? 'change' : has ? '' : 'set';
  $('sysLock').hidden = open; $('sysBody').hidden = !open;
  if (open) { renderImport(); return; }
  $('sysLockNote').textContent = !S.sysLoaded ? '読み込んでいます…' : mode === 'set' ? 'システムのパスワードがまだ決まっていません。運営の中でも、Firebase のルールやデータの片付けを触る人だけが知るパスワードを決めてください（4文字以上）。'
    : mode === 'change' ? '新しいパスワードを2回入れてください。' : 'Firebase のルール・データの取り込みや片付け・計測など、システムの設定です。システムのパスワードを入れてください。';
  $('sysPwL').textContent = mode === '' ? 'システムのパスワード' : '新しいパスワード';
  $('sysPw2F').hidden = mode === '';
  $('sysGo').textContent = mode === 'set' ? '決めて入る' : mode === 'change' ? '変える' : '入る';
  $('sysGo').disabled = !S.sysLoaded;
}
/* パスワードの確かめはサーバーのルールで行う（ハッシュは conf/sysKey に置き、だれも読めない。合えば conf/sysCheck に書ける） */
async function sysGo() {
  const pw = $('sysPw').value, has = !!(S.sysConf && S.sysConf.salt), mode = sysMode === 'change' ? 'change' : has ? '' : 'set';
  $('sysErr').textContent = '';
  const keep = (hash, salt) => { try { sessionStorage.setItem(SYSKEY, JSON.stringify({ hash, salt })); } catch (e) {} };
  $('sysGo').disabled = true;
  try {
    if (mode === '') {
      const hash = await sha(S.sysConf.salt + pw);
      try { await B.commit([{ op: 'set', path: ROOT + '/conf/sysCheck', data: { key: hash, at: TS, by: devName } }]); }
      catch (e) { $('sysErr').textContent = (e && e.code) === 'permission-denied' ? 'パスワードが違います' : '確かめられませんでした（' + ((e && e.code) || '') + '）。電波を確かめてください'; return; }
      keep(hash, S.sysConf.salt);
    } else {
      if (pw.length < 4) { $('sysErr').textContent = '4文字以上にしてください'; return; }
      if (pw !== $('sysPw2').value) { $('sysErr').textContent = '2回の入力が違います'; return; }
      const salt = Math.random().toString(36).slice(2) + Date.now().toString(36), hash = await sha(salt + pw);
      const w = [{ op: 'set', path: ROOT + '/conf/sysKey', data: mode === 'change' ? { hash, old: sysKey() } : { hash } }, { op: 'set', path: ROOT + '/conf/sysMeta', data: { salt, setAt: TS, by: devName } }];
      try { await B.commit(w); }
      catch (e) { $('sysErr').textContent = (e && e.code) === 'permission-denied' ? (mode === 'set' ? 'ほかの端末で先にパスワードが決められました。そのパスワードで入ってください（版20までの古いパスワードの置き場所が残っている場合は、Firebase のコンソールで staff → conf → sys を消してから決めてください）' : 'パスワードを変えられませんでした。一度「システムを閉じる」を押して、入り直してから変えてください') : '保存できませんでした（' + ((e && e.code) || '') + '）'; return; }
      keep(hash, salt); S.sysConf = { salt };
      toast(mode === 'set' ? 'システムのパスワードを決めました' : 'システムのパスワードを変えました');
    }
    sysMode = ''; $('sysPw').value = ''; $('sysPw2').value = '';
    renderSys(); renderImport();
  } finally { $('sysGo').disabled = !S.sysLoaded; }
}

/* ===== テストのデータの片付け =====
   スプレッドシートから取り込んだもの以外（テストで入れた名簿・受付・締めた回・記録）を、選んで消す。
   ルールは、conf/cleanup の until（ミリ秒）が今より後の間だけ削除を通す（片付けの間の15分だけ。始めるにはシステムのパスワードが要る）。
   最初はどれにもチェックを入れない（本番の記録をうっかり消さないように）。調べたときの回と rev を覚え、消すときに回や結果が変わっていれば止める */
let CL = null;
function clScan() {
  if (CL && CL.running) { $('clMsg').textContent = '片付けの途中です。終わってから調べ直してください'; return; }
  const pastIds = new Set(PAST.roster.map((p) => p.id)), sheetPid = new Set(histRows().filter((h) => h.src === 'sheet').map((h) => h.pid));
  const ev = S.events[S.cur] || {};
  CL = {
    eid: S.cur, rev: ev.rev || '',
    roster: S.roster.filter((r) => r.createdIn !== 'sheet' && !pastIds.has(r.id)).map((r) => ({ id: r.id, name: r.name, keep: sheetPid.has(r.id) })),
    hist: S.hist.filter((h) => h.src !== 'sheet'),
    events: Object.keys(S.events).filter((k) => k !== S.cur).map((k) => ({ id: k, ...S.events[k] })),
    ck: S.checkins.slice(), teams: evTeams(ev).length + evMatches(ev).length > 0
  };
  const rm = rosterById(), byDay = {};
  CL.hist.forEach((h) => { const k = h.kind === 'haoh' ? '覇王戦 第' + h.no + '回（' + fmtDate(h.date) + '）' : fmtDate(h.date) + ' ' + (h.ename || ''); (byDay[k] = byDay[k] || []).push(h.id); });
  CL.histGroups = byDay;
  const ch = (key, label, note) => '<li><label><input type="checkbox" data-cl="' + esc(key) + '"> <span>' + esc(label) + (note ? '<small class="muted" style="display:block">' + esc(note) + '</small>' : '') + '</span></label></li>';
  const sec = (h, items) => items.length ? '<h3 class="s">' + esc(h) + '</h3><ul class="cl-list">' + items.join('') + '</ul>' : '';
  const html =
    sec('名簿（スプレッドシートにいない人）', CL.roster.map((r) => ch('r:' + r.id, r.name, r.keep ? 'スプレッドシートの記録がある人です' : ''))) +
    sec('記録（スプレッドシートから取り込んだもの以外）', Object.keys(byDay).sort().map((k) => ch('h:' + k, k + '：' + byDay[k].length + '件'))) +
    sec('締めた回', CL.events.map((e) => ch('e:' + e.id, (e.name || e.id) + (e.status === 'closed' ? '' : '（開いたまま）'), (e.final && e.final.standings ? e.final.standings.length + 'チームの順位' : '結果なし')))) +
    sec('いまの回「' + (ev.name || '') + '」', [].concat(CL.ck.length ? [ch('ck', '受付 ' + CL.ck.length + '人（' + CL.ck.map((c) => (rm[resolveId(c.id, rm)] || {}).name || c.name).slice(0, 30).join('・') + (CL.ck.length > 30 ? '…' : '') + '）')] : [],
      CL.teams ? [ch('tm', 'チーム・対戦表・試合の結果')] : []));
  $('clList').innerHTML = html ? '<p class="muted">消すものにチェックを入れてください（最初はどれにも入っていません）。<button class="btn small ghost" id="clAll" type="button">すべてチェック</button></p>' + html +
    '<p class="warnline" style="margin-top:10px">チェックしたものを消します。消したものは戻せません。</p><button class="btn primary" id="clGo" type="button">チェックしたものを消す</button>'
    : '<p class="muted">消すものはありません。</p>';
  $('clMsg').textContent = '';
  if ($('clAll')) $('clAll').onclick = () => { $('clList').querySelectorAll('[data-cl]').forEach((x) => { x.checked = true; }); };
  if ($('clGo')) { let armed = false; $('clGo').onclick = () => { if (!$('clList').querySelector('[data-cl]:checked')) { $('clMsg').textContent = '消すものにチェックを入れてください'; return; } if (!armed) { armed = true; $('clGo').textContent = 'もう一度押すと消します'; return; } clRun(); }; }
}
async function clRun() {
  if (!CL || CL.running || needEvent()) return;
  const cl = CL; cl.running = true; // 途中で「調べる」を押しても、この片付けの中身は変わらない
  if (S.cur !== cl.eid) { CL = null; $('clList').innerHTML = ''; $('clMsg').textContent = '調べたあとに、ほかの端末で新しい回が始まりました。もう一度「消すものを調べる」から'; return; }
  const key = sysKey(); if (!key) { cl.running = false; $('clMsg').textContent = 'システムのパスワードを入れ直してください（「システムを閉じる」→入り直す）'; return; }
  const on = new Set([...$('clList').querySelectorAll('[data-cl]:checked')].map((x) => x.dataset.cl));
  const simple = [], delHist = new Set(), skipped = [];
  Object.keys(cl.histGroups).forEach((k) => { if (on.has('h:' + k)) cl.histGroups[k].forEach((id) => { simple.push(ROOT + '/hist/' + id); delHist.add(id); }); });
  /* 名簿の人は、消す直前にサーバーを読み直し、残す記録の持ち主や、まとめ先になっている人は消さない（調べたあとに記録が移された場合など） */
  const delRoster = cl.roster.filter((r) => on.has('r:' + r.id));
  $('clGo').disabled = true; $('clMsg').textContent = '消しています…';
  if (delRoster.length) {
    let hiNow, roNow;
    try { hiNow = await B.getServerCol(ROOT + '/hist'); roNow = await B.getServerCol(ROOT + '/roster'); } catch (e) { cl.running = false; $('clGo').disabled = false; $('clMsg').textContent = 'サーバーを読めませんでした。電波を確かめてください'; return; }
    const gone = new Set(delRoster.map((r) => r.id)), used = new Set();
    hiNow.forEach((h) => { if (!delHist.has(h.id) && h.rid) used.add(h.rid); });
    roNow.forEach((r) => { if (r.mergedInto && !gone.has(r.id)) used.add(r.mergedInto); });
    delRoster.forEach((r) => { if (used.has(r.id)) skipped.push(r.name); else simple.push(ROOT + '/roster/' + r.id); });
  }
  const CLEAN = ROOT + '/conf/cleanup', del = (path) => ({ op: 'delete', path });
  let n = 0;
  try {
    await B.commit([{ op: 'set', path: CLEAN, data: { until: Math.floor(srvNow()) + 15 * 60000, key, by: devName } }]);
    /* いまの回：受付を消すとき・チームを空にするときは、調べたときの rev から順に rev を変える（その間に結果や受付が変わっていたら断られる） */
    const ck = on.has('ck') ? cl.ck.map((c) => ROOT + '/events/' + cl.eid + '/checkins/' + c.id) : [];
    if (ck.length || on.has('tm')) {
      let base = cl.rev;
      const parts = ck.length ? chunks(ck, 5) : [[]];
      for (const [i, part] of parts.entries()) {
        const rev = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), opId = rid('c');
        const data = { rev, chk: { base, op: opId }, ...(i === 0 && on.has('tm') ? { tm: {}, mt: {}, assign: {}, teams: null, shown: false } : {}) };
        try { await B.commit([{ op: 'update', path: ROOT + '/events/' + cl.eid, data }].concat(part.map(del))); }
        catch (e) { if ((e && e.code) === 'permission-denied') throw Object.assign(new Error('changed'), { code: 'changed' }); throw e; }
        base = rev; n += part.length;
      }
    }
    for (const e of cl.events) if (on.has('e:' + e.id)) {
      const cks = (await B.getServerCol(ROOT + '/events/' + e.id + '/checkins')).map((c) => ROOT + '/events/' + e.id + '/checkins/' + c.id);
      for (const part of chunks(cks, 6)) { await B.commit(part.map(del)); n += part.length; } // 1人3回の参照×6人＝18（上限20）
      await B.commit([del(ROOT + '/events/' + e.id)]); n++;
    }
    for (const part of chunks(simple, 15)) { await B.commit(part.map(del)); n += part.length; $('clMsg').textContent = '消しています… ' + n + '件'; }
    await B.commit([{ op: 'set', path: CLEAN, data: { until: 0, by: devName } }]);
    CL = null; $('clList').innerHTML = ''; $('clMsg').textContent = n + '件を消しました' + (on.has('tm') ? '（いまの回のチーム・試合も空にしました）' : '') + '。' + (skipped.length ? skipped.join('・') + ' さんは、記録の持ち主やまとめ先になっているので消しませんでした。' : '') + '参加者画面も新しい内容に変わります。';
  } catch (e) {
    /* 途中で止まったときは片付けの時間を閉じない（ほかの端末が片付けている途中かもしれない。15分で自然に閉じる） */
    cl.running = false; $('clGo').disabled = false;
    $('clMsg').textContent = (e && e.code) === 'changed' ? '調べたあとに、いまの回で受付や結果が変わったため止めました（' + n + '件は消しました）。もう一度「消すものを調べる」から'
      : (e && e.code) === 'permission-denied' ? '断られました。システムのパスワードを入れ直してから、もう一度「消すものを調べる」から（' + n + '件は消しました）'
      : '途中で止まりました（' + ((e && e.code) || '') + '）。「消すものを調べる」からやり直すと、残りを消せます';
  }
}

/* ===== タブ ===== */
function showPhase(ph) {
  S.phase = ph; ls.set('phase', ph);
  $('ph-entry').hidden = ph !== 'entry';
  $('ph-set').hidden = ph !== 'set';
  $('ph-team').hidden = ph !== 'team';
  $('ph-game').hidden = ph !== 'game';
  $('ph-other').hidden = ph !== 'rec';
  $('ph-sys').hidden = ph !== 'sys';
  if (ph === 'sys') renderSys();
  $('otherH').textContent = '記録';
  if (ph === 'rec') renderRec();
  if (ph === 'team') renderTeam();
  if (ph === 'game') renderGame();
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
    await tryW('受付を、回の更新番号を変えずに消す（旧版の端末。断られるはず）', W.cancel(R, e1, [ppl[0].id]), 'denied');
    await tryW('受付の取消（アプリと同じ）', W.rev(R, e1, W.cancel(R, e1, [ppl[0].id])).concat([W.opDoc(R, opc)]), 'ok');
    /* まとめ：AにBをまとめる→逆向き（AをBに）は断られる */
    const A = { ...ppl[1], rawId: ppl[1].id }, Bp = { ...ppl[2], rawId: ppl[2].id };
    const om = { id: 'om' + t, type: 'merge', eid: e1, items: [Bp, A], tapAt: now() };
    await tryW('BをAにまとめる（アプリと同じ）', W.rev(R, e1, W.merge(R, e1, A, Bp, om.id, false, now())).concat([W.opDoc(R, om)]), 'ok');
    const om2 = { id: 'om2' + t, type: 'merge', eid: e1, items: [A, Bp], tapAt: now() };
    await tryW('同時に逆向き：AをBにまとめる（断られるはず）', W.rev(R, e1, W.merge(R, e1, Bp, A, om2.id, true, now())).concat([W.opDoc(R, om2)]), 'denied');
    await tryW('まとめたBを元に戻す（断られるはず）', [{ op: 'update', path: R + '/roster/' + Bp.id, data: { mergedInto: '' } }], 'denied');
    await tryW('まとめたBを古い新規登録で上書き（断られるはず）', [{ op: 'set', path: R + '/roster/' + Bp.id, data: { name: Bp.name } }], 'denied');
    await tryW('まとめたBに受付（断られるはず）', W.checkin(R, e1, [Bp], 'ob' + t, now(), null), 'denied');
    await tryW('自分自身にまとめる（断られるはず）', [{ op: 'update', path: R + '/roster/' + ppl[3].id, data: { mergedInto: ppl[3].id } }], 'denied');
    await tryW('まとめ済みのBへまとめる（断られるはず）', [{ op: 'update', path: R + '/roster/' + ppl[3].id, data: { mergedInto: Bp.id } }], 'denied');
    const g1 = 'g' + om.id;
    await tryW('まとめを元に戻すついでに名前も変える（断られるはず）', [{ op: 'update', path: R + '/roster/' + Bp.id, data: { mergedInto: '', unmergedAt: TS, unmergeOf: g1, name: 'X' } }], 'denied');
    await tryW('違うまとめの番号で元に戻す（断られるはず）', [{ op: 'update', path: R + '/roster/' + Bp.id, data: { mergedInto: '', unmergedAt: TS, unmergeOf: 'gx' + t } }], 'denied');
    await tryW('まとめを元に戻す操作（アプリと同じ）', [{ op: 'update', path: R + '/roster/' + Bp.id, data: { mergedInto: '', unmergedAt: TS, unmergeOf: g1 } }], 'ok');
    await tryW('戻したBを、こんどはCにまとめる', [{ op: 'update', path: R + '/roster/' + Bp.id, data: { mergedInto: ppl[3].id, mergedAt: TS, mergeId: 'g2' + t } }], 'ok');
    await tryW('前のまとめを見て押した古い「元に戻す」が遅れて届く（断られるはず）', [{ op: 'update', path: R + '/roster/' + Bp.id, data: { mergedInto: '', unmergedAt: TS, unmergeOf: g1 } }], 'denied');
    /* 版12までのまとめ（mergeId なし）も元に戻せる */
    await tryW('版12の形でまとめる（mergeId なし）', [{ op: 'update', path: R + '/roster/' + ppl[9].id, data: { mergedInto: ppl[10].id, mergedAt: TS } }], 'ok');
    await tryW('版12の形のまとめを元に戻す', [{ op: 'update', path: R + '/roster/' + ppl[9].id, data: { mergedInto: '', unmergedAt: TS, unmergeOf: '' } }], 'ok');
    /* 名前を戻すのは、押した画面で見えていた名前がいまの名前と同じときだけ */
    await tryW('ほかの端末で直された名前を、古い画面から戻す（断られるはず）', [{ op: 'update', path: R + '/roster/' + ppl[11].id, data: { name: 'X', nameChk: { v: '別の名前', op: 'n1' } } }], 'denied');
    await tryW('いまの名前を確かめて名前を戻す', [{ op: 'update', path: R + '/roster/' + ppl[11].id, data: { name: 'X', nameChk: { v: ppl[11].name, op: 'n2' } } }], 'ok');
    await tryW('大会の記録を書く', [{ op: 'set', path: R + '/hist/h1' + t, data: { eid: e1, date: '2026-01-01', rid: ppl[4].id, name: ppl[4].name, rank: 1, teams: 4, at: TS } }], 'ok');
    await tryW('覇王戦を記録する', [{ op: 'set', path: R + '/hist/haoh_t' + t, data: { kind: 'haoh', no: 1, date: '2026-01-01', rid: ppl[4].id, name: 'x', entrants: [], ver: 'v1', editOf: '', at: TS } }], 'ok');
    await tryW('同じ回を別の端末が新しく記録する（断られるはず）', [{ op: 'set', path: R + '/hist/haoh_t' + t, data: { kind: 'haoh', no: 1, date: '2026-01-01', rid: ppl[6].id, name: 'z', entrants: [], ver: 'v9', editOf: 'new', at: TS } }], 'denied');
    await tryW('覇王戦の記録を直す', [{ op: 'set', path: R + '/hist/haoh_t' + t, data: { kind: 'haoh', no: 1, date: '2026-01-02', rid: ppl[5].id, name: 'y', entrants: [ppl[5].id], ver: 'v2', editOf: 'v1', at: TS } }], 'ok');
    await tryW('大会の記録を覇王戦の記録に書き換える（断られるはず）', [{ op: 'set', path: R + '/hist/h1' + t, data: { kind: 'haoh', no: 9, date: '2026-01-01' } }], 'denied');
    await tryW('大会の案内を保存する', [{ op: 'set', path: R + '/conf/info', data: { '大会名': '試験', updatedAt: TS } }], 'ok');
    await tryW('片付けの時間外に記録を消す（断られるはず）', [{ op: 'delete', path: R + '/hist/haoh_t' + t }], 'denied');
    await tryW('システムのパスワードのハッシュを置く', [{ op: 'set', path: R + '/conf/sysKey', data: { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }], 'ok');
    await tryW('今のハッシュを知らずに、パスワードを置き換える（断られるはず）', [{ op: 'set', path: R + '/conf/sysKey', data: { hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', old: 'x' } }], 'denied');
    await tryW('パスワードを変えずに、塩（salt）だけ書き換える（断られるはず）', [{ op: 'set', path: R + '/conf/sysMeta', data: { salt: 'x' } }], 'denied');
    await tryW('違うパスワードで確かめる（断られるはず）', [{ op: 'set', path: R + '/conf/sysCheck', data: { key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }], 'denied');
    await tryW('正しいパスワードで確かめる', [{ op: 'set', path: R + '/conf/sysCheck', data: { key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }], 'ok');
    await tryW('パスワードなしで片付けを始める（断られるはず）', [{ op: 'set', path: R + '/conf/cleanup', data: { until: Math.floor(srvNow()) + 15 * 60000 } }], 'denied');
    await tryW('1日先まで片付けの時間にする（断られるはず）', [{ op: 'set', path: R + '/conf/cleanup', data: { until: Math.floor(srvNow()) + 86400000, key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }], 'denied');
    await tryW('片付けを始める（15分）', [{ op: 'set', path: R + '/conf/cleanup', data: { until: Math.floor(srvNow()) + 15 * 60000, key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }], 'ok');
    await tryW('片付けの間に記録を消す', [{ op: 'delete', path: R + '/hist/haoh_t' + t }], 'ok');
    await tryW('片付けの間でも、いまの回は消せない（断られるはず）', [{ op: 'delete', path: R + '/events/' + e1 }], 'denied');
    await tryW('片付けを終える', [{ op: 'set', path: R + '/conf/cleanup', data: { until: 0 } }], 'ok');
    await tryW('記録を別の人へ移す', [{ op: 'update', path: R + '/hist/h1' + t, data: { rid: ppl[5].id, movedFrom: ppl[4].id, movedAt: TS, mv: 1 } }], 'ok');
    await tryW('同じ記録を、古い持ち主のつもりで別の端末が移す（断られるはず）', [{ op: 'update', path: R + '/hist/h1' + t, data: { rid: ppl[6].id, movedFrom: ppl[4].id, movedAt: TS, mv: 1 } }], 'denied');
    await tryW('記録を元の人へ戻す', [{ op: 'update', path: R + '/hist/h1' + t, data: { rid: ppl[4].id, movedFrom: ppl[5].id, movedAt: TS, mv: 2 } }], 'ok');
    await tryW('戻したあとに、最初の持ち主を見て押した古い移動が届く（断られるはず）', [{ op: 'update', path: R + '/hist/h1' + t, data: { rid: ppl[6].id, movedFrom: ppl[4].id, movedAt: TS, mv: 1 } }], 'denied');
    await tryW('まとめ済みの人へ記録を移す（断られるはず）', [{ op: 'update', path: R + '/hist/h1' + t, data: { rid: Bp.id, movedFrom: ppl[4].id, movedAt: TS, mv: 3 } }], 'denied');
    await tryW('大会の記録を消す（断られるはず）', [{ op: 'delete', path: R + '/hist/h1' + t }], 'denied');
    await tryW('名簿にない人だけの受付（断られるはず）', [{ op: 'set', path: R + '/events/' + e1 + '/checkins/zz' + t, data: { name: 'Z' } }], 'denied');
    { const r = await run(W.checkin(R, e1, ppl.slice(4), 'oz' + t, now(), null).concat([W.opDoc(R, { id: 'oz' + t, type: 'in', eid: e1, items: ppl.slice(4), tapAt: now() })]));
      res.push(['（参考）20人を分けずに1回で受付', 'info', r === 'ok' ? '書けた（この環境では上限に届かなかった）' : r === 'denied' ? '断られた（だから' + CHUNK + '人ずつに分けています）' : '判定不能（' + r.slice(6) + '）']); }
    /* 回を締める→旧回への操作は断られる */
    await tryW('回の更新番号を変えずに結果を書く（旧版の端末。断られるはず）', [{ op: 'update', path: R + '/events/' + e1, data: { 'mt.x1.ta': 50 } }], 'denied');
    await tryW('抽選を決める（回の更新番号が変わる）', [{ op: 'update', path: R + '/events/' + e1, data: { rev: 'r0' + t, drawId: 'd1' + t } }], 'ok');
    await tryW('抽選したあとに変わった回へ、古い画面の抽選を決める（断られるはず）', [{ op: 'update', path: R + '/events/' + e1, data: { rev: 'rx' + t, drawId: 'd2' + t, chk: { base: 'r9' + t, op: 'c1' } } }], 'denied');
    await tryW('前の抽選の発表で参加者画面に出す（断られるはず）', [{ op: 'update', path: R + '/events/' + e1, data: { rev: 'ry' + t, shown: true, shownDraw: 'd0' + t } }], 'denied');
    await tryW('いまの抽選の発表で参加者画面に出す', [{ op: 'update', path: R + '/events/' + e1, data: { rev: 'rz' + t, shown: true, shownDraw: 'd1' + t, chk: { base: 'r0' + t, op: 'c2' } } }], 'ok');
    await tryW('結果を入れる（回の更新番号が変わる）', [{ op: 'update', path: R + '/events/' + e1, data: { rev: 'r1' + t } }], 'ok');
    await tryW('古い順位で締める（直前の結果が入っていない。断られるはず）', W.newEvent(R, e1, true, 'ec' + t, '試験の回C', 0, { ev: { closeRev: 'r0' } }), 'denied');
    const box = R.split('/')[1], pubPath = 'public/tsukiichi_' + box;
    const publicWrite = (data) => [{ op: 'set', path: pubPath, data }];
    const bulletin = { body: '{}', at: TS, updatedAt: '試験', box, event: e1, rev: 'r1' + t, seq: 1 };
    await tryW('公開文書に端末名を含める（断られるはず）', publicWrite({ ...bulletin, by: '試験端末' }), 'denied');
    await tryW('現在の回と更新番号で初回の速報を公開', publicWrite(bulletin), 'ok');
    await tryW('古い順序の速報を再送（断られるはず）', publicWrite(bulletin), 'denied');
    await tryW('得点訂正前の速報を公開（断られるはず）', publicWrite({ ...bulletin, seq: 2, rev: 'r0' + t }), 'denied');
    await tryW('次の順序で速報を更新', publicWrite({ ...bulletin, seq: 2 }), 'ok');
    await tryW('旧版の再抽選で得点を消す（断られるはず）', [{ op: 'update', path: R + '/events/' + e1, data: { rev: 'old' + t, mt: {}, drawnAt: TS } }], 'denied');
    await tryW('新しい回を始める（いまの回を締める）', W.newEvent(R, e1, true, e2, '試験の回2', 0, { ev: { closeRev: 'r1' + t } }), 'ok');
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
  B.commit(FAKE.map((n, i) => ({ op: 'set', path: ROOT + '/roster/r' + pad(i + 1), data: { name: n, norm: norm(n), exp: i % 4 === 0, level: i % 4 === 0 ? [9, 7, 6, 5, 4, 2][i / 4] : null, beg: i % 4 !== 0 && i % 7 === 3, createdAt: TS } })))
    .then(() => toast('架空の名簿24人を入れました'), (e) => toast('入れられませんでした（' + ((e && e.code) || '') + '）', true));
};
$('seedHist').onclick = seedHistory;
$('impGo').onclick = () => importSheet($('impGo'));
$('sysGo').onclick = sysGo;
$('sysPw').onkeydown = (e) => { if (e.key === 'Enter' && $('sysPw2F').hidden) sysGo(); };
$('sysOut').onclick = () => { try { sessionStorage.removeItem(SYSKEY); } catch (e) {} renderSys(); };
$('sysPwChange').onclick = () => { sysMode = 'change'; renderSys(); };
$('clScan').onclick = clScan;
$('impExp').oninput = renderImport;
$('infoSave').onclick = saveInfo;
$('infoReset').onclick = () => renderInfo(true);
$('hoNew').onclick = () => { if (!needEvent()) openHaoh(0); };
$('hoCopy').onclick = () => { navigator.clipboard.writeText(haohText()).then(() => toast('出場資格の一覧をコピーしました'), () => toast('コピーできませんでした', true)); };
$('bkSave').onclick = () => saveBackup(false);
$('bkPick').onclick = pickBackupDir;
$('bkFile').onchange = () => { const f = $('bkFile').files[0]; $('bkFile').value = ''; if (f) restoreBackup(f); };
$('bkRestoreGo').onclick = applyRestore;
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
window.__tk = { S, unsent, rejected, people, dupGroups, W, RULES, T, drawPeople, teamOptions, drawTeams, checkTeams, pairGroups, rrList, buildMatches, rebuildMatches, inSync, assignCourts, standings, evMatches, evTeams, hasRes, personStats, histRows, closingData: (e) => closingData(e), closingSummary, serverClosing, publicData, PUBST, topPoints, balance, BK, saveBackup, haohEligible, importPlan, infoNow, openHaoh };

boot();
