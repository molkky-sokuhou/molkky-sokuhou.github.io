import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file://'+__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','index.html')); SRV='http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV+p).read()
def server(): return json.loads(get('/state'))['docs']
def byname(kind,name):
    for k,v in server().items():
        if ('/'+kind+'/') in k and v.get('name')==name: return v
    return {}
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('OK ' if c else 'NG ')+l)
async def mk(b,name,theme='light',fs='m'):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}');localStorage.setItem('mk_view_theme','{theme}');localStorage.setItem('mk_view_fs','{fs}')")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx,pg
sw=lambda pg,i: pg.locator('label.switch:has(#'+i+')')
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目','dark','xl')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        # はじめての人：初心者＋早帰り＋目印
        await A.fill('#eq','たなか ゆう'); await A.wait_for_timeout(200)
        await sw(A,'pBeg').click(); await sw(A,'pEarly').click(); await A.fill('#pPair','Z')
        await A.click('#newAdd'); await A.wait_for_timeout(2500)
        r=byname('roster','たなか ゆう'); c=byname('checkins','たなか ゆう')
        ok(r.get('beg') is True and not r.get('exp') and 'early' not in r and 'pair' not in r,'はじめての人：初心者は名簿に（早帰り・目印は名簿に入れない） '+str({k:r.get(k) for k in ('exp','beg','level')}))
        ok(c.get('early') is True and c.get('pair')=='Z','はじめての人：早帰り・目印はこの回の受付に '+str({k:c.get(k) for k in ('early','pair')}))
        # はじめての人：経験豊富＋評価8（初心者を押してから経験豊富を押すと初心者が外れる）
        await A.fill('#eq','やまもと けん'); await A.wait_for_timeout(200)
        ok(await A.locator('#pLvBox').is_hidden(),'経験豊富を押すまで評価は出ない')
        await sw(A,'pBeg').click(); await sw(A,'pExp').click()
        ok(not await A.locator('#pBeg').is_checked() and await A.locator('#pLvBox').is_visible(),'経験豊富にすると初心者が外れ、評価が出る')
        await A.select_option('#pLv','8'); await A.click('#newAdd'); await A.wait_for_timeout(2500)
        r=byname('roster','やまもと けん')
        ok(r.get('exp') is True and r.get('level')==8 and not r.get('beg'),'経験豊富・評価8で名簿に入る '+str({k:r.get(k) for k in ('exp','beg','level')}))
        ok(not await A.locator('#pExp').is_checked() and await A.locator('#pLvBox').is_hidden(),'受付のあと、印は元に戻る')
        # 名簿の人：チェックして印を付けてから受付
        names=[ (await A.locator('#rList .rc span').nth(i).inner_text()).split('\n') for i in range(await A.locator('#rList .rc span').count())]
        plain=[n[0] for n in names if n[1]=='名簿']; expn=[n[0] for n in names if n[1]=='経験豊富']
        p1,p2,p3=plain[0],plain[1],plain[2]; e1=expn[0]
        print('   選んだ人:',p1,p2,p3,'経験豊富:',e1)
        for nm in (p1,p2,p3,e1): await A.locator('#rList .rc span',has_text=nm).first.click()
        ok(await A.locator('#selBox').is_visible() and await A.locator('#selList li').count()==4,'チェックした4人の印の欄が出る')
        ok(await A.locator('#selList li',has_text=e1).locator('[data-sf=exp]').get_attribute('aria-pressed')=='true','名簿で経験豊富の人は、最初から経験豊富が付いている')
        await A.locator('#selList li',has_text=p1).locator('[data-sf=beg]').click()
        await A.locator('#selList li',has_text=p2).locator('[data-sf=early]').click()
        inp=A.locator('#selList li',has_text=p2).locator('input'); await inp.click(); await A.keyboard.type('Q')
        await A.locator('#selList li',has_text=p3).locator('[data-sf=exp]').click()
        await A.locator('#selList li',has_text=p3).locator('select').select_option('7')
        ok(await inp.input_value()=='Q','描き直しても目印の入力が消えない')
        await A.screenshot(path='flags_sel.png',full_page=True)
        print('   sw',await A.evaluate('document.documentElement.scrollWidth'))
        await A.click('#qAdd'); await A.wait_for_timeout(3000)
        ok(byname('roster',p1).get('beg') is True,'チェックした人：初心者が名簿に入る（'+p1+'）')
        c2=byname('checkins',p2); ok(c2.get('early') is True and c2.get('pair')=='Q','チェックした人：早帰り・目印Qがこの回の受付に（'+p2+'）')
        r3=byname('roster',p3); ok(r3.get('exp') is True and r3.get('level')==7,'チェックした人：経験豊富・評価7が名簿に（'+p3+'）')
        ok(not await A.evaluate("window.__tk.rejected().length"),'届かなかった操作はない')
        ok(await A.locator('#selBox').is_hidden(),'受付のあと印の欄は閉じる')
        t2=await A.locator('#plist li',has_text=p2).inner_text(); t1=await A.locator('#plist li',has_text=p1).inner_text()
        ok('早帰り' in t2 and '目印 Q' in t2 and '初心者' in t1,'受付済みの一覧に 初心者・早帰り・目印 が出る')
        # 受付済みの人を押して印を直す
        await A.locator('#plist [data-c]',has_text=p1).click(); await A.wait_for_timeout(200)
        ok(await A.locator('#cf_beg').is_checked() and await A.locator('#cfLvBox').is_hidden(),'押すと今の印が入った編集画面が出る')
        await A.screenshot(path='flags_sheet.png')
        await sw(A,'cf_exp').click()
        ok(not await A.locator('#cf_beg').is_checked(),'経験豊富にすると初心者が外れる')
        await A.select_option('#cf_level','9'); await sw(A,'cf_early').click(); await A.fill('#cf_pair','W')
        await A.click('#cfSave'); await A.wait_for_timeout(2500)
        r1=byname('roster',p1); c1=byname('checkins',p1)
        ok(r1.get('exp') is True and r1.get('level')==9 and r1.get('beg') is False,'名簿：経験豊富・評価9・初心者なしに変わる '+str({k:r1.get(k) for k in ('exp','beg','level')}))
        ok(c1.get('early') is True and c1.get('pair')=='W','受付：早帰り・目印Wに変わる')
        await B.wait_for_timeout(1000)
        tb=await B.locator('#plist li',has_text=p1).inner_text()
        ok('経験豊富' in tb and '早帰り' in tb and '目印 W' in tb,'もう1台の一覧にも反映される')
        # 変更なし
        await A.locator('#plist [data-c]',has_text=p1).click(); await A.click('#cfSave'); await A.wait_for_timeout(300)
        ok('変更はありませんでした' in await A.inner_text('#toast'),'何も変えずに保存すると「変更はありませんでした」')
        n0=len([k for k in server() if '/ops/' in k])
        await A.wait_for_timeout(500); ok(len([k for k in server() if '/ops/' in k])==n0,'変更なしのときは書き込まない')
        # 抽選の材料
        dp=await A.evaluate("JSON.stringify(window.__tk.drawPeople().filter(p=>['%s','%s','たなか ゆう'].includes(p.name)).map(p=>[p.name,p.exp,p.level,p.beg,p.early,p.pair]))"%(p1,p2))
        print('   抽選の材料:',dp)
        d=json.loads(dp); m={x[0]:x for x in d}
        ok(m[p1][1:]==[True,9,False,True,'W'] and m[p2][4:]==[True,'Q'] and m['たなか ゆう'][3:]==[True,True,'Z'],'抽選の材料に名簿の印と、この回の早帰り・目印が入る')
        # チームタブから初心者・早帰りを切り替え（2台目）
        await B.click('.nb[data-ph=team]'); await B.wait_for_timeout(800)
        row=B.locator('#tmPeople li',has_text=p2)
        await row.locator('[data-beg]').click(); await B.wait_for_timeout(1500)
        await B.locator('#tmPeople li',has_text=p2).locator('[data-early]').click(); await B.wait_for_timeout(2000)
        x=await A.evaluate("JSON.stringify(window.__tk.drawPeople().find(p=>p.name==='%s'))"%p2); x=json.loads(x)
        ok(x['beg'] is True and x['early'] is False,'チームタブ（もう1台）で初心者オン・早帰りオフ → この端末にも反映')
        await B.screenshot(path='flags_team_dark.png',full_page=True)
        # 初心者を多めにして抽選の偏りを見る
        stat=await A.evaluate("""()=>{const t=window.__tk;const ps=Array.from({length:22},(_,i)=>{const exp=i%4===0;return {id:'x'+i,rawId:'x'+i,name:'人'+i,exp,level:exp?1+(i*7)%10:0,beg:!exp&&i%3===1,early:!exp&&i%5===2,pair:''}});
          const o=t.teamOptions(ps).out; const opt=o.find(x=>x.T===6)||o[0]; let bad=0,bspread=0,early2=0;
          for(let i=0;i<200;i++){const r=t.drawTeams(ps,opt,{});if(t.checkTeams(r,ps,{}).some(c=>!c[0]))bad++;
            const bg=r.map(x=>x.members.filter(m=>m.beg).length);bspread=Math.max(bspread,Math.max(...bg)-Math.min(...bg));
            early2+=r.filter(x=>x.members.filter(m=>m.early).length>1).length;}
          return {n:ps.length,T:opt.T,beg:ps.filter(p=>p.beg).length,early:ps.filter(p=>p.early).length,bad,bspread,early2}}""")
        print('   ',stat)
        ok(stat['bad']==0 and stat['bspread']<=1,'初心者を多めにしても200回すべて点検合格・初心者の差は1人以内')
        # 取り消しも残っている
        await A.locator('#plist [data-c]',has_text=p3).click(); await A.click('#cxYes'); await A.wait_for_timeout(2500)
        ok(not byname('checkins',p3),'編集画面から受付の取り消しもできる')
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
