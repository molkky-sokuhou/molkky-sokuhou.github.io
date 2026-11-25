import asyncio, json, urllib.request
from playwright.async_api import async_playwright
_D=__import__('os').path.dirname(__import__('os').path.abspath(__file__)); ADMIN='file://'+_D+'/../admin/index.html'; VIEW='file://'+_D+'/../index.html'; SRV='http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV+p).read()
def docs(): return json.loads(get('/state'))['docs']
def pub():
    d=docs().get('public/tsukiichi_proto'); return json.loads(d['body']) if d else None
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('OK ' if c else 'NG ')+l)
async def mk(b,url,name='1台目',theme='light'):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}');localStorage.setItem('mk_view_theme','{theme}')")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); await pg.goto(url); await pg.wait_for_timeout(1500); return ctx,pg
async def reload(V):
    await V.click('#headReload'); await V.wait_for_timeout(800)
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        cv,V=await mk(b,VIEW,'見る人')
        ok('まだ大会情報がありません' in await V.inner_text('#syncStatus'),'公開データがないうちは「まだ大会情報がありません」')
        ca,A=await mk(b,ADMIN)
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.click('#seedBtn'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.click('#impGo'); await A.click('#impGo'); await A.wait_for_timeout(3500)
        d=pub(); ok(d is not None,'運営の端末が公開データを書く')
        ok(d and d['state']['previousResult'] and d['state']['previousResult']['date']=='2026-11-21','前回の結果＝取り込んだ11/21の大会')
        await reload(V)
        await V.click('#t-rank'); await V.wait_for_timeout(300); t=await V.inner_text('#rankBody')
        ok('前回の大会結果' in t and 'マルック・kenji' in t,'参加者画面に前回（11/21）の結果が出る')
        await V.click('#t-rank'); await V.wait_for_timeout(300)
        if await V.locator('#recordsPanel').count(): await V.evaluate("document.getElementById('recordsPanel').open=true"); await V.wait_for_timeout(800)
        rt=await V.inner_text('#p-rank'); ok('マルック' in rt and 'やきとり' in rt,'記録に過去の優勝（マルック）と覇王戦（やきとり）が出る')
        # 受付→抽選（発表前は出さない）
        await A.click('.nb[data-ph=entry]'); n=await A.locator('#rList .rc span').count()
        for i in range(10): await A.locator('#rList .rc span').nth(i).click()
        await A.click('#qAdd'); await A.wait_for_timeout(3000)
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300); await A.click('#tmDraw'); await A.wait_for_timeout(300); await A.click('#tmSave'); await A.wait_for_timeout(2500)
        d=pub(); ok(d['state']['teams']==[] and d['state']['matches']==[],'発表中（「チームを見る」の前）は、参加者画面にチームも対戦表も出さない')
        await A.click('#rvClose'); await A.wait_for_timeout(3000)
        d=pub(); ok(len(d['state']['teams'])>=2 and len(d['state']['matches'])>0 and len(d['state']['players'])==10,'「チームを見る」で、チーム・対戦表・メンバーを出す')
        body=docs()['public/tsukiichi_proto']['body']
        bad=[k for k in ('"exp"','"level"','"beg"','"early"','"pair"','"rid"','"dev"','"uid"','8wvI','mergedInto','keepName') if k in body]
        ok(not bad,'公開データに運営だけの印（経験豊富・評価・初心者・早帰り・目印・端末・UID・まとめ）が入っていない '+str(bad))
        await reload(V); await V.click('#t-match'); await V.wait_for_timeout(300)
        mt=await V.inner_text('#p-match'); ok('第1ラウンド' in mt and '1コート' in mt,'参加者画面の「試合・コート」にラウンドとコートが出る')
        # 得点→順位
        await A.click('.nb[data-ph=game]'); await A.wait_for_timeout(300)
        mid=await A.locator('#gBody .mt').first.get_attribute('data-m'); await A.click('[data-m="%s"]'%mid); await A.fill('#sc_a','57'); await A.fill('#sc_b','33'); await A.click('#scSave'); await A.wait_for_timeout(3000)
        await reload(V); await V.click('#t-rank'); await V.wait_for_timeout(300)
        rk=await V.inner_text('#rankBody'); ok('57' in rk and '33' in rk,'得点を入れると、参加者画面の順位に出る')
        await V.click('#t-team'); await V.wait_for_timeout(300)
        if await V.locator('[data-pick]').count():
            await V.locator('[data-pick]').first.click(); await V.wait_for_timeout(300)
        mine=await V.inner_text('#p-team'); ok('変更' in mine and ('ラウンド' in mine),'自分のチームを選ぶと、自分の試合が出る')
        await V.screenshot(path='view_team.png',full_page=True)
        # 次の回を始める → 前回の結果が見える
        await A.click('.nb[data-ph=set]'); await A.click('#evNew'); await A.wait_for_timeout(300); await A.click('#evYes'); await A.wait_for_timeout(3500)
        d=pub(); ok(d['state']['teams']==[] and d['state']['previousResult'] and any(s['total']==57 for s in d['state']['previousResult']['standings']),'次の回を始めると、さっき締めた回が「前回の結果」になる')
        await reload(V); await V.click('#t-rank'); await V.wait_for_timeout(300)
        ok('前回の大会結果' in await V.inner_text('#rankBody'),'参加者画面にも前回の結果が出続ける')
        # 行き来
        hrefs=await V.evaluate("[...document.querySelectorAll('a.to-admin')].map(a=>a.getAttribute('href'))")
        ok('admin/' in hrefs,'参加者画面の下に「運営の画面」への入口')
        ok(await A.locator('a.to-view').count()==1 and await A.locator('a.to-view').get_attribute('href')=='../','運営画面の上に「参加者の画面」への入口')
        print('   sw',await V.evaluate('document.documentElement.scrollWidth'))
        await V.click('#themeSwitch'); await V.wait_for_timeout(200); await V.screenshot(path='view_dark.png')
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
