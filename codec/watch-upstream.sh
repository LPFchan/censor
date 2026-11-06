#!/bin/sh
# Daily check for new libjpeg-turbo and emsdk releases. When either is newer
# than the pins in codec/build.sh, this bumps the pins on a branch, rebuilds
# the codec from scratch, runs the tests, and opens a PR if everything passes.
# Either way it messages the operator through Hermes (`hermes send`), once per
# new version pair. Nothing is merged or deployed automatically.
#
# It resets the checkout it lives in, so run it from a dedicated clone, not a
# working copy. Needs docker, gh (logged in, push access), node/npm, hermes.
# Installed on grimoire as the user timer censor-codec-watch.timer.
set -eu

# The whole body is one function so sh parses it before running: the checkout
# below may replace this file mid-run.
main() {
  REPO="$(cd "$(dirname "$0")/.." && pwd)"
  TO="${HERMES_TO:-telegram:162926836}"
  STATE="${XDG_STATE_HOME:-$HOME/.local/state}/censor-codec-watch"
  mkdir -p "$STATE"
  cd "$REPO"

  git fetch -q origin main
  git checkout -q -f -B main origin/main

  cur_ljt=$(sed -n 's/^LJT_TAG=//p' codec/build.sh)
  cur_emsdk=$(sed -n 's#^EMSDK_IMAGE=emscripten/emsdk:##p' codec/build.sh)
  new_ljt=$(gh api repos/libjpeg-turbo/libjpeg-turbo/releases/latest --jq .tag_name)
  new_emsdk=$(git ls-remote --tags --refs https://github.com/emscripten-core/emsdk.git |
    sed 's#.*refs/tags/##' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)

  # Never move a pin backwards, and wait for the docker image of a new emsdk tag.
  newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }
  newer "$new_ljt" "$cur_ljt" || new_ljt=$cur_ljt
  if newer "$new_emsdk" "$cur_emsdk"; then
    docker manifest inspect "emscripten/emsdk:$new_emsdk" >/dev/null 2>&1 || new_emsdk=$cur_emsdk
  else
    new_emsdk=$cur_emsdk
  fi
  [ "$new_ljt" = "$cur_ljt" ] && [ "$new_emsdk" = "$cur_emsdk" ] && exit 0

  key="ljt-$new_ljt-emsdk-$new_emsdk"
  [ "$(cat "$STATE/last" 2>/dev/null)" = "$key" ] && exit 0 # already reported
  summary=""
  [ "$new_ljt" != "$cur_ljt" ] && summary="libjpeg-turbo $cur_ljt -> $new_ljt"
  [ "$new_emsdk" != "$cur_emsdk" ] && summary="${summary:+$summary, }emsdk $cur_emsdk -> $new_emsdk"
  log="$STATE/$key.log"

  ping() {
    hermes send -q --to "$TO" "$1"
    echo "$key" >"$STATE/last"
  }
  fail() {
    ping "censor codec update ($summary): $1. Log on grimoire: $log"
    exit 0
  }

  git clean -q -ffdx # -ff: also the nested libjpeg-turbo clone
  git checkout -q -B "codec/bump-$key"
  sed -i "s/^LJT_TAG=.*/LJT_TAG=$new_ljt/; s#^EMSDK_IMAGE=.*#EMSDK_IMAGE=emscripten/emsdk:$new_emsdk#" codec/build.sh

  if ! ./codec/build.sh >"$log" 2>&1; then
    grep -q 'patch does not apply' "$log" &&
      fail "the SIMD patch no longer applies and needs a manual rebase"
    fail "the codec build failed"
  fi
  { npm ci && npm test; } >>"$log" 2>&1 || fail "the build worked but tests failed"

  git add -A
  git commit -q -m "fix(deps): bump the JPEG codec to $summary" \
    -m "Opened by codec/watch-upstream.sh: clean rebuild with codec/build.sh, tests pass."
  git push -q -f -u origin "codec/bump-$key"
  url=$(gh pr create --fill --base main)
  ping "censor codec update ($summary) built and passed tests. PR: $url"
}
main "$@"
