# 版21：チャッピーのレビュー（版17〜20）の指摘①〜⑬の再現
import asyncio, json, os, time, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); SRV = 'http://localhost:8765'
R = 'staff/proto'
def get(p): return urllib.request.urlopen(SRV + p).read()
def docs(): return json.loads(get('/state'))['docs']
def commit(writes): return json.loads(urllib.request.urlopen(urllib.request.Request(SRV + '/commit', data=json.dumps({'writes': writes}).encode(), method='POST')).read())
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
async def mk(b, name):
    ctx = await b.new_context(viewport={'width': 375, 'height': 800}, accept_downloads=True)
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';window.__SYS_GATE=1;localStorage.setItem('tk_devName','{name}')")
    pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx, pg
async def closeov(pg): await pg.evaluate("()=>{document.getElementById('ov').hidden=true}")
async def checkin(pg, names):
    await closeov(pg); await pg.click('.nb[data-ph=entry]')
    for n in names:
        await pg.fill('#eq', n); await pg.wait_for_timeout(120); await pg.locator('#rList .rc span', has_text=n).first.click()
    await pg.fill('#eq', ''); await pg.click('#qAdd'); await pg.wait_for_timeout(2500)
async def unlock(pg, pw='7788'):
    await pg.click('.nb[data-ph=sys]'); await pg.wait_for_timeout(500)
    if await pg.locator('#sysPw2F').is_visible(): await pg.fill('#sysPw', pw); await pg.fill('#sysPw2', pw)
    else: await pg.fill('#sysPw', pw)
    await pg.click('#sysGo'); await pg.wait_for_timeout(1200)

