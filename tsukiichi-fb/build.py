import re, sys, pathlib
VER = sys.argv[1] if len(sys.argv) > 1 else '2026.11.24'
S = pathlib.Path(__file__).resolve().parent / 'src'
r = lambda n: (S / n).read_text(encoding='utf8')
VIEWCTL = '''<div class="viewctl" role="group" aria-label="画面の表示">
<button type="button" class="vc-btn" data-vc="theme" aria-label="暗い画面にする"></button>
<button type="button" class="vc-btn" data-vc="font" aria-haspopup="true" aria-expanded="false" aria-label="文字の大きさを変える" title="文字の大きさ"><span class="vc-a" aria-hidden="true"><span class="s">あ</span><span class="b">あ</span></span></button>
<div class="vc-pop" hidden><b>文字の大きさ</b><div class="vc-opts"><button type="button" data-fs-set="m">標準</button><button type="button" data-fs-set="l">大きめ</button><button type="button" data-fs-set="xl">特大</button></div><small>この端末で覚えておきます</small></div>
</div>'''
body = r('body.html').replace('@@VIEWCTL@@', VIEWCTL).replace('@@NAV@@', r('nav.html')).replace('@@VER@@', VER)
html = f'''<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>月いちモルック 受付</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=Zen+Maru+Gothic:wght@500;700;900&display=swap">
<style>
{r('base.css')}
{r('extra.css')}
</style>
</head>
<body>
<script>
{r('viewctl.js')}
</script>
{body}
<script type="module">
{r('fakeserver.js')}
{r('app.js').replace('@@VER@@', VER).replace('/*@@PAST@@*/ { rows: [], haoh: [] }', r('past.json'))}
</script>
</body>
</html>
'''
# 運営の画面は admin/、参加者の画面（11/22版の参加者ページ）は入口の index.html
base = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else S.parent)
(base / 'admin').mkdir(exist_ok=True)
(base / 'admin' / 'index.html').write_text(html, encoding='utf8')
(base / 'index.html').write_text(r('view.html').replace('@@VER@@', VER), encoding='utf8')
print(base, len(html))
