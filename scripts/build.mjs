import { mkdir, copyFile } from "node:fs/promises";
// 許可した公開ファイルだけを出力。server/.env やサーバーコードは配信しない。
await mkdir("dist/tutor", { recursive: true });
await mkdir("dist/mock", { recursive: true });
for (const path of [
  "index.html",
  ".nojekyll",
  "tutor/index.html",
  "tutor/app.js",
  "tutor/style.css",
  "tutor/questions.json",
  "mock/textbook.html",
  "mock/workbook.html",
])
  await copyFile(path, "dist/" + path);
console.log(
  "静的プレビューをdist/に出力しました。AI実行にはローカルサーバーが必要です。",
);
