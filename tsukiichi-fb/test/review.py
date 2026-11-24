import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file://'+__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','admin','index.html')); SRV='http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV+p).read()
def docs(): return json.loads(get('/state'))['docs']
def roster(id): return [v for k,v in docs().items() if k.endswith('/roster/'+id)][0]
def hist(): return {k.split('/')[-1]:v for k,v in docs().items() if '/hist/' in k}
def cur_ev():
    d=docs(); box=[v for k,v in d.items() if k.startswith('staff/') and k.count('/')==1][0]; return box['currentEvent'], d['staff/test/events/'+box['currentEvent']] if 'staff/test/events/'+box['currentEvent'] in d else [v for k,v in d.items() if k.endswith('/events/'+box['currentEvent'])][0]
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('OK ' if c else 'NG ')+l)
async def mk(b,name,theme='light'):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}');localStorage.setItem('mk_view_theme','{theme}')")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx,pg
async def closeov(pg): await pg.evaluate("()=>{document.getElementById('ov').hidden=true}")
async def person(pg,name):
    await closeov(pg); await pg.click('.nb[data-ph=rec]'); await pg.fill('#recQ',''); await pg.wait_for_timeout(200)
    await pg.locator('#recList [data-pp]',has_text=name).first.click(); await pg.wait_for_timeout(200)
