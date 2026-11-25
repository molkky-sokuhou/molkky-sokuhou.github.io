// 自動試験用の模擬サーバー（Firestore のルールと同じ判定）
const http = require('http');
const { fakeServerCommit } = require('../src/fakeserver.js');
let db = { docs: {}, ver: 0 };
let slow = 0, failUntil = 0;
const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/state') { res.end(JSON.stringify(db)); return; }
    if (u.pathname === '/reset') { db = { docs: {}, ver: 0 }; slow = 0; failUntil = 0; res.end('{}'); return; }
    // 試験用：ルールを通さずに文書を置く（版20までの古いデータを再現する）
    if (u.pathname === '/seed') { const w = JSON.parse(body); Object.keys(w).forEach((k) => { db.docs[k] = w[k]; }); db.ver++; res.end('{}'); return; }
    // 試験用：本番のルールの版（rulesVer の判定）を変える。n を空にすると画面と同じ版
    if (u.pathname === '/rulesno') { const n = u.searchParams.get('n'); if (n) db.rulesNo = +n; else delete db.rulesNo; res.end('{}'); return; }
    if (u.pathname === '/slow') { slow = +u.searchParams.get('ms') || 0; res.end('{}'); return; }
    if (u.pathname === '/fail') { failUntil = Date.now() + (+u.searchParams.get('ms') || 0); res.end('{}'); return; }
    if (u.pathname === '/commit') {
      if (Date.now() < failUntil) { res.statusCode = 503; res.end('{}'); return; }
      setTimeout(() => { const r = fakeServerCommit(db, JSON.parse(body).writes, Date.now()); if (!r.ok && process.env.FAKE_LOG) console.log('deny', r.path, r.why || ''); res.end(JSON.stringify(r)); }, slow);
      return;
    }
    res.statusCode = 404; res.end();
  });
});
srv.listen(process.env.PORT || 8765, () => console.log('fake server on', srv.address().port));
