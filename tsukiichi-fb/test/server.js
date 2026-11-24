// 自動試験用の模擬サーバー（Firestore のルールと同じ判定）
const http = require('http');
const { fakeServerCommit } = require('../src/fakeserver.js');
let db = { docs: {}, ver: 0 };
const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/state') { res.end(JSON.stringify(db)); return; }
    if (u.pathname === '/reset') { db = { docs: {}, ver: 0 }; res.end('{}'); return; }
    if (u.pathname === '/commit') { const r = fakeServerCommit(db, JSON.parse(body).writes, Date.now()); res.end(JSON.stringify(r)); return; }
    res.statusCode = 404; res.end();
  });
});
srv.listen(process.env.PORT || 8765, () => console.log('fake server on', srv.address().port));
