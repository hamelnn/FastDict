#!/bin/zsh
set -eu
cd -- "${0:A:h}/.."
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  print -u2 '请先安装 Node.js 22 LTS，再重新打开本脚本。详见 docs/macos.md。'
  read -r '?按 Enter 关闭…'
  exit 1
fi

print '正在准备FastLingo macOS 的构建依赖…'
task_build_status=0
if npm ci && npm run macos:build; then
  print '已生成应用，请查看 release/macos。'
  open release/macos
else
  task_build_status=1
  print -u2 '构建未完成。请查看上方错误与 docs/macos.md；没有生成可交付的 Mac 应用。'
fi
read -r '?按 Enter 关闭…'
exit "$task_build_status"
