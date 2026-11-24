import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file:///home/claude/tsukiichi-fb/index.html'; SRV='http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV+p).read()
def server(): return json.loads(get('/state'))
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('OK ' if c else 'NG ')+l)
PAIR=['ゆい','そうた','めい','あおい']; OUT=['そら','かい']
async def mk(b,name,theme='light',fs='m'):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}');localStorage.setItem('mk_view_theme','{theme}');localStorage.setItem('mk_view_fs','{fs}')")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx,pg
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目','dark','xl')
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        n=await A.locator('#rList .rc span').count()
        for i in range(n):
            sp=A.locator('#rList .rc span').nth(i); t=(await sp.inner_text()).split('\n')[0]
            if t not in OUT: await sp.click()
        await A.click('#qAdd'); await A.wait_for_timeout(3500)
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(500)
        await A.evaluate("""()=>{const ul=document.getElementById('tmPeople');new MutationObserver(()=>{(window.__mut=window.__mut||[]).push(document.activeElement.tagName+':'+(document.activeElement.dataset.pair||'')+' '+(new Error().stack||'').split('\\n').slice(1,3).join('|'))}).observe(ul,{childList:true});}""")
        for nm in PAIR:
            inp=A.locator('#tmPeople li', has_text=nm).locator('input[data-pair]')
            await inp.click(); await A.keyboard.type('A'); await A.keyboard.press('Tab'); await A.wait_for_timeout(150)
        print('   mut:', await A.evaluate("JSON.stringify(window.__mut)"))
        await A.locator('#tmTarget').click(); await A.wait_for_timeout(3000)
        print('   ops:', await A.evaluate("JSON.stringify(window.__tk.S.ops.filter(o=>o.type==='edit').map(o=>[o.items[0].name,o.state,o.reason||'']))"))
        print('   server pairs:', {v['name']:v.get('pair') for k,v in server()['docs'].items() if '/checkins/' in k and v.get('pair')})
        print('   対象:', await A.inner_text('#tmTarget'))
        opts=await A.evaluate("[...document.querySelectorAll('[data-tc]')].map(b=>+b.dataset.tc)")
        sel=await A.evaluate("+document.querySelector('[data-tc][aria-pressed=true]').dataset.tc")
        print('   選べるチーム数:',opts,' はじめの選択:',sel,' 内訳:',await A.inner_text('.tm-sizes'))
        ok(7 in opts,'7チームを選べる')
        await A.click('[data-tc="7"]'); await A.wait_for_timeout(100)
        await A.click('#tmDraw'); await A.wait_for_timeout(500)
        prev=await A.evaluate("window.__tk.T.preview.map(t=>({name:t.name,fixed:t.fixed,m:t.members.map(x=>({n:x.name,e:x.exp,l:x.level}))}))")
        allnames=[m['n'] for t in prev for m in t['m']]
        ok(len(prev)==7,'7チームに分かれた')
        ok(len(allnames)==22 and len(set(allnames))==22 and not set(OUT)&set(allnames),'22人全員が重複なく入っている（受付していない2人は入らない）')
        fixed=[t for t in prev if t['fixed']]
        ok(len(fixed)==1 and sorted(m['n'] for m in fixed[0]['m'])==sorted(PAIR),'希望の4人だけで1チーム（'+(fixed[0]['name'] if fixed else '?')+'）')
        normal=[t for t in prev if not t['fixed']]
        ok(len(normal)==6 and all(len(t['m'])==3 for t in normal),'残り18人が3人ずつ6チーム')
        ok(all(sum(1 for m in t['m'] if m['e'])==1 for t in normal),'経験豊富は各チーム1人ずつ')
        ok(sorted(t['name'] for t in prev)==list('ABCDEFG'),'チーム名の初期値は A〜G')
        checks=await A.inner_text('#tmChecks'); print('   画面の点検:\n     '+checks.replace('\n','\n     '))
        ok('✗' not in checks,'画面の点検はすべて ✓')
        for t in sorted(prev,key=lambda x:x['name']): print('    ',t['name'],('希望'+t['fixed']) if t['fixed'] else '','/'.join(m['n']+('★'+str(m['l']) if m['e'] else '') for m in t['m']))
        await A.screenshot(path='team_prev.png',full_page=True)
        # 何回も抽選して、毎回正しいかと、組み合わせが変わるか
        stat=await A.evaluate("""()=>{const t=window.__tk;const ps=t.drawPeople();const o=t.teamOptions(ps).out.find(x=>x.T===7);let bad=0,sigs=new Set();
          for(let i=0;i<200;i++){const r=t.drawTeams(ps,o);if(t.checkTeams(r,ps).some(c=>!c[0]))bad++;sigs.add(r.map(x=>x.members.map(m=>m.id).sort().join(',')).sort().join('|'));}
          return {bad,variety:sigs.size}}""")
        ok(stat['bad']==0,'200回抽選してすべて点検合格（不合格 '+str(stat['bad'])+'回）')
        ok(stat['variety']>150,'毎回ちがう組み合わせになる（200回で'+str(stat['variety'])+'通り）')
        # 保存してもう1台に出る
        await A.click('#tmSave'); await A.wait_for_timeout(3000)
        ev=[v for k,v in server()['docs'].items() if k.count('/')==3 and '/events/' in k][0]
        ok(len(ev.get('teams',[]))==7,'開催回に7チームが保存された')
        await B.click('.nb[data-ph=team]'); await B.wait_for_timeout(1500)
        ok('決まったチーム' in await B.inner_text('#tmResH') and await B.locator('#tmTeams .tcard').count()==7,'もう1台にも決まったチームが出る')
        await B.screenshot(path='team_saved_dark.png',full_page=True)
        print('   sw', await A.evaluate('document.documentElement.scrollWidth'), await B.evaluate('document.documentElement.scrollWidth'))
        # 経験豊富の評価を変えると、抽選の材料に反映される
        sel=B.locator('#tmPeople li',has_text='はると').locator('select')
        await sel.select_option('3'); await B.wait_for_timeout(2500)
        lv=await A.evaluate("window.__tk.drawPeople().find(p=>p.name==='はると').level")
        ok(lv==3,'もう1台で変えた評価（はると 9→3）がこの端末の抽選にも反映される')
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
