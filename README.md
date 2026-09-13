# 10-years-from-now
Hackathon project: 10年後のあたりまえ

高校生が問題演習とAI対話を通じて、自分専用の教科書を育てられる学習サービス「GROWBOOK」のプロトタイプです。

## Demo

GitHub Pages: https://manabiai.netlify.app/

## 音声AI学習入口（英語）

生徒は黙って問題を解き、その画面・音声・解答操作を記録します。終了後、記録を手掛かりにAIが音声で話しかけ、生徒の説明で情報を補い、教科書の説明案・類題につなげます。この入口を `tutor/` に追加しています。元の英語モックはそのまま残しています。

Node.js 22以上で、`server/.env.example` を `server/.env` にコピーし、OpenAI APIキーを設定してください。

```sh
npm start
```

`http://localhost:3000/tutor/` をPC Chromeで開きます。APIクレジットが必要です。キーをフロントエンドやGitHubに保存しないでください。

GitHub Pagesは静的プレビューのみ。ライブ音声・教科書生成にはローカルサーバーが必要です。

詳しい実演手順・制約・データの扱いは [DEMO.md](DEMO.md) を参照してください。

参照する英語問題・画面: https://manabiai.netlify.app/ 。先頭3問を入口デモに採用。既存のGeminiチャットは維持し、新しい音声・記録APIは `/api/tutor/` に分離しています。
