# 早报助手

每天按你设的时间，把天气、日程、待办和新闻整理成一份中文早报，通过 Discord（或 Telegram）私信发给你；之后可以直接在对话里追问。早报由你自己电脑上的本地模型（Ollama）生成。

程序在 Docker 里常驻运行，Ollama 在 Mac 本机运行。下面按第一次安装的顺序写。

## 1. 准备

1. **Docker Desktop**：从 <https://www.docker.com/products/docker-desktop/> 安装。打开 Settings → General，勾选 **Start Docker Desktop when you sign in to your computer**，这样 Mac 重启登录后程序会自己起来。
2. **Ollama**：从 <https://ollama.com/download> 安装，确认它在“系统设置 → 通用 → 登录项”里（安装时默认会加上）。然后下载模型：

   ```sh
   ollama pull qwen3.6:35b
   ```

   模型名以 <https://ollama.com/library> 为准。qwen3.6:35b 需要约 24 GB 内存（2026-11-10 起用它，比 qwen3:32b 快约 5 倍、更守人名规则）；内存小的 Mac 可以换更小的 Qwen，早报质量会差一些。

3. **Node 24 和 pnpm**（可选）：只用来在本机跑 `pnpm brief:dry` 试早报和跑测试。只用 Docker 可以不装，第 4 步有对应的 Docker 命令。

   ```sh
   corepack enable   # pnpm 的版本由 package.json 固定
   pnpm install --frozen-lockfile
   ```

## 2. 配置文件

每个人一个容器，共用 Mac 上的 Ollama；只有你一个人时也是这样，以后加人只要再加一个用户（第 16 节）。配置分两层：

- `config.shared.toml`：所有人共用的设置，模型、默认的订阅源等；
- `users/<名字>/`：每个人自己的 `config.toml`（家的位置、日历、兴趣）、`.env`（token 和用户 id）和 `data/`（这个人的待办、定时和历史早报）。

个人配置里写的值优先（表逐键合并，数组整个替换）；`[ollama]` 只能写在共用配置里。这些文件都在 `.gitignore` 里。

```sh
cp config.shared.example.toml config.shared.toml
scripts/add-user.sh ivan        # 名字用小写字母、数字和 -
```

至少要改：

- `config.shared.toml` 的 `ollama.model`：和 `ollama list` 显示的名字一致，例如 `qwen3.6:35b`；
- `users/ivan/config.toml` 的 `[brief]`：`timezone`、`city`、`latitude`、`longitude`，你“家”的位置；
- `users/ivan/.env`：聊天渠道的 token 和 id，见第 3 步。

日历、新闻等其他设置见第 8、10 节，模板里每一项都有注释。`users/` 里有 token 和私密日历链接，不要发给别人。

`ollama.host` 保持 `http://localhost:11434` 就行：`compose.yaml` 用环境变量 `MORNING_BRIEF_OLLAMA_HOST` 把它换成 `http://host.docker.internal:11434`（容器访问 Mac 本机的地址）。

**本机开发**用一个测试用户 `tester`（`scripts/add-user.sh tester`），它有自己的容器和**单独的测试机器人**：

- `pnpm dev:dry`：用 `config.shared.toml` 加 `users/tester/config.toml`、数据在 `users/tester/data/`，跑本机最新的代码打印一份早报，不用重新构建镜像。环境变量 `MORNING_BRIEF_DATA_DIR` 让同一份个人配置在本机和容器里都能用。
- 聊天功能：`docker compose build template && docker compose up -d tester`，在测试机器人里试，没问题再重建其他人的容器。

只想用一个配置文件、不用 Docker 时，也可以 `cp config.example.toml config.toml` 后跑 `pnpm brief:dry`，数据在项目根目录的 `data/`。不要在本机跑 `pnpm start`：用了某个人的 token 时，它会和那个人的容器同时登录同一个机器人，每句话收到两份回复，早报也可能发两次，`app.lock` 拦不住（两边的数据目录不同）。

## 3. 创建聊天机器人

Discord 和 Telegram 至少开一个；都开时早报两边都发，在哪边提问就在哪边回复。

### Discord

1. 打开 <https://discord.com/developers/applications>，点 **New Application**，起个名字（例如“早报”）。
2. 左边点 **Bot**：
   - 点 **Reset Token**，复制 token，填进 `users/<名字>/.env` 的 `DISCORD_BOT_TOKEN`。token 等于机器人的密码，不要发给别人；泄露了就再点一次 Reset Token。
   - **Privileged Gateway Intents** 下面三个开关都不用开（私信内容不需要特权）。
3. 左边点 **Installation**：**Installation Contexts** 只勾 **Guild Install**；**Install Link** 选 **Discord Provided Link**；**Default Install Settings** 的 Scopes 选 `bot` 和 `applications.commands`，Permissions 选 `Send Messages`。保存。
4. 在 Discord 里自己建一个服务器（左边栏的“+”→ 亲自创建 → 仅供我和我的朋友使用），只有你一个人也可以。
5. 复制第 3 步页面上的 Install Link，在浏览器打开，把机器人加到这个服务器。你和机器人要在同一个服务器里，它才能私信你。
6. 确认 `users/<名字>/config.toml` 里 `[discord]` 的 `enabled = true`，`.env` 里的 `DISCORD_USER_ID` 先留空。

用户 id 在第 5 节启动后获取。每个人要有自己的机器人，不能共用 token。

### Telegram（可选）

> Telegram 适配有完整的单元测试，但还没有在真机上验证过。

1. 在 Telegram 里找 **@BotFather**，发 `/newbot`，按提示起名字，拿到 token，填进 `.env` 的 `TELEGRAM_BOT_TOKEN`。
2. 个人配置的 `[telegram]` 里 `enabled = true`，`TELEGRAM_CHAT_ID` 先不填。

