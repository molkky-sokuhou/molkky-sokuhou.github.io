# 版23：チャッピーのレビュー（版21〜22）の指摘の再現
import asyncio, json, os, re, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); SRV = 'http://localhost:8765'
R = 'staff/proto'
def get(p): return urllib.request.urlopen(SRV + p).read()
def docs(): return json.loads(get('/state'))['docs']
def commit(writes): return json.loads(urllib.request.urlopen(urllib.request.Request(SRV + '/commit', data=json.dumps({'writes': writes}).encode(), method='POST')).read())
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
def rid_of(name): return next(k.split('/')[-1] for k, v in docs().items() if k.startswith(R + '/roster/') and v.get('name') == name)
async def mk(b, name):
    ctx = await b.new_context(viewport={'width': 375, 'height': 800}, accept_downloads=True)
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';window.__SYS_GATE=1;localStorage.setItem('tk_devName','{name}')")
    pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx, pg
async def closeov(pg): await pg.evaluate("()=>{document.getElementById('ov').hidden=true}")
async def unlock(pg, pw='7788'):
    await pg.click('.nb[data-ph=sys]'); await pg.wait_for_timeout(500)
    if await pg.locator('#sysPw2F').is_visible(): await pg.fill('#sysPw', pw); await pg.fill('#sysPw2', pw)
    else: await pg.fill('#sysPw', pw)
    await pg.click('#sysGo'); await pg.wait_for_timeout(1200)

