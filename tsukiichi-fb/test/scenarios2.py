import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file:///home/claude/tsukiichi-fb/index.html'; SRV='http://localhost:8765'
def get(path): return urllib.request.urlopen(SRV+path).read()
def server(): return json.loads(get('/state'))
def commit(writes):
    req=urllib.request.Request(SRV+'/commit',data=json.dumps({'writes':writes}).encode(),method='POST'); return json.loads(urllib.request.urlopen(req).read())
def srv_in(eid): return sorted(v['name'] for k,v in server()['docs'].items() if k.startswith(f'staff/proto/events/{eid}/checkins/'))
def roster(): return {k.split('/')[-1]:v for k,v in server()['docs'].items() if k.startswith('staff/proto/roster/')}
errs=[]; res=[]
def ok(c,label): res.append(c); print(('OK ' if c else 'NG ')+label); return c
async def mk(b,name,extra=''):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';try{{localStorage.setItem('tk_devName','{name}')}}catch(e){{}}"+extra)
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(name+': '+str(e)))
    await pg.goto(URL); await pg.wait_for_timeout(1500); return ctx,pg
async def reopen(ctx,name):
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(name+': '+str(e))); await pg.goto(URL); await pg.wait_for_timeout(3000); return pg
async def st(pg):
    return await pg.evaluate("""()=>{const t=window.__tk;return {cur:t.S.cur,people:t.people().map(p=>p.name).sort(),unsent:t.unsent().length,
      ops:t.S.ops.map(o=>[o.type,o.state,o.items.length,o.items.map(i=>i.name).join('/'),o.reason||'']),rej:t.rejected().map(o=>o.items.map(i=>i.name).join('/')+' / '+o.reason),
      dups:t.dupGroups().length,box:document.getElementById('statusBox').innerText.replace(/\\n/g,' | '),bar:document.getElementById('saveBar').innerText.replace(/\\n/g,' ')}}""")
async def pick(pg,names):
    for n in names:
        await pg.fill('#eq',n); await pg.wait_for_timeout(40)
        await pg.locator('#rList .rc span',has_text=n).first.click()
    await pg.fill('#eq',''); await pg.click('#qAdd'); await pg.wait_for_timeout(100)
async def pickall(pg):
    for i in range(await pg.locator('#rList .rc span').count()): await pg.locator('#rList .rc span').nth(i).click()
    await pg.click('#qAdd'); await pg.wait_for_timeout(100)
async def newp(pg,name):
    await pg.fill('#eq',name); await pg.wait_for_timeout(80); await pg.click('#newAdd'); await pg.wait_for_timeout(100)
async def cancel(pg,name):
    await pg.locator('#plist .prow',has_text=name).first.click(); await pg.click('#cxYes'); await pg.wait_for_timeout(100)
async def startEvent(pg):
    if await pg.is_visible('#evGate [data-newev]'): await pg.click('#evGate [data-newev]')
    else: await pg.click('.nb[data-ph=set]'); await pg.click('#evNew')
    await pg.click('#evYes'); await pg.wait_for_timeout(1800)
