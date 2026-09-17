#!/bin/sh
# ポケモンの画像をこのフォルダの sprites/ に落としてくる（任意）。
# 実行しなくても遊べる（その場合は画像だけ PokeAPI の CDN から読み込む）。
# オフラインで遊びたいとき・CDN をブロックしている環境で使う。
set -e
cd "$(dirname "$0")"
mkdir -p sprites
BASE="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon"
i=1
while [ "$i" -le 151 ]; do
  if [ ! -s "sprites/$i.png" ]; then
    curl -fsSL -o "sprites/$i.png" "$BASE/$i.png" || { echo "No.$i の取得に失敗しました" >&2; exit 1; }
  fi
  i=$((i + 1))
done
echo "sprites/ に151匹そろいました。"