async def checkin(pg,names):
    await closeov(pg); await pg.click('.nb[data-ph=entry]')
    for n in names:
        await pg.fill('#eq',n); await pg.wait_for_timeout(150); await pg.locator('#rList .rc span',has_text=n).first.click()
    await pg.fill('#eq',''); await pg.click('#qAdd'); await pg.wait_for_timeout(2500)
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目','dark')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.wait_for_timeout(1500); await A.click('#seedHist'); await A.wait_for_timeout(2500)
        # ⑧ 同じ日の2件は、読み込み順で数が変わらない
        r=await A.evaluate("""()=>{const t=window.__tk,keep=t.S.hist;const rows=[{id:'x1',rid:'r05',date:'2026-07-01',rank:1},{id:'x2',rid:'r05',date:'2026-07-01',rank:4}];
          t.S.hist=rows;const a=t.personStats(false).r05;t.S.hist=rows.slice().reverse();const b=t.personStats(false).r05;t.S.hist=keep;return [[a.n,a.win,a.top3,a.dup.length],[b.n,b.win,b.top3,b.dup.length]]}""")
        ok(r[0]==r[1]==[1,1,1,1],'⑧ 同じ日の「1位と4位」は、どちらの順で読んでも 参加1・優勝1・3位以内1、要確認1件 '+str(r))
        # ⑤ 抽選のあとにまとめても、チーム・早帰り・目印を引き継ぎ、記録から漏れない
        await checkin(A,['ハルト','ゆい','そうた','めい','あおい','けんた','ひな','りく'])
        await A.locator('#plist [data-c]',has_text='ハルト').click(); await A.locator('label.switch:has(#cf_early)').click(); await A.fill('#cf_pair','Z'); await A.click('#cfSave'); await A.wait_for_timeout(2000)
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300)
        # 目印Zが1人だけ → 普通に抽選される
        await A.click('#tmDraw'); await A.wait_for_timeout(300); await A.click('#tmSave'); await A.wait_for_timeout(300); await closeov(A); await A.wait_for_timeout(2500)
        team_h=await A.evaluate("window.__tk.people().find(p=>p.name==='ハルト').team")
        await A.click('.nb[data-ph=game]'); await A.wait_for_timeout(300)
        mid=await A.locator('#gBody .mt').first.get_attribute('data-m'); await A.click('[data-m="%s"]'%mid); await A.fill('#sc_a','50'); await A.fill('#sc_b','30'); await A.click('#scSave'); await A.wait_for_timeout(2000)
        await person(A,'はると'); await A.select_option('#mgWith',label='ハルト'); await A.wait_for_timeout(200); await A.click('#mgGo'); await A.click('#mgGo'); await A.wait_for_timeout(2500)
        pp=await A.evaluate("JSON.stringify(window.__tk.people().filter(p=>p.name==='はると'||p.name==='ハルト').map(p=>[p.name,p.team,p.early,p.pair]))")
        ok(json.loads(pp)==[['はると',team_h,True,'Z']],'⑤ 抽選・得点のあとに「ハルト」を「はると」にまとめても、チーム'+chr(64+team_h)+'・早帰り・目印Zを引き継ぐ '+pp)
        eid,e=cur_ev(); ok(e['assign'].get('r01')==team_h and not e['assign'].get('r90'),'⑤ 所属もまとめ先（はると）の番号で保存される')
        c=await A.evaluate("JSON.stringify(window.__tk.closingData(window.__tk.S.cur))"); c=json.loads(c)
        ok(any(h['data']['name']=='はると' for h in c['hist']) and c['n']==len(c['hist']) and not c['missing'],'⑤ 締めたときの記録に、はるとが入る（受付'+str(c['n'])+'人＝記録'+str(len(c['hist']))+'人）')
        # 2人とも受付済みで別々のチーム → 残すチームを選ぶ
        await checkin(A,['いつき','ゆか'])
        await A.locator('#plist [data-c]',has_text='いつき').click(); await A.select_option('#cf_team','1'); await A.click('#cfSave'); await A.wait_for_timeout(1500)
        await A.locator('#plist [data-c]',has_text='ゆか').click(); await A.select_option('#cf_team','2'); await A.click('#cfSave'); await A.wait_for_timeout(1500)
        await person(A,'いつき'); await A.select_option('#mgWith',label='ゆか'); await A.wait_for_timeout(200)
        ok(await A.locator('#mgTeam').count()==1,'⑤ 2人とも別々のチームに入っているときは、残すチームを選ぶ欄が出る')
        await A.select_option('#mgTeam','2'); await A.click('#mgGo'); await A.click('#mgGo'); await A.wait_for_timeout(2500)
        pp=json.loads(await A.evaluate("JSON.stringify(window.__tk.people().filter(p=>['いつき','ゆか'].includes(p.name)).map(p=>[p.name,p.team]))"))
        ok(pp==[['いつき',2]],'⑤ 選んだチーム（B）に1人として残る '+str(pp))
        # ④ 古い「元に戻す」が、その後の別のまとめを外さない
        await person(A,'はると'); await A.click('[data-um="r90"]')   # 1台目：1回目だけ押して止まる（画面は古いまま）
        await person(B,'はると'); await B.click('[data-um="r90"]'); await B.click('[data-um="r90"]'); await B.wait_for_timeout(2500)
        await person(B,'ゆい'); await B.select_option('#mgWith',label='ハルト'); await B.wait_for_timeout(200); await B.click('#mgGo'); await B.click('#mgGo'); await B.wait_for_timeout(2500)
        ok(roster('r90').get('mergedInto')=='r02','④ 2台目：元に戻してから、ハルトをゆいにまとめた')
        await A.click('[data-um="r90"]'); await A.wait_for_timeout(3000)
        ok(roster('r90').get('mergedInto')=='r02','④ 1台目の古い「元に戻す」は断られ、新しいまとめ（ゆい）は外れない')
        rj=await A.evaluate("JSON.stringify(window.__tk.rejected().map(o=>o.items[0].name))")
        tt=await A.evaluate("document.getElementById('toast').textContent")
        ok('ハルト' in rj or 'まとめが変わっていました' in tt,'④ 1台目では、古い「元に戻す」は送らずに知らせる（送っていれば「届かなかった操作」に名前つきで残る） '+rj+' '+tt)
        await A.evaluate("()=>window.__tk.rejected().forEach(o=>{o.state='done'})")
        # ⑦ 同じ記録を2台で別々の人へ移す → あとの方は断られる
        await person(A,'りく'); await A.locator('[data-hr]').first.check(); await A.select_option('#spTo',label='そうた'); await A.click('#spGo')
        hid=await A.locator('[data-hr]').first.get_attribute('data-hr')
        await person(B,'りく'); await B.locator('[data-hr="%s"]'%hid).check(); await B.select_option('#spTo',label='めい'); await B.click('#spGo'); await B.click('#spGo'); await B.wait_for_timeout(2500)
        await A.click('#spGo'); await A.wait_for_timeout(3000)
        h=hist()[hid]; meirid=[k.split('/')[-1] for k,v in docs().items() if '/roster/' in k and v.get('name')=='めい'][0]
        ok(h['rid']==meirid,'⑦ 先に届いた移動（めいへ）が残り、古い持ち主のつもりの移動（そうたへ）は断られる')
        ok(await A.evaluate("window.__tk.rejected().length")>=1,'⑦ 断られた移動は1台目に残る')
        # 2度押しの途中で移す先を変えたら1回目に戻る
        await person(A,'けんた'); await A.locator('[data-hr]').first.check(); await A.select_option('#spTo',label='そうた'); await A.click('#spGo')
        await A.select_option('#spTo',label='めい'); ok(await A.inner_text('#spGo')=='記録を移す','⑦ 2度押しの途中で移す先を変えると、確認は1回目に戻る')
        await closeov(A)
        # ⑥ 結果を入れると回の更新番号が変わり、ふつうに締められる
        r0=cur_ev()[1].get('rev')
        await A.click('.nb[data-ph=game]'); await A.click('#gFilter [data-f=all]'); await A.wait_for_timeout(300)
        await A.click('[data-m="%s"]'%mid); await A.fill('#sc_a','45'); await A.click('#scSave'); await A.wait_for_timeout(2000)
        ok(cur_ev()[1].get('rev') and cur_ev()[1].get('rev')!=r0,'⑥ 得点を直すと、回の更新番号（rev）が変わる')
        n0=len(hist()); await A.click('.nb[data-ph=set]'); await A.click('#evNew'); await A.wait_for_timeout(300)
        sm=await A.inner_text('#sheet'); ok('受付 ' in sm and '記録 ' in sm,'⑥ 締める画面に「受付○人／記録○人」が出る')
        await A.click('#evYes'); await A.wait_for_timeout(3000)
        old=[v for k,v in docs().items() if k.count('/')==3 and '/events/' in k and v.get('status')=='closed'][0]
        ok(old.get('closeRev')==old.get('rev') and len(hist())>n0,'⑥ 最新の更新番号で締めたので通り、記録が残る')
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