async def main():
    get('/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目')
        await startEvent(A); await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        e1=(await st(A))['cur']
        # ② 10人確認→圏外で1人取消
        await pick(A,['はると','ゆい','そうた','めい','けんた','あおい','りく','ひな','だいき','さくら']); await A.wait_for_timeout(2500)
        sa=await st(A); ok('最後にサーバーで確認できた受付 10人' in sa['box'] and '（いまの表示と同じ）' in sa['box'],'② 10人が確認済み：'+sa['box'][:120])
        await ca.set_offline(True); await A.wait_for_timeout(1500)
        await cancel(A,'はると'); await A.wait_for_timeout(500)
        sa=await st(A)
        ok('この端末の表示 9人・送信待ち 1件' in sa['box'] and '取消1件' in sa['box'] and '最後にサーバーで確認できた受付 10人' in sa['box'],'② 表示9人・取消待ち1件・最後のサーバー確認10人 が分かれる')
        print('    ',sa['box']); print('     固定行:',sa['bar'])
        await ca.set_offline(False); await A.wait_for_timeout(2500)
        sa=await st(A); ok('最後にサーバーで確認できた受付 9人' in sa['box'] and '（いまの表示と同じ）' in sa['box'],'② 届いたら9人で確認済み')
        # ① 各端末の最後の報告（全員確定とは言わない）
        await B.wait_for_timeout(500); sb=await st(B)
        ok('全員分' not in sb['box'] and '1台目：' in sb['box'] and 'の報告で送信待ち' in sb['box'],'① 各端末の最後の報告だけを出す：'+sb['box'].split(' | ')[-2:][0][:150])
        # ③ 24人一括（残り14人＋新規10人で24人）: 8人ずつ3回に分かれる
        for n in range(10): await newp(A,'しけん%02d'%n)
        await A.wait_for_timeout(3000)
        # 9人取消して全員を一括で受付 → まずはみんな取消（画面上で）
        get('/reset'); await A.close(); await B.close(); await ca.close(); await cb.close()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目')
        await startEvent(A); await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        e1=(await st(A))['cur']
        # 途中で切断：返事を遅くして、1回目が届いたあとに圏外→閉じる→開き直す
        get('/slow?ms=1200')
        await pickall(A)
        sa=await st(A); ins=[o for o in sa['ops'] if o[0]=='in']
        ok(len(ins)==3 and sorted(o[2] for o in ins)==[8,8,8],'③ 24人が8人ずつ3つの操作に分かれる '+str([o[2] for o in ins]))
        await A.wait_for_timeout(1700); await ca.set_offline(True); await A.wait_for_timeout(300)
        sa=await st(A); print('     切断時の状態:',[o[1] for o in sa['ops'] if o[0]=='in'], 'サーバー', len(srv_in(e1)),'人')
        await A.close(); get('/slow?ms=0'); await ca.set_offline(False)
        A=await reopen(ca,'1台目'); await A.wait_for_timeout(4000)
        sa=await st(A)
        ok(len(srv_in(e1))==24 and sa['unsent']==0 and all(o[1]=='done' for o in sa['ops'] if o[0]=='in'),'③ 切断→開き直しで24人全員が届き、操作はすべて届いた扱い（サーバー'+str(len(srv_in(e1)))+'人）')
        # 拒否が途中の1回だけに起きる：Bが圏外のあいだに、サーバー側で2回目の中の1人（r10）を別の人にまとめる
        get('/reset'); await A.close(); await B.close(); await ca.close(); await cb.close()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目')
        await startEvent(A); await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2500)
        e1=(await st(A))['cur']
        await ca.set_offline(True); await A.wait_for_timeout(1200)
        print('     まとめ（サーバー側で直接）:',commit([{'op':'update','path':'staff/proto/roster/r10','data':{'mergedInto':'r01'}}]))
        await pickall(A); await A.wait_for_timeout(300)
        await ca.set_offline(False); await A.wait_for_timeout(5000)
        sa=await st(A)
        rejn=[r for r in sa['rej']]
        ok(len(rejn)==1 and rejn[0].startswith('だいき/さくら/ゆうと/みお/こうき/りな/しょう/なな') and '「さくら」さんは別の人とまとめ済み' in rejn[0],'③ 拒否された2回目の8人が名前つきで残る：'+str(rejn))
        ok(len(srv_in(e1))==16,'③ ほかの2回分（16人）は保存されている：'+str(len(srv_in(e1))))
        await A.click('#rjList [data-rs]'); await A.wait_for_timeout(3000)
        sa=await st(A); s=srv_in(e1)
        ok(len(s)==23 and 'さくら' not in s and 'はると' in s and not sa['rej'] and sa['unsent']==0,'③ 送り直すと、さくらは行き先（はると）に読み替え、残り7人が保存：'+str(len(s))+'人')
        # ④ 逆向きの同時まとめ
        get('/reset'); await A.close(); await B.close(); await ca.close(); await cb.close()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目')
        await startEvent(A); await A.wait_for_timeout(1500)
        await cb.set_offline(True); await B.wait_for_timeout(1200)
        await newp(A,'やまだ はな'); await newp(B,'やまだ はな'); await A.wait_for_timeout(500)
        await cb.set_offline(False); await A.wait_for_timeout(3500); await B.wait_for_timeout(500)
        ok((await st(A))['dups']==1 and (await st(B))['dups']==1,'④ 2台に同じ重複候補')
        await A.click('#dupList [data-merge]'); await B.click('#dupList [data-merge]'); await B.click('#mgSwap')
        ka=await A.inner_text('#sheet'); kb=await B.inner_text('#sheet')
        print('     A:',ka.split('\n')[2][:40],' B:',kb.split('\n')[2][:40])
        get('/slow?ms=600')
        await asyncio.gather(A.click('#mgYes'),B.click('#mgYes'))
        await A.wait_for_timeout(5000); get('/slow?ms=0'); await B.wait_for_timeout(2000)
        r=roster(); merged={k:v.get('mergedInto') for k,v in r.items() if v.get('mergedInto')}
        sa,sb=await st(A),await st(B); s=srv_in((await st(A))['cur'])
        ok(len(merged)==1 and all(r[v].get('mergedInto') in (None,'') for v in merged.values()),'④ まとめは片方だけ通り、相互参照なし '+str(merged))
        ok(s.count('やまだ はな')==1 and sa['people'].count('やまだ はな')==1 and sb['people'].count('やまだ はな')==1,'④ 両方消えず1人残る（サーバー・A・B）')
        lose=[x for x in (sa['rej']+sb['rej'])]
        ok(len(lose)==1 and '別の端末で' in lose[0],'④ 負けた方の端末に理由つきで残る：'+str(lose))
        # ④ 統合済みが古い書き込みで戻らない（サーバーへ直接）
        dropid=list(merged.keys())[0]
        ok(commit([{'op':'update','path':'staff/proto/roster/'+dropid,'data':{'mergedInto':''}}])['ok'] is False,'④ まとめ済みを元に戻す書き込みは断られる')
        ok(commit([{'op':'set','path':'staff/proto/roster/'+dropid,'data':{'name':'やまだ はな'}}])['ok'] is False,'④ まとめ済みを古い新規登録で上書きは断られる')
        # ⑤ ルールの確認：通信エラーは判定不能、ほかはすべて✓
        await A.click('.nb[data-ph=set]')
        get('/fail?ms=17000'); await A.click('#selfBtn')
        for i in range(60):
            await A.wait_for_timeout(2000)
            out=await A.inner_text('#selfOut')
            if 'すべて想定どおり' in out or '件あります' in out: break
        lines=out.split('\n')
        ok(any(l.startswith('？') and '判定不能' in l for l in lines),'⑤ 通信の失敗は「判定不能」：'+[l for l in lines if l.startswith('？')][0][:60])
        ok(not any(l.startswith('✗') for l in lines),'⑤ 想定と違う（✗）はなし')
        await A.click('#selfBtn')
        for i in range(60):
            await A.wait_for_timeout(1500)
            out=await A.inner_text('#selfOut')
            if 'すべて想定どおり' in out or '件あります' in out: break
        print('     '+out.replace('\n','\n     '))
        ok('すべて想定どおり' in out,'⑤ 電波が戻れば全項目が想定どおり')
        # ⑤ 消去の確認
        await A.click('#wipeBtn'); await A.wait_for_timeout(2500)
        if await A.is_visible('#wpYes'):
            await A.click('#wpYes'); await A.wait_for_timeout(3000)
        msg=await A.inner_text('#lockErr')
        names=await A.evaluate("indexedDB.databases().then(d=>d.map(x=>x.name))")
        nops=await A.evaluate("window.__tk.S.ops.length")
        ok('消えたことを確かめました' in msg and 'tk_fake' not in names and nops==0 and await A.is_visible('#lock'),'⑤ 消去を確かめてから「消しました」、自動では入らない：'+msg+' / DB '+str(names)+' / 記録 '+str(nops))
        print('errs',errs); print('合計', sum(res),'/',len(res))
        await b.close()
asyncio.run(main())
