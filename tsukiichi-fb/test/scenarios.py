import asyncio, json, urllib.request
from playwright.async_api import async_playwright
URL='file://'+__import__('os').path.abspath(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','index.html'))
SRV='http://localhost:8765'
def server(): return json.loads(urllib.request.urlopen(SRV+'/state').read())
def srv_checkins(eid): return sorted(v['name'] for k,v in server()['docs'].items() if k.startswith(f'staff/proto/events/{eid}/checkins/'))
INIT="window.__FAKE_URL='%s';" % SRV + """(function(){var r=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){try{var d=JSON.parse(r.call?Storage.prototype.getItem.call(this,'dbg')||'[]':'[]');d.push(k+' @ '+location.href.slice(-12)+' '+(new Error().stack||'').split('\\n').slice(1,4).join(' / '));Storage.prototype.setItem.call(this,'dbg',JSON.stringify(d))}catch(e){};return r.call(this,k)}})();"""
errs=[]
async def mk(b,name):
    ctx=await b.new_context(viewport={'width':375,'height':800})
    await ctx.add_init_script(INIT+f"try{{localStorage.setItem('tk_devName','{name}')}}catch(e){{}}")
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(name+': '+str(e)))
    await pg.goto(URL); await pg.wait_for_timeout(1500)
    return ctx,pg
async def reopen(ctx,name):
    pg=await ctx.new_page(); pg.on('pageerror',lambda e:errs.append(name+': '+str(e)))
    await pg.goto(URL)
    print('   dbg:', await pg.evaluate("localStorage.getItem('dbg')"))
    pass
    await pg.wait_for_timeout(2500); return pg
async def st(pg):
    return await pg.evaluate("""()=>{const t=window.__tk;return {cur:t.S.cur,people:t.people().map(p=>p.name+(p.pending?'*':'')).sort(),unsent:t.unsent().length,rej:t.rejected().map(o=>o.type+':'+o.items.map(i=>i.name).join('/')+' / '+o.reason),dups:t.dupGroups().length,bar:document.getElementById('saveBar').innerText.replace(/\\n/g,' | ')}}""")
async def pick(pg,names):
    for n in names:
        await pg.fill('#eq',n); await pg.wait_for_timeout(80)
        await pg.locator('#rList .rc span',has_text=n).first.click()
    await pg.click('#qAdd'); await pg.wait_for_timeout(100)
async def newp(pg,name):
    await pg.fill('#eq',name); await pg.wait_for_timeout(80); await pg.click('#newAdd'); await pg.wait_for_timeout(100)
async def cancel(pg,name):
    await pg.locator('#plist .prow',has_text=name).first.click(); await pg.click('#cxYes'); await pg.click('#cxYes'); await pg.wait_for_timeout(100)
