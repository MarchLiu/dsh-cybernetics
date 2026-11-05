#!/bin/sh
# 修复 A（最小改动，保留当前文件其余内容）
# 把被 PyYAML round-trip 变成布尔键的 reasoningEfforts.off 改回字符串键 'off'。
# 影响面：仅 cordis.patch.yml 中 llm-pi-ai → providers → zai-coding-cn 两个模型的
#        reasoningEfforts 首行（当前 49 / 65 行，内容 `false: null`）。
#
# 用法：
#   ./fix-A-quoted-off.sh                 # 默认改真实 profile 文件
#   ./fix-A-quoted-off.sh /tmp/copy.yml   # 改指定副本（自测用）
set -eu

TARGET=${1:-/Users/mars/.dsh/profiles/web/cordis.patch.yml}
LOCK=/Users/mars/.dsh/profiles/web/.#cordis.patch.yml

[ -f "$TARGET" ] || { echo "ABORT: 找不到 $TARGET" >&2; exit 2; }

# 0) 预检：Emacs 正在编辑同一文件（存在锁文件）时先别改，否则 buffer 保存会把修复冲掉
if [ "$TARGET" = "/Users/mars/.dsh/profiles/web/cordis.patch.yml" ] && [ -e "$LOCK" ]; then
  echo "ABORT: 存在 Emacs 锁文件 $LOCK —— 先在 Emacs 里关掉该 buffer（或确认不保存）后重跑" >&2
  exit 3
fi

# 1) 只在 llm-pi-ai 的 providers 段内替换 `false: null` 行（缩进 14 空格）
COUNT=$(grep -c '^              false: null$' "$TARGET" || true)
if [ "$COUNT" -ne 2 ]; then
  echo "ABORT: 期望 2 处 '              false: null'，实际 $COUNT 处；文件可能已被改动，先人工核对" >&2
  exit 4
fi

# 2) 备份 + 就地替换
BAK="$TARGET.bak-pre-offkeyfix-$(date +%Y%m%d-%H%M%S)"
cp -p "$TARGET" "$BAK"
echo "backup: $BAK"

sed -i '' 's/^              false: null$/              '"'"'off'"'"': null/' "$TARGET"

# 3) 校验：用 llm-pi-ai 真实 schema 跑一遍（不通过就不算修好）
node - "$TARGET" <<'EOF'
const [, , file] = process.argv;
const { createRequire } = require('node:module');
const req = createRequire('/Users/mars/.dsh/profiles/web/');
const yaml = req('js-yaml');
const fs = require('node:fs');
const entries = yaml.load(fs.readFileSync(file, 'utf8'));
const e = entries.find((x) => x && x.id === 'llm-pi-ai');
if (!e) { console.error('FAIL: 没有 llm-pi-ai 条目'); process.exit(1); }
const routes = Object.keys(e.config.providers ?? {});
import('/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
  .then((pi) => {
    try {
      pi.Config(structuredClone(e.config));
      console.log('OK: Config() 通过，routes =', routes.join(', '));
    } catch (err) {
      console.error('FAIL: Config() 仍然报错 ->', String(err.message).slice(0, 400));
      process.exit(1);
    }
    const cy = entries.find((x) => x && x.id === 'dsh-cybernetics');
    console.log('dsh-cybernetics.hardGate =', cy?.config?.hardGate);
  });
EOF

echo
echo "下一步：重启 dsh web 使配置生效（cordis-plugin-loader 不 watch 补丁文件，热改无效）："
echo "  1) 停掉当前 3080 端口的 dsh web（pid 见 ~/.dsh/dsh-config-manager/running/web.json）"
echo "  2) dsh web      # 或 dsh --profile web"
