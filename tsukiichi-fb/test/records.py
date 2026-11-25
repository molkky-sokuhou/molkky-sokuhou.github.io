import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file://'+__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','admin','index.html')); SRV='http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV+p).read()
def docs(): return json.loads(get('/state'))['docs']
def roster(id): return [v for k,v in docs().items() if k.endswith('/roster/'+id)][0]
def hist(): return {k.split('/')[-1]:v for k,v in docs().items() if '/hist/' in k}
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('OK ' if c else 'NG ')+l)
async def mk(b,name,theme='light'):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}');localStorage.setItem('mk_view_theme','{theme}')")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx,pg
async def stats(pg,name):
    return await pg.evaluate("""(n)=>{const t=window.__tk,r=t.S.roster.find(x=>!x.mergedInto&&x.name===n);if(!r)return null;const s=t.personStats(false)[r.id]||{n:0,win:0,top3:0};return [s.n,s.win,s.top3]}""",name)
async def person(pg,name):
    await pg.evaluate("()=>{document.getElementById('ov').hidden=true}")
    await pg.click('.nb[data-ph=rec]'); await pg.fill('#recQ',''); await pg.wait_for_timeout(200)
    await pg.locator('#recList [data-pp]',has_text=name).first.click(); await pg.wait_for_timeout(200)
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目','dark')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.click('#seedBtn'); await A.wait_for_timeout(1500); await A.click('#seedHist'); await A.wait_for_timeout(2500)
        ok(len(hist())==48,'架空の過去の記録 3大会×16人')
        ok(await stats(A,'はると')==[2,0,0] or (await stats(A,'はると'))[0]==2,'まとめる前：はると 参加2回 '+str(await stats(A,'はると')))
        ok((await stats(A,'ハルト'))[0]==1,'まとめる前：ハルト（間違えて登録）参加1回')
        # 受付の名簿は参加回数の多い順・回数つき
        await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(300)
        first=(await A.locator('#rList .rc span').first.inner_text()).replace('\n',' ')
        ok('参加3回' in first,'受付の名簿は参加回数の多い順で「参加○回」が出る（先頭：'+first+'）')
        # まとめる：はると ← ハルト（同じ日の記録なし）
        await person(A,'はると')
        await A.select_option('#mgWith',label='ハルト'); await A.wait_for_timeout(200)
        ok(await A.locator('#mgMore .warnline').count()==0,'同じ日の記録がないときは注意を出さない')
        await A.click('#mgGo'); await A.wait_for_timeout(500)
        ok(not roster('r90').get('mergedInto'),'まとめるは1回目では送らない')
        await A.click('#mgGo'); await A.wait_for_timeout(2500)
        r=roster('r90'); ok(r.get('mergedInto')=='r01' and r.get('keepNameBefore')=='はると','2回目でハルトをはるとにまとめる')
        ok(await stats(A,'はると')==[3,(await stats(A,'はると'))[1],(await stats(A,'はると'))[2]] and await stats(A,'ハルト') is None,'まとめたあと：はると 参加3回（自動で数え直し）、ハルトは一覧から消える')
        await B.click('.nb[data-ph=rec]'); await B.fill('#recQ','ハルト'); await B.wait_for_timeout(500)
        t=await B.inner_text('#recList'); ok('はると' in t and 'まとめた人：ハルト' in t,'もう1台でも「ハルト」で探すと、まとめ先のはるとが出る')
        await B.screenshot(path='rec_list_dark.png',full_page=True)
        # 元に戻す（名前は変えていないので名前を戻す欄は出ない）
        await person(A,'はると'); await A.screenshot(path='rec_person.png',full_page=True)
        await A.click('[data-um="r90"]'); await A.click('[data-um="r90"]'); await A.wait_for_timeout(2500)
        ok(not roster('r90').get('mergedInto') and (await stats(A,'はると'))[0]==2 and (await stats(A,'ハルト'))[0]==1,'元に戻すと、はると2回・ハルト1回に戻る')
        # 名前を選んでまとめる→名前も戻す
        await person(A,'ハルト'); await A.select_option('#mgWith',label='はると'); await A.wait_for_timeout(200)
        await A.check('input[name=mgName][value=new]'); await A.fill('#mgNew','はると（H）'); await A.click('#mgGo'); await A.click('#mgGo'); await A.wait_for_timeout(2500)
        ok(roster('r90').get('name')=='はると（H）' and roster('r01').get('mergedInto')=='r90','ほかの名前を選んでまとめられる（残す名前「はると（H）」）')
        await person(A,'はると（H）')
        ok(await A.locator('[data-rn="r01"]').count()==1,'元に戻すとき「名前をハルトに戻す」を選べる')
        await A.click('[data-um="r01"]'); await A.click('[data-um="r01"]'); await A.wait_for_timeout(2500)
        ok(roster('r90').get('name')=='ハルト' and not roster('r01').get('mergedInto'),'元に戻すと名前も「ハルト」に戻る')
        # 同じ日の記録がある2人：注意を出すが、まとめられる
        mate=await A.evaluate("()=>{const t=window.__tk,h=t.histRows();const d=new Set(h.filter(x=>x.pid==='r01').map(x=>x.date));const o=h.find(x=>x.pid!=='r01'&&x.pid!=='r90'&&d.has(x.date));return [o.pid,t.S.roster.find(r=>r.id===o.pid).name]}")
        await person(A,'はると'); await A.select_option('#mgWith',label=mate[1]); await A.wait_for_timeout(200)
        w=await A.locator('#mgMore .warnline').inner_text() if await A.locator('#mgMore .warnline').count() else ''
        ok('同じ日の大会に両方の記録' in w,'同じ日の記録がある2人は注意を出す：'+w[:40])
        await A.click('#mgGo'); await A.click('#mgGo'); await A.wait_for_timeout(2500)
        ok(roster(mate[0]).get('mergedInto')=='r01','注意が出ても、運営の判断でまとめられる（'+mate[1]+'）')
        await person(A,'はると'); um=[await x.get_attribute('data-um') for x in await A.locator('[data-um]').all()]
        for u in um: await A.click('[data-um="%s"]'%u); await A.click('[data-um="%s"]'%u); await A.wait_for_timeout(2000)
        # 分ける：りく の記録のうち1件を新しい人へ→既存の人へ戻す
        before=(await stats(A,'りく'))[0]
        await person(A,'りく'); await A.locator('[data-hr]').first.check()
        await A.select_option('#spTo','_new'); await A.fill('#spNew','りく（別人）'); await A.click('#spGo'); await A.click('#spGo'); await A.wait_for_timeout(2500)
        ok((await stats(A,'りく'))[0]==before-1 and (await stats(A,'りく（別人）'))[0]==1,'記録を分ける：りく '+str(before)+'回→'+str(before-1)+'回、新しい「りく（別人）」1回')
        moved=[v for v in hist().values() if v.get('movedFrom')]; ok(len(moved)==1,'移した記録には、元の持ち主が残る（movedFrom）')
        await person(A,'りく（別人）'); await A.locator('[data-hr]').first.check(); await A.select_option('#spTo',label='りく'); await A.click('#spGo'); await A.click('#spGo'); await A.wait_for_timeout(2500)
        ok((await stats(A,'りく'))[0]==before and (await stats(A,'りく（別人）'))[0]==0,'分けた記録を、元の人へ戻せる')
        # いまの回に受付済みのハルトを、受付していないはるとにまとめる
        await A.click('.nb[data-ph=entry]'); await A.fill('#eq','ハルト'); await A.wait_for_timeout(200)
        await A.locator('#rList .rc span',has_text='ハルト').click(); await A.click('#qAdd'); await A.wait_for_timeout(2500)
        await person(A,'はると'); await A.select_option('#mgWith',label='ハルト'); await A.click('#mgGo'); await A.click('#mgGo'); await A.wait_for_timeout(2500)
        names=await A.evaluate("window.__tk.people().map(p=>p.name)")
        ok('はると' in names and 'ハルト' not in names and len(names)==1,'受付済みの人をまとめると、受付もまとめ先の人になる '+str(names))
        # 締め：受付→抽選→結果→新しい回
        await A.click('.nb[data-ph=entry]'); n=await A.locator('#rList .rc span').count()
        for i in range(min(n,11)): await A.locator('#rList .rc span').nth(i).click()
        await A.click('#qAdd'); await A.wait_for_timeout(3000)
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300); await A.click('#tmDraw'); await A.wait_for_timeout(300); await A.click('#tmSave'); await A.wait_for_timeout(300); await A.click('#rvClose'); await A.wait_for_timeout(2500)
        await A.click('.nb[data-ph=game]'); await A.wait_for_timeout(300)
        ids=[await A.locator('#gBody .mt').nth(i).get_attribute('data-m') for i in range(2)]
        for i,mid in enumerate(ids):
            await A.click('[data-m="%s"]'%mid); await A.fill('#sc_a',str(60+i)); await A.fill('#sc_b','40'); await A.click('#scSave'); await A.wait_for_timeout(1500)
        await A.wait_for_timeout(1500); n0=len(hist()); before=(await stats(A,'はると'))[0]
        await A.click('.nb[data-ph=set]'); await A.click('#evNew'); await A.wait_for_timeout(300)
        sm=await A.inner_text('#sheet'); ok('12人の参加の記録を残します' in sm and '1位' in sm,'締める前に、残す記録の人数と1位が出る：'+[l for l in sm.split('\n') if '記録を残します' in l][0][:60])
        await A.click('#evYes'); await A.wait_for_timeout(3000)
        ok(len(hist())==n0+12,'新しい回を始めると、前の回の12人の記録が残る')
        e_old=[v for k,v in docs().items() if k.count('/')==3 and '/events/' in k and v.get('status')=='closed'][0]
        ok(e_old.get('final') and e_old['final']['standings'][0]['rank']==1,'締めた回に順位（final）が残る')
        ok((await stats(A,'はると'))[0]==before+1,'締めた回の参加が、はるとの参加回数に加わる（'+str(before)+'→'+str(before+1)+'回）')
        # 結果なしで締める
        await A.click('#evNew'); await A.wait_for_timeout(300)
        ok('結果が1件もないので' in await A.inner_text('#sheet'),'結果がない回は「記録は作りません」と出る')
        n1=len(hist()); await A.click('#evYes'); await A.wait_for_timeout(3000)
        ok(len(hist())==n1,'結果がない回を締めても、記録は増えない')
        print('   sw',await A.evaluate('document.documentElement.scrollWidth'),await B.evaluate('document.documentElement.scrollWidth'))
        ok(not await A.evaluate('window.__tk.rejected().length'),'届かなかった操作はない')
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
