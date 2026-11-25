import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file://'+__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','admin','index.html')); SRV='http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV+p).read()
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('OK ' if c else 'NG ')+l)
PA=['ゆい','そうた','めい','あおい']; PB=['けんた','えま']; OUT=['そら','かい']
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':375,'height':800})
        await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','1台目')")
        A=await ctx.new_page(); A.on('pageerror',lambda e:errs.append(str(e))); await A.goto(URL); await A.wait_for_timeout(1500)
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        n=await A.locator('#rList .rc span').count()
        for i in range(n):
            sp=A.locator('#rList .rc span').nth(i)
            if (await sp.inner_text()).split('\n')[0] not in OUT: await sp.click()
        await A.click('#qAdd'); await A.wait_for_timeout(3500); await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(500)
        for nm,mk in [(x,'A') for x in PA]+[(x,'B') for x in PB]:
            inp=A.locator('#tmPeople li', has_text=nm).locator('input[data-pair]')
            await inp.click(); await A.keyboard.type(mk); await A.keyboard.press('Tab'); await A.wait_for_timeout(150)
        await A.locator('#tmTarget').click(); await A.wait_for_timeout(2500)
        marks=await A.inner_text('#tmMarks'); print('   '+marks.replace('\n',' | '))
        ok(await A.locator('[data-open]').count()==1,'チェックは2人の目印「B」にだけ出る（4人の「A」には出ない）')
        async def draw(T):
            await A.click(f'[data-tc="{T}"]'); await A.click('#tmDraw'); await A.wait_for_timeout(400)
            return await A.evaluate("window.__tk.T.preview.map(t=>({name:t.name,fixed:t.fixed,mark:t.mark,m:t.members.map(x=>x.name)}))")
        # チェックなし：Bの2人だけで1チーム
        opts=await A.evaluate("[...document.querySelectorAll('[data-tc]')].map(b=>+b.dataset.tc)"); print('   チェックなし 選べる:',opts,await A.inner_text('.tm-sizes'))
        pv=await draw(6)
        tb=[t for t in pv if 'けんた' in t['m']][0]
        ok(sorted(tb['m'])==sorted(PB),'チェックなし：Bの2人だけで1チーム '+str(tb['m']))
        await A.click('#tmCancel')
        # チェックあり：Bの2人は一緒、ほかの人も入る
        await A.click('#tmMarks .switch'); await A.wait_for_timeout(2500)
        opts=await A.evaluate("[...document.querySelectorAll('[data-tc]')].map(b=>+b.dataset.tc)"); sz=await A.inner_text('.tm-sizes'); mk=await A.inner_text('#tmMarks'); print('   チェックあり 選べる:',opts,sz); ok('ほかの人と同じチーム' in sz and 'ほかの人で人数をそろえます' in mk,'チェックすると説明と内訳がすぐ変わる')
        bad=0
        for k in range(30):
            pv=await draw(6)
            tb=[t for t in pv if 'けんた' in t['m']][0]; ta=[t for t in pv if 'ゆい' in t['m']][0]
            names=[x for t in pv for x in t['m']]
            good = 'えま' in tb['m'] and 3<=len(tb['m'])<=4 and sorted(ta['m'])==sorted(PA) and len(names)==22==len(set(names)) and len(pv)==6
            if not good: bad+=1
            if k==0: print('    例:',' / '.join(t['name']+':'+'・'.join(t['m']) for t in sorted(pv,key=lambda x:x['name'])))
            await A.click('#tmCancel')
        ok(bad==0,'チェックあり：30回とも、Bの2人は同じチームでほかに1〜2人入り、Aの4人は4人だけ、22人重複なし、6チーム（不合格'+str(bad)+'回）')
        chk=await A.evaluate("(()=>{const t=window.__tk;const ps=t.drawPeople();const o=t.teamOptions(ps).out.find(x=>x.T===6);let bad=0;for(let i=0;i<200;i++){const r=t.drawTeams(ps,o);if(t.checkTeams(r,ps).some(c=>!c[0]))bad++;}return bad})()")
        ok(chk==0,'200回抽選してすべて画面の点検に合格')
        pv=await draw(6); print('   点検:', (await A.inner_text('#tmChecks')).replace('\n',' | '))
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
