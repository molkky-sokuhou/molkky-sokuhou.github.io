# 版15：チャッピーのレビュー（版14）の指摘を、模擬サーバーと2台の画面で再現して確かめる
import asyncio, json, urllib.request
from playwright.async_api import async_playwright
import os
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); VIEW = 'file://' + os.path.join(HERE, '..', 'index.html'); SRV = 'http://localhost:8765'
R = 'staff/proto'
def get(p): return urllib.request.urlopen(SRV + p).read()
def docs(): return json.loads(get('/state'))['docs']
def commit(writes): return json.loads(urllib.request.urlopen(urllib.request.Request(SRV + '/commit', data=json.dumps({'writes': writes}).encode(), method='POST')).read())
def cur():
    d = docs(); e = d[R]['currentEvent']; return e, d[R + '/events/' + e]
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
async def mk(b, name, url=URL):
    ctx = await b.new_context(viewport={'width': 375, 'height': 800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}')")
    pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); await pg.goto(url); await pg.wait_for_timeout(1500); return ctx, pg
async def closeov(pg): await pg.evaluate("()=>{document.getElementById('ov').hidden=true}")
async def checkin(pg, names):
    await closeov(pg); await pg.click('.nb[data-ph=entry]')
    for n in names:
        await pg.fill('#eq', n); await pg.wait_for_timeout(120); await pg.locator('#rList .rc span', has_text=n).first.click()
    await pg.fill('#eq', ''); await pg.click('#qAdd'); await pg.wait_for_timeout(2500)
async def person(pg, name):
    await closeov(pg); await pg.click('.nb[data-ph=rec]'); await pg.fill('#recQ', ''); await pg.wait_for_timeout(200)
    await pg.locator('#recList [data-pp]', has_text=name).first.click(); await pg.wait_for_timeout(200)
async def draw_and_save(pg):
    await closeov(pg); await pg.click('.nb[data-ph=team]'); await pg.wait_for_timeout(300)
    await pg.click('#tmDraw'); await pg.wait_for_timeout(200)
    if await pg.locator('#rdYes').count() and await pg.locator('#rdYes').is_visible(): await pg.click('#rdYes'); await pg.wait_for_timeout(200)
    await pg.click('#tmSave'); await pg.wait_for_timeout(300)