`chat_id` 在第 5 节启动后获取。

## 4. 先试一份早报

不连聊天渠道，只在终端打印给模型的数据和生成的早报（不发送、不写归档）：

```sh
docker compose build template                                     # 第一次和更新代码后构建镜像
docker compose run --rm ivan node --import tsx src/index.ts --dry
```

第一次生成要先把模型读进内存，多花几秒到一分钟；之后一份约 10–20 秒（qwen3.6:35b）。看看天气、日程、待办对不对，新闻后面的“原文”链接能不能打开。

## 5. 启动

```sh
docker compose up -d          # 启动所有人
docker compose logs -f ivan   # 看日志，Ctrl-C 退出查看（程序继续运行）
```

日志里出现 `Discord 已连接` 就好了。然后获取你的 id：

- **Discord**：在服务器成员列表里点机器人 → 发消息，随便发一句。它会回复你的用户 ID，填进 `users/ivan/.env` 的 `DISCORD_USER_ID`。
- **Telegram**：给机器人发 `/start`，它会回复你的 chat_id，填进 `.env` 的 `TELEGRAM_CHAT_ID`。

填好后：

```sh
docker compose up -d ivan     # 改了 .env 要用 up -d 重建容器，restart 不会重新读 .env
```

再给机器人发 `/help` 试试。Discord 里输入 `/` 会弹出命令菜单（第一次可能要等一会儿或重启 Discord 才出现）；直接打字发 `/todo` 这样的文字也可以。

常用的 Docker 命令（`ivan` 换成那个人的名字；不写名字就是所有人）：

| 做什么                       | 命令                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| 看日志                       | `docker compose logs -f --tail 100 ivan`                         |
| 改了 `config.toml` 之后      | `docker compose restart ivan`（改共用配置就重启所有人）          |
| 改了 `.env` 之后             | `docker compose up -d ivan`                                      |
| 更新代码之后（`git pull`）   | `docker compose build template && docker compose up -d`          |
| 停止（不再自动启动）         | `docker compose down`                                            |
| 立刻发一份早报到这个人的渠道 | `docker compose exec ivan node --import tsx src/index.ts --once` |

程序崩溃或 Docker Desktop 重启后，容器会自动重新运行（`restart: unless-stopped`）；`docker compose down` 之后要再 `up -d` 才会运行。每个人的日志最多保留约 30 MB，旧的自动删除。

## 6. 设置定时早报

定时只在聊天里设置，不在配置文件里。第一次启动时 bot 会私信提醒你设置。

| 命令                  | 作用                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `/schedule`           | 看所有定时和下一次早报的时间                                                    |
| `/schedule add 08:00` | 每天 08:00 发；后面可以加 `工作日` 或 `周末`，例如 `/schedule add 07:30 工作日` |
| `/schedule remove 2`  | 删除第 2 个；`/schedule remove 1 3` 一次删几个                                  |
| `/schedule clear`     | 删除全部定时（暂停自动早报）                                                    |

- 时间是你当前所在城市的当地时间，跟着 `/city` 走。
- 同一天会生效的两个定时不能是同一时间，也至少要隔 30 分钟；最多 6 个。
- 新加的定时从下一次开始，比如 10:30 加一个 08:00，今天不会马上补发。
- 电脑睡过了某个定时，醒来后 `catch_up_hours`（默认 4）小时内仍补发，但不超过下一个定时。生成失败按 `retry_minutes` 重试；模型一直不可用时发一份不经过模型的原始数据版。
- 定时存在 `data/schedules.json`，也可以手动编辑。

发 `/brief` 可以随时生成一份。其他命令见 `/help`；不以 `/` 开头的文字都当成问题，比如“今天要带伞吗”“第二条新闻展开讲讲”。想看某条新闻的原文总结，用 `/more`（见第 10 节）。

## 7. 让 Mac 在早报时间醒着

Mac 睡着时 Docker 和 Ollama 都停着，早报发不出去。程序在容器里，没法像直接运行那样用 `caffeinate` 阻止睡眠；用 `pmset` 定时唤醒的话，Mac 一分钟左右又会睡着，来不及生成。所以推荐**插电时不自动睡眠**（显示器照常关闭）：

```sh
sudo pmset -c sleep 0
```

或者在“系统设置 → 电池（台式机是“节能”）→ 选项”里打开“显示器关闭时，防止自动进入睡眠”。

Mac 睡过了某个定时，醒来后在补发窗口（`catch_up_hours`）内仍会补发；过了窗口都没醒，那个定时当天就不发了。

## 8. 日历

把日历的 .ics 订阅地址填进 `calendar.ics_urls`（可以填多个，`webcal://` 会自动转成 `https://`）。**这些链接等同于钥匙**：拿到链接的人不用登录就能看到你的全部日程，不要发给别人，也不要提交到 git。程序在日志里会把它们打码。

- **Google 日历**：网页版 → 右上角齿轮“设置” → 左边选你的日历 → “集成日历” → 复制 **“iCal 格式的私密地址”**（不是“公开地址”）。
- **Outlook / Microsoft 365**：网页版 Outlook → 设置 → 日历 → 共享日历 → “发布日历”，选日历和“可以查看所有详细信息”，点“发布”，复制 **ICS** 链接。
- **iCloud**：Mac 上的“日历”App，右键日历 → “共享日历…” → 勾选“公开日历”，复制 `webcal://` 链接。注意“公开”的意思是任何拿到链接的人都能看。

日历链接写在个人配置 `users/<名字>/config.toml` 的 `ics_urls` 里，改完 `docker compose restart <名字>`，用 `/refresh` 检查。

