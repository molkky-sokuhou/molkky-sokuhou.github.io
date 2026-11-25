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
/* サーバー側：ルールで判定してから書く（まとめて全部通るか、全部断るか）。
   ルールの参照回数の上限（1回のまとめ書きで20回、1つの書き込みで10回）も、キャッシュなしとして数える */
function fakeServerCommit(db, writes, now) {
  const docs = db.docs;
  const after = fakeApply(docs, writes, now);
  if (!after) return { ok: false, code: 'not-found' };
  let calls = 0;
  const getAfter = (path) => { calls++; return after[path]; };
  const getBefore = (path) => { calls++; return docs[path]; };
  const cleaning = (box) => { calls++; const c = docs['staff/' + box + '/conf/cleanup']; return !!c && (c.until || 0) > now; };
  const revBumped = (box, e) => { const p2 = 'staff/' + box + '/events/' + e; return ((getAfter(p2) || {}).rev || '') !== ((getBefore(p2) || {}).rev || ''); };
  const same = (x, y) => JSON.stringify(x === undefined ? null : x) === JSON.stringify(y === undefined ? null : y);
  const isOpen = (box, e) => { const ev = getAfter('staff/' + box + '/events/' + e); return !!ev && ev.status === 'open'; };
  const notMerged = (box, rid) => { const r = getAfter('staff/' + box + '/roster/' + rid); return !!r && !r.mergedInto; };
  for (const w of writes) {
    const p = w.path.split('/'), del = w.op === 'delete', before = docs[w.path], next = after[w.path];
    const c0 = calls;
    let ok = false;
    if (p[0] === 'public' && !del) {
      const box = 'staff/' + next.box, event = docs[box + '/events/' + next.event];
      ok = p.length === 2 && p[1] === 'tsukiichi_' + next.box
        && Object.keys(next).every(k => ['body', 'updatedAt', 'at', 'box', 'event', 'rev', 'seq'].includes(k))
        && next.at === now && next.seq === ((before && before.seq) || 0) + 1
        && docs[box]?.currentEvent === next.event && !!event && next.rev === (event.rev || '');
    }
    else if (p[0] === 'staff' && p.length === 2) {
      const previous = before?.currentEvent || '';
      ok = !del && next.prevEvent === previous && next.currentEvent !== previous &&
        isOpen(p[1], next.currentEvent) &&
        (!previous || getAfter(w.path + '/events/' + previous)?.status === 'closed');
    }
    else if (p[0] === 'staff' && p.length === 4 && p[2] === 'roster') {
      const box = p[1], id = p[3];
      if (del) ok = cleaning(p[1]) && (before || {}).createdIn !== 'sheet';
      else if (!before) ok = !(next && next.mergedInto);
      else if (!before.mergedInto) ok = (!next.mergedInto || (next.mergedInto !== id && notMerged(box, next.mergedInto)))
        && (same(before.nameChk, next.nameChk) || (next.nameChk && next.nameChk.v === (before.name || '')));
      else {
        /* まとめを元に戻す：mergedInto を空にして unmergedAt（サーバー時刻）を書く。ほかの項目は変えない */
        const keys = new Set(Object.keys(before).concat(Object.keys(next))), changed = [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
        ok = !next.mergedInto && next.unmergedAt === now && (next.unmergeOf || '') === (before.mergeId || '') && changed.every((k) => k === 'mergedInto' || k === 'unmergedAt' || k === 'unmergeOf');
      }
    }
    else if (p[0] === 'staff' && p.length === 4 && (p[2] === 'metrics' || p[2] === 'ping')) ok = true;
    else if (p[0] === 'staff' && p.length === 4 && p[2] === 'conf') {
      const key = (docs['staff/' + p[1] + '/conf/sysKey'] || {}).hash;
      if (p[3] === 'sysKey') ok = !del && typeof next.hash === 'string' && next.hash.length === 64 && (!before || (next.old || '') === before.hash);
      else if (p[3] === 'sysCheck') ok = !del && !!key && next.key === key;
      else if (p[3] === 'cleanup') ok = !del && ((next.until || 0) === 0 || (!!key && next.key === key && Number.isFinite(next.until) && next.until <= now + 960000));
      else ok = true;
    }
    else if (p[0] === 'staff' && p.length === 4 && p[2] === 'hist') {
      if (del) ok = cleaning(p[1]) && (before || {}).src !== 'sheet';
      else if (!before) ok = true;
      else {
        const keys = new Set(Object.keys(before).concat(Object.keys(next))), changed = [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
        ok = next.movedFrom === before.rid && next.rid !== before.rid && (next.mv || 0) === (before.mv || 0) + 1 && changed.every((k) => k === 'rid' || k === 'movedFrom' || k === 'movedAt' || k === 'mv') && notMerged(p[1], next.rid)
          || (before.kind === 'haoh' && next.kind === 'haoh' && next.no === before.no && (next.editOf || '') === (before.ver || ''));
      }
    }
    else if (p[0] === 'staff' && p.length === 4 && p[2] === 'events') {
      if (del) ok = cleaning(p[1]) && (docs['staff/' + p[1]] || {}).currentEvent !== p[3];
      else if (!before) { const bx = getAfter('staff/' + p[1]); ok = next.status === 'open' && !!bx && bx.currentEvent === p[3]; }
      else ok = before.status === 'open' && ((next.status === 'open' && (next.rev || '') !== (before.rev || '')
        && (same(before.drawnAt, next.drawnAt) || (!same(before.drawId, next.drawId) && !same(before.chk, next.chk)))
        && (same(before.chk, next.chk) || (next.chk && next.chk.base === (before.rev || '')))
        && (same(before.shown, next.shown) || next.shown !== true || (next.shownDraw || '') === (before.drawId || '')))
        || (next.status === 'closed' && (next.closeRev || '') === (before.rev || '')));
    }
    else if (p[0] === 'staff' && p.length === 6 && p[2] === 'events') {
      const box = p[1], e = p[3], kind = p[4], id = p[5];
      if (kind === 'checkins') ok = del ? (isOpen(box, e) && revBumped(box, e)) || (cleaning(box) && (getBefore('staff/' + box + '/events/' + e) || {}).status === 'closed') : isOpen(box, e) && notMerged(box, id) && revBumped(box, e);
      else if (kind === 'ops') ok = !del && !before && isOpen(box, e);
      else if (kind === 'devices') ok = !del;
    }
    if (calls - c0 > 10 || calls > 20) return { ok: false, code: 'permission-denied', path: w.path, why: 'too-many-calls' };
    if (!ok) return { ok: false, code: 'permission-denied', path: w.path };
  }
  db.docs = after; db.ver = (db.ver || 0) + 1;
  return { ok: true };
}
if (typeof module !== 'undefined') module.exports = { fakeServerCommit, fakeApply };