async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ca, A = await mk(b, '1台目'); cb, B = await mk(b, '2台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.wait_for_timeout(1500); await A.click('#seedHist'); await A.wait_for_timeout(2500)
        await checkin(A, ['ゆい', 'そうた', 'めい', 'あおい', 'けんた', 'ひな', 'りく', 'だいき', 'さくら', 'ゆうと', 'みお', 'こうき'])
        await B.wait_for_timeout(1500)

        # ① 旧版の端末（rev を変えない）の得点訂正・受付の取消は断られる
        e, ev = cur()
        r = commit([{'op': 'update', 'path': R + '/events/' + e, 'data': {'mt.zz.ta': 65}}])
        ok(not r['ok'], '① 回の更新番号を変えない得点の書き換え（版12の端末）は断られる')
        r = commit([{'op': 'delete', 'path': R + '/events/' + e + '/checkins/r05'}])
        ok(not r['ok'], '① 回の更新番号を変えない受付の取消（版12の端末）は断られる')

        # ④ 前の抽選の「チームを見る」で、次の抽選を出さない
        await draw_and_save(A)
        ok(await A.locator('#rvClose').is_visible(), '④ 1台目：抽選1の発表画面が開いている')
        await B.wait_for_timeout(1500); await draw_and_save(B); await B.wait_for_timeout(2500)
        await A.wait_for_timeout(1500)
        await A.click('#rvClose'); await A.wait_for_timeout(2500)
        e, ev = cur()
        ok(not ev.get('shown'), '④ 1台目の古い発表の「チームを見る」では、2台目の抽選2は参加者画面に出ない')
        tt = await A.evaluate("document.getElementById('toast').textContent")
        ok('抽選し直された' in tt, '④ 1台目に理由を知らせる：' + tt)
        await B.click('#rvClose'); await B.wait_for_timeout(2500)
        e, ev = cur(); ok(ev.get('shown') and ev.get('shownDraw') == ev.get('drawId'), '④ 2台目の「チームを見る」で抽選2が出る')
        r = commit([{'op': 'update', 'path': R + '/events/' + e, 'data': {'rev': 'x1', 'shown': False}}]); r2 = commit([{'op': 'update', 'path': R + '/events/' + e, 'data': {'rev': 'x2', 'shown': True, 'shownDraw': 'old'}}])
        ok(r['ok'] and not r2['ok'], '④ ルールでも、いまの抽選（drawId）と違う発表からは出せない')
        commit([{'op': 'update', 'path': R + '/events/' + e, 'data': {'rev': 'x3', 'shown': True, 'shownDraw': ev['drawId']}}])

        # ⑤ 再抽選のプレビュー中に入った得点を、黙って消さない
        await A.wait_for_timeout(1500); await closeov(A); await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300)
        await A.click('#tmDraw'); await A.wait_for_timeout(200); await A.click('#rdYes'); await A.wait_for_timeout(300)
        await closeov(B); await B.click('.nb[data-ph=game]'); await B.wait_for_timeout(500)
        mid = await B.locator('#gBody .mt').first.get_attribute('data-m')
        await B.click('[data-m="%s"]' % mid); await B.fill('#sc_a', '50'); await B.fill('#sc_b', '40'); await B.click('#scSave'); await B.wait_for_timeout(2500)
        await A.wait_for_timeout(1500)
        await A.click('#tmSave'); await A.wait_for_timeout(2500)
        e, ev = cur()
        ok((ev['mt'].get(mid) or {}).get('ta') == 50, '⑤ 2台目の得点（50対40）は残る')
        msg = await A.evaluate("document.getElementById('tmMsg').textContent")
        ok('ほかの端末で試合の結果' in msg, '⑤ 1台目には、抽選し直さなかった理由が出る：' + msg)
        r = commit([{'op': 'update', 'path': R + '/events/' + e, 'data': {'rev': 'y1', 'mt': {}, 'chk': {'base': 'old', 'op': 'q1'}}}])
        ok(not r['ok'], '⑤ ルールでも、抽選したときの rev と違えば決められない')

        # ② 解散したチームを、遅れて届いたまとめで割り当てない（ルール）
        r = commit([{'op': 'update', 'path': R + '/events/' + e, 'data': {'rev': 'y2', 'assign.r05': 1, 'chk': {'base': 'old2', 'op': 'q2'}}}])
        ok(not r['ok'], '② まとめる画面を開いたあとに回が変わっていれば（解散など）、チームの引き継ぎは断られる')

        # ③ 当日にまとめた人を元に戻すと、受付とチームも戻る
        await checkin(A, ['ハルト', 'はると'])
        n0 = await A.evaluate("window.__tk.people().length")
        await A.locator('#plist [data-c]', has_text='ハルト').click(); await A.select_option('#cf_team', '1'); await A.click('#cfSave'); await A.wait_for_timeout(1500)
        await A.locator('#plist [data-c]', has_text='はると').click(); await A.select_option('#cf_team', '2'); await A.click('#cfSave'); await A.wait_for_timeout(1500)
        await person(A, 'はると'); await A.select_option('#mgWith', label='ハルト'); await A.wait_for_timeout(200)
        await A.select_option('#mgTeam', '2'); await A.click('#mgGo'); await A.click('#mgGo'); await A.wait_for_timeout(2500)
        n1 = await A.evaluate("window.__tk.people().length")
        ok(n1 == n0 - 1, '③ まとめると受付が1人減る（%d→%d）' % (n0, n1))
        await person(A, 'はると'); await A.click('[data-um]'); await A.click('[data-um]'); await A.wait_for_timeout(2500)
        pp = json.loads(await A.evaluate("JSON.stringify(window.__tk.people().filter(p=>['はると','ハルト'].includes(p.name)).map(p=>[p.name,p.team]).sort())"))
        ok(sorted(map(tuple, pp)) == sorted([('ハルト', 1), ('はると', 2)]), '③ 元に戻すと、ハルトの受付とチーム（1）も戻る ' + str(pp))
        c = json.loads(await A.evaluate("JSON.stringify(window.__tk.closingData(window.__tk.S.cur))"))
        ok(c['n'] == n0, '③ 締めの受付人数も元の %d人に戻る（%d人）' % (n0, c['n']))

        # 条件付き：締めはサーバーから読み直して計算する
        sc = json.loads(await A.evaluate("window.__tk.serverClosing(window.__tk.S.cur).then(c=>JSON.stringify(c))"))
        ok(sc['n'] == c['n'] and len(sc['hist']) == len(c['hist']), '条件付き：サーバーから読み直した締めの中身が、表示と同じ（受付%d・記録%d）' % (sc['n'], len(sc['hist'])))
        # ⑭ 結果があるのに記録0人のとき
        t = await A.evaluate("window.__tk.closingSummary({nres:2,n:3,hist:[],missing:['あ','い'],ev:{final:{standings:[]}}})")
        ok('結果は 2件' in t and 'あ・い' in t, '⑭ 結果があるのに記録0人のときは、そう書き、記録に入らない人を出す：' + t)

        # ⑥⑦ 参加者画面の中身：古い中身が後から届いても、新しい中身に書き直す
        await A.wait_for_timeout(3000)
        published = docs()['public/tsukiichi_proto']
        ok('by' not in published, '公開文書に運営端末名を保存しない')
        stale = commit([{'op': 'set', 'path': 'public/tsukiichi_proto', 'data': {'body': '{"state":{"teams":[]},"records":{}}', 'updatedAt': 'old'}}])
        await A.wait_for_timeout(5000)
        now_body = docs()['public/tsukiichi_proto']['body']
        mine = await A.evaluate("JSON.stringify(window.__tk.publicData())")
        ok(not stale['ok'] and now_body == mine, '⑥ 古い形式の公開書き込みを拒否し、最新の内容を保つ')
        # 送っている途中に得点が変わっても、最後の得点が届く
        get('/slow?ms=2500')
        await closeov(A); await A.click('.nb[data-ph=game]'); await A.wait_for_timeout(300)
        ids = await A.locator('#gBody .mt').evaluate_all("els=>els.map(e=>e.dataset.m)")
        await A.click('[data-m="%s"]' % ids[0]); await A.fill('#sc_a', '30'); await A.fill('#sc_b', '20'); await A.click('#scSave'); await A.wait_for_timeout(1800)
        await A.click('[data-m="%s"]' % ids[1]); await A.fill('#sc_a', '45'); await A.fill('#sc_b', '35'); await A.click('#scSave')
        await A.wait_for_timeout(14000); get('/slow?ms=0'); await A.wait_for_timeout(4000)
        body = json.loads(docs()['public/tsukiichi_proto']['body'])
        tots = sorted([(m['totalA'], m['totalB']) for m in body['state']['matches'] if m['totalA'] != ''])
        ok((45, 35) in tots and (30, 20) in tots, '⑦ 送っている間に入った得点も、参加者画面に届く ' + str(tots))

        # 古い版の端末を知らせる
        commit([{'op': 'merge', 'path': R + '/events/' + e + '/devices/dOLD', 'data': {'name': '古いiPhone', 'pending': 0, 'rejected': 0, 'at': int(__import__('time').time() * 1000), 'ver': '2026.11.24-12'}}])
        await A.wait_for_timeout(2500); await closeov(A); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(300)
        sb = await A.evaluate("document.getElementById('statusBox').textContent")
        ok('古いiPhone' in sb and '古い版' in sb, '古い版のままの端末を運営画面に出す')

        # ⑪ 記録の移動：A→B→A のあと、古い A→C は断られる（ルール）
        hid = [k for k, v in docs().items() if '/hist/' in k and v.get('rid') == 'r05'][0]
        h0 = docs()[hid]
        r1 = commit([{'op': 'update', 'path': hid, 'data': {'rid': 'r06', 'movedFrom': 'r05', 'movedAt': 1, 'mv': (h0.get('mv') or 0) + 1}}])
        r2 = commit([{'op': 'update', 'path': hid, 'data': {'rid': 'r05', 'movedFrom': 'r06', 'movedAt': 2, 'mv': (h0.get('mv') or 0) + 2}}])
        r3 = commit([{'op': 'update', 'path': hid, 'data': {'rid': 'r07', 'movedFrom': 'r05', 'movedAt': 3, 'mv': (h0.get('mv') or 0) + 1}}])
        ok(r1['ok'] and r2['ok'] and not r3['ok'], '⑪ 移して戻したあとに届いた古い移動は断られる')

        # ⑧ 版12のまとめ（mergeId なし）を元に戻せる（ルール）
        commit([{'op': 'set', 'path': R + '/roster/L1', 'data': {'name': 'れがしー'}}])
        commit([{'op': 'update', 'path': R + '/roster/L1', 'data': {'mergedInto': 'r08', 'mergedAt': 1}}])
        r = commit([{'op': 'update', 'path': R + '/roster/L1', 'data': {'mergedInto': '', 'unmergedAt': {'__ts': 1}, 'unmergeOf': ''}}])
        ok(r['ok'], '⑧ 版12でまとめた人（番号なし）も元に戻せる')
        # ⑨ 名前を戻すのは、見えていた名前がいまの名前と同じときだけ（ルール）
        r = commit([{'op': 'update', 'path': R + '/roster/r08', 'data': {'name': 'X', 'nameChk': {'v': '違う名前', 'op': 'z'}}}])
        ok(not r['ok'], '⑨ ほかの端末で直された名前を、古い画面の「名前も戻す」で上書きしない')

        # ⑩ 参加者画面：同じ日の「4位→1位」の順でも、優勝1回と数える。⑬ URLで別の場所のデータを読ませない
        commit([{'op': 'set', 'path': R + '/hist/dupA', 'data': {'eid': 'dupd', 'date': '2026-06-01', 'rid': 'r10', 'name': 'ゆうと', 'team': 'T1', 'rank': 4, 'teams': 4, 'total': 100, 'at': 1}},
                {'op': 'set', 'path': R + '/hist/dupB', 'data': {'eid': 'dupd2', 'date': '2026-06-01', 'rid': 'r10', 'name': 'ゆうと', 'team': 'T2', 'rank': 1, 'teams': 4, 'total': 200, 'at': 2}}])
        await A.wait_for_timeout(5000)
        cv, V = await mk(b, '参加者', VIEW)
        await V.click('[data-tab=rank]'); await V.wait_for_timeout(300); await V.evaluate("document.getElementById('recordsPanel').open=true"); await V.wait_for_timeout(1500)
        await V.click('[data-y=""]'); await V.wait_for_timeout(300)
        txt = await V.locator('details.rec', has_text='ゆうと').first.text_content()
        ok('覇者' in txt, '⑩ 参加者画面でも、同じ日の良い方の順位（1位）で数える：' + txt[:40])
        cx = await b.new_context(); X = await cx.new_page(); hits = []
        X.on('request', lambda r: hits.append(r.url) if r.url.startswith('https://evil.example') else None)
        await X.goto(VIEW + '?fake=https://evil.example'); await X.wait_for_timeout(2000)
        ok(not hits, '⑬ URLの fake 指定では、ほかの場所のデータを読まない')

        # ⑫ 同じ名前の2チームを、前回の結果で1行にまぜない
        e, ev = cur()
        await closeov(A); await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(500)
        nos = sorted(int(k[1:]) for k, v in ev['tm'].items() if v and not v.get('gone'))
        commit([{'op': 'update', 'path': R + '/events/' + e, 'data': {'rev': 'n1', 'tm.t%d.name' % nos[0]: '同名', 'tm.t%d.name' % nos[1]: '同名'}}])
        await A.wait_for_timeout(2500)
        await A.click('.nb[data-ph=set]'); await A.click('#evNew'); await A.wait_for_timeout(300); await A.click('#evYes'); await A.wait_for_timeout(2500)
        if await A.locator('#evYes').count() and await A.locator('#evYes').is_visible(): await A.click('#evYes'); await A.wait_for_timeout(2500)
        await A.wait_for_timeout(3000)
        pr = json.loads(await A.evaluate("JSON.stringify(window.__tk.publicData().state.previousResult)"))
        e2, ev2 = cur()
        closed = docs()[R + '/events/' + e]
        ok(closed.get('status') == 'closed' and len(pr['standings']) == len(closed['final']['standings']) == len(nos), '⑫ 前回の結果は、締めた回の順位と同じ %dチーム（同じ名前の2チームも別の行）' % len(pr['standings']))

        # 抽選：実績上位を別々のチームへ・全員早帰りのチームを避けない
        r = json.loads(await A.evaluate("""()=>{const t=window.__tk;const ps=[];
          for(let i=0;i<12;i++)ps.push({id:'p'+i,name:'p'+i,exp:i<4,level:i<4?5:0,beg:false,early:false,pair:'',top:i>=4&&i<8,pts:0});
          const opt=t.teamOptions(ps).out.find(o=>o.T===4);let bad=0,expBad=0;
          for(let n=0;n<100;n++){const tm=t.drawTeams(ps,opt);const tp=tm.map(x=>x.members.filter(m=>m.top).length),ex=tm.map(x=>x.members.filter(m=>m.exp).length);
            if(Math.max(...tp)-Math.min(...tp)>1)bad++;if(Math.max(...ex)-Math.min(...ex)>1)expBad++;}
          const ps2=[];for(let i=0;i<6;i++)ps2.push({id:'q'+i,name:'q'+i,exp:i<3,level:i<3?5:0,beg:false,early:i<3,pair:'',top:false,pts:0});
          const t2=t.balance(ps2,2);const allEarly=t2.some(x=>x.every(m=>m.early));
          return JSON.stringify([bad,expBad,allEarly]);}"""))
        ok(r[0] == 0 and r[1] == 0, '抽選：100回とも、経験豊富と実績上位が各チームに1人ずつ（ずれ %d・%d回）' % (r[0], r[1]))
        ok(r[2] is True, '抽選：早帰り3人・ほか3人の2チームなら、1人だけ残るチームを作らず、全員早帰りのチームにする')

        ok(not errs, 'ページのエラーなし ' + str(errs[:3]))
        await b.close()
    print('合計', sum(res), '/', len(res))
asyncio.run(main())
