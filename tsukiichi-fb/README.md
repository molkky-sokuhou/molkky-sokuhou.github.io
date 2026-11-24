# 月いちモルック 受付の試作（Firebase）

- 公開ページ：`index.html`（`python3 build.py 版番号` で `src/` から組み立てる。直すのは `src/`）
- `src/app.js` 本体／`src/fakeserver.js` 練習モードと自動試験用の模擬サーバー（Firestoreのルールと同じ判定）／`src/base.css` 既存の運営画面の見た目／`src/extra.css` 追加分
- 自動試験：`node test/server.js` を起動してから `python3 test/scenarios.py`（2台・圏外・閉じて開き直す・同名のまとめ・旧回の操作）と `python3 test/scenarios2.py`（人数と確認時刻、8人ずつの分割と途中切断・途中拒否、逆向きの同時まとめ、ルールの確認の判定不能、消去の確認）
- Firestoreのルール：アプリの設定タブ「Firestoreのルール」に、運営アカウントのUID入りの全文が出る（src/app.js の RULES）
- Firestoreのルールは、このプロジェクトの資料（claude/tsukiichi-firebase.md）にある最新版を使う
