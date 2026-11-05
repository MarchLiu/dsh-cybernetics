#!/bin/sh
# 修复 B（回到 17:28 的 pre-hardgate 备份，然后仅用文本追加 hardGate: true）
# 优点：把 round-trip 丢掉的全部注释一起找回来；缺点：会丢掉 17:28 之后对 patch
#       文件的其它改动（实测只有 agent-default-model 的 provider/model 改动会被回滚，
#       见 DIAGNOSIS.md「语义差异」一节）。
#
# 用法：
#   ./fix-B-restore-backup.sh                 # 改真实 profile 文件
#   ./fix-B-restore-backup.sh /tmp/copy.yml   # 改指定副本（自测用）
set -eu

TARGET=${1:-/Users/mars/.dsh/profiles/web/cordis.patch.yml}
BAKSRC=/Users/mars/.dsh/profiles/web/cordis.patch.yml.bak-pre-hardgate-20261104-172829
LOCK=/Users/mars/.dsh/profiles/web/.#cordis.patch.yml

[ -f "$TARGET" ] || { echo "ABORT: 找不到 $TARGET" >&2; exit 2; }
[ -f "$BAKSRC" ] || { echo "ABORT: 找不到备份 $BAKSRC" >&2; exit 2; }

if [ "$TARGET" = "/Users/mars/.dsh/profiles/web/cordis.patch.yml" ] && [ -e "$LOCK" ]; then
  echo "ABORT: 存在 Emacs 锁文件 $LOCK —— 先关掉 buffer 再重跑" >&2
  exit 3
fi

# 0) 备份当前（含损坏态）文件，便于回退
BAK="$TARGET.bak-pre-restore-$(date +%Y%m%d-%H%M%S)"
cp -p "$TARGET" "$BAK"
echo "backup(current): $BAK"

# 1) 还原 pre-hardgate 备份
cp -p "$BAKSRC" "$TARGET"

# 2) 文本插入 hardGate（不做任何 YAML round-trip，避免再次破坏 off 键）
python3 - "$TARGET" <<'EOF'
import sys, io
path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()
needle = "    triageAgentModel: zai-coding-cn/glm-5.3-flash\n"
if "hardGate:" in src:
    print("skip: hardGate 已存在")
else:
    if src.count(needle) != 1:
        sys.exit("ABORT: 无法唯一定位 triageAgentModel 行（%d 处）" % src.count(needle))
    src = src.replace(needle, needle + "    hardGate: true\n")
    io.open(path, "w", encoding='utf-8').write(src)
    print("inserted: hardGate: true")
EOF

# 3) 校验
node - "$TARGET" <<'EOF'
const [, , file] = process.argv;
const { createRequire } = require('node:module');
const req = createRequire('/Users/mars/.dsh/profiles/web/');
const yaml = req('js-yaml');
const fs = require('node:fs');
const entries = yaml.load(fs.readFileSync(file, 'utf8'));
const e = entries.find((x) => x && x.id === 'llm-pi-ai');
const cy = entries.find((x) => x && x.id === 'dsh-cybernetics');
import('/Users/mars/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js').then((pi) => {
  try {
    pi.Config(structuredClone(e.config));
    console.log('OK: Config() 通过，routes =', Object.keys(e.config.providers).join(', '));
  } catch (err) {
    console.error('FAIL: Config() 仍报错 ->', String(err.message).slice(0, 400));
    process.exit(1);
  }
  console.log('dsh-cybernetics.hardGate =', cy?.config?.hardGate, '| allGoalsMode =', cy?.config?.allGoalsMode);
});
EOF

echo
echo "下一步：重启 dsh web 使配置生效。"
