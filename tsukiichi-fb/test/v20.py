# 版20：参加者画面の通信を減らす（大会の日だけ自動で更新、それ以外は開いたときだけ）
import asyncio, json, os, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); VIEW = 'file://' + os.path.join(HERE, '..', '..', 'tsukiichi', 'index.html'); SRV = 'http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV + p).read()
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
async def mk(b, name, url):
    ctx = await b.new_context(viewport={'width': 375, 'height': 800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}')")
    pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); await pg.goto(url); await pg.wait_for_timeout(1500); return ctx, pg
async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ca, A = await mk(b, '1台目', URL)
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.click('#impGo'); await A.click('#impGo'); await A.wait_for_timeout(3000)
        await A.click('.nb[data-ph=set]'); await A.fill('#if_開催日', '2030-01-01'); await A.click('#infoSave'); await A.wait_for_timeout(3000)
        cv, V = await mk(b, '見る人', VIEW)
        n = []; V.on('request', lambda r: n.append(r.url) if r.url.startswith(SRV) else None)
        lv = json.loads(await V.evaluate("JSON.stringify({on:window.__live.on})"))
        ok(not lv['on'], '大会の日ではない（開催日が先・チームなし）ときは、自動で読み直さない')
        await V.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); await V.wait_for_timeout(500)
        ok(len(n) == 0, 'ほかのアプリから戻っても、3分以内なら読み直さない（通信 %d回）' % len(n))
        # 当日：チームを出す
        await A.click('.nb[data-ph=sys]'); await A.click('#seedBtn'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=entry]')
        for nm in ['はると', 'ゆい', 'そうた', 'めい', 'けんた', 'あおい']:
            await A.fill('#eq', nm); await A.wait_for_timeout(100); await A.locator('#rList .rc span', has_text=nm).first.click()
        await A.fill('#eq', ''); await A.click('#qAdd'); await A.wait_for_timeout(2500)
        await A.click('.nb[data-ph=team]'); await A.click('#tmDraw'); await A.wait_for_timeout(300); await A.click('#tmSave'); await A.wait_for_timeout(800); await A.click('#rvClose'); await A.wait_for_timeout(3000)
        await V.click('#headReload'); await V.wait_for_timeout(1500)
        lv = json.loads(await V.evaluate("JSON.stringify({on:window.__live.on,kind:window.__live.kind})"))
        ok(lv['on'], 'チームが出て、終わっていない試合があれば、自動で更新する（%s）' % lv['kind'])
        st = await V.locator('#syncStatus').text_content()
        ok('自動で更新中' in st, '画面に「自動で更新中」と出る：' + st)
        await V.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))")
        ok(not await V.evaluate("window.__live.on"), '画面を見ていない間は止める')
        await V.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))"); await V.wait_for_timeout(300)
        ok(await V.evaluate("window.__live.on"), '戻ると、また自動で更新する')
        ok(not errs, 'ページのエラーなし ' + str(errs[:3]))
        await b.close()
    print('合計', sum(res), '/', len(res))
asyncio.run(main())