## 9. 历史早报

- 在聊天里发 `/history` 看最近有早报的日期，`/history 11-02` 或 `/history 昨天` 看那天的早报。
- 文件在 `users/<名字>/data/archive/日期/` 下：
  - 定时早报：`brief-scheduled-0800.md`（`0800` 是定时的时间）；
  - 手动早报（`/brief`、`--once`）：`brief-manual-093015.md`（生成时的时分秒）；
  - 每份早报旁边有同名的 `raw-*.json`（各数据源的原始数据、新闻挑选结果）和 `input-*.txt`（发给模型的完整提示词和数据）。
- `.md` 文件开头有 YAML 属性，可以直接用 Obsidian 打开 `users/<名字>/data/archive/` 浏览。
- `archive.retention_days`（默认 90）：超过天数的归档在发送定时早报后删除；`0` 表示永久保留。

## 10. 新闻来源

`news.feeds` 里填 RSS 或 Atom 地址。怎么找：

- 网站上的 RSS 图标或“订阅”链接；
- 试试常见路径：`/feed`、`/rss`、`/rss.xml`、`/atom.xml`、`/index.xml`；
- 网页源码里搜 `application/rss+xml`，`href` 就是地址；
- 没有 RSS 的网站可以看看 RSSHub（<https://docs.rsshub.app>）有没有对应的路由。

早报里每条新闻是 `- **3** 来源 | 中文标题 | 中文副标题 [原文]`，前面的数字是 `/more` 用的编号（见下面“深入看某条新闻”）。来源默认是 feed 自己的标题，很多看不出是哪家（CNBC 叫 “US Top News and Analysis”，ABC 叫 “Top Stories”），可以起个短名：

```toml
feeds = [
  { url = "https://www.cnbc.com/id/100003114/device/rss/rss.html", name = "CNBC" },
  { url = "https://www.scmp.com/rss/4/feed", name = "SCMP" },
  { url = "https://www.scmp.com/rss/2/feed", name = "SCMP" },   # 同名也可以，仍然各自轮流
  "https://hnrss.org/frontpage?points=200",                     # 不写名字就用 feed 的标题
]
```

名字不能写成域名的样子（`interest.co.nz` 写成 `interest`），否则启动时会报错：看起来像域名的文字会被输出清理删掉。

用 `curl` 检查地址能不能用（有的 feed 是压缩的，要加 `--compressed`）：

```sh
curl -sL --compressed https://www.rnz.co.nz/rss/national.xml | head -20
```

能看到 `<rss` 或 `<feed` 开头的 XML 就对了。

- `max_age_hours`（默认 48）：只要最近多少小时发布的；没有发布时间的条目保留。
- `select_count`（默认 40）：候选池大小。按源轮流挑，一个源更新多也挤不掉别的源；源多时调大，让每个源都有机会进来。
- `brief_count`（默认 10，`select_count` 更小时取 `select_count`）：早报里写几条。`select_count` 不大于它时不让模型挑，日志里会提示。候选多于这个数时，模型只看候选的来源和标题，挑出这几条并按重要性排好（挑法写在 `src/llm/prompts.ts` 的 `SELECT_PROMPT`），写早报时全部写进去。模型挑选失败或超时（`select_timeout_seconds`，默认 120 秒）时，用按源轮流的前几条，早报照常发。
- `interests` 和 `avoid`：模型挑选时优先选感兴趣的话题，不想看的话题除非是大新闻否则不选；兴趣以外的大新闻（重大灾害、选举结果、本地紧急事件）也会保留。写具体的话题效果更好，比如“奥克兰交通”好过“新闻”、“美联储利率”好过“经济”。两项都可以留空，这时只按重要性和覆盖面挑。
- `dedup_days`（默认 3）：最近几天早报里**实际写到**的新闻不再出现；同一天后面的早报也不重复前面的。
- **深入看某条新闻**：发 `/more 3`（`#3`、`N3`、`第3条`、全角数字也行），或者写描述，例如 `/more 加州富人税`、`/more Kiwibank`，由模型认出是哪条。机器人会读那条新闻的原文，用本地模型写一段不超过 400 字的总结，开头是来源和原文标题，最后是原文链接；之后可以接着追问。
  - 编号指**当天最近一份**早报：中午又发过 `/brief` 的话，`/more 3` 是中午那份的第 3 条。回复开头的标题对不上就是选错了。
  - 读不到原文时（付费墙、拦截程序访问的网站如 SCMP、Economist，NYT 也经常拦，要 JavaScript 才显示正文的如 Stuff，Google News 的跳转链接如 Reuters、AP），只根据 RSS 摘要写，并在开头说明原因。
  - 2026-11-13 实测（qwen3.6:35b）：读到 2000 字左右的原文时，读网页加写总结约 3 秒，只用摘要时约 1 秒。原文越长越慢，期间模型被占用，其他问题和别人的早报会排在后面。
- 想知道某天为什么是这几条：看那天的 `raw-*.json` 里的 `news`：`candidates` 是全部候选，`tooOld` 是太旧被过滤的，`dedupExcluded` 是因为最近用过被排除的，`poolSize` 是候选池的条数，`method` 是挑选方式（`model` 模型挑选、`round_robin` 没有调用模型、`round_robin_fallback` 模型失败后按源轮流），`selected` 是写早报用的，`usedIds` 是早报里实际写到的。

## 11. 旅行时切换位置

- `/city Shanghai`：切换到上海。天气、日期和定时都按上海的当地时间算，`/schedule add 08:00` 的早报就在上海时间 08:00 发。用英文城市名；切错了（同名城市）就加上国家，例如 `/city Wellington New Zealand`。
- `/where`：当前城市、当地时间和下次早报时间。
- `/home`：回到 `config.toml` 里的家。

