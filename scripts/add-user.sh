#!/bin/sh
# Adds a person: users/<name>/ with config, .env and data, plus their service
# in compose.override.yaml. Never overwrites anything.
set -eu

cd "$(dirname "$0")/.."
name="${1:-}"

if ! printf '%s' "$name" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; then
  echo "用法：scripts/add-user.sh <名字>（小写字母、数字和 -，例如 alice）" >&2
  exit 1
fi
if [ "$name" = template ]; then
  echo "template 是保留的名字，换一个" >&2
  exit 1
fi
dir="users/$name"
if [ -e "$dir" ]; then
  echo "$dir 已经存在，没有做任何改动" >&2
  exit 1
fi
if [ -f compose.override.yaml ] && grep -Eq "^  $name:" compose.override.yaml; then
  echo "compose.override.yaml 里已经有 $name，没有做任何改动" >&2
  exit 1
fi

mkdir -p "$dir/data"
cp config.user.example.toml "$dir/config.toml"
cp user.env.example "$dir/.env"
chmod 600 "$dir/.env"

[ -f compose.override.yaml ] || printf 'services:\n' > compose.override.yaml
cat >> compose.override.yaml <<YAML
  $name:
    extends: { file: compose.yaml, service: template }
    profiles: !reset []
    build: !reset null
    hostname: morning-brief-$name
    env_file: $dir/.env
    volumes:
      - ./$dir/config.toml:/app/config.toml:ro
      - ./$dir/data:/app/data
YAML

cat <<TEXT
已创建 $dir/ 并加入 compose.override.yaml。接下来：
1. 给 $name 建一个自己的 Discord 机器人（README 第 3 步），把 token 填进 $dir/.env 的 DISCORD_BOT_TOKEN
2. 按需修改 $dir/config.toml（家的城市和时区、日历、兴趣）
3. docker compose up -d $name
4. 让 $name 私信机器人任意一句，把回复里的用户 ID 填进 $dir/.env 的 DISCORD_USER_ID，再 docker compose up -d $name
5. 让 $name 在聊天里用 /schedule add 08:05 设置定时（和别人错开几分钟）
TEXT
