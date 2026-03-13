
which crc32 >/dev/null 2>&1 || { echo "crc32 command not found. Please install it to proceed." >&2; exit 1; }
which git >/dev/null 2>&1 || { echo "git command not found. Please install it to proceed." >&2; exit 1; }

npm run build:wasm:release || exit 1

rm -rf webarchive/web
mkdir -p webarchive
cp -a examples/browser webarchive/web
rm -f webarchive/web/dist webarchive/web/src
mkdir -p webarchive/web/dist
cp -a dist/*.js webarchive/web/dist/
cp -a dist/*.wasm webarchive/web/dist/
cp -a src webarchive/web/
rm -rf webarchive/web/src/node

RKWASM_HASH=$(crc32 "webarchive/web/dist/rkdeveloptool.wasm")
RKTOOLSRC_VER=$(git log -1 --format="%h")

find webarchive/web -name '*.js' -o -name '*.html' | xargs -r sed -i '' -e "s#RKDEVELOPTOOL_VER#$RKWASM_HASH#g" -e "s#RKTOOLSRC_VER#$RKTOOLSRC_VER#g"

xattr -cr webarchive/web 2>/dev/null || true

TAR=tar

which gtar >/dev/null 2>&1 && TAR=gtar

$TAR -C webarchive/web -czf webarchive/webarchive.tar.gz .

echo "pack webarchive/webarchive.tar.gz finished!"
