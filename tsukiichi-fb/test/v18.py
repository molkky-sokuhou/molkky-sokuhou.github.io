# 版18：システムタブ（パスワード）・テストのデータの片付け・覇王戦の一覧が枠からはみ出さない
import asyncio, json, os, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); SRV = 'http://localhost:8765'
R = 'staff/proto'
def get(p): return urllib.request.urlopen(SRV + p).read()
def docs(): return json.loads(get('/state'))['docs']
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
async def mk(b, name, gate=True, theme='light'):
    ctx = await b.new_context(viewport={'width': 375, 'height': 800}, color_scheme=theme)
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';" + ("window.__SYS_GATE=1;" if gate else '') + f"localStorage.setItem('tk_devName','{name}');localStorage.setItem('mk_view_theme','{theme}')")
    pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx, pg
async def closeov(pg): await pg.evaluate("()=>{document.getElementById('ov').hidden=true}")
def n(prefix): return len([k for k in docs() if k.startswith(R + prefix)])

async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ca, A = await mk(b, '1台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)

        # 設定タブは大会の情報だけ
        await A.click('.nb[data-ph=set]'); await A.wait_for_timeout(300)
        st = await A.locator('#ph-set').inner_text()
        ok('大会の案内' in st and '開催回' in st and 'Firestore' not in st and 'テスト用' not in st and '計測' not in st, '設定タブは大会の案内と開催回だけ')

        # システムタブ：パスワードを決める→鍵をかける→違うパスワード→正しいパスワード
        await A.click('.nb[data-ph=sys]'); await A.wait_for_timeout(500)
        ok(await A.locator('#sysBody').is_hidden() and await A.locator('#sysPw2F').is_visible(), '初めて開くとパスワードを決める画面（中身は隠れている）')
        await A.fill('#sysPw', '7788'); await A.fill('#sysPw2', '7789'); await A.click('#sysGo'); await A.wait_for_timeout(300)
        ok('違います' in await A.locator('#sysErr').text_content() and await A.locator('#sysBody').is_hidden(), '2回の入力が違えば入れない')
        await A.fill('#sysPw', '7788'); await A.fill('#sysPw2', '7788'); await A.click('#sysGo'); await A.wait_for_timeout(1500)
        sk = docs().get(R + '/conf/sysKey') or {}; sm = docs().get(R + '/conf/sysMeta') or {}
        ok(await A.locator('#sysBody').is_visible() and len(sk.get('hash', '')) == 64 and sm.get('salt') and '7788' not in json.dumps(sk) + json.dumps(sm), '決めると入れる。サーバーにはパスワードそのものは残らない（ハッシュは別の文書）')
        await A.click('#sysOut'); await A.wait_for_timeout(300)
        ok(await A.locator('#sysBody').is_hidden(), '「システムを閉じる」で鍵がかかる')
        cb, B2 = await mk(b, '2台目'); await B2.click('.nb[data-ph=sys]'); await B2.wait_for_timeout(800)
        ok(await B2.locator('#sysPw2F').is_hidden() and await B2.locator('#sysBody').is_hidden(), 'ほかの端末では、決めたパスワードを入れる画面')
        await B2.fill('#sysPw', '1111'); await B2.click('#sysGo'); await B2.wait_for_timeout(300)
        ok('違います' in await B2.locator('#sysErr').text_content() and await B2.locator('#sysBody').is_hidden(), '違うパスワードでは入れない')
        await B2.fill('#sysPw', '7788'); await B2.click('#sysGo'); await B2.wait_for_timeout(500)
        ok(await B2.locator('#sysBody').is_visible(), '正しいパスワードで入れる')
        await cb.close()
        await A.fill('#sysPw', '7788'); await A.click('#sysGo'); await A.wait_for_timeout(500)

        # テストのデータを作る：架空の名簿・架空の記録・取り込み・受付・締めた回
        await A.click('#seedBtn'); await A.wait_for_timeout(1500); await A.click('#seedHist'); await A.wait_for_timeout(2000)
        await A.fill('#impExp', 'てつ・マルック'); await A.click('#impGo'); await A.click('#impGo'); await A.wait_for_timeout(3500)
        await A.click('.nb[data-ph=entry]')
        for nm in ['ゆい', 'そうた', 'めい', 'あおい', 'マルック', 'てつ']:
            await A.fill('#eq', nm); await A.wait_for_timeout(120); await A.locator('#rList .rc span', has_text=nm).first.click()
        await A.fill('#eq', ''); await A.click('#qAdd'); await A.wait_for_timeout(2500)
        await A.click('.nb[data-ph=team]'); await A.click('#tmDraw'); await A.wait_for_timeout(300); await A.click('#tmSave'); await A.wait_for_timeout(1500); await closeov(A)
        await A.click('.nb[data-ph=set]'); await A.click('#evNew'); await A.wait_for_timeout(300); await A.click('#evYes'); await A.wait_for_timeout(2500)
        if await A.locator('#evYes').is_visible(): await A.click('#evYes'); await A.wait_for_timeout(2500)
        await A.click('.nb[data-ph=entry]')
        for nm in ['ゆい', 'マルック']:
            await A.fill('#eq', nm); await A.wait_for_timeout(120); await A.locator('#rList .rc span', has_text=nm).first.click()
        await A.fill('#eq', ''); await A.click('#qAdd'); await A.wait_for_timeout(2500)
        before = (n('/roster/'), n('/hist/'), n('/events/'))
        print('     片付け前', before)

        # 片付け
        await A.click('.nb[data-ph=sys]'); await A.click('#clScan'); await A.wait_for_timeout(500)
        txt = await A.locator('#clList').inner_text()
        ok('ゆい' in txt and 'マルック' not in txt.split('記録')[0] and '締めた回' in txt and '受付 2人' in txt, '調べると、テストの名簿・記録・締めた回・いまの受付が出る（取り込んだ人は出ない）')
        r = json.loads(json.dumps(get('/state').decode()))
        ok(await A.locator('#clList [data-cl]:checked').count() == 0, '最初はどれにもチェックが入っていない')
        await A.click('#clAll'); await A.click('#clGo'); await A.click('#clGo'); await A.wait_for_timeout(6000)
        msg = await A.locator('#clMsg').text_content()
        d = docs()
        ros = [v['name'] for k, v in d.items() if k.startswith(R + '/roster/')]
        hs = [v for k, v in d.items() if k.startswith(R + '/hist/')]
        evs = [k for k in d if k.startswith(R + '/events/') and k.count('/') == 3]
        cks = [k for k in d if '/checkins/' in k]
        ok(len(ros) == 33 and 'ゆい' not in ros, '名簿はスプレッドシートの33人だけ残る（%d人）：%s' % (len(ros), msg))
        ok(len(hs) == 51 and all(h.get('src') == 'sheet' for h in hs), '記録は取り込んだ50件＋覇王戦1件だけ残る（%d件）' % len(hs))
        ok(len(evs) == 1 and not cks, 'テストで締めた回と、受付は消える（回 %d・受付 %d）' % (len(evs), len(cks)))
        import time
        u = (d.get(R + '/conf/cleanup') or {}).get('until', 0)
        ok(0 < u - time.time() * 1000 <= 5 * 60000 + 5000, '片付けの時間は5分まで（版28：終わっても0に戻さず、5分で閉じる）')
        from urllib.request import Request, urlopen
        rr = json.loads(urlopen(Request(SRV + '/commit', data=json.dumps({'writes': [{'op': 'delete', 'path': R + '/hist/haoh_1'}]}).encode(), method='POST')).read())
        ok(not rr['ok'], '片付けの時間のあとは、記録を消せない（ルール）')

        # 覇王戦の一覧：優勝の多い人の日付が枠からはみ出さない（明るい・暗い）
        await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(500)
        for theme in ['light', 'dark']:
            await A.evaluate("document.documentElement.dataset.theme='%s'" % theme)
            over = await A.evaluate("""()=>{const box=document.getElementById('hoBox').getBoundingClientRect();return [...document.querySelectorAll('#hoEl *')].filter(e=>{const r=e.getBoundingClientRect();return r.right>box.right-2||r.left<box.left}).length}""")
            ok(over == 0, '覇王戦の一覧が枠からはみ出さない（%s）' % theme)
            await A.locator('#hoBox').screenshot(path='/tmp/v18_haoh_%s.png' % theme)
        await A.click('.nb[data-ph=sys]'); await A.wait_for_timeout(300)
        await A.screenshot(path='/tmp/v18_sys.png')
        ok(await A.evaluate("document.documentElement.scrollWidth") <= 375, '6つのタブでも横にはみ出さない')
        ok(not errs, 'ページのエラーなし ' + str(errs[:3]))
        await b.close()
    print('合計', sum(res), '/', len(res))
asyncio.run(main())