## 12. 长时间外出前的检查清单

Mac 留在家里无人照看时：

- **插电时永不睡眠**：`sudo pmset -c sleep 0`。旅行时定时按当地时间，换算成奥克兰时间会变（比如北京时间 08:00 是奥克兰时间 13:00），一直醒着最省事。
- **停电后自动开机**：`sudo pmset autorestart 1`。
- **重启后程序不一定会运行**：Docker Desktop 和 Ollama 要有用户登录才会启动；开了 FileVault 时，开机会停在密码界面，要等人回来输入密码。出门期间在“系统设置 → 通用 → 软件更新”里关掉自动安装更新，避免系统更新重启后卡住。
- **准备远程登录**：安装 Tailscale，开启“系统设置 → 通用 → 共享 → 远程登录”，出问题时可以 SSH 回去 `docker compose logs`、`docker compose restart`。
- **出发前演练一次**：`/city` 切到目的地，确认回复里的国家和下次早报时间对，再 `/brief`，确认天气已经换成目的地，最后 `/home` 切回来。
- **配好健康检查**（第 17 节）：停电、Docker 没起来这类情况无法完全避免，至少要能及时知道。出门前把检查的宽限时间调长（比如 12 小时），因为旅行时发送时间换算成奥克兰时间会变。
- **去中国大陆**：手机上收 Discord 或 Telegram（以及 Tailscale）需要 VPN；Mac 留在奥克兰，抓取数据不受影响。

## 13. 常见问题

- **每句话收到两份回复，或者早报发了两次**：有两个程序登录了同一个机器人。通常是本机 `pnpm start` 用了容器里某个人的 token，或者两个人的 `.env` 填了同一个 token。停掉本机的程序或换成各自的机器人。
- **日志说 `app.lock 属于另一台机器或容器`，或“另一个实例正在运行”**：同一个数据目录只能有一个程序在跑。通常是两个服务挂了同一个 `users/<名字>/data/`，或者容器在运行时又在本机用同一个目录 `pnpm start`。停掉其中一个。如果确认都已经停了，删掉那个目录里的 `app.lock` 再启动。`brief:dry` 和 `--once` 不受影响，可以和常驻的程序同时用。
- **Telegram 返回 409**：同一个 bot token 有两个程序在收消息，停掉一个。
- **容器连不上 Ollama**：在 Mac 上运行 `curl http://localhost:11434/api/version`，没有返回就是 Ollama 没开；返回了就检查 `ollama.model` 和 `ollama list` 是否一致。
- **早报内容不全或胡编**：检查 `ollama.num_ctx`。Ollama 默认上下文很短，输入超长时会悄悄截掉一部分；日志里有“超过 num_ctx 的 75%”时，调大 `num_ctx` 或减少 `select_count`。
- **改了配置没生效**：改了 `config.toml` 或 `config.shared.toml` 要 `docker compose restart`；改了 `.env` 要 `docker compose up -d <名字>`。
- **没收到定时早报**：先看 `/schedule` 有没有定时、`/where` 的下次时间对不对，再看 `docker compose logs` 里那个时间前后的记录。最常见的原因是 Mac 睡着了（见第 7 节）。

## 14. 隐私

- 模型在你自己的 Mac 上运行，日程、待办不会发给任何模型服务商。
- 但早报和对话内容会经过 Discord / Telegram 的服务器。
- `users/` 里有每个人的日程、待办和早报的明文，以及 token 和日历链接：不要放进同步盘，不要提交到 git（`.gitignore` 已经排除）。同一台 Mac 上的人，管理员能看到所有人的数据。

## 15. 数据和备份

每个人的数据都在 `users/<名字>/data/`（容器里的 `/app/data`，`paths.data_dir` 的默认值），每个文件的作用见 [`data/README.md`](data/README.md)。迁移时复制 `config.shared.toml` 和整个 `users/` 即可。待办文件是 `users/<名字>/data/todo.md`，想用 Obsidian 编辑就打开这个文件。

- **Mac 上**：Time Machine 会备份项目目录，包括 `users/`。
- **服务器上**：用云盘快照，或者每天用 `restic`（或 `rclone`）把 `data/` 加密备份到对象存储。例如 crontab：

  ```cron
  # 每天 03:00 加密备份，保留 30 天
  0 3 * * * RESTIC_REPOSITORY=s3:https://s3.example.com/morning-brief RESTIC_PASSWORD_FILE=$HOME/.restic-pass restic backup /srv/morning-brief/users /srv/morning-brief/config.shared.toml && RESTIC_REPOSITORY=s3:https://s3.example.com/morning-brief RESTIC_PASSWORD_FILE=$HOME/.restic-pass restic forget --keep-daily 30 --prune
  ```

  里面有日程和待办等私人数据，备份一定要加密（restic 默认加密）。

- 数据目录必须挂载到容器外（`compose.yaml` 已经这样做）。不要部署到 Cloud Run、Lambda 这类无状态平台：容器重启后数据会丢，定时也会重复发。

## 16. 多人使用

一人一个容器，共用 Mac 上的同一个 Ollama。加一个人：

```sh
scripts/add-user.sh alice
```

它会建好 `users/alice/`（`config.toml`、`.env`、`data/`），在 `compose.override.yaml` 里加上 alice 的服务，并打印接下来的步骤：

