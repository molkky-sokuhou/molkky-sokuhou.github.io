# 版17：スプレッドシートの取り込み・大会の案内・覇王戦の記録と出場資格・バックアップ
import asyncio, json, os, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); VIEW = 'file://' + os.path.join(HERE, '..', 'index.html'); SRV = 'http://localhost:8765'
R = 'staff/proto'
def get(p): return urllib.request.urlopen(SRV + p).read()
def docs(): return json.loads(get('/state'))['docs']
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
async def mk(b, name, url=URL):
    ctx = await b.new_context(viewport={'width': 375, 'height': 800}, accept_downloads=True)
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}')")
    pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); await pg.goto(url); await pg.wait_for_timeout(1500); return ctx, pg
async def closeov(pg): await pg.evaluate("()=>{document.getElementById('ov').hidden=true}")
def hist(kind=None): return {k: v for k, v in docs().items() if k.startswith(R + '/hist/') and (v.get('kind') == kind)}
def roster(): return {k: v for k, v in docs().items() if k.startswith(R + '/roster/')}

async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ca, A = await mk(b, '1台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)

        # 1. 取り込み
        await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(500)
        t = await A.locator('#impSum').text_content()
        ok('名簿 33人' in t and '記録 50件' in t and '覇王戦 1件' in t, '取り込む前の説明：' + t)
        await A.fill('#impExp', open('/tmp/explist.txt').read()); await A.wait_for_timeout(200)
        await A.click('.nb[data-ph=entry]'); await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(300)
        await A.click('#impGo'); await A.click('#impGo'); await A.wait_for_timeout(3500)
        ok(len(roster()) == 33 and len(hist()) == 50 and len(hist('haoh')) == 1, '名簿33人・記録50件・覇王戦1件が入る（%d・%d・%d）' % (len(roster()), len(hist()), len(hist('haoh'))))
        ok(not any(v['name'] in ('あ', 'い', 'う', 'え') for v in roster().values()), 'テストの4人（あ・い・う・え）は入らない')
        exp = sorted(v['name'] for v in roster().values() if v.get('exp'))
        ok(len(exp) == 14 and 'てつ' in exp and 'カリヤス' not in exp, '経験豊富の印 14人 ' + '・'.join(exp))
        info = docs().get(R + '/conf/info') or {}
        ok(info.get('場所') == 'B&G海洋センター ゲートボールコート' and info.get('開催日') == '2026-12-19', '大会の案内も入る')
        t = await A.locator('#impSum').text_content()
        ok('すべて取り込み済み' in t and await A.locator('#impGo').is_hidden(), 'もう一度は取り込めない（重ならない）：' + t)
        h = docs()[R + '/hist/imp-2026-11-21_Mmwptmb0upse3ll']
        ok(h['rank'] == 1 and h['total'] == 660 and h['played'] == 7 and h['teams'] == 8 and h['members'] == ['マルック', 'kenji'], '11/21のマルック：1位・660点・7試合・8チーム・チームメンバー')

        # 2. 覇王戦の出場資格（第1回 12/20 以降の覇者。12/20の優勝も入る）
        el = json.loads(await A.evaluate("JSON.stringify(window.__tk.haohEligible())"))
        names = [e['name'] for e in el['list']]
        ok(el['nextNo'] == 2 and len(names) == 20 and '学園長' in names and 'やきとり' in names and names[0] == 'マルック' and el['list'][0]['wins'] == 5,
           '第2回の出場資格は20人（12/20の学園長も入る・マルックは優勝5回）')
        t = await A.locator('#hoElH').text_content()
        ok('第2回' in t and '20人' in t, '運営画面に出場資格の見出し：' + t)
        await A.wait_for_timeout(2500)
        cv, V = await mk(b, '参加者', VIEW)
        await V.click('[data-tab=rank]'); await V.wait_for_timeout(300); await V.evaluate("document.getElementById('recordsPanel').open=true"); await V.wait_for_timeout(800)
        hb = await V.locator('#haohBox').text_content()
        ok('20人' in hb and 'やきとり' in hb and '以降' in hb, '参加者画面にも出場資格20人（以降）')

        # 3. 大会の案内を直す
        await closeov(A); await A.click('.nb[data-ph=set]'); await A.wait_for_timeout(300)
        await A.fill('#if_場所', '高松市の別会場'); await A.fill('#if_開催日', '2027-01-16'); await A.click('#infoSave'); await A.wait_for_timeout(3500)
        body = json.loads(docs()['public/tsukiichi_proto']['body'])
        ok(body['state']['settings']['場所'] == '高松市の別会場' and body['state']['settings']['開催日'] == '2027-01-16', '案内を直すと参加者画面の中身も変わる')
        await V.reload(); await V.wait_for_timeout(2000)
        ok('高松市の別会場' in (await V.locator('#where').text_content()), '参加者画面に直した場所が出る')

        # 4. 覇王戦を記録する
        await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(300)
        await A.click('#hoNew'); await A.wait_for_timeout(300)
        n = await A.locator('#hoEnt input:checked').count()
        ok(n == 20, '記録の画面で、出場資格の20人に最初からチェック（%d）' % n)
        await A.fill('#hoDate', '2026-11-28'); await A.select_option('#hoKing', label='ナオキックス'); await A.click('#hoSave'); await A.wait_for_timeout(3000)
        hh = docs().get(R + '/hist/haoh_2') or {}
        ok(hh.get('no') == 2 and hh.get('date') == '2026-11-28' and len(hh.get('entrants', [])) == 20 and hh.get('name') == 'ナオキックス', '第2回 覇王戦（覇王ナオキックス・出場20人）を記録')
        el = json.loads(await A.evaluate("JSON.stringify(window.__tk.haohEligible())"))
        ok(el['nextNo'] == 3 and len(el['list']) == 0, '次（第3回）の出場資格は、11/28以降の優勝がまだないので0人')
        await A.click('[data-ho="2"]'); await A.wait_for_timeout(300); await A.fill('#hoDate', '2026-11-21'); await A.click('#hoSave'); await A.wait_for_timeout(3000)
        el = json.loads(await A.evaluate("JSON.stringify(window.__tk.haohEligible())"))
        ok(docs()[R + '/hist/haoh_2']['date'] == '2026-11-21' and [e['name'] for e in el['list']] == sorted(['マルック', 'kenji'], key=lambda x: (x != 'kenji', x)) or set(e['name'] for e in el['list']) == {'マルック', 'kenji'}, '日付を11/21に直すと、その日の覇者（マルック・kenji）が次の出場資格に入る')

        # 5. バックアップ（フォルダへ保存）と、締めたときの自動保存
        await A.evaluate("""()=>{window.__saved={};window.__n=0;window.__tk.BK.dir={name:'NAS',queryPermission:async()=>'granted',requestPermission:async()=>'granted',
          getFileHandle:async(n)=>({createWritable:async()=>({write:async(t)=>{window.__saved[n]=t;window.__n++},close:async()=>{}})})};}""")
        await A.click('#bkSave'); await A.wait_for_timeout(3000)
        saved = json.loads(await A.evaluate("JSON.stringify(Object.keys(window.__saved))"))
        msg = await A.locator('#bkMsg').text_content()
        ok(len(saved) == 1 and saved[0].startswith('tsukiichi_') and 'NAS' in msg, 'フォルダにバックアップを保存：' + msg)
        bk = json.loads(await A.evaluate("Object.values(window.__saved)[0]"))
        ok(bk['counts']['roster'] == 33 and bk['counts']['hist'] == 52 and any('/conf/info' in k for k in bk['docs']), 'バックアップの中身：名簿33・記録52（覇王戦2つ含む）・案内')
        await A.click('.nb[data-ph=set]'); await A.click('#evNew'); await A.wait_for_timeout(300); await A.click('#evYes'); await A.wait_for_timeout(2500)
        await A.wait_for_timeout(5000)
        n2 = await A.evaluate("window.__n")
        ok(n2 == 2, '回を締めると自動でもう一度保存（保存した回数 %d）' % n2)

        # 6. ファイルとして保存（フォルダを選べない端末）→ 空のサーバーに戻す
        await A.evaluate("()=>{window.__tk.BK.dir=null}")
        await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(300)
        async with A.expect_download() as dl: await A.click('#bkSave')
        d = await dl.value; path = '/tmp/v17_backup.json'; await d.save_as(path)
        ok(json.load(open(path))['counts']['roster'] == 33, 'フォルダを選べない端末は、ファイルとして保存')
        get('/reset'); await ca.close(); ca, A = await mk(b, '3台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(300)
        await A.evaluate("document.querySelector('#bkBox details').open=true")
        await A.set_input_files('#bkFile', path); await A.wait_for_timeout(800)
        ok(await A.locator('#bkRestoreGo').is_visible(), '戻すものの件数が出る：' + await A.locator('#bkMsg').text_content())
        await A.click('#bkRestoreGo'); await A.wait_for_timeout(3500)
        ok(len(roster()) == 33 and len(hist()) == 50 and len(hist('haoh')) == 2, '空のサーバーに、名簿33人・記録50件・覇王戦2件が戻る（%d・%d・%d）' % (len(roster()), len(hist()), len(hist('haoh'))))

        for theme in ['light', 'dark']:
            await A.emulate_media(color_scheme=theme); await A.evaluate("document.documentElement.dataset.theme='%s'" % theme)
            await A.locator('#hoBox').screenshot(path='/tmp/v17_haoh_%s.png' % theme)
            await A.locator('#bkBox').screenshot(path='/tmp/v17_bk_%s.png' % theme)
        ok(await A.evaluate("document.documentElement.scrollWidth") <= 375, '記録タブが横にはみ出さない')
        ok(not errs, 'ページのエラーなし ' + str(errs[:3]))
        await b.close()
    print('合計', sum(res), '/', len(res))
asyncio.run(main())
