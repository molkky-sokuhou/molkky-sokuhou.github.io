# 版29：新しい版への自動切り替え・ルール公開の途中でシステムを閉じたとき・確かめられないときは公開しない
import asyncio, json, os, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
ADMIN = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); VIEW = 'file://' + os.path.join(HERE, '..', 'index.html'); SRV = 'http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV + p).read()
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
async def mk(b, url, extra=''):
    ctx = await b.new_context(viewport={'width': 375, 'height': 800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';window.__SYS_GATE=1;window.__RULES_UID='UID9';window.__VER_URL='{SRV}/vercheck/';localStorage.setItem('tk_devName','x');{extra}")
    pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    return ctx, pg
NEW = '2099.01.01-1'
async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # 運営画面：新しい版があれば入れ替える。シートを開いている間は待つ
        ctx, A = await mk(b, ADMIN)
        hits = {'n': 0}
        async def ver(route, req):
            hits['n'] += 1
            await route.fulfill(status=200, body="<script>const VER = '%s';</script>" % NEW, headers={'Access-Control-Allow-Origin': '*'})
        await ctx.route('**/vercheck/**', ver)
        await A.goto(ADMIN); await A.wait_for_timeout(1500)
        await A.evaluate("()=>{document.getElementById('ov').hidden=false}")
        await A.wait_for_timeout(4500)
        ok('v=' not in A.url and hits['n'] >= 1, 'シートを開いている間は、新しい版があっても入れ替えない')
        await A.evaluate("()=>{document.getElementById('ov').hidden=true}")
        await A.wait_for_timeout(7000)
        ok(('v=' + NEW) in A.url, '閉じたら新しい版へ入れ替える（' + A.url.split('?')[-1] + '）')
        n0 = hits['n']; u0 = A.url
        await A.wait_for_timeout(6000)
        ok(A.url == u0, '入れ替えたあと、同じ版へ何度も入れ替えない（キャッシュで古いまま返るとき）')
        await ctx.close()
        # 「最新にする」：最新なら、そう出す
        ctx, A = await mk(b, ADMIN)
        async def same(route, req):
            v = open(os.path.join(HERE, '..', 'admin', 'index.html')).read().split("const VER = '")[1].split("'")[0]
            await route.fulfill(status=200, body="<script>const VER = '%s';</script>" % v, headers={'Access-Control-Allow-Origin': '*'})
        await ctx.route('**/vercheck/**', same)
        await A.goto(ADMIN); await A.wait_for_timeout(1500)
        await A.wait_for_timeout(3500); await A.evaluate("()=>[...document.querySelectorAll('[data-vercheck]')].find(b=>b.offsetParent).click()"); await A.wait_for_timeout(800)
        ok('最新です' in await A.locator('#toast').text_content(), '「最新にする」：最新ならそう出す')
        await ctx.close()
        # 参加者画面
        ctx, V = await mk(b, VIEW)
        async def vv(route, req): await route.fulfill(status=200, body="<script>var PAGE_VER = '%s';</script>" % NEW, headers={'Access-Control-Allow-Origin': '*'})
        await ctx.route('**/vercheck/**', vv)
        await V.goto(VIEW); await V.wait_for_timeout(7000)
        ok(('v=' + NEW) in V.url, '参加者画面も新しい版へ入れ替える')
        await ctx.close()

        # ルールの公開：ログインの返事を待つ間にシステムを閉じたら、返事は捨てる
        get('/reset')
        MOCK = """()=>{window.__calls=[];window.__delay=0;
          window.google={accounts:{oauth2:{initTokenClient:(o)=>({requestAccessToken:()=>{setTimeout(()=>o.callback({access_token:'TOK',expires_in:3600}),window.__delay);}})}}};
          const f0=window.fetch;window.fetch=async(u,o)=>{if(String(u).indexOf('firebaserules')<0)return f0(u,o);window.__calls.push(o.method);
            if(String(u).endsWith('/rulesets')&&window.__lockOnPost)document.getElementById('sysOut').click();
            return new Response(JSON.stringify(String(u).endsWith('/rulesets')?{name:'projects/x/rulesets/a'}:{}),{status:200});};}"""
        ctx, A = await mk(b, ADMIN); await A.goto(ADMIN); await A.wait_for_timeout(1500); await A.evaluate(MOCK)
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        async def unlock():
            await A.click('.nb[data-ph=sys]'); await A.wait_for_timeout(400)
            if await A.locator('#sysPw2F').is_visible(): await A.fill('#sysPw2', '7788')
            await A.fill('#sysPw', '7788'); await A.click('#sysGo'); await A.wait_for_timeout(1200)
        get('/rulesno?n=1'); await unlock()
        await A.evaluate("()=>{document.getElementById('rulesCidBox').open=true}")
        await A.fill('#rulesCid', '1-a.apps.googleusercontent.com'); await A.click('#rulesCidSave'); await A.wait_for_timeout(1200)
        await A.evaluate("window.__delay=1500"); await A.click('#rulesPub'); await A.wait_for_timeout(200); await A.click('#sysOut'); await A.wait_for_timeout(2500)
        ok(await A.evaluate("window.__calls.length") == 0, '④ ログインを待つ間にシステムを閉じたら、あとから届いた許可で公開しない')
        await unlock(); await A.evaluate("()=>{window.__delay=0;window.__lockOnPost=true}")
        await A.click('#rulesPub'); await A.wait_for_timeout(1500)
        calls = await A.evaluate("window.__calls")
        ok(calls == ['POST'], '④ ルールを送っている間にシステムを閉じたら、切り替えない（' + ','.join(calls) + '）')
        await A.evaluate("()=>{window.__lockOnPost=false;window.__calls=[]}")
        await unlock()
        await A.evaluate("()=>{window.__tk.RS.probe=()=>Promise.reject({code:'unavailable'})}")
        await A.click('#rulesPub'); await A.wait_for_timeout(1200)
        ok(await A.evaluate("window.__calls.length") == 0 and '確かめられ' in await A.inner_text('#rulesPubMsg'), '⑤ 本番のルールの版を確かめられないときは公開しない')
        get('/rulesno')
        print('errs', errs); ok(not errs, 'ページのエラーなし')
        await b.close()
    print('合計 %d / %d' % (sum(res), len(res)))
asyncio.run(main())