1. 给 alice 建一个**她自己的** Discord 机器人（第 3 步），token 填进 `users/alice/.env`。每个人要有自己的机器人：同一个 token 被两个容器登录时，每个容器都会收到所有人的私信。
2. 改 `users/alice/config.toml`：家的城市和时区、日历、兴趣（`interests`、`avoid`），想多订几个源就写 `extra_feeds`。
3. `docker compose up -d alice`，让 alice 私信机器人拿到用户 ID，填进 `.env` 后再 `docker compose up -d alice`。
4. 让 alice 在聊天里设置定时，和别人错开几分钟：模型一次只处理一个请求，大家都在 08:00 时后面的人要排队（qwen3.6:35b 一份早报约 10 秒；换模型前用 qwen3:32b 实测，两人同时发时后面的人多等约 45 秒）。不要靠调高 Ollama 的 `OLLAMA_NUM_PARALLEL` 来解决：64GB 的 Mac 加载模型后空闲内存不到 1 GB，并发会再多占内存。

其他：

- 所有人共用 `config.shared.toml` 里的模型和 `num_ctx`，个人配置里不能写 `[ollama]`，否则 Ollama 会反复切换模型，非常慢。人多时调大 `timeout_seconds`，排队时间也算在里面。
- 每个人的服务在 `compose.override.yaml` 里（不进 git，`docker compose` 自动读取），继承 `compose.yaml` 里的模板 `template`，只写名字、`hostname`、`.env` 和挂载。删掉一个人：`docker compose rm -sf alice`，再从 `compose.override.yaml` 删掉那一段，`users/alice/` 按需备份后删除。
- 只操作某一个人：`docker compose restart alice`、`docker compose logs -f alice`。

更多考虑见 PLAN.md 阶段 9 和第 7 节“多用户部署”。

## 17. 监控（健康检查）

