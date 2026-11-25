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
        # 版29：片付けは消さずに印を置くだけ。片付けたあとに記録が移されても、その人は表示に戻る（消えない）
        c3 = rid_of('めい')
        await A.wait_for_timeout(1500)
        await A.click('#clScan'); await A.wait_for_timeout(600)
        await A.click('#clAll'); await A.click('#clGo'); await A.wait_for_timeout(5000)
        msg = await A.locator('#clMsg').text_content(); d = docs()
        vis = lambda: A.evaluate("window.__tk.S.roster.map(x=>x.id)")
        v1 = await vis()
        ok(a in v1 and bb in v1, '2. 残る記録の持ち主（まとめた人）と、そのまとめ先は表示に残る：' + msg[:70])
        ok(c3 not in v1 and (R + '/roster/' + c3) in d and (R + '/hide/r_' + c3) in d, '片付けた人は表示から外れるが、名簿は消えない')
        commit([{'op': 'update', 'path': imp[1], 'data': {'rid': c3, 'movedFrom': docs()[imp[1]]['rid'], 'movedAt': 1, 'mv': 1}}])
        await A.wait_for_timeout(2000)
        ok(c3 in await vis(), '1. 片付けたあとに記録を移された人は、表示に戻る（記録の持ち主が消えない）')
        ok(not any(k.endswith('/conf/cleanup') for k in docs()), '9. 片付けの時間（cleanup）は使わない')
        await A.click('#clGo') if await A.locator('#clGo').count() else None

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

        # 7・8（版29）戻す：空のときか、同じファイルから戻している途中のときだけ
        get('/reset'); await ca.close(); ca, A = await mk(b, '2台目'); await newev(A); await unlock(A)
        await A.click('#seedBtn'); await A.wait_for_timeout(2000)
        ro = sorted((k.split('/')[-1], v) for k, v in docs().items() if k.startswith(R + '/roster/'))
        (p1, d1), (p2, d2), (p3, d3), (p4, d4), (p5, d5) = ro[:5]
        def mkbk(saved): return {'app': 'tsukiichi-fb', 'ver': 'x', 'box': 'proto', 'savedAt': saved, 'savedBy': 'NAS', 'counts': {}, 'docs': {
            R + '/roster/' + p1: {**d1, 'mergedInto': p2}, R + '/roster/' + p2: {**d2, 'mergedInto': p3}, R + '/roster/' + p3: d3,
            R + '/roster/' + p4: {**d4, 'mergedInto': p5, 'unmergedAt': 5, 'unmergeOf': 'old'}, R + '/roster/' + p5: d5}}
        open('/tmp/v28_bk1.json', 'w').write(json.dumps(mkbk(1000))); open('/tmp/v28_bk2.json', 'w').write(json.dumps(mkbk(2000)))
        async def pick(f):
            await A.click('.nb[data-ph=rec]'); await A.evaluate("()=>{document.querySelector('#bkBox details').open=true}")
            await A.set_input_files('#bkFile', f); await A.wait_for_timeout(1200)
        await pick('/tmp/v28_bk1.json')
        ok('もう名簿・記録があります' in await A.locator('#bkMsg').text_content() and await A.locator('#bkRestoreGo').is_hidden(), '名簿が入っている箱には戻さない（空のときだけ）')
        # 空の箱：同じファイルの途中から（p1 だけ作ってまとめる前に止まった）。別のファイルは混ぜない
        get('/reset'); await ca.close(); ca, A = await mk(b, '3台目'); await newev(A)
        commit([{'op': 'set', 'path': R + '/roster/' + p1, 'data': {**d1, 'restoreOf': 'b1000_NAS', 'restoredAt': 1}}])
        await pick('/tmp/v28_bk2.json')
        ok('もう名簿・記録があります' in await A.locator('#bkMsg').text_content(), '7. 途中で止まった復元に、別のファイルは混ぜない')
        await pick('/tmp/v28_bk1.json'); await A.click('#bkRestoreGo'); await A.wait_for_timeout(4000)
        d = docs()
        ok(d[R + '/roster/' + p1].get('mergedInto') == p2 and d[R + '/roster/' + p2].get('mergedInto') == p3, '7. 同じファイルを選び直すと、途中から続けて A→B→C のまとめも戻る')
        ok(d[R + '/roster/' + p4].get('mergedInto') == p5 and not d[R + '/roster/' + p4].get('unmergedAt'), '8. バックアップに昔の「元に戻す」の跡があっても、まとめは戻る（跡は外す）')
        # 戻したあとに「元に戻す」をした人は、同じファイルをもう一度選んでもまとめ直さない
        commit([{'op': 'set', 'path': R + '/roster/' + p4, 'data': {**{k: v for k, v in d[R + '/roster/' + p4].items() if k != 'mergedInto'}, 'unmergedAt': 9}}]) if False else urllib.request.urlopen(urllib.request.Request(SRV + '/seed', data=json.dumps({R + '/roster/' + p4: {**{k: v for k, v in d[R + '/roster/' + p4].items() if k != 'mergedInto'}, 'unmergedAt': 9}}).encode(), method='POST')).read()
        await A.wait_for_timeout(1500); await pick('/tmp/v28_bk1.json')
        if await A.locator('#bkRestoreGo').is_visible(): await A.click('#bkRestoreGo'); await A.wait_for_timeout(3000)
        ok(not docs()[R + '/roster/' + p4].get('mergedInto'), '8. 戻したあとに「元に戻す」をした人は、まとめ直さない')

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