def ok(c,label): print(('OK ' if c else 'NG ')+label); return c
async def main():
    urllib.request.urlopen(SRV+'/reset')
    async with async_playwright() as p:
        b=await p.chromium.launch()
        ca,A=await mk(b,'1台目'); cb,B=await mk(b,'2台目')
        # 最初の回
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(2000)
        await A.click('.nb[data-ph=set]'); await A.click('#seedBtn'); await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(2000)
        await B.wait_for_timeout(1500)
        e1=(await st(A))['cur']; ok(e1 and (await st(B))['cur']==e1,'2台とも同じ開催回 '+e1)
        # S1 受付
        await pick(A,['はると','ゆい','そうた']); await A.wait_for_timeout(2500); await B.wait_for_timeout(500)
        sa,sb=await st(A),await st(B)
        ok(sa['people']==sb['people']==['そうた','はると','ゆい'],'S1 2台に同じ3人 '+str(sb['people']))
        print('   A bar:',sa['bar'])
        # S2 同じ初参加者を2台で（重複候補→まとめ→古いIDへの遅れた受付が人数を戻さない）
        await cb.set_offline(True); await B.wait_for_timeout(1500)
        await newp(A,'さとう みき'); await A.wait_for_timeout(1500)
        await newp(B,'さとう みき'); await B.wait_for_timeout(300)
        await cb.set_offline(False); await B.wait_for_timeout(4000); await A.wait_for_timeout(1000)
        sa=await st(A); ok(sa['dups']==1 and sa['people'].count('さとう みき')==2,'S2 重複候補が出る '+str(sa['people']))
        # B 圏外：Bの「さとう」を取消→名簿から受付し直し（Bの側のID）
        await cb.set_offline(True); await B.wait_for_timeout(1500)
        await cancel(B,'さとう みき'); await B.wait_for_timeout(200)
        await B.fill('#eq','さとう'); await B.wait_for_timeout(100)
        cnt=await B.locator('#rList .rc span',has_text='さとう').count()
        if cnt: await B.locator('#rList .rc span',has_text='さとう').first.click(); await B.click('#qAdd')
        print('   B offline:',(await st(B))['bar'])
        # A でまとめる（Bのを消す方に）
        await A.click('#dupList [data-merge]'); await A.wait_for_timeout(200)
        sheet=await A.inner_text('#sheet'); print('   merge sheet:',sheet.replace('\n',' ')[:160])
        await A.click('#mgYes'); await A.wait_for_timeout(2500)
        sa=await st(A); ok(sa['people'].count('さとう みき')==1 and sa['dups']==0,'S2 まとめて1人 '+str(sa['people']))
        await cb.set_offline(False); await B.wait_for_timeout(6000); await A.wait_for_timeout(500)
        sa,sb=await st(A),await st(B)
        ok(sa['people'].count('さとう みき')==1 and sb['people'].count('さとう みき')==1,'S2 Bの復帰後も1人 A='+str(sa['people'])+' B='+str(sb['people']))
        ok(any('さとう' in r for r in sb['rej']),'S2 Bに断られた操作が名前つきで残る '+str(sb['rej']))
        ok(srv_checkins(e1).count('さとう みき')==1,'S2 サーバーの実件数も1人 '+str(srv_checkins(e1)))
        # S3 旧回の操作が新しい回に届かない（B圏外で受付・取消→Aが新しい回→Bは閉じて開き直す）
        await cb.set_offline(True); await B.wait_for_timeout(1500)
        await pick(B,['めい']); await cancel(B,'ゆい'); await B.wait_for_timeout(300)
        print('   B offline2:',(await st(B))['bar'])
        await A.click('.nb[data-ph=set]'); await A.click('#evNew'); await A.wait_for_timeout(300)
        print('   new event sheet:',(await A.inner_text('#sheet')).replace('\n',' ')[:200])
        await A.click('#evYes'); await A.wait_for_timeout(2500); await A.click('.nb[data-ph=entry]')
        e2=(await st(A))['cur']; ok(e2!=e1,'S3 新しい回 '+str(e2))
        print('   B ops before close:', await B.evaluate("JSON.stringify(window.__tk.S.ops.map(o=>[o.type,o.state,o.items.map(i=>i.name).join('/')]))"))
        print('   B keys before close:', await B.evaluate("Object.keys(localStorage).join(',')"), await B.evaluate("(localStorage.getItem('tk_ops_proto')||'').length"))
        await B.close()
        await cb.set_offline(False)
        B=await reopen(cb,'2台目'); await B.wait_for_timeout(6000)
        sb=await st(B)
        print('   B ops after reopen:', await B.evaluate("JSON.stringify(window.__tk.S.ops.map(o=>[o.type,o.state,o.items.map(i=>i.name).join('/')]))"))
        ok(sb['cur']==e2,'S3 Bも新しい回に切り替わる')
        ok(srv_checkins(e2)==[],'S3 新しい回に旧回の操作が入らない '+str(srv_checkins(e2)))
        ok('めい' not in srv_checkins(e1) and 'ゆい' in srv_checkins(e1),'S3 締めた旧回も変わらない '+str(srv_checkins(e1)))
        ok(len(sb['rej'])>=2 and any('めい' in r for r in sb['rej']) and any('ゆい' in r for r in sb['rej']),'S3 Bに断られた受付・取消が名前つきで残る')
        for r in sb['rej']: print('    ',r)
        ok(sb['unsent']==0,'S3 Bの送信待ちは0')
        # S4 圏外で受付・取消 → 閉じる → 再接続して開く（同じ回の中）
        await pick(A,['けんた','あおい']); await A.wait_for_timeout(2500)
        await ca.set_offline(True); await A.wait_for_timeout(1500)
        await pick(A,['りく']); await cancel(A,'あおい'); await A.wait_for_timeout(300)
        sa=await st(A); print('   A offline:',sa['bar'])
        # 端末のデータを消す：送信待ちがあると消せない
        await A.click('.nb[data-ph=set]'); await A.click('#wipeBtn'); await A.wait_for_timeout(300)
        ok('送信待ち' in await A.inner_text('#wipeMsg'),'④ 送信待ちがあると消せない：'+await A.inner_text('#wipeMsg'))
        await A.close(); await ca.set_offline(False)
        A=await reopen(ca,'1台目'); await A.wait_for_timeout(6000); await B.wait_for_timeout(1000)
        sa,sb=await st(A),await st(B)
        server_now=srv_checkins(e2)
        ok(sa['people']==sb['people']==sorted(server_now)==['けんた','りく'],'S4 2台の表示とサーバーの実件数が一致 A='+str(sa['people'])+' B='+str(sb['people'])+' srv='+str(server_now))
        ok(sa['unsent']==0 and not sa['rej'],'S4 Aの送信待ち0・断られた操作なし')
        print('   A bar:',sa['bar']); print('   B bar:',sb['bar'])
        # 自己診断（模擬サーバーのルール）
        await A.click('.nb[data-ph=set]'); await A.click('#selfBtn'); await A.wait_for_timeout(9000)
        print('   self:',(await A.inner_text('#selfOut')).replace('\n',' | '))
        await A.screenshot(path='s_set.png',full_page=True)
        await A.click('.nb[data-ph=entry]'); await A.wait_for_timeout(300); await A.screenshot(path='s_entry.png')
        await B.click('.nb[data-ph=entry]'); await B.screenshot(path='s_entryB.png',full_page=True)
        print('errs',errs)
        await b.close()
asyncio.run(main())
