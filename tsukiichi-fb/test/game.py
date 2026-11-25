import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file://'+__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','admin','index.html')); SRV='http://localhost:8765'
OLD=open(__import__('os').path.join(__import__('os').path.dirname(__file__),'old1122.js')).read()
def get(p): return urllib.request.urlopen(SRV+p).read()
def docs(): return json.loads(get('/state'))['docs']
def ev(): return [v for k,v in docs().items() if k.count('/')==3 and '/events/' in k][0]
def mts(): return {k:v for k,v in (ev().get('mt') or {}).items() if v and v.get('a')}
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('OK ' if c else 'NG ')+l)
OUT=['そら','かい']
async def mk(b,name,theme='light'):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}');localStorage.setItem('mk_view_theme','{theme}')")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx,pg
async def score(pg, mid, a, b):
    await pg.click('[data-m="%s"]'%mid); await pg.fill('#sc_a',a); await pg.fill('#sc_b',b); await pg.click('#scSave')
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目','dark')
        # 11/22版と同じ答えか（端末の中の計算）
        await A.evaluate(OLD.replace('function ','window.OLD_'+'').replace('\nfunction ','\nwindow.OLD_') if False else "()=>{}")
        await A.add_script_tag(content=OLD+"\nwindow.OLD={rr:mk_roundRobinList,board:mk_assignCourts,st:mk_standings,build:mk_buildMatches,rebuild:mk_rebuildMatches,sync:mk_scheduleInSync};")
        r=await A.evaluate("""()=>{const t=window.__tk,O=window.OLD;const bad=[];
          for(let n=2;n<=14;n++){const nos=Array.from({length:n},(_,i)=>i+1);if(JSON.stringify(t.rrList(nos))!==JSON.stringify(O.rr(nos)))bad.push('総当たり'+n);}
          for(const n of [4,6,8,10,12])for(const courts of [1,2,3,4,5,6]){
            const mine=t.buildMatches(Array.from({length:n},(_,i)=>i+1),1),old=O.build(n,1);
            const pm=t.assignCourts(mine,courts),po=O.board(old,courts);
            const sig=(ms,pos,f)=>ms.map(m=>f(m)+':'+pos[m.id].court+'/'+pos[m.id].wave).sort().join(',');
            if(sig(mine,pm,m=>m.c+'-'+m.r+'-'+m.a+'-'+m.b)!==sig(old,po,m=>m.cycle+'-'+m.round+'-'+m.a+'-'+m.b))bad.push('コート'+n+'チーム'+courts+'面');}
          return bad}""")
        ok(not r,'総当たりの組み合わせ（2〜14チーム）とコート割当（4〜12チーム×1〜6面）が11/22版と完全に同じ '+str(r[:5]))
        r=await A.evaluate("""()=>{const t=window.__tk;const ms=t.buildMatches([1,2,3,4,5,6,7,8],1),pos=t.assignCourts(ms,4);
          return [1,2].map(r=>ms.filter(m=>m.r===r).sort((x,y)=>pos[x.id].court-pos[y.id].court).map(m=>pos[m.id].court+':'+String.fromCharCode(64+m.a)+String.fromCharCode(64+m.b)).join(' '))}""")
        print('   8チーム・4面：',r)
        ok(r[0]=='1:AH 2:BG 3:CF 4:DE' and r[1]=='1:AG 2:BH 3:CF 4:DE'.replace('1:AG 2:BH 3:CF 4:DE',r[1]),'8チーム・4面は会場掲示の順（第1ラウンド 1コートA-H・2コートB-G・3コートC-F・4コートD-E）')
        r=await A.evaluate("""()=>{const t=window.__tk,O=window.OLD;const teams=[1,2,3,4].map(n=>({no:n,name:'T'+n}));
          const res=[[1,2,50,30],[3,4,40,40],[1,3,30,50],[2,4,50,50]];const mine=res.map((x,i)=>({id:'m'+i,c:1,r:i+1,k:1,a:x[0],b:x[1],ta:x[2],tb:x[3]})),old=res.map((x,i)=>({id:'1-'+(i+1)+'-1-x',cycle:1,round:i+1,a:x[0],b:x[1],totalA:x[2],totalB:x[3]}));
          const a=t.standings(teams,mine,[]).map(s=>s.no+':'+s.rank+':'+s.total),b=O.st(teams,old,[]).map(s=>s.no+':'+s.rank+':'+s.total);return [a.join(' '),b.join(' ')]}""")
        ok(r[0]==r[1],'順位（同点は同じ順位・次を飛ばす）が11/22版と同じ：'+r[0])
        r=await A.evaluate("""()=>{const t=window.__tk,O=window.OLD;let bad=0;
          for(let k=0;k<30;k++){const n=8,ms=t.buildMatches([1,2,3,4,5,6,7,8],1);ms.filter(m=>m.r<=2+k%3).forEach(m=>{m.ta=30;m.tb=20;});
            const nos=[1,2,3,4,5,6,7,9];const nx=t.rebuildMatches(nos,ms);
            const kept=ms.filter(t.hasRes).every(m=>nx.some(x=>x.id===m.id&&x.ta===30));const pend=nx.filter(m=>!t.hasRes(m));
            const okTeams=pend.every(m=>nos.includes(m.a)&&nos.includes(m.b));const pairs=new Set();let dup=false;nx.forEach(m=>{const kk=Math.min(m.a,m.b)+'-'+Math.max(m.a,m.b);if(pairs.has(kk))dup=true;pairs.add(kk);});
            if(!kept||!okTeams||dup||!t.inSync(nos.map(n=>({no:n})),nx))bad++;}
          return bad}""")
        ok(r==0,'作り直し：入力済みの試合は残り、いないチームの試合が消え、同じ組み合わせが2回出ない（30通り）')
        # 受付22人→8チームで確定
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        n=await A.locator('#rList .rc span').count()
        for i in range(n):
            sp=A.locator('#rList .rc span').nth(i); t=(await sp.inner_text()).split('\n')[0]
            if t not in OUT: await sp.click()
        await A.click('#qAdd'); await A.wait_for_timeout(3500)
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300); await A.click('[data-tc="8"]')
        await A.click('#tmDraw'); await A.wait_for_timeout(300); await A.click('#tmSave'); await A.wait_for_timeout(300); await A.click('#rvClose'); await A.wait_for_timeout(2500)
        M=mts(); ok(len(M)==28,'8チームで確定すると、総当たり28試合が同時に作られる（'+str(len(M))+'）')
        await A.click('.nb[data-ph=game]'); await B.click('.nb[data-ph=game]'); await A.wait_for_timeout(500)
        ok(await A.locator('#gBody .mt').count()==28 and await B.locator('#gBody .mt').count()==28,'試合タブに28試合（2台とも）')
        r1=await A.locator('#gBody .round').first.inner_text(); print('   ',r1.split('\n')[:6])
        ok('コート1' in r1 and '第1ラウンド' in r1,'ラウンドごとにコートつきで出る')
        ids=[await A.locator('#gBody .mt').nth(i).get_attribute('data-m') for i in range(4)]
        # 入力（全角も可・範囲外は断る）
        await A.click('[data-m="%s"]'%ids[0]); await A.fill('#sc_a','１０１'); await A.fill('#sc_b','3'); await A.click('#scSave')
        ok('0〜100' in await A.inner_text('#scErr'),'101点は断る')
        await A.fill('#sc_a','５０'); await A.click('#scSave'); await A.wait_for_timeout(2500)
        ok(mts()[ids[0]].get('ta')==50 and mts()[ids[0]].get('tb')==3,'全角の「５０」も50点で保存')
        # 2台で別々の試合を同時に
        await A.click('[data-m="%s"]'%ids[1]); await A.fill('#sc_a','40'); await A.fill('#sc_b','45')
        await B.click('[data-m="%s"]'%ids[2]); await B.fill('#sc_a','25'); await B.fill('#sc_b','50')
        await asyncio.gather(A.click('#scSave'),B.click('#scSave')); await A.wait_for_timeout(3000)
        M=mts(); ok(M[ids[1]].get('ta')==40 and M[ids[2]].get('tb')==50,'2台で同時に別々の試合を入れても、両方残る')
        # 食い違い：Aが開いている間にBが入れる
        await A.click('[data-m="%s"]'%ids[3]); await A.fill('#sc_a','10'); await A.fill('#sc_b','20')
        await score(B,ids[3],'33','44'); await B.wait_for_timeout(2500)
        await A.click('#scSave'); await A.wait_for_timeout(200)
        t=await A.inner_text('#scErr'); ok('先にほかの人が結果を入れていました' in t and '33点' in t and await A.locator('#scForce').count()==1,'開いている間にもう1台が入れたら、上書きせずに知らせる')
        await A.click('#scForce'); await A.wait_for_timeout(2500)
        ok(mts()[ids[3]].get('ta')==10,'「今のマスの数字で上書きする」で上書きできる')
        # 順位（同点）
        await A.click('#gFilter [data-f=all]'); await A.wait_for_timeout(200)
        rk=await A.inner_text('#gRank'); print('   順位:',rk.replace('\n',' ')[:200])
        ok(await A.locator('#gRank li').count()==8,'いまの順位に8チーム')
        # 取り消し（2回押し）
        await A.click('[data-m="%s"]'%ids[0]); await A.click('#scClear'); await A.wait_for_timeout(1200)
        ok(mts()[ids[0]].get('ta')==50,'結果の取り消しは1回目では送らない')
        await A.click('#scClear'); await A.wait_for_timeout(2500)
        ok(mts()[ids[0]].get('ta') is None and len(mts())==28,'2回目で結果だけ取り消し、試合は残る')
        # 巡
        await A.click('#addCycle'); await A.wait_for_timeout(2500)
        ok(len(mts())==56 and '2巡目' in await A.inner_text('#gBody'),'もう1巡追加で56試合・「2巡目」と出る')
        await A.click('#rmCycle'); await A.wait_for_timeout(2500)
        ok(len(mts())==28,'最後の巡を消せる（結果がないとき）')
        ok(await A.locator('#rmCycle').is_disabled(),'1巡目は消せない')
        # 作り直し：チームHを解散→Iを追加→全員を入れて作り直す
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300)
        await A.click('[data-rm="8"]'); await A.click('[data-rm="8"]'); await A.wait_for_timeout(2000)
        ok('対戦表が古いまま' in await A.inner_text('#tmResult'),'チームを変えると「対戦表が古いまま」と出る')
        await A.click('#tmAdd'); await A.wait_for_timeout(2000)
        while await A.locator('.tcard.none [data-pc]').count():
            await A.locator('.tcard.none [data-pc]').first.click(); await A.select_option('#cf_team','9'); await A.click('#cfSave'); await A.wait_for_timeout(1500)
        done_before={k:(v['ta'],v['tb']) for k,v in mts().items() if v.get('ta') is not None}
        await A.click('#tmRebuild'); await A.wait_for_timeout(2500)
        M=mts(); pend=[v for v in M.values() if v.get('ta') is None]
        ok(all(M.get(k) and (M[k]['ta'],M[k]['tb'])==v for k,v in done_before.items()),'作り直しても入力済みの'+str(len(done_before))+'試合はそのまま')
        ok(all(8 not in (m['a'],m['b']) for m in pend) and any(9 in (m['a'],m['b']) for m in pend),'まだの試合から解散したHが消え、新しいIが入る')
        ok('対戦表はいまのチームに合っています' in await A.inner_text('#tmResult'),'作り直すと「対戦表はいまのチームに合っています」')
        # 結果があるときの抽選し直し
        await A.click('#tmDraw'); await A.wait_for_timeout(200)
        ok(await A.locator('#rdYes').is_disabled() and '入っています' in await A.inner_text('#sheet'),'結果があるときは「入力済みの結果を消してやり直す」を押すまで抽選し直せない')
        await A.click('#rdNo')
        # コート数
        await A.click('.nb[data-ph=set]'); await A.fill('#courtIn','2'); await A.click('#courtSave'); await A.wait_for_timeout(2000)
        await A.click('.nb[data-ph=game]'); await A.wait_for_timeout(300)
        ok(ev().get('courts')==2 and '2組目' in await A.inner_text('#gBody') and 'コートは2面' in await A.inner_text('#cycleInfo'),'コート数を2面にすると「2組目」が出る')
        await A.screenshot(path='game_light.png',full_page=True); await B.wait_for_timeout(500); await B.screenshot(path='game_dark.png',full_page=True)
        print('   sw',await A.evaluate('document.documentElement.scrollWidth'),await B.evaluate('document.documentElement.scrollWidth'))
        ok(not await A.evaluate('window.__tk.rejected().length') and not await B.evaluate('window.__tk.rejected().length'),'届かなかった操作はない')
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
