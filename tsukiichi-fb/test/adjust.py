import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file://'+__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','admin','index.html')); SRV='http://localhost:8765'
def get(p): return urllib.request.urlopen(SRV+p).read()
def docs(): return json.loads(get('/state'))['docs']
def ev(): return [v for k,v in docs().items() if k.count('/')==3 and '/events/' in k][0]
def byname(kind,name):
    for k,v in docs().items():
        if ('/'+kind+'/') in k and v.get('name')==name: return v
    return {}
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('OK ' if c else 'NG ')+l)
OUT=['そら','かい']
async def mk(b,name,theme='light'):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';localStorage.setItem('tk_devName','{name}');localStorage.setItem('mk_view_theme','{theme}')")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx,pg
def team_of(name):
    e=ev(); rid=[k.split('/')[-1] for k,v in docs().items() if '/roster/' in k and v.get('name')==name][0]
    return e.get('assign',{}).get(rid)
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目','dark')
        # 抽選の関数（端末の中だけ）：⑤⑥
        r=await A.evaluate("""()=>{const t=window.__tk;const P=(n,o)=>Object.assign({id:'x'+n,rawId:'x'+n,name:'人'+n,exp:false,level:0,beg:false,early:false,pair:''},o||{});
          const ps=[P(1,{pair:'A'}),P(2,{pair:'A'}),P(3,{pair:'B'}),P(4,{pair:'B'})];
          const o=t.teamOptions(ps,{}).out; const d=o[0]&&t.drawTeams(ps,o[0],{}); return {opts:o.map(x=>x.T),ok:d?t.checkTeams(d,ps,{}).every(c=>c[0]):false}}""")
        ok(r['opts']==[2] and r['ok'],'⑤ 全員が目印の組（A2人・B2人）でも2チームを選べて、点検も合格 '+str(r))
        r=await A.evaluate("""()=>{const t=window.__tk;let out={};
          for(const [n,T,E] of [[14,6,2],[22,8,3],[18,6,4]]){const ps=Array.from({length:n},(_,i)=>({id:'y'+i,rawId:'y'+i,name:'人'+i,exp:i%5===0,level:i%5===0?1+i%10:0,beg:i%5===2,early:i<E*3&&i%3===1,pair:''}));
            const o=t.teamOptions(ps,{}).out.find(x=>x.T===T);let bad=0;
            for(let k=0;k<200;k++){const d=t.drawTeams(ps,o,{});if(d.some(tm=>{const e=tm.members.filter(m=>m.early).length;return e&&tm.members.length-e===1}))bad++;}
            out[n+'人'+T+'チーム早帰り'+ps.filter(p=>p.early).length+'人']=bad;}
          return out}""")
        ok(all(v==0 for v in r.values()),'⑥ 早めに帰る人が抜けて1人になるチームを作らない（各200回）'+str(r))
        r=await A.evaluate("""()=>{const t=window.__tk;const ps=Array.from({length:8},(_,i)=>({id:'z'+i,rawId:'z'+i,name:'人'+i,exp:false,level:0,beg:false,early:i===0,pair:''}));
          const o=t.teamOptions(ps,{}).out.find(x=>x.T===4);const d=t.drawTeams(ps,o,{});return t.checkTeams(d,ps,{}).filter(c=>c[2]==='warn').map(c=>[c[0],c[1]])}""")
        ok(r and r[0][0] is False and '1人になる' in r[0][1],'⑥ 2人チームしか作れず避けられないときは警告を出す：'+r[0][1])
        # 受付22人
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        n=await A.locator('#rList .rc span').count()
        for i in range(n):
            sp=A.locator('#rList .rc span').nth(i); t=(await sp.inner_text()).split('\n')[0]
            if t not in OUT: await sp.click()
        await A.click('#qAdd'); await A.wait_for_timeout(3500)
        # ⑦ 抽選の表示中に、もう1台が目印を変える
        await A.click('.nb[data-ph=team]'); await B.click('.nb[data-ph=team]'); await A.wait_for_timeout(500)
        await A.click('#tmDraw'); await A.wait_for_timeout(400)
        ok(await A.locator('#tmSave').count()==1,'抽選の結果（保存前）が出る')
        inp=B.locator('#tmPeople li',has_text='ゆい').locator('input[data-pair]')
        await inp.click(); await B.keyboard.type('Q'); await B.keyboard.press('Tab'); await B.wait_for_timeout(2500)
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300)
        ok(await A.locator('#tmSave').count()==0 and '取り消しました' in await A.inner_text('#tmMsg'),'⑦ もう1台が目印を変えたら、表示中の結果は使えなくなる：'+(await A.inner_text('#tmMsg'))[:40])
        e0=ev(); ok(not e0.get('tm'),'⑦ 古い結果は保存されていない')
        inp=B.locator('#tmPeople li',has_text='ゆい').locator('input[data-pair]'); await inp.fill(''); await B.keyboard.press('Tab'); await B.wait_for_timeout(2500)
        # 抽選→確定→発表
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300)
        await A.click('#tmDraw'); await A.wait_for_timeout(400); await A.click('#tmSave'); await A.wait_for_timeout(300)
        ok(await A.locator('#rv').is_visible(),'確定すると発表が出る')
        await A.wait_for_timeout(900); n1=await A.locator('#rv li').count()
        await A.click('#rvAll'); n2=await A.locator('#rv li').count()
        ok(0<n1<22 and n2==22,'1人ずつ出て、「すぐに全部見る」で22人全員（途中 '+str(n1)+'人）')
        await A.screenshot(path='adj_reveal.png'); await A.click('#rvClose'); await A.wait_for_timeout(2500)
        e=ev(); ok(len(e.get('tm',{}))==6 and len(e.get('assign',{}))==22,'6チーム・22人の所属がサーバーに保存')
        ok(await B.locator('#tmTeams .tcard').count()==6 and '決まったチーム' in await B.inner_text('#tmResH'),'もう1台にも決まったチームが出る')
        # 名前の訂正
        await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(200)
        await A.locator('#plist [data-c]',has_text='りく').click(); await A.fill('#cf_name','めい'); await A.click('#cfSave')
        ok('もう受付されています' in await A.inner_text('#cfErr') and await A.locator('#ov').is_visible(),'受付済みの人と同じ名前には直せない（画面は閉じない）')
        await A.fill('#cf_name','そら'); await A.click('#cfSave')
        ok('名簿に「そら」さんがすでにいます' in await A.inner_text('#cfErr'),'名簿にいる別の人と同じ名前には直せない')
        await A.fill('#cf_name','りくと'); await A.click('#cfSave'); await A.wait_for_timeout(2500)
        ok(byname('roster','りくと') and byname('checkins','りくと') and not byname('checkins','りく'),'名前の訂正で、名簿と受付の両方が「りくと」になる')
        ok(await B.locator('#tmTeams',has_text='りくと').count()==1,'もう1台のチームにも直した名前が出る')
        # 所属の付け替え（2台で別々の人を同時に）
        e=ev(); ta=team_of('ゆい'); tb=team_of('ひな')
        others=sorted(set(int(k[1:]) for k in e['tm'])-{ta}); dest_a=others[0]
        others_b=sorted(set(int(k[1:]) for k in e['tm'])-{tb,dest_a}); dest_b=others_b[0]
        await A.locator('#plist [data-c]',has_text='ゆい').click(); await A.select_option('#cf_team',str(dest_a))
        await B.click('.nb[data-ph=entry]'); await B.locator('#plist [data-c]',has_text='ひな').click(); await B.select_option('#cf_team',str(dest_b))
        await asyncio.gather(A.click('#cfSave'),B.click('#cfSave')); await A.wait_for_timeout(3000)
        ok(team_of('ゆい')==dest_a and team_of('ひな')==dest_b,'2台で同時に別々の人を付け替えても、両方とも残る')
        tag=await B.locator('#plist li',has_text='ゆい').inner_text()
        ok(('チーム '+chr(64+dest_a)) in tag,'受付済みの一覧にチーム名が出る：'+tag.replace('\n',' '))
        # チーム名の変更
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300)
        rn=A.locator('[data-rn="1"]'); await rn.fill('ロケット'); await rn.press('Tab'); await A.wait_for_timeout(2500)
        ok(ev()['tm']['t1']['name']=='ロケット','確定後にチーム名を変えられる')
        await B.click('.nb[data-ph=team]'); await B.wait_for_timeout(300)
        ok(await B.locator('[data-rn="1"]').input_value()=='ロケット','もう1台にも新しいチーム名')
        # 解散（2回押し）→未所属→奇数の警告→追加
        mem2=sum(1 for v in ev()['assign'].values() if v==2)
        await A.click('[data-rm="2"]'); await A.wait_for_timeout(200)
        ok(await A.locator('[data-rm="2"]').inner_text()=='本当に解散' and not ev()['tm']['t2'].get('gone'),'解散は1回目では確定しない')
        await A.click('[data-rm="2"]'); await A.wait_for_timeout(2500)
        ok(ev()['tm']['t2'].get('gone') is True,'2回目で解散')
        txt=await A.inner_text('#tmResult')
        ok('まだチームに入っていない人が '+str(mem2)+'人' in txt and '奇数' in txt,'解散したチームの'+str(mem2)+'人が「まだチームに入っていない人」に出て、奇数の警告も出る')
        await A.click('#tmAdd'); await A.wait_for_timeout(2500)
        e=ev(); ok('t7' in e['tm'] and await A.locator('#tmTeams .tcard:not(.none)').count()==6 and '奇数' not in await A.inner_text('#tmResult'),'チームを1つ追加（G）して偶数に戻る')
        none=A.locator('.tcard.none [data-pc]'); nm=(await none.first.inner_text()).split('\n')[0]
        await none.first.click(); await A.select_option('#cf_team','7'); await A.click('#cfSave'); await A.wait_for_timeout(2500)
        ok(team_of(nm)==7,'チームに入っていない人（'+nm+'）を名前から新しいチームへ入れられる')
        await A.screenshot(path='adj_light.png',full_page=True); await B.wait_for_timeout(800); await B.screenshot(path='adj_dark.png',full_page=True)
        print('   sw',await A.evaluate('document.documentElement.scrollWidth'),await B.evaluate('document.documentElement.scrollWidth'))
        # 遅れて来た人
        await A.click('.nb[data-ph=entry]'); await A.locator('#rList .rc span',has_text='そら').click(); await A.click('#qAdd'); await A.wait_for_timeout(2500)
        await A.click('.nb[data-ph=team]'); await A.wait_for_timeout(300)
        ok(await A.locator('.tcard.none',has_text='そら').count()==1,'確定後に受付した人は「まだチームに入っていない人」に出る（抽選し直さなくてよい）')
        # 取り消し（2回押し）
        await A.click('.nb[data-ph=entry]'); await A.locator('#plist [data-c]',has_text='ゆい').click(); await A.click('#cxYes'); await A.wait_for_timeout(1500)
        ok(byname('checkins','ゆい') and 'もう一度押すと' in await A.inner_text('#cxYes'),'取り消しは1回目では送らない')
        await A.click('#cxYes'); await A.wait_for_timeout(2500)
        ok(not byname('checkins','ゆい') and team_of('ゆい') is None,'2回目で取り消し、チームの所属も外れる')
        ok(not await A.evaluate('window.__tk.rejected().length') and not await B.evaluate('window.__tk.rejected().length'),'どちらの端末にも届かなかった操作はない')
        print('errs',errs); print('合計',sum(res),'/',len(res)); await b.close()
asyncio.run(main())
