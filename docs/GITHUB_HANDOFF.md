# GitHubへの送信手順

まず `gh auth status` で接続アカウントを確認。以下は `tyoshida-green` の場合です。別アカウントならURLとhead指定を読み替えてください。

## 所有者からWrite権限が付いた場合

```sh
gh repo view Dong7601/10-years-from-now --json viewerPermission
git fetch origin
git log --oneline --left-right HEAD...origin/main
```

チーム側の追加更新があれば、内容を確認してマージ・テストしてから `git push origin main`。force pushはしません。

## 権限が来ない場合のfork経由

以下は外部にforkとPRを作成します。実行指示を受けてから行う準備手順です。元のoriginは変更しません。

```sh
gh repo fork Dong7601/10-years-from-now --clone=false
git push https://github.com/tyoshida-green/10-years-from-now.git HEAD:growbook-demo
gh pr create --repo Dong7601/10-years-from-now --base main --head tyoshida-green:growbook-demo --title "GROWBOOKの記録・振り返り入口と静的モックを追加" --body-file docs/PR_BODY.md
```

forkが既に存在するときは、その所有者・対象リポジトリを確認して再利用します。同名ブランチがある場合もforce pushせず、別ブランチ名を選びます。PR作成後は所有者の確認とマージが必要です。

## 所有者への送付文面

GROWBOOKの英語演習の記録・終了後の振り返り画面と、理科の静的モックを同梱しました。既存のGeminiチャット・教科書生成・5単元の教科書更新は維持しています。発表はローカルで npm start し、/tutor/ のテキスト入力ルートを使う想定です。直接pushする場合はtyoshida-greenへのWrite権限付与をお願いします。fork経由の場合は、作成したPRの確認とマージをお願いします。実マイクと画面録画は未検証のため、その点は発表でも区別してください。
