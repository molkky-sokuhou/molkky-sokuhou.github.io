# 版28：チャッピーのレビュー（版22→27）の指摘の再現
import asyncio, json, os, re, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); SRV = 'http://localhost:8765'; R = 'staff/proto'
def get(p): return urllib.request.urlopen(SRV + p).read()
def docs(): return json.loads(get('/state'))['docs']
def commit(w): return json.loads(urllib.request.urlopen(urllib.request.Request(SRV + '/commit', data=json.dumps({'writes': w}).encode(), method='POST')).read())
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
def rid_of(name): return next(k.split('/')[-1] for k, v in docs().items() if k.startswith(R + '/roster/') and v.get('name') == name)
async def mk(b, name, extra=''):
    ctx = await b.new_context(viewport={'width': 375, 'height': 800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';window.__SYS_GATE=1;window.__RULES_UID='UID9';localStorage.setItem('tk_devName','{name}');{extra}")
    pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx, pg
async def unlock(pg, pw='7788'):
    await pg.click('.nb[data-ph=sys]'); await pg.wait_for_timeout(500)
    if await pg.locator('#sysPw2F').is_visible(): await pg.fill('#sysPw2', pw)
    await pg.fill('#sysPw', pw); await pg.click('#sysGo'); await pg.wait_for_timeout(1200)
async def newev(pg): await pg.click('#evGate [data-newev]'); await pg.click('#evYes'); await pg.wait_for_timeout(1500)
MOCK = """()=>{window.__calls=[];window.__tokens=0;window.__prompts=[];window.__fail=0;
  window.google={accounts:{oauth2:{initTokenClient:(o)=>({requestAccessToken:(q)=>{window.__tokens++;window.__prompts.push(q&&q.prompt);setTimeout(()=>o.callback({access_token:'TOK'+window.__tokens,expires_in:3600}),10);}})}}};
  const f0=window.fetch;window.fetch=async(u,o)=>{if(String(u).indexOf('firebaserules')<0)return f0(u,o);window.__calls.push({u:String(u),a:o.headers.Authorization});
    if(window.__fail)return new Response(JSON.stringify({error:{message:'denied'}}),{status:window.__fail});
    return new Response(JSON.stringify(String(u).endsWith('/rulesets')?{name:'projects/tsukiichi-molkky/rulesets/abc'}:{}),{status:200});};}"""

async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ca, A = await mk(b, '1台目')
        await newev(A); await unlock(A)
        await A.click('#seedBtn'); await A.wait_for_timeout(1500); await A.click('#seedHist'); await A.wait_for_timeout(2000)
        await A.fill('#impExp', 'てつ'); await A.click('#impGo'); await A.click('#impGo'); await A.wait_for_timeout(3500)

        # 模擬サーバーでも、パスワードの置き場所は読めない
        rd = await A.evaluate(f"async()=>{{try{{await window.__tk.RS.probe('{R}/conf/sysKey');return 'read'}}catch(e){{return e.code}}}}")
        ok(rd == 'permission-denied', '模擬サーバーでも sysKey は読めない')

        # 2. A を B にまとめ、A に残る記録がある。A・B を両方消す候補に選んでも、B（まとめ先）は消えない
        d = docs()
        imp = sorted(k for k in d if '/hist/imp-' in k)
        a, bb = rid_of('ゆい'), rid_of('そうた')
        commit([{'op': 'update', 'path': imp[0], 'data': {'rid': a, 'movedFrom': d[imp[0]]['rid'], 'movedAt': 1, 'mv': 1}}])
        commit([{'op': 'update', 'path': R + '/roster/' + a, 'data': {'mergedInto': bb, 'mergeId': 'mX'}}])
        # 版22→27 の1：読み直してから消すまでの間に、別の人へ記録が移されたら、その人を戻す
        c3 = rid_of('めい')
        moved = {'done': False}
        async def hook(route, req):
            body = req.post_data or ''
            if not moved['done'] and ('"delete"' in body) and (R + '/roster/') in body and (R + '/roster/' + c3) in body:
                moved['done'] = True
                commit([{'op': 'update', 'path': imp[1], 'data': {'rid': c3, 'movedFrom': docs()[imp[1]]['rid'], 'movedAt': 1, 'mv': 1}}])
            await route.continue_()
        await A.route('**/commit', hook)
        await A.wait_for_timeout(1500)
        await A.click('#clScan'); await A.wait_for_timeout(600)
        await A.click('#clAll'); await A.click('#clGo'); await A.click('#clGo'); await A.wait_for_timeout(7000)
        await A.unroute('**/commit')
        msg = await A.locator('#clMsg').text_content(); d = docs()
        ok((R + '/roster/' + a) in d and (R + '/roster/' + bb) in d, '2. 残る人のまとめ先も消さない：' + msg[:70])
        ok(moved['done'] and (R + '/roster/' + c3) in d and d[imp[1]]['rid'] == c3, '1. 読み直したあとに記録が移された人は、元に戻す')
        cl = d.get(R + '/conf/cleanup', {})
        ok(cl.get('until', 0) > 0, '9. 片付けが終わっても、片付けの時間を0に戻さない（ほかの端末の片付けを止めない）')

        # P2 まとめ先の人から「同じチームにしない」を外せる
        sheet = sorted(k.split('/')[-1] for k, v in docs().items() if k.startswith(R + '/roster/') and v.get('createdIn') == 'sheet' and not v.get('mergedInto'))
        x = sheet[0]
        commit([{'op': 'update', 'path': R + '/roster/' + c3, 'data': {'ng.' + x: True}}, {'op': 'update', 'path': R + '/roster/' + x, 'data': {'ng.' + c3: True}}])
        cc = sheet[1]
        commit([{'op': 'update', 'path': R + '/roster/' + c3, 'data': {'mergedInto': cc, 'mergeId': 'mY'}}])
        await A.wait_for_timeout(1500)
        await A.evaluate(f"window.__tk.openPerson('{cc}')"); await A.wait_for_timeout(300)
        has = await A.locator(f'[data-ngrm="{x}"]').count()
        await A.click(f'[data-ngrm="{x}"]'); await A.wait_for_timeout(1500)
        await A.evaluate(f"window.__tk.openPerson('{cc}')"); await A.wait_for_timeout(300)
        left = await A.locator(f'[data-ngrm="{x}"]').count()
        ok(has == 1 and left == 0, 'P2 まとめ先の人から、まとめた人の組を外せる')
        ev = await A.evaluate("window.__tk.S.cur"); rev0 = docs()[R + '/events/' + ev].get('rev')
        await A.select_option('#ngWith', x); await A.click('#ngAdd'); await A.wait_for_timeout(1500)
        await A.evaluate(f"window.__tk.openPerson('{cc}')"); await A.wait_for_timeout(300)
        ok(await A.locator(f'[data-ngrm="{x}"]').count() == 1, 'P2 外したあと、もう一度足せる')
        ok(docs()[R + '/events/' + ev].get('rev') != rev0, '6. 同じチームにしない人を足すと、いまの回の rev が変わる（ほかの端末の抽選案は決められない）')
        await A.evaluate("document.getElementById('ov').hidden=true")

        # P2 取り込んだ覇王戦で出場者を選び、覇王を含めなかったら、覇王は候補に残らず、保存もできない
        ho = sorted(k for k in docs() if re.search(r'/hist/haoh_\d+$', k))[0]; no = int(ho.split('_')[-1]); king = docs()[ho]['rid']
        await A.evaluate(f"window.__tk.openHaoh({no})"); await A.wait_for_timeout(300)
        before = json.loads(await A.evaluate("JSON.stringify([...document.querySelectorAll('#hoKing option')].map(o=>o.value).filter(Boolean))"))
        boxes = A.locator('#hoEnt input'); vals = [await boxes.nth(i).get_attribute('value') for i in range(await boxes.count())]
        pick = [v for v in vals if v != king][:2]
        if not pick:
            opts = json.loads(await A.evaluate("JSON.stringify([...document.querySelectorAll('#hoAdd option')].map(o=>o.value).filter(Boolean))"))
            for v in [o for o in opts if o != king][:2]:
                await A.select_option('#hoAdd', v); await A.wait_for_timeout(100)
            pick = [v for v in opts if v != king][:2]
        else:
            for v in pick: await A.locator(f'#hoEnt input[value="{v}"]').check()
        await A.wait_for_timeout(200)
        after = json.loads(await A.evaluate("JSON.stringify([...document.querySelectorAll('#hoKing option')].map(o=>o.value).filter(Boolean))"))
        ok(king in before and king not in after, 'P2 出場者を選ぶと、出場者でない覇王は候補から消える')
        await A.evaluate("document.getElementById('ov').hidden=true")

        # 7・8 戻す：まとめ先がもうほかへまとまっている／版22で途中まで戻した人／「元に戻す」をした人
        get('/reset'); await ca.close(); ca, A = await mk(b, '2台目'); await newev(A); await unlock(A)
        await A.click('#seedBtn'); await A.wait_for_timeout(2000)
        ro = sorted((k.split('/')[-1], v) for k, v in docs().items() if k.startswith(R + '/roster/'))
        (p1, d1), (p2, d2), (p3, d3), (p4, d4), (p5, d5), (p6, d6) = ro[:6]
        bk = {'app': 'tsukiichi-fb', 'ver': 'x', 'box': 'proto', 'savedAt': 1, 'counts': {}, 'docs': {
            R + '/roster/' + p1: {**d1, 'mergedInto': p2}, R + '/roster/' + p2: d2, R + '/roster/' + p3: d3,
            R + '/roster/' + p4: {**d4, 'mergedInto': p5}, R + '/roster/' + p5: d5,
            R + '/roster/' + p6: {**d6, 'restoreMerge': p3}}}
        open('/tmp/v28_bk.json', 'w').write(json.dumps(bk))
        # サーバー：p1 はない（バックアップから作る）。p2 は p3 へまとめ済み。p4 は版22で途中まで戻した人（restoredAt だけ）。p6 はない
        urllib.request.urlopen(urllib.request.Request(SRV + '/seed', data=json.dumps({R + '/roster/' + p4: {**d4, 'restoredAt': 1}}).encode(), method='POST')).read()
        st = json.loads(get('/state')); st['docs'].pop(R + '/roster/' + p1, None); st['docs'].pop(R + '/roster/' + p6, None)
        get('/reset'); urllib.request.urlopen(urllib.request.Request(SRV + '/seed', data=json.dumps(st['docs']).encode(), method='POST')).read()
        commit([{'op': 'update', 'path': R + '/roster/' + p2, 'data': {'mergedInto': p3, 'mergeId': 'mZ'}}])
        await ca.close(); ca, A = await mk(b, '3台目'); await A.wait_for_timeout(1000)
        await A.click('.nb[data-ph=rec]'); await A.evaluate("()=>{document.querySelector('#bkBox details').open=true}")
        await A.set_input_files('#bkFile', '/tmp/v28_bk.json'); await A.wait_for_timeout(1000)
        await A.click('#bkRestoreGo'); await A.wait_for_timeout(4000)
        d = docs()
        ok(d[R + '/roster/' + p1].get('mergedInto') == p3 and not d[R + '/roster/' + p1].get('restoreMerge'), '7. まとめ先がもうほかへまとまっていたら、その先へまとめる（restoreMerge は残らない）')
        ok(d[R + '/roster/' + p4].get('mergedInto') == p5, '8. 版22で途中まで戻した人も、選び直せばまとめが戻る')
        ok(d[R + '/roster/' + p6].get('mergedInto') == p3, '7. 戻している途中に取ったバックアップ（restoreMerge だけ）からも、まとめが戻る')

        # 5・4・10 ルールの公開
        get('/reset'); await ca.close(); ca, A = await mk(b, '4台目')
        await A.evaluate(MOCK); await newev(A)
        rn = await A.evaluate("window.__tk.RULES_NO")
        get('/rulesno?n=%d' % (rn - 1)); await unlock(A); await A.wait_for_timeout(500)
        ok('古いです' in await A.inner_text('#rulesState'), '本番が古い版なら「古いです」')
        await A.evaluate("()=>{document.getElementById('rulesCidBox').open=true}")
        await A.fill('#rulesCid', '1-a.apps.googleusercontent.com'); await A.click('#rulesCidSave'); await A.wait_for_timeout(1200)
        get('/rulesno?n=%d' % (rn + 1))
        await A.click('#rulesPub'); await A.wait_for_timeout(800)
        ok(len(await A.evaluate("window.__calls")) == 0 and '新しいルール' in await A.inner_text('#rulesPubMsg'), '5. 押す直前に新しい版が公開されていたら、古い版で上書きしない')
        ok(await A.locator('#rulesPub').is_hidden() and '新しいルール' in await A.inner_text('#rulesState'), '5. この画面が古いと出て、公開ボタンを隠す')
        get('/rulesno?n=%d' % (rn - 1)); await A.evaluate("window.__tk.checkRules()"); await A.wait_for_timeout(400)
        await A.evaluate("window.__fail=403"); await A.click('#rulesPub'); await A.wait_for_timeout(800)
        await A.evaluate("window.__fail=0"); await A.click('#rulesPub'); await A.wait_for_timeout(800)
        pr = await A.evaluate("window.__prompts")
        ok(pr[-1] == 'select_account' and await A.evaluate("window.__tokens") == 2, '10. 権限のないアカウントのあとは、アカウントを選び直す画面から')
        await A.click('#sysOut'); await A.wait_for_timeout(300); await unlock(A)
        await A.click('#rulesPub'); await A.wait_for_timeout(800)
        ok(await A.evaluate("window.__tokens") == 3, '4. システムを閉じたら、Google の許可を捨てる（入り直すとログインし直す）')
        ok('TOK' not in json.dumps(await A.evaluate("JSON.stringify(window.__tk.RS)")), '4. 許可（トークン）は window.__tk から見えない')
        await A.click('#sysOut'); await A.wait_for_timeout(300)
        r0 = len(await A.evaluate("window.__calls")); await A.evaluate("()=>document.getElementById('rulesPub').click()"); await A.wait_for_timeout(500)
        ok(len(await A.evaluate("window.__calls")) == r0, '4. システムを閉じたあとは公開できない')
        rules = await A.evaluate("window.__tk.RULES")
        ok("int(v) <= %d" % rn in rules and 'ルールの版 R%d' % rn in rules.split('\n')[1], 'ルールの rulesVer は、この版以下の番号だけ読める')
        get('/rulesno')
        print('errs', errs); ok(not errs, 'ページのエラーなし')
        await b.close()
    print('合計 %d / %d' % (sum(res), len(res)))
asyncio.run(main())
