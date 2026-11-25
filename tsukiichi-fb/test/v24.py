# 版24：同じチームにしない組・ルールの頭の版
import asyncio, json, os, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); SRV = 'http://localhost:8765'; R = 'staff/proto'
def get(p): return urllib.request.urlopen(SRV + p).read()
def docs(): return json.loads(get('/state'))['docs']
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
def rid_of(name): return next(k.split('/')[-1] for k, v in docs().items() if k.startswith(R + '/roster/') and v.get('name') == name)

async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 375, 'height': 800})
        await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','1台目')")
        A = await ctx.new_page(); A.on('pageerror', lambda e: errs.append(str(e))); await A.goto(URL); await A.wait_for_timeout(1500)

        rules = await A.evaluate("window.__tk.RULES")
        ver = await A.evaluate("window.__tk.RULES_VER")
        ok(rules.split('\n')[1].startswith('// ') and ('ルールの版 ' + ver) in rules.split('\n')[1], 'ルールの2行目にルールの版（' + ver + '）')

        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        n = await A.locator('#rList .rc span').count()
        for i in range(n): await A.locator('#rList .rc span').nth(i).click()
        await A.click('#qAdd'); await A.wait_for_timeout(3500)

        # 名簿の人の画面で「同じチームにしない人」を足す（両方の名簿に書かれる）
        exps = [v['name'] for k, v in docs().items() if k.startswith(R + '/roster/') and v.get('exp')]
        a, c = exps[0], exps[1]; ra, rc = rid_of(a), rid_of(c)
        await A.evaluate(f"window.__tk.openPerson('{ra}')"); await A.wait_for_timeout(300)
        await A.select_option('#ngWith', rc); await A.click('#ngAdd'); await A.wait_for_timeout(1500)
        d = docs()
        ok(d[R + '/roster/' + ra].get('ng', {}).get(rc) is True and d[R + '/roster/' + rc].get('ng', {}).get(ra) is True, '足すと両方の名簿に書かれる')
        ok(c in await A.inner_text('#sheet'), '名簿の人の画面に相手の名前が出る')
        # 普通の人どうしも1組（2組目は別の端末から同時に足しても消し合わない欄の書き方）
        ns = [v['name'] for k, v in docs().items() if k.startswith(R + '/roster/') and not v.get('exp')]
        x, y = rid_of(ns[0]), rid_of(ns[1])
        urllib.request.urlopen(urllib.request.Request(SRV + '/commit', data=json.dumps({'writes': [{'op': 'update', 'path': R + '/roster/' + x, 'data': {'ng.' + y: True}}]}).encode(), method='POST')).read()
        await A.wait_for_timeout(1500)
        d = docs(); ok(d[R + '/roster/' + ra]['ng'].get(rc) is True, '別の欄を書いても前の組は消えない')

        # 抽選：200回やって、どの組も同じチームにならない（片方の名簿にだけ書いた組も守る）
        await A.click('#ppClose'); await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(500)
        st = await A.evaluate("""()=>{const t=window.__tk;const ps=t.drawPeople();const outs=t.teamOptions(ps).out;let bad=0,chk=0;
          outs.forEach(o=>{for(let i=0;i<100;i++){const r=t.drawTeams(ps,o);if(r.some(tm=>tm.members.some(p=>tm.members.some(q=>p.ng.has(q.id)))))bad++;if(t.checkTeams(r,ps).some(c=>!c[0]))chk++;}});
          return {bad,chk,n:outs.length}}""")
        ok(st['bad'] == 0 and st['chk'] == 0, '全部のチーム数で100回ずつ抽選して、組が同じチームにならない・点検も合格 ' + str(st))
        tgt = await A.inner_text('#tmTarget')
        ok('同じチームにしない組' in tgt and a in tgt and c in tgt, '抽選の画面に組が出る')
        await A.click('#tmDraw'); await A.wait_for_timeout(500)
        ok('同じチームにしない組（2組）は、別々のチームです' in await A.inner_text('#tmChecks'), '抽選の点検に ✓ が出る')

        # 目印のまとまりの中に組があると、抽選の前に止める
        st = await A.evaluate(f"""()=>{{const t=window.__tk;const ps=t.drawPeople();ps.forEach(p=>{{if(p.id==='{ra}'||p.id==='{rc}')p.pair='X';}});return t.teamOptions(ps)}}""")
        ok(not st['out'] and '同じチームにしない組' in st['why'], '目印のまとまりに組があると止める：' + st['why'][:40])

        # 決めたあとに手で同じチームにしたら、注意（⚠）だけ出る
        await A.click('#tmSave'); await A.wait_for_timeout(2500); await A.evaluate("document.getElementById('ov').hidden=true")
        ev = await A.evaluate("window.__tk.S.cur"); asg = docs()[R + '/events/' + ev]['assign']
        urllib.request.urlopen(urllib.request.Request(SRV + '/commit', data=json.dumps({'writes': [{'op': 'update', 'path': R + '/events/' + ev, 'data': {'assign.' + rc: asg[ra], 'rev': 'zz' + ev}}]}).encode(), method='POST')).read()
        await A.wait_for_timeout(2000)
        chk = await A.inner_text('#tmChecks')
        ok('同じチームにしない組が同じチームです' in chk, '手で同じチームにすると注意が出る')

        # 外す：両方の名簿が false になり、抽選の対象から消える
        await A.evaluate(f"window.__tk.openPerson('{ra}')"); await A.wait_for_timeout(300)
        await A.click(f'[data-ngrm="{rc}"]'); await A.wait_for_timeout(1500)
        d = docs()
        ok(d[R + '/roster/' + ra]['ng'].get(rc) is False and d[R + '/roster/' + rc]['ng'].get(ra) is False, '外すと両方の名簿で false')
        n2 = await A.evaluate("window.__tk.drawPeople().reduce((s,p)=>s+p.ng.size,0)")
        ok(n2 == 2, '残りは1組だけ（2人分） ' + str(n2))

        # 参加者向けのデータに組が入らない
        pub = json.dumps(await A.evaluate("window.__tk.publicData()"), ensure_ascii=False)
        ok('"ng"' not in pub and 'ng.' not in pub, '参加者向けのデータに組が入っていない')
        print('errs', errs); ok(not errs, 'ページのエラーなし')
        await b.close()
    print('合計 %d / %d' % (sum(res), len(res)))
asyncio.run(main())