async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ca, A = await mk(b, '1台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await unlock(A)
        await A.click('#seedBtn'); await A.wait_for_timeout(1500); await A.click('#seedHist'); await A.wait_for_timeout(2000)
        await A.fill('#impExp', 'てつ'); await A.click('#impGo'); await A.click('#impGo'); await A.wait_for_timeout(3500)
        d = docs()

        # ③⑧ 取り込んだ覇王戦にも版（ver）があり、新しく記録する操作（editOf:'new'）では上書きできない
        ho = sorted(k for k in d if re.search(r'/hist/haoh_\d+$', k))
        ok(ho and all(d[k].get('ver', '').startswith('sheet-') for k in ho), '③⑧ 取り込んだ覇王戦に ver が付く')
        h0 = d[ho[0]]
        r = commit([{'op': 'set', 'path': ho[0], 'data': {**h0, 'name': '上書き', 'ver': 'hvX', 'editOf': 'new'}}])
        ok(not r['ok'], '③⑧ 同じ回を「新しく記録」しても上書きされない（ルール）')
        r = commit([{'op': 'set', 'path': ho[0], 'data': {**h0, 'ver': 'hvY', 'editOf': h0['ver']}}])
        ok(r['ok'], '③⑧ 見ていた版を添えれば直せる')

        # ⑨ 取り込んだ記録を別の人へ移し、元の人をまとめたあとでも、取り込み直すと重ならない
        imp = sorted(k for k in d if '/hist/imp-' in k)
        k0 = imp[0]; x = d[k0]['rid']
        others = [v['name'] for kk, v in d.items() if kk.startswith(R + '/roster/') and v.get('createdIn') == 'sheet' and kk.split('/')[-1] != x]
        z, y = rid_of(others[0]), rid_of(others[1])
        r1 = commit([{'op': 'update', 'path': k0, 'data': {'rid': z, 'movedFrom': x, 'movedAt': 1, 'mv': 1}}])
        r2 = commit([{'op': 'update', 'path': R + '/roster/' + x, 'data': {'mergedInto': y, 'mergeId': 'mT'}}])
        await A.wait_for_timeout(2500)
        pl = json.loads(await A.evaluate("JSON.stringify((({rows,skip})=>({rows,skip}))(window.__tk.importPlan()))"))
        ok(r1['ok'] and r2['ok'] and pl['rows'] == 0, '⑨ 移してからまとめた人の記録も取り込み直さない ' + str(pl))

        # ①②（版29）片付け：調べたあとに、残す記録がテストの人へ移されたら、その人は表示に残る
        await A.click('.nb[data-ph=entry]')
        await A.click('.nb[data-ph=sys]'); await A.click('#clScan'); await A.wait_for_timeout(500)
        yui = rid_of('ゆい')
        k1 = imp[1]; r3 = commit([{'op': 'update', 'path': k1, 'data': {'rid': yui, 'movedFrom': docs()[k1]['rid'], 'movedAt': 1, 'mv': 1}}])
        await A.wait_for_timeout(1500)
        await A.click('#clAll'); await A.click('#clGo'); await A.wait_for_timeout(5000)
        msg = await A.locator('#clMsg').text_content(); d = docs()
        vis = await A.evaluate("window.__tk.S.roster.map(x=>x.name).join(',')")
        ok(r3['ok'] and (R + '/roster/' + yui) in d and 'ゆい' in vis, '①② 残す記録の持ち主になった人は表示に残る：' + msg[:80])
        ok('件を片付けました' in msg and 'そうた' not in vis, '①② ほかは画面から外れる')

        # ⑤ 戻す：A→B と B→C のまとめを順に戻す。まとめを元に戻した人は、古いバックアップを戻してもまとめ直さない
        await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(300)
        await A.evaluate("""()=>{window.__saved={};window.__tk.BK.dir={name:'NAS',queryPermission:async()=>'granted',requestPermission:async()=>'granted',
          getFileHandle:async(n)=>({createWritable:async()=>({write:async(t)=>{window.__saved[n]=t},close:async()=>{}})})};}""")
        await A.click('#bkSave'); await A.wait_for_timeout(1500)
        bk = json.loads(list(json.loads(await A.evaluate("JSON.stringify(window.__saved)")).values())[0])
        rs = [k.split('/')[-1] for k, v in bk['docs'].items() if '/roster/' in k and not v.get('mergedInto')][:3]
        a_, b_, c_ = rs
        bk['docs'][R + '/roster/' + a_]['mergedInto'] = b_; bk['docs'][R + '/roster/' + b_]['mergedInto'] = c_
        open('/tmp/v23_bk.json', 'w').write(json.dumps(bk))
        get('/reset'); await ca.close(); ca, A = await mk(b, '2台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=rec]'); await A.evaluate("document.querySelector('#bkBox details').open=true")
        await A.set_input_files('#bkFile', '/tmp/v23_bk.json'); await A.wait_for_timeout(1000)
        await A.click('#bkRestoreGo'); await A.wait_for_timeout(4000)
        d = docs(); ra, rb = d.get(R + '/roster/' + a_, {}), d.get(R + '/roster/' + b_, {})
        ok(ra.get('mergedInto') == b_ and rb.get('mergedInto') == c_ and ra.get('restoreOf'), '⑤ A→B と B→C のまとめが両方戻る（どのバックアップから戻したか restoreOf が付く）')
        get('/reset'); await ca.close(); ca, A = await mk(b, '3台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        bid = 'b' + str(round(bk['savedAt'])) + '_' + str(bk.get('savedBy') or '')[:20]
        commit([{'op': 'set', 'path': R + '/roster/' + i, 'data': {**{k: v for k, v in bk['docs'][R + '/roster/' + i].items() if k != 'mergedInto'}, 'restoredAt': 1, 'restoreOf': bid, 'unmergedAt': 2}} for i in (a_, b_, c_)])  # 同じバックアップから戻したあと「元に戻す」をした人には unmergedAt がある
        await A.wait_for_timeout(1500); await A.click('.nb[data-ph=rec]'); await A.evaluate("document.querySelector('#bkBox details').open=true")
        await A.set_input_files('#bkFile', '/tmp/v23_bk.json'); await A.wait_for_timeout(1000)
        if await A.locator('#bkRestoreGo').is_visible(): await A.click('#bkRestoreGo'); await A.wait_for_timeout(3000)
        d = docs()
        ok(not d[R + '/roster/' + a_].get('mergedInto') and not d[R + '/roster/' + b_].get('mergedInto'), '⑤ まとめを元に戻した人は、古いバックアップを戻してもまとめ直さない')

        # P2 覇王戦の画面：出場者の記録がある回では、出場者でない人を覇王の候補に出さない
        get('/reset'); await ca.close(); ca, A = await mk(b, '4台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await unlock(A); await A.click('#seedBtn'); await A.wait_for_timeout(1500)
        ids = [k.split('/')[-1] for k in docs() if k.startswith(R + '/roster/')][:3]
        commit([{'op': 'set', 'path': R + '/hist/haoh_1', 'data': {'kind': 'haoh', 'no': 1, 'date': '2026-01-01', 'rid': ids[0], 'name': 'x', 'entrants': [ids[1], ids[2]], 'ver': 'v1', 'src': 'app'}}])
        await A.wait_for_timeout(1500)
        await A.evaluate("window.__tk.openHaoh(1)"); await A.wait_for_timeout(300)
        opts = json.loads(await A.evaluate("JSON.stringify([...document.querySelectorAll('#hoKing option')].map(o=>o.value).filter(Boolean))"))
        ok(ids[0] not in opts and set(opts) == {ids[1], ids[2]}, 'P2 覇王の候補は出場者だけ ' + str(opts))

        # ④ 版20までの conf/sys が残っている箱：古いパスワードを知っている人だけが新しい置き場所へ移せる
        import hashlib
        get('/reset'); urllib.request.urlopen(urllib.request.Request(SRV + '/seed', data=json.dumps({R + '/conf/sys': {'salt': 's1', 'hash': hashlib.sha256(b's11234').hexdigest()}}).encode(), method='POST')).read()
        r = commit([{'op': 'set', 'path': R + '/conf/sysKey', 'data': {'hash': 'a' * 64}}])
        ok(not r['ok'], '④ 古い置き場所が残っていると、新しいパスワードを置けない（ルール）')
        r = commit([{'op': 'delete', 'path': R + '/conf/sys'}])
        ok(not r['ok'], '④ 古い置き場所は画面からは消せない（コンソールで消す）')
        await ca.close(); ca, A = await mk(b, '5台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.wait_for_timeout(600)
        await A.fill('#sysPw', '5678'); await A.fill('#sysPw2', '5678'); await A.click('#sysGo'); await A.wait_for_timeout(1200)
        ok(await A.locator('#sysBody').is_hidden() and 'conf' in await A.locator('#sysErr').text_content() and (R + '/conf/sysKey') not in docs(), '④ 古い置き場所が残っている間は、だれもパスワードを決められず、消し方を案内する')

        # P2 viewport は拡大を止めない
        html = open(os.path.join(HERE, '..', 'admin', 'index.html')).read()
        ok('maximum-scale' not in html, 'P2 viewport に maximum-scale がない')
        print('errs', errs)
        ok(not errs, 'ページのエラーなし')
        await b.close()
    print('合計 %d / %d' % (sum(res), len(res)))
asyncio.run(main())