早报没发出来时，程序没法通过聊天告诉你（可能正是聊天渠道出了问题，或者程序根本没在运行），所以交给外部的健康检查服务，例如免费的 [healthchecks.io](https://healthchecks.io)：

1. 给每个人建一个检查，把 ping 地址填进这个人的 `users/<名字>/config.toml`：

   ```toml
   [monitor]
   healthcheck_url = "https://hc-ping.com/…"
   ```

   然后 `docker compose restart <名字>`。这个地址谁拿到都能报“正常”，当作秘密，日志里会自动隐藏。

2. 设好检查的周期和宽限时间：
   - **周期**：最简单的是 1 天，能发现程序停了、Mac 睡着了；但一天有多个定时时，漏了其中一个发现不了。想每个定时都检查，就选 cron 写法列出所有定时，例如 `0 8,14,20 * * *`，时区选 Pacific/Auckland；用 `/schedule` 改了定时也要跟着改。只在工作日的定时一定要用 cron（例如 `0 8 * * 1-5`），否则周末会误报。
   - **宽限时间**：至少 1 小时（失败会重试几次，还要算上生成时间）。

程序在每次定时早报发出后（包括降级早报）报一次“正常”；重试用完仍有渠道没收到、或者到补发截止时间还没成功时，马上报“失败”（请求 `<地址>/fail`），不用等宽限时间。请求里带一句说明，例如“08:00 每天 的定时早报已发送”，在 healthchecks.io 的事件记录里能看到。手动 `/brief` 不报。请求失败只在日志里记一条警告，不影响早报。

## 18. 待办接 Microsoft To Do

待办默认存在 `todo.md` 里，用 `/add`、`/done` 管理。也可以改用 Microsoft To Do：增删改都在 To Do App 里做，机器人只读（早报、聊天和 `/todo` 读它），待办只存一个地方。

1. **注册应用**（一次，大家共用；免费，但个人微软账号要先有一个目录，注册免费 Azure 账户就有）。共用的只是应用的身份（client ID），每个人用自己的微软账号登录，只读得到自己的待办：
   - 在 [Microsoft Entra](https://entra.microsoft.com) →“应用注册”→“新注册”，账户类型选“仅个人 Microsoft 帐户”，重定向 URI 不填。
   - “身份验证”→“设置”：打开“允许公共客户端流”。
   - “API 权限”→ Microsoft Graph →“委托的权限”：加 `Tasks.Read` 和 `offline_access`。只有读权限，机器人改不了你的待办。
   - 把“概述”页的“应用程序（客户端）ID”填进 `config.shared.toml`（想用自己注册的应用的人，在个人配置里写同样的 `[microsoft]` 覆盖）：

     ```toml
     [microsoft]
     client_id = "…"
     ```

2. **这个人的配置**（`users/<名字>/config.toml`），然后 `docker compose restart <名字>`：

   ```toml
   [todo]
   backend = "ms_todo"
   lists = ["Tasks"]   # 读哪些列表；不写就读默认列表
   ```

3. **登录**：在聊天里发 `/todo_login`，机器人回复一个网址和验证码，在浏览器里打开、输入验证码、用你的微软账号登录并同意。成功后机器人会说读到了几条待办。登录凭证存在这个人的 `data/ms-token.json`，之后自动续期。

- **按艾森豪威尔矩阵分组**：标了星（⭐）的算重要；已过期、今天截止或 `urgent_days`（默认 3，旧名字 `brief_days` 也认）天内截止的算紧急，没有截止日期的不算紧急。`/todo` 分成“🔥 重要且紧急”“📅 重要不紧急”“⚡ 紧急不重要”“💤 其他”四组，空的组不显示。
- **早报只写紧急的**：“重要且紧急”在前，“紧急不重要”在后。截止日期更远的、没有截止日期的（包括标了星的）不写进早报，免得每天看到同样的长清单；`/todo` 和聊天时问待办仍然是全部。
- **每周回顾**：个人配置的 `[todo]` 写 `review_day = "sun"`（`"mon"`…`"sun"`），那天的早报在待办之后多一段“🗓 本周回顾”，列出标了星但不急的待办（重要不紧急），提醒这周给它们排时间。按当前所在地的星期几算；那天的每一份早报都带，包括 `/brief`；那天早报没发出去就跳过这周。没有这类待办时早报和平时一样。默认不写，不回顾。
- 每组里有截止日期的排在前面（“还有 3 天”“今天截止”“已过期 2 天”），按日期排。读多个列表时会写上列表名。
- `/add`、`/done` 会提示去 App 里改。`todo.md` 不再读取，也不会被删除。
- 登录失效（长期不用，或者在 [账户的应用授权](https://account.live.com/consent/Manage) 里撤销了）时，早报的待办部分写“待办获取失败”并提示重新 `/todo_login`，其他部分照常。
- 待办本来就存在微软的服务器上；模型仍在本机，待办只发给本地模型。

## 设计说明

代码按模块分目录，每个模块只通过 `index.ts` 对外，依赖只能指向更底层的模块；完整的目录说明和规则见 PLAN.md 第 3 节，`pnpm lint` 会检查。

### 日历库：node-ical

阶段 2 开始前对比了 `node-ical` 0.27.3 和 `ical.js` 2.2.1（2026-11-03），fixture 在 `test/fixtures/calendar/`，在 `TZ=UTC` 和 `TZ=Pacific/Auckland` 下各跑一遍：

| 场景                                                                     | node-ical | ical.js                             |
| ------------------------------------------------------------------------ | --------- | ----------------------------------- |
| 奥克兰夏令时切换日的每日重复事件（09:00 从 21:00Z 变为 20:00Z）          | ✅        | ✅                                  |
| EXDATE 排除某一天                                                        | ✅        | ✅                                  |
| RECURRENCE-ID 改到同一天的另一个时间、改到另一天                         | ✅        | ✅                                  |
| Outlook 的 Windows 时区名（`New Zealand Standard Time`），没有 VTIMEZONE | ✅        | ❌ 当作浮动时间，结果随系统时区变化 |
| IANA 时区名（`Asia/Shanghai`），没有 VTIMEZONE                           | ✅        | ❌ 同上                             |

选用 node-ical：全部通过，而且结果不依赖运行机器的时区，符合“可移植性”的要求。它的 `expandRecurringEvent()` 自带 EXDATE 和 RECURRENCE-ID 处理。

node-ical 把全天日期和浮动时间（没有 TZID 也没有 Z 的时间）按运行机器的时区解析。`sources/calendar/expand.ts` 用本地时间字段把它们读回来，再放到当前生效的时区里重新计算，并用前后各放宽两天的窗口展开重复事件，最后自己按“与今天有重叠”过滤。测试在 `TZ=UTC`、`Pacific/Auckland`、`America/Los_Angeles`、`Asia/Kolkata` 下结果都一样。状态为 `CANCELLED` 的事件不显示。

### 新闻

- `sources/news/` 只抓取，返回全部候选；新闻编号 `N1`、`N2`…… 在挑选之后由 `numberNews()` 分配，所以编号总是连续的，只覆盖交给模型的那几条。
- Google News 的 feed（例如用来订阅 Reuters、AP）摘要只是把标题再写一遍，早报里会出现两次一样的标题；摘要只是重复标题时当作“只有标题”（`repeatsTitle`）。
- hnrss 的摘要只有 `Article URL`、`Points` 这些元数据，清理后为空的条目标记为“只有标题”，给模型的文本里写“（只有标题）”。
- **挑新闻和写早报分成两次模型调用**（2026-11-05）。一开始让模型在写早报时从几十条候选里挑，qwen3:32b 明显偏向编号靠前的条目：44 个源、50 条候选、提示词写明“编号顺序不代表重要性”“覆盖不同地区”，3 次 `brief:dry` 选的还是前十几条（科技和美国新闻）。现在先单独调用一次，只给编号、来源和标题让它挑（`C1`、`C2`…，和早报里的 `N1`… 区分开），再把挑中的按它给的顺序重新编号交给写早报那一步，写早报时不再挑。
- 模型给的编号里，不存在和重复的忽略、多的截断；能用的不到 `brief_count` 一半算失败，够一半但不满时用按源轮流顺序里没选上的补满。
- **新闻的来源由程序加，不让模型写。** 模型只写“中文标题 | 中文副标题 [N3]”，清理输出时按编号查到来源，补在行首（`sanitizeBrief`）。原因是模型会翻译来源名（“New Zealand Herald”写成“新西兰先驱报”）；来源本身也来自 feed，同样要清理：去掉链接和 Markdown 符号，`|` 换成空格；域名不删，把点换成全角（“Latest stories from interest．co．nz”），能看懂但不会变成链接，也不会像模型输出里那样被删成“来自 的最新消息”。只给列表行（`- `、`1.`、`1、` 开头）加来源，开头总览里引用新闻的句子不加。模型照样写了一模一样的来源时不会重复，写的是翻译过的来源就会出现两次，提示词里明确要求不写。
- 按源轮流按订阅地址分组，不按名字，所以几个源起同一个名字时仍然各自有机会。
- **人名会被翻译（基本解决）。** 提示词要求人名照抄原文，qwen3:32b 仍会把 Trump 写成“特朗普”、Vance 写成“万斯”，有一次还把 JD Vance 的话写成了“拜登”说的。2026-11-10 换成 qwen3.6:35b 后，3 次测试只有 1 处（有通行中文名的“黄仁勋”）。点“原文”可以核对。
- **已知情况：热门话题会占好几条。** 筛选提示词要求同一件事只选一条，qwen3:32b 只部分做到（2026-11-05 实测，美国中期选举 10 条里占 5–6 条，同一起本地事件偶尔两家媒体各一条）。可以接受：占得多说明那个话题确实热门。
- 降级早报（模型不可用时）不调用模型挑选，直接用按源轮流的前 `brief_count` 条，全部列出。
- 链接规范化时去掉 `utm_*`、`at_*`（BBC 加的）、`fbclid`、`gclid`、`mc_cid`、`mc_eid` 和末尾的 `/`。
- BBC 中文简体 feed（`/zhongwen/simp/rss.xml`）在 2026-11-03 已经 301 跳转到繁体 feed，`fetch` 会自动跟随；模型照样用简体写早报。
- **`/more` 读原文**（阶段 8.7）：正文用 `@mozilla/readability` 提取，DOM 用 `linkedom`（比 jsdom 轻很多）。2026-11-12 用当天 39 个来源各一条真实链接验证：26 个读到了正文（RNZ、BBC、Guardian、Newsroom、Interest、ABC、NPR、Wired、The Verge、Foreign Policy、Hacker News 指向的文章等，多数 2000–10000 字）；读不到的是 403 拦截（SCMP、NYT、Economist、Politico、The Diplomat、Times of Israel、Seeking Alpha）、Google News 跳转（Reuters、AP，要 JavaScript）、要 JavaScript 显示正文（Stuff）、视频页（Al Jazeera 的视频新闻，正文太短）。User-Agent 照常写明是本程序，不伪装成浏览器去绕过拦截。读不到的退回 RSS 摘要。NYT 不是每篇都拦：2026-11-14 有一篇读到了原文。
  - 只读当天早报里那条新闻的链接；网页限 2 MB（边读边计，不靠 Content-Length），按 Content-Type 或 `<meta charset>` 解码（GBK、Big5 也行）；正文不到 300 字当作没读到。
  - 给模型的正文最多约 6000 token：几个容器共用一个 Ollama，一次只处理一个请求，长文会让别人的早报排队。
  - 编号写成 `- **3**`，不写 `3. `：Discord 会把 `3.` 当成有序列表重新编号，模型漏写一条时显示的数字就和 `/more` 的编号对不上了。
- 一个源失败时拿不到 feed 标题，失败提示里用域名的主要部分指代它（例如 `www.rnz.co.nz` 写成 `rnz`）。不用完整域名，因为模型输出清理会删掉看起来像域名的文字（见“提示注入”）。

### 待办

- 两种后端：`todo.md`（可写）和 Microsoft To Do（只读，见第 18 节）。只读是有意的：待办只存一个地方，不做双向同步。
- Microsoft To Do 的截止日期只有日期，但接口返回的是一个时间：要么是那个时区的 0 点（直接取写着的日期），要么是用户当地的 0 点换算成 UTC（实测奥克兰的 11月19日返回 `2026-11-18T11:00:00`，UTC）。程序遇到 0 点就取写着的日期，其他时间换算到家里的时区再取日期，UTC 以东和以西都对；接口给的是 Windows 时区名时直接取写着的日期。
- 设备码登录：`/todo_login` 先回复验证码，再在后台每隔几秒问一次 Microsoft 登录好了没有，最多等 14 分钟（Discord 的命令回复 15 分钟后失效）。刷新令牌每次刷新都会换新的，所以同一个人的刷新排队进行；`pnpm dev:dry` 只用不写回，免得替换掉容器正在用的凭证。

- `- [ ]` 和 `* [ ]` 都算待办，缩进的子任务也算，序号按文件顺序。内容为空的 `- [ ]` 不算。
- 所有读写在进程内排队执行，同时到达的 `/add` 和 `/done` 不会互相覆盖。

### 提示注入

`sources/gather.ts` 把各小节内容里出现的 `<数据`、`</数据` 换成全角 `＜`，这样日历标题或新闻里写的 `</数据>` 不能提前结束数据小节。

### 模型输出清理

模型的输出（早报和聊天回复）先删掉所有网址：Markdown 链接只保留文字，`https://…`、`<https://…>` 和看起来像域名的文字（`evil.com/login`、`www.…`，常见后缀）都删掉，因为 Telegram 会把裸域名也显示成链接。然后才把 `[N3]` 换成 `[原文](真实链接)`，不存在的编号直接删掉。早报输入超过 `num_ctx` 的 75% 时从末尾减少新闻条数，并记一条 warn。

### 早报质量检查（qwen3:32b，2026-11-03）

用当天真实数据（奥克兰天气、示例待办、BBC 中文、RNZ、Hacker News、Karpathy）连续生成 3 份早报，后两份排除前面用过的新闻，共 16 条新闻逐条对照原文。每份 16–30 秒。

- 没有编造数字，引语按原意翻译，只有标题的 HN 条目没有被编出内容，编号全部替换成了正确链接。
- **问题 1**：紫外线指数 7 被写成“中等”（WHO 标准是“高”）。改为在天气文本里直接写 `紫外线指数 7（高）`，之后 3 份都对。
- **问题 2**：BBC 中文 feed 是繁体，模型有一次把 3 条新闻照抄成繁体。在提示词里加了“繁体新闻也要改写成简体”，用同一份输入重试 3 次，繁体字都是 0。
- **问题 3**：提示词示例里的新闻恰好是当天的真实新闻，模型原样照抄了。今天没错，但以后可能把示例当成新闻写进早报，所以示例标题改为“只演示格式和语气，示例里的新闻不是今天的数据”。
- **已知问题：专有名词误译。** Southland Hospital 被译成“南地医院”，有一次甚至是“南兰开夏医院”（South Lancashire，完全是另一个地方）。把规则从“中文后括号保留英文”改成“只有熟知的译名才用中文，其他直接写英文”后重试 3 次，人名 David 保留了英文，医院名仍然 2 次“南地”、1 次“南兰开夏”。只靠提示词解决不了，记录下来，以后换模型或调整时再看。点“原文”可以核对。
- 小问题，暂不处理：偶尔对分时天气做一点过度解读（“下午雨势稍弱”）；新闻链接的位置偶尔放在句首。

### 归档

- `archive/日期/` 下每份早报三个文件 `brief-*.md`、`raw-*.json`、`input-*.txt`：定时早报带定时的时间（`brief-scheduled-0800.md`），手动早报（`/brief`、`brief:once`）带生成时的时分秒（`brief-manual-093015.md`），重名时加 `-2`。阶段 6 之前的 `brief.md` 照样能读。
- `brief-*.md` 开头是 YAML front matter（生成时间、类型、定时、城市、时区、模型、是否降级），在 Obsidian 里显示为笔记属性。
- `raw.json` 记录各数据源给模型的文本和结构化数据；新闻部分记录全部候选、因太旧被过滤的、因跨天去重被排除的、给模型的编号和链接（`selected`）、早报里实际提到的编号（`usedIds`）。
- 跨天去重只排除前几天早报里**实际提到**的新闻（`recentUsedNewsLinks`），给了模型但没写进早报的新闻第二天还能出现。
- 降级早报（不经过模型）的 `input.txt` 是空的。

### brief:dry

`brief:dry` 和 `dev:dry` 不连接任何聊天渠道，所以 token 可以不填，渠道也可以都不开。它只打印，不写归档；但待办文件不存在时会创建它。

### 聊天渠道

- Telegram 和 Discord 共用 `chat/core/` 里的命令和对话逻辑；`chat/telegram/`、`chat/discord/` 只负责收发和检查发送者。
- 只处理主人本人的私聊/私信，群组、服务器频道和陌生人的消息一律忽略（记日志，不回复）。主人 id 没配置时，谁发消息都只回复对方的 id。
- Discord 的用户 ID 超出 JS 能精确表示的整数范围，所以配置里是字符串。
- Discord 的 slash 命令只允许在和机器人的私信里用；以 `/` 开头的普通文字也按命令处理。slash 命令要在 3 秒内确认，所以先 `deferReply`，生成完再编辑回复。
- 消息先按段落、再按行切分（Telegram 按转换成 HTML 后的长度算 4000，Discord 2000），不会切断 `[原文](链接)`。Discord 每条消息都关掉链接预览，Telegram 也一样。
- 两个渠道都开时，早报两边都发；一边发送失败不影响另一边，`SendError` 会列出失败的渠道（阶段 6 只对它们重发）。
- `data_dir/app.lock` 保证同时只有一个 `pnpm start`：Discord 允许同一个 token 多个连接，两个实例会把每条消息回复两遍。进程意外退出留下的锁会被下次启动接管。`brief:once` 不加锁，它只发送、不接收消息。
- 模型正在生成早报时提的问题，会等早报发出后再回答，用的是这份新早报的新闻。
- 启动时 Ollama 检查不通过只记警告、继续运行（开机时 Ollama 可能还没起来），真正请求时再报错。

### 定时

- `schedules/` 只管定时本身（存储、校验、发送窗口），`scheduler/` 每 30 秒检查一次并运行。每次检查都重新读位置、`schedules.json` 和 `state.json`，所以 `/city`、`/schedule` 马上生效，重启也不会重复发。
- 每个定时的发送窗口从它的时间开始，持续 `catch_up_hours`，但不超过当天会生效的下一个定时，也不跨过午夜；所以任何时刻最多一个定时在窗口内，睡过几个定时醒来只补最近的那个。
- `state.json` 按定时 id 记录发过的日期、重试次数和没发出去的早报（`pendingBrief`，只重发给失败的渠道）。先发送、成功后才记为已发送：如果正好在这两步之间被杀，重启后会再发一份，宁可重复不要漏发。
- 模型失败、下一次重试又来不及时，直接发降级早报。
- 同一天后面的早报不会重复前面早报讲过的新闻（`recentUsedNewsLinks` 把当天的早报也算进去）。
- 退出时（Ctrl-C、SIGTERM）先停定时器，等正在生成的早报和回复最多 30 秒，再断开渠道。

### Docker

- 镜像里直接用 `node --import tsx src/index.ts` 运行，不经过 pnpm 或 tsx 的命令行包装：这样 Node 是容器的 1 号进程，`docker stop` 的 SIGTERM 直接到程序，能正常等早报完成再退出。`tsx` 因此是运行时依赖。不另外编译成 JS，少一步构建，开发和容器里跑的是同一份代码。
- `compose.yaml` 的 `stop_grace_period: 40s`：Docker 默认 10 秒后强杀，程序退出时最多要等 30 秒。
- 容器的时区是 UTC，不影响：程序所有时间计算都按当前生效的城市时区。
- 容器里 `keepAwake` 不会运行（不是 macOS），所以 Mac 要靠 `pmset` 保持醒着（第 7 节）。
- `app.lock` 记录主机名。容器和本机共用 `data/`，彼此看不到对方的进程，所以别的主机名留下的锁一律不接管，让用户确认后手动删除。容器的主机名在 `compose.yaml` 里固定、程序总是 1 号进程，所以容器崩溃留下的锁会被重启后的容器自己接管，不需要手动处理。Mac 的主机名可能随网络变化，这时本机崩溃留下的锁也要手动删一次。
- `ollama.host` 用 `MORNING_BRIEF_OLLAMA_HOST` 覆盖，而不是 Ollama 自己的 `OLLAMA_HOST`：后者常被设成 `0.0.0.0` 这类给 Ollama 服务端用的值。
