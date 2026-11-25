import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file://'+__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','admin','index.html')); SRV='http://localhost:8765'
def get(path): return urllib.request.urlopen(SRV+path).read()
def server(): return json.loads(get('/state'))
def open_events(): return [k for k,v in server()['docs'].items() if k.count('/')==3 and '/events/' in k and v.get('status')=='open']
errs=[]; res=[]
def ok(c,label): res.append(c); print(('OK ' if c else 'NG ')+label); return c
async def mk(b,name,fake=True):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script((f"if(location.search.indexOf('nofake')<0)window.__FAKE_URL='{SRV}';" if fake else '')+f"try{{localStorage.setItem('tk_devName','{name}')}}catch(e){{}}")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(name+': '+str(e)))
    await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx,pg
async def st(pg):
    return await pg.evaluate("""()=>{const t=window.__tk;return {mode:t.S.mode,cur:t.S.cur,people:t.people().map(p=>p.name).sort(),ops:t.S.ops.length,rej:t.rejected().map(o=>o.items.map(i=>i.name).join('/')),
      box:(document.getElementById('statusBox').innerText||'').replace(/\\n/g,' | ')}}""")
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目')
        # ③ 2台が同時に「最初の回を始める」
        await A.click('#evGate [data-newev]'); await B.click('#evGate [data-newev]')
        get('/slow?ms=400')
        await asyncio.gather(A.click('#evYes'),B.click('#evYes'))
        await A.wait_for_timeout(4000); get('/slow?ms=0'); await B.wait_for_timeout(1500)
        oe=open_events(); sa,sb=await st(A),await st(B)
        ok(len(oe)==1 and sa['cur']==sb['cur']==oe[0].split('/')[-1],'③ 同時に始めても開いている回は1つ、2台とも同じ回を表示 '+str(oe))
        # ③ 確認画面を開いている間に他端末が回を変えた
        await A.click('.nb[data-ph=set]'); await A.click('#evNew'); await A.wait_for_timeout(200)
        await B.click('.nb[data-ph=set]'); await B.click('#evNew'); await B.click('#evYes'); await B.wait_for_timeout(2500); await A.wait_for_timeout(1000)
        sheet_closed=await A.is_hidden('#ov'); sa,sb=await st(A),await st(B)
        ok(sheet_closed and sa['cur']==sb['cur'] and len(open_events())==1,'③ 確認画面の間に他端末が回を変えたら、開始を止めて新しい回を表示')
        # 古い画面のまま押した場合（画面の更新が届く前）：サーバー側で断られる
        await ca.set_offline(True); await A.wait_for_timeout(1200)
        await A.click('#evNew'); await A.wait_for_timeout(100)
        dis=await A.get_attribute('#evYes','disabled')
        ok(dis is not None,'③ サーバーで確認できていない間は「始める」を押せない')
        await A.click('#evNo'); await ca.set_offline(False); await A.wait_for_timeout(2000)
        # オンラインで取消した直後の表示順（端末の人数が先に減り、サーバー確認人数は届いてから）
        await A.click('.nb[data-ph=sys]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(1500)
        for n in ['はると','ゆい','そうた']:
            await A.fill('#eq',n); await A.locator('#rList .rc span',has_text=n).first.click()
        await A.fill('#eq',''); await A.click('#qAdd'); await A.wait_for_timeout(2500)
        get('/slow?ms=1500')
        await A.locator('#plist .prow',has_text='はると').first.click(); await A.click('#cxYes'); await A.click('#cxYes'); await A.wait_for_timeout(300)
        s1=(await st(A))['box']
        await A.wait_for_timeout(2500); get('/slow?ms=0'); await A.wait_for_timeout(1000)
        s2=(await st(A))['box']
        ok('この端末の表示 2人・送信待ち 1件' in s1 and '最後にサーバーで確認できた受付 3人' in s1,'取消直後：端末の表示2人・送信待ち1件、サーバー確認は3人のまま')
        ok('この端末の表示 2人・送信待ち 0件' in s2 and '最後にサーバーで確認できた受付 2人' in s2 and 'いまの表示と同じ' in s2,'届いたあと：サーバー確認も2人（いまの表示と同じ）')
        print('     直後:',s1[:150]); print('     あと:',s2[:150])
        # ② 練習モードではルールを表示・コピーしない
        await A.click('.nb[data-ph=sys]')
        ok(await A.is_hidden('#rulesBody') and '本番の運営モード' in await A.inner_text('#rulesNote'),'② 練習・試験ではルールの全文を出さない')
        # ① 本番（ここでは自動試験の保存先）で拒否された受付を残し、練習モードに入る
        await ca.set_offline(True); await A.wait_for_timeout(1200)
        await A.click('.nb[data-ph=entry]')
        await A.fill('#eq','めい'); await A.locator('#rList .rc span',has_text='めい').first.click(); await A.fill('#eq',''); await A.click('#qAdd'); await A.wait_for_timeout(300)
        await B.click('.nb[data-ph=set]'); await B.click('#evNew'); await B.click('#evYes'); await B.wait_for_timeout(2000)
        await ca.set_offline(False); await A.wait_for_timeout(5000)
        sa=await st(A); ok(sa['rej']==['めい'],'① 本番側に拒否された受付（めい）が残る '+str(sa['rej']))
        await A.close()
        pg=await ca.new_page()
        pg.on('pageerror',lambda e:errs.append('practice: '+str(e)))
        await pg.goto(URL+'?nofake'); await pg.wait_for_timeout(1000)
        await pg.click('#demoBtn'); await pg.wait_for_timeout(1500)
        sp=await st(pg); txt=await pg.inner_text('body')
        ok(sp['mode']=='demo' and sp['ops']==0 and not sp['rej'] and 'めい' not in await pg.inner_text('#rjBox') and await pg.is_hidden('#rjBox'),'① 練習モードには本番の失敗記録も名前も出ない')
        # 練習で記録を作って消す
        await pg.click('#evGate [data-newev]'); await pg.click('#evYes'); await pg.wait_for_timeout(1500)
        await pg.click('.nb[data-ph=sys]'); await pg.click('#seedBtn'); await pg.click('.nb[data-ph=entry]'); await pg.wait_for_timeout(1500)
        await pg.fill('#eq','ゆい'); await pg.locator('#rList .rc span',has_text='ゆい').first.click(); await pg.fill('#eq',''); await pg.click('#qAdd'); await pg.wait_for_timeout(2500)
        await pg.click('.nb[data-ph=sys]'); await pg.click('#wipeBtn'); await pg.wait_for_timeout(2500)
        if await pg.is_visible('#wpYes'): await pg.click('#wpYes'); await pg.wait_for_timeout(3000)
        ok('消しました' in await pg.inner_text('#lockErr'),'① 練習モードで消去できる：'+await pg.inner_text('#lockErr'))
        await pg.close()
        A=await ca.new_page(); A.on('pageerror',lambda e:errs.append('A2: '+str(e))); await A.goto(URL); await A.wait_for_timeout(3000)
        sa=await st(A); ok(sa['mode']=='test' and sa['rej']==['めい'],'① 練習で消しても本番側の記録（めい）は残る '+str(sa['rej'])+' mode='+str(sa['mode']))
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
