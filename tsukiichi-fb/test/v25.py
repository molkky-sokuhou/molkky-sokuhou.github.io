# 版25：ルールの版の確認と「ルールを公開」ボタン（Google のログインと Firebase Rules API は試験用に差し替える）
import asyncio, json, os, urllib.request
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(HERE, '..', 'admin', 'index.html'); SRV = 'http://localhost:8765'; R = 'staff/proto'
def get(p): return urllib.request.urlopen(SRV + p).read()
def docs(): return json.loads(get('/state'))['docs']
res = []; errs = []
def ok(c, l): res.append(bool(c)); print(('OK ' if c else 'NG ') + l)
MOCK = """()=>{window.__calls=[];window.__tokens=0;window.__fail=0;
  window.google={accounts:{oauth2:{initTokenClient:(o)=>({requestAccessToken:()=>{window.__tokens++;window.__cid=o.client_id;window.__scope=o.scope;setTimeout(()=>o.callback({access_token:'TOK',expires_in:3600}),10);}})}}};
  const f0=window.fetch;window.fetch=async(u,o)=>{if(String(u).indexOf('firebaserules')<0)return f0(u,o);window.__calls.push({u:String(u),m:o.method,a:o.headers.Authorization,b:JSON.parse(o.body)});
    if(window.__fail)return new Response(JSON.stringify({error:{message:'denied'}}),{status:window.__fail});
    return new Response(JSON.stringify(String(u).endsWith('/rulesets')?{name:'projects/tsukiichi-molkky/rulesets/abc'}:{}),{status:200});};
  window.__tk.RS.probe=()=>Promise.reject({code:'permission-denied'});}"""
async def main():
    get('/reset')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 375, 'height': 800})
        await ctx.add_init_script(f"window.__FAKE_URL='{SRV}';window.__SYS_GATE=1;window.__RULES_UID='UID123';localStorage.setItem('tk_devName','1台目')")
        A = await ctx.new_page(); A.on('pageerror', lambda e: errs.append(str(e))); await A.goto(URL); await A.wait_for_timeout(1500)
        await A.evaluate(MOCK)
        await A.click('#evGate [data-newev]'); await A.click('#evYes'); await A.wait_for_timeout(1500)
        await A.click('.nb[data-ph=sys]'); await A.wait_for_timeout(400)
        await A.fill('#sysPw', '7788'); await A.fill('#sysPw2', '7788'); await A.click('#sysGo'); await A.wait_for_timeout(1500)
        st = await A.inner_text('#rulesState')
        ok('古いです' in st and await A.locator('#rulesPub').is_visible(), '本番のルールが古いと出て、公開ボタンが出る：' + st)
        ok('ルールの版 R' in await A.inner_text('#rulesVerH'), '見出しにルールの版')
        await A.click('#rulesPub'); await A.wait_for_timeout(300)
        ok('クライアントID' in await A.inner_text('#rulesPubMsg'), 'クライアントIDがないと、設定を案内する')
        await A.evaluate("document.getElementById('rulesCidBox').open=true")
        await A.fill('#rulesCid', 'abc'); await A.click('#rulesCidSave'); await A.wait_for_timeout(300)
        ok('形が違います' in await A.inner_text('#rulesCidSt'), '形の違うIDは保存しない')
        await A.fill('#rulesCid', '123-abc.apps.googleusercontent.com'); await A.click('#rulesCidSave'); await A.wait_for_timeout(1500)
        ok(docs().get(R + '/conf/deploy', {}).get('clientId') == '123-abc.apps.googleusercontent.com', 'クライアントIDを保存（conf/deploy）')
        # 403：権限のないアカウント
        await A.evaluate("window.__fail=403"); await A.click('#rulesPub'); await A.wait_for_timeout(800)
        ok('権限がありません' in await A.inner_text('#rulesPubMsg'), '権限のないアカウントだと理由を出す')
        # 公開：ルールの全文（UID入り）を送り、切り替える。公開後に「最新です」へ変わる
        await A.evaluate("window.__fail=0;window.__calls=[]")
        await A.click('#rulesPub'); await A.wait_for_timeout(500)
        calls = await A.evaluate("window.__calls")
        ok(len(calls) == 2 and calls[0]['m'] == 'POST' and calls[0]['u'].endswith('/projects/tsukiichi-molkky/rulesets') and 'UID123' in calls[0]['b']['source']['files'][0]['content'] and '__UID__' not in calls[0]['b']['source']['files'][0]['content'], 'ルールの全文（この運営アカウントのUID入り）を送る')
        ok(calls[1]['m'] == 'PATCH' and calls[1]['u'].endswith('/releases/cloud.firestore') and calls[1]['b']['release']['rulesetName'].endswith('/rulesets/abc') and calls[1]['a'] == 'Bearer TOK', '送ったルールに切り替える')
        ok(await A.evaluate("window.__cid") == '123-abc.apps.googleusercontent.com' and 'firebase' in await A.evaluate("window.__scope"), '保存したクライアントIDでログインを開く')
        ok('公開しました' in await A.inner_text('#rulesPubMsg'), '公開しましたと出る')
        await A.evaluate("window.__tk.RS.probe=()=>Promise.resolve(null)"); await A.wait_for_timeout(6000)
        ok('最新です' in await A.inner_text('#rulesState'), '行き渡ると「最新です」に変わる')
        # 1時間以内はログインし直さない
        n0 = await A.evaluate("window.__tokens"); await A.click('#rulesPub'); await A.wait_for_timeout(500)
        ok(await A.evaluate("window.__tokens") == n0 and len(await A.evaluate("window.__calls")) == 4, '1時間以内なら、ログインせずに公開できる')
        print('errs', errs); ok(not errs, 'ページのエラーなし')
        await b.close()
    print('合計 %d / %d' % (sum(res), len(res)))
asyncio.run(main())