async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ca, A = await mk(b, '1台目'); cb, B = await mk(b, '2台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await unlock(A)
        ok(await A.locator('#sysBody').is_visible(), 'パスワードを決めて入る')
        r = commit([{'op': 'set', 'path': R + '/conf/sysCheck', 'data': {'key': 'x' * 64}}])
        ok(not r['ok'], '④ 違うハッシュではパスワードの確かめが通らない（ルール）')
        await A.click('#seedBtn'); await A.wait_for_timeout(1500)
        await A.fill('#impExp', 'てつ・マルック'); await A.click('#impGo'); await A.click('#impGo'); await A.wait_for_timeout(3500)
        await checkin(A, ['ゆい', 'そうた', 'めい', 'あおい', 'マルック', 'てつ'])
        await unlock(B)

        # ④ 片付けの時間は16分まで。取り込んだ記録は片付けの間でも消せない
        key = docs()[R + '/conf/sysKey']['hash']
        now = int(time.time() * 1000)
        ok(not commit([{'op': 'set', 'path': R + '/conf/cleanup', 'data': {'until': now + 86400000, 'key': key}}])['ok'], '④ 1日先までの片付けの時間は書けない')
        ok(commit([{'op': 'set', 'path': R + '/conf/cleanup', 'data': {'until': now + 600000, 'key': key}}])['ok'], '④ パスワードを知っていれば10分の片付けは始められる')
        hid = [k for k, v in docs().items() if '/hist/imp-' in k][0]
        ok(not commit([{'op': 'delete', 'path': hid}])['ok'], '④ 片付けの間でも、取り込んだ記録は消せない')
        rid0 = [k for k, v in docs().items() if '/roster/' in k and v.get('createdIn') == 'sheet'][0]
        ok(not commit([{'op': 'delete', 'path': rid0}])['ok'], '④ 片付けの間でも、取り込んだ名簿の人は消せない')
        commit([{'op': 'set', 'path': R + '/conf/cleanup', 'data': {'until': 0}}])

        # ① 調べたあとに新しい回が始まったら、片付けは止まる
        await A.click('.nb[data-ph=sys]'); await A.wait_for_timeout(300); await A.click('#clScan'); await A.wait_for_timeout(300)
        ok(await A.locator('#clList [data-cl]:checked').count() == 0, '③ 最初はどれにもチェックが入っていない')
        await A.check('[data-cl="ck"]')
        await closeov(B); await B.click('.nb[data-ph=set]'); await B.click('#evNew'); await B.wait_for_timeout(300); await B.click('#evYes'); await B.wait_for_timeout(2500)
        if await B.locator('#evYes').is_visible(): await B.click('#evYes'); await B.wait_for_timeout(2500)
        await checkin(B, ['ゆい', 'マルック'])
        await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.click('#clGo'); await A.click('#clGo'); await A.wait_for_timeout(2500)
        cur = docs()[R]['currentEvent']
        cks = [k for k in docs() if k.startswith(R + '/events/' + cur + '/checkins/')]
        ok(len(cks) == 2 and '新しい回' in await A.locator('#clMsg').text_content(), '① 新しい回の受付2人は消えず、理由が出る')

        # ① 同じ回でも、調べたあとに結果が入ったら止まる
        await A.click('#clScan'); await A.wait_for_timeout(300); await A.check('[data-cl="ck"]')
        commit([{'op': 'update', 'path': R + '/events/' + cur, 'data': {'rev': 'zz1', 'mt.x.ta': 50}}])
        await A.click('#clGo'); await A.click('#clGo'); await A.wait_for_timeout(2500)
        cks = [k for k in docs() if k.startswith(R + '/events/' + cur + '/checkins/')]
        ok(len(cks) == 2 and '変わった' in await A.locator('#clMsg').text_content(), '① 調べたあとに結果が入ったら、受付は消さない')
        # ② 片付けで受付を消すと、回の rev が変わる（締めの計算と食い違えば締めが断られる）
        await A.wait_for_timeout(1200); await A.click('#clScan'); await A.wait_for_timeout(300); await A.check('[data-cl="ck"]')
        rev0 = docs()[R + '/events/' + cur].get('rev')
        await A.click('#clGo'); await A.click('#clGo'); await A.wait_for_timeout(2500)
        cks = [k for k in docs() if k.startswith(R + '/events/' + cur + '/checkins/')]
        ok(not cks and docs()[R + '/events/' + cur].get('rev') != rev0, '② 受付を消すと、回の rev も変わる')
        ok(not commit([{'op': 'update', 'path': R + '/events/' + cur, 'data': {'status': 'closed', 'closeRev': rev0}}])['ok'], '② 消す前の rev で締めようとすると断られる')

        # ③⑧ 覇王戦：直しても取り込み元（sheet）のまま。2台が同じ回を新しく記録しても上書きしない
        await closeov(A); await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(300)
        await A.evaluate("document.querySelector('[data-ho=\"1\"]').click()"); await A.wait_for_timeout(300); await A.click('#hoSave'); await A.wait_for_timeout(2000)
        ok(docs()[R + '/hist/haoh_1'].get('src') == 'sheet' and docs()[R + '/hist/haoh_1'].get('ver'), '③ 取り込んだ覇王戦を直しても、取り込み元のまま（片付けの対象にならない）')
        await closeov(B); await B.click('.nb[data-ph=rec]'); await B.wait_for_timeout(300)
        await closeov(A); await A.click('#hoNew'); await A.wait_for_timeout(300); await B.click('#hoNew'); await B.wait_for_timeout(300)
        await A.select_option('#hoKing', index=1); await B.select_option('#hoKing', index=2)
        await A.click('#hoSave'); await B.click('#hoSave'); await A.wait_for_timeout(3000)
        h2 = docs().get(R + '/hist/haoh_2') or {}
        rjB = await B.evaluate("JSON.stringify(window.__tk.rejected().map(o=>o.items[0].name))")
        ok(h2.get('ver') and '覇王戦' in rjB, '⑧ 同じ回をあとから記録した方は断られ、届かなかった操作に残る ' + rjB)

        # ⑨ 取り込んだ記録の持ち主を直したあとでも、取り込みは止まらない
        imp = [(k, v) for k, v in docs().items() if '/hist/imp-' in k][0]
        commit([{'op': 'update', 'path': imp[0], 'data': {'rid': 'r05', 'movedFrom': imp[1]['rid'], 'movedAt': 1, 'mv': 1}}])
        await A.wait_for_timeout(1500); await A.click('.nb[data-ph=sys]'); await A.wait_for_timeout(500)
        t = await A.locator('#impSum').text_content()
        ok('すべて取り込み済み' in t, '⑨ 持ち主を直した記録があっても「すべて取り込み済み」 ' + t[-30:])

        # ⑦ 同じ名前の人が2人いる名前は取り込まない
        get('/reset'); await ca.close(); ca, A = await mk(b, '3台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        commit([{'op': 'set', 'path': R + '/roster/x1', 'data': {'name': 'コトリン', 'norm': 'ことりん'}}, {'op': 'set', 'path': R + '/roster/x2', 'data': {'name': 'コトリン', 'norm': 'ことりん'}}])
        await A.wait_for_timeout(1500); await unlock(A); await A.wait_for_timeout(500)
        t = await A.locator('#impSum').text_content()
        ok('コトリン さんの分は取り込みません' in t, '⑦ 同じ名前が2人いる人は取り込まないと出る')
        await A.click('#impGo'); await A.click('#impGo'); await A.wait_for_timeout(3500)
        ok(not any(v.get('rid') in ('x1', 'x2') for k, v in docs().items() if '/hist/' in k), '⑦ どちらのコトリンさんにも成績は付かない')

        # ⑫ 案内は直した欄だけ保存（ほかの端末が直した会場を戻さない）
        await A.click('.nb[data-ph=set]'); await A.wait_for_timeout(300)
        commit([{'op': 'merge', 'path': R + '/conf/info', 'data': {'場所': 'Bが直した会場'}}])
        await A.fill('#if_お知らせ', 'Aが直したお知らせ'); await A.click('#infoSave'); await A.wait_for_timeout(2000)
        info = docs()[R + '/conf/info']
        ok(info.get('場所') == 'Bが直した会場' and info.get('お知らせ') == 'Aが直したお知らせ', '⑫ 直した欄だけ保存し、ほかの端末が直した会場はそのまま')

        # ⑬ 同じ分に2回保存しても、別のファイルになる
        await A.click('.nb[data-ph=rec]'); await A.wait_for_timeout(300)
        await A.evaluate("""()=>{window.__saved={};window.__tk.BK.dir={name:'NAS',queryPermission:async()=>'granted',requestPermission:async()=>'granted',
          getFileHandle:async(n)=>({createWritable:async()=>({write:async(t)=>{window.__saved[n]=t},close:async()=>{}})})};}""")
        await A.click('#bkSave'); await A.wait_for_timeout(1500); await A.evaluate("window.__tk.saveBackup(true)"); await A.wait_for_timeout(1500)
        names = json.loads(await A.evaluate("JSON.stringify(Object.keys(window.__saved))"))
        ok(len(names) == 2 and any('締め' in n for n in names), '⑬ 手動と締めの保存が別のファイルになる ' + str(names))

        # ⑤ 戻すのを途中で止めても、もう一度押すとまとめまで戻る
        bk = json.loads(list(json.loads(await A.evaluate("JSON.stringify(window.__saved)")).values())[0])
        ids = [k.split('/')[-1] for k in bk['docs'] if '/roster/' in k][:2]
        bk['docs'][R + '/roster/' + ids[1]]['mergedInto'] = ids[0]
        open('/tmp/v21_bk.json', 'w').write(json.dumps(bk))
        get('/reset'); await ca.close(); ca, A = await mk(b, '4台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        commit([{'op': 'set', 'path': R + '/roster/' + i, 'data': {**{k: v for k, v in bk['docs'][R + '/roster/' + i].items() if k != 'mergedInto'}, 'restoredAt': 1, **({'restoreMerge': ids[0]} if i == ids[1] else {})}} for i in ids])  # 版23：途中で止まった復元には restoreMerge が付いている
        await A.wait_for_timeout(1500); await A.click('.nb[data-ph=rec]'); await A.evaluate("document.querySelector('#bkBox details').open=true")
        await A.set_input_files('#bkFile', '/tmp/v21_bk.json'); await A.wait_for_timeout(1000)
        await A.click('#bkRestoreGo'); await A.wait_for_timeout(3000)
        ok(docs()[R + '/roster/' + ids[1]].get('mergedInto') == ids[0], '⑤ 途中で止まった復元を続けると、まとめ（mergedInto）も戻る')
        # ⑥ 復元の画面を開いたあとに別の端末が作った人は、書き換えない
        get('/reset'); await ca.close(); ca, A = await mk(b, '5台目')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=rec]'); await A.evaluate("document.querySelector('#bkBox details').open=true")
        await A.set_input_files('#bkFile', '/tmp/v21_bk.json'); await A.wait_for_timeout(1000)
        commit([{'op': 'set', 'path': R + '/roster/' + ids[0], 'data': {'name': 'Bが作った名前'}}])
        await A.click('#bkRestoreGo'); await A.wait_for_timeout(3000)
        ok(docs()[R + '/roster/' + ids[0]].get('name') == 'Bが作った名前', '⑥ 開いたあとに別の端末が作った人は、古い内容で書き換えない')

        ok(not errs, 'ページのエラーなし ' + str(errs[:3]))
        await b.close()
    print('合計', sum(res), '/', len(res))
asyncio.run(main())
