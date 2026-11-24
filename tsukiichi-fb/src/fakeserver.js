/* ===== 模擬サーバー（練習モードと自動試験用）。Firestore のルールと同じ判定をここでも行う ===== */
/* 書き込みをそのまま当てはめる（端末の画面に先に出す分。ルールはここでは見ない） */
function fakeApply(docs, writes, now) {
  const after = Object.assign({}, docs);
  const TS = (v) => (v && typeof v === 'object' && v.__ts) ? now : v;
  const fill = (o) => { const r = {}; Object.keys(o || {}).forEach((k) => { r[k] = TS(o[k]); }); return r; };
  for (const w of writes) {
    if (w.op === 'delete') { delete after[w.path]; continue; }
    if (w.op === 'set') { after[w.path] = fill(w.data); continue; }
    if (w.op === 'merge') { after[w.path] = Object.assign({}, after[w.path] || {}, fill(w.data)); continue; }
    if (w.op === 'update') {
      if (!after[w.path]) return null;
      const d = JSON.parse(JSON.stringify(after[w.path]));
      Object.keys(w.data).forEach((k) => { const ks = k.split('.'); let o = d; for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] = o[ks[i]] || {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = TS(w.data[k]); });
      after[w.path] = d;
    }
  }
  return after;
}
/* サーバー側：ルールで判定してから書く（まとめて全部通るか、全部断るか） */
function fakeServerCommit(db, writes, now) {
  const docs = db.docs;
  const after = fakeApply(docs, writes, now);
  if (!after) return { ok: false, code: 'not-found' };
  const isOpen = (box, e) => { const ev = after['staff/' + box + '/events/' + e]; return !!ev && ev.status === 'open'; };
  const notMerged = (box, rid) => { const r = after['staff/' + box + '/roster/' + rid]; return !!r && !r.mergedInto; };
  for (const w of writes) {
    const p = w.path.split('/'), del = w.op === 'delete', exists = !!docs[w.path];
    let ok = false;
    if (p[0] === 'public') ok = true;
    else if (p[0] === 'staff' && p.length === 2) ok = !del;
    else if (p[0] === 'staff' && p.length === 4 && p[2] === 'roster') ok = !del;
    else if (p[0] === 'staff' && p.length === 4 && (p[2] === 'metrics' || p[2] === 'ping')) ok = true;
    else if (p[0] === 'staff' && p.length === 4 && p[2] === 'events') ok = !del && (!exists || docs[w.path].status === 'open');
    else if (p[0] === 'staff' && p.length === 6 && p[2] === 'events') {
      const box = p[1], e = p[3], kind = p[4], id = p[5];
      if (kind === 'checkins') ok = del ? isOpen(box, e) : isOpen(box, e) && notMerged(box, id);
      else if (kind === 'ops') ok = !del && !exists && isOpen(box, e);
      else if (kind === 'devices') ok = !del;
    }
    if (!ok) return { ok: false, code: 'permission-denied', path: w.path };
  }
  db.docs = after; db.ver = (db.ver || 0) + 1;
  return { ok: true };
}
if (typeof module !== 'undefined') module.exports = { fakeServerCommit, fakeApply };
