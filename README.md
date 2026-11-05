# 早报助手

每天按你设的时间，把天气、日程、待办和新闻整理成一份中文早报，通过 Discord（或 Telegram）私信发给你；之后可以直接在对话里追问。早报由你自己电脑上的本地模型（Ollama）生成。

程序在 Docker 里常驻运行，Ollama 在 Mac 本机运行。下面按第一次安装的顺序写。

## 1. 准备

1. **Docker Desktop**：从 <https://www.docker.com/products/docker-desktop/> 安装。打开 Settings → General，勾选 **Start Docker Desktop when you sign in to your computer**，这样 Mac 重启登录后程序会自己起来。
2. **Ollama**：从 <https://ollama.com/download> 安装，确认它在“系统设置 → 通用 → 登录项”里（安装时默认会加上）。然后下载模型：

   ```sh
   ollama pull qwen3:32b
   ```

   模型名以 <https://ollama.com/library> 为准。qwen3:32b 需要约 20 GB 内存；内存小的 Mac 可以换 `qwen3:14b` 或 `qwen3:8b`，早报质量会差一些。

3. **Node 24 和 pnpm**（可选）：只用来在本机跑 `pnpm brief:dry` 试早报和跑测试。只用 Docker 可以不装，第 4 步有对应的 Docker 命令。

   ```sh
   corepack enable   # pnpm 的版本由 package.json 固定
   pnpm install --frozen-lockfile
   ```

## 2. 配置文件

```sh
cp config.example.toml config.toml
```

至少要改：

- `ollama.model`：和 `ollama list` 显示的名字一致，例如 `qwen3:32b`；
- `[brief]` 里的 `timezone`、`city`、`latitude`、`longitude`：你“家”的位置；
- 聊天渠道的 token 和 id：见第 3 步。

日历、新闻等其他设置见第 8、10 节，文件里每一项都有注释。`config.toml` 里有 token 和私密日历链接，已经在 `.gitignore` 里，不要发给别人。

`ollama.host` 保持 `http://localhost:11434` 就行：在 Docker 里运行时，`compose.yaml` 用环境变量 `MORNING_BRIEF_OLLAMA_HOST` 把它换成 `http://host.docker.internal:11434`（容器访问 Mac 本机的地址）。

## 3. 创建聊天机器人

Discord 和 Telegram 至少开一个；都开时早报两边都发，在哪边提问就在哪边回复。

### Discord

1. 打开 <https://discord.com/developers/applications>，点 **New Application**，起个名字（例如“早报”）。
2. 左边点 **Bot**：
   - 点 **Reset Token**，复制 token，填进 `config.toml` 的 `discord.bot_token`。token 等于机器人的密码，不要发给别人；泄露了就再点一次 Reset Token。
   - **Privileged Gateway Intents** 下面三个开关都不用开（私信内容不需要特权）。
3. 左边点 **Installation**：**Installation Contexts** 只勾 **Guild Install**；**Install Link** 选 **Discord Provided Link**；**Default Install Settings** 的 Scopes 选 `bot` 和 `applications.commands`，Permissions 选 `Send Messages`。保存。
4. 在 Discord 里自己建一个服务器（左边栏的“+”→ 亲自创建 → 仅供我和我的朋友使用），只有你一个人也可以。
5. 复制第 3 步页面上的 Install Link，在浏览器打开，把机器人加到这个服务器。你和机器人要在同一个服务器里，它才能私信你。
6. 确认 `config.toml` 里 `[discord]` 的 `enabled = true`，`user_id` 先留空。

`user_id` 在第 5 节启动后获取。

### Telegram（可选）

> Telegram 适配有完整的单元测试，但还没有在真机上验证过。

1. 在 Telegram 里找 **@BotFather**，发 `/newbot`，按提示起名字，拿到 token，填进 `telegram.bot_token`。
2. `[telegram]` 里 `enabled = true`，`chat_id` 先留 `0`。

`chat_id` 在第 5 节启动后获取。

## 4. 先试一份早报

不连聊天渠道，只在终端打印给模型的数据和生成的早报（不发送、不写归档）：

```sh
pnpm brief:dry
# 没装 Node 时用 Docker：
docker compose run --rm morning-brief node --import tsx src/index.ts --dry
```

第一次生成要先把模型读进内存，可能要一两分钟；之后一份约 20–40 秒。看看天气、日程、待办对不对，新闻后面的“原文”链接能不能打开。

## 5. 启动

```sh
docker compose up -d --build
docker compose logs -f        # 看日志，Ctrl-C 退出查看（程序继续运行）
```

日志里出现 `Discord 已连接` 就好了。然后获取你的 id：

- **Discord**：在服务器成员列表里点机器人 → 发消息，随便发一句。它会回复你的用户 ID，填进 `discord.user_id`（要加引号）。
- **Telegram**：给机器人发 `/start`，它会回复你的 chat_id，填进 `telegram.chat_id`。

填好后：

```sh
docker compose restart
```

再给机器人发 `/help` 试试。Discord 里输入 `/` 会弹出命令菜单（第一次可能要等一会儿或重启 Discord 才出现）；直接打字发 `/todo` 这样的文字也可以。

常用的 Docker 命令：

| 做什么                     | 命令                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| 看日志                     | `docker compose logs -f --tail 100`                                       |
| 改了 `config.toml` 之后    | `docker compose restart`                                                  |
| 更新代码之后（`git pull`） | `docker compose up -d --build`                                            |
| 停止（不再自动启动）       | `docker compose down`                                                     |
| 立刻发一份早报到所有渠道   | `docker compose exec morning-brief node --import tsx src/index.ts --once` |

程序崩溃或 Docker Desktop 重启后，容器会自动重新运行（`restart: unless-stopped`）；`docker compose down` 之后要再 `up -d` 才会运行。日志最多保留约 30 MB，旧的自动删除。

## 6. 设置定时早报

定时只在聊天里设置，不在 `config.toml` 里。第一次启动时 bot 会私信提醒你设置。

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

发 `/brief` 可以随时生成一份。其他命令见 `/help`；不以 `/` 开头的文字都当成问题，比如“今天要带伞吗”“第二条新闻展开讲讲”。

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

改完 `config.toml` 后 `docker compose restart`，用 `/refresh` 或 `pnpm brief:dry` 检查。

## 9. 历史早报

- 在聊天里发 `/history` 看最近有早报的日期，`/history 11-02` 或 `/history 昨天` 看那天的早报。
- 文件在 `data/archive/日期/` 下：
  - 定时早报：`brief-scheduled-0800.md`（`0800` 是定时的时间）；
  - 手动早报（`/brief`、`--once`）：`brief-manual-093015.md`（生成时的时分秒）；
  - 每份早报旁边有同名的 `raw-*.json`（各数据源的原始数据、新闻挑选结果）和 `input-*.txt`（发给模型的完整提示词和数据）。
- `.md` 文件开头有 YAML 属性，可以直接用 Obsidian 打开 `data/archive/` 浏览。
- `archive.retention_days`（默认 90）：超过天数的归档在发送定时早报后删除；`0` 表示永久保留。

## 10. 新闻来源

`news.feeds` 里填 RSS 或 Atom 地址。怎么找：

- 网站上的 RSS 图标或“订阅”链接；
- 试试常见路径：`/feed`、`/rss`、`/rss.xml`、`/atom.xml`、`/index.xml`；
- 网页源码里搜 `application/rss+xml`，`href` 就是地址；
- 没有 RSS 的网站可以看看 RSSHub（<https://docs.rsshub.app>）有没有对应的路由。

用 `curl` 检查地址能不能用（有的 feed 是压缩的，要加 `--compressed`）：

```sh
curl -sL --compressed https://www.rnz.co.nz/rss/national.xml | head -20
```

能看到 `<rss` 或 `<feed` 开头的 XML 就对了。

- `max_age_hours`（默认 48）：只要最近多少小时发布的；没有发布时间的条目保留。
- `select_count`（默认 40）：候选池大小。按源轮流挑，一个源更新多也挤不掉别的源；源多时调大，让每个源都有机会进来。
- `brief_count`（默认 10）：早报里写几条。候选多于这个数时，模型只看候选的来源和标题，挑出这几条并按重要性排好（挑法写在 `src/llm/prompts.ts` 的 `SELECT_PROMPT`），写早报时全部写进去。模型挑选失败或超时（`select_timeout_seconds`，默认 120 秒）时，用按源轮流的前几条，早报照常发。
- `interests` 和 `avoid`：模型挑选时优先选感兴趣的话题，不想看的话题除非是大新闻否则不选；兴趣以外的大新闻（重大灾害、选举结果、本地紧急事件）也会保留。写具体的话题效果更好，比如“奥克兰交通”好过“新闻”、“美联储利率”好过“经济”。两项都可以留空，这时只按重要性和覆盖面挑。
- `dedup_days`（默认 3）：最近几天早报里**实际写到**的新闻不再出现；同一天后面的早报也不重复前面的。
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
- **去中国大陆**：手机上收 Discord 或 Telegram（以及 Tailscale）需要 VPN；Mac 留在奥克兰，抓取数据不受影响。

## 13. 常见问题

- **日志说 `app.lock 属于另一台机器或容器`，或“另一个实例正在运行”**：同一个 `data/` 只能有一个程序在跑。通常是容器在运行时又在本机 `pnpm start`。停掉其中一个（`docker compose down` 或 Ctrl-C）。如果确认两边都已经停了，删掉 `data/app.lock` 再启动。`brief:dry` 和 `--once` 不受影响，可以和常驻的程序同时用。
- **Telegram 返回 409**：同一个 bot token 有两个程序在收消息，停掉一个。
- **容器连不上 Ollama**：在 Mac 上运行 `curl http://localhost:11434/api/version`，没有返回就是 Ollama 没开；返回了就检查 `ollama.model` 和 `ollama list` 是否一致。
- **早报内容不全或胡编**：检查 `ollama.num_ctx`。Ollama 默认上下文很短，输入超长时会悄悄截掉一部分；日志里有“超过 num_ctx 的 75%”时，调大 `num_ctx` 或减少 `select_count`。
- **改了 `config.toml` 没生效**：要 `docker compose restart`。
- **没收到定时早报**：先看 `/schedule` 有没有定时、`/where` 的下次时间对不对，再看 `docker compose logs` 里那个时间前后的记录。最常见的原因是 Mac 睡着了（见第 7 节）。

## 14. 隐私

- 模型在你自己的 Mac 上运行，日程、待办不会发给任何模型服务商。
- 但早报和对话内容会经过 Discord / Telegram 的服务器。
- `data/` 里有日程、待办和早报的明文，`config.toml` 里有 token 和日历链接：不要放进同步盘，不要提交到 git（`.gitignore` 已经排除）。

## 15. 数据和备份

程序产生的所有数据都在 `data/`（`paths.data_dir`）里，每个文件的作用见 [`data/README.md`](data/README.md)。迁移时复制整个 `data/` 和 `config.toml` 即可。

- **Mac 上**：Time Machine 会备份项目目录，包括 `data/`。
- **服务器上**：用云盘快照，或者每天用 `restic`（或 `rclone`）把 `data/` 加密备份到对象存储。例如 crontab：

  ```cron
  # 每天 03:00 加密备份，保留 30 天
  0 3 * * * RESTIC_REPOSITORY=s3:https://s3.example.com/morning-brief RESTIC_PASSWORD_FILE=$HOME/.restic-pass restic backup /srv/morning-brief/data && RESTIC_REPOSITORY=s3:https://s3.example.com/morning-brief RESTIC_PASSWORD_FILE=$HOME/.restic-pass restic forget --keep-daily 30 --prune
  ```

  里面有日程和待办等私人数据，备份一定要加密（restic 默认加密）。

- 数据目录必须挂载到容器外（`compose.yaml` 已经这样做）。不要部署到 Cloud Run、Lambda 这类无状态平台：容器重启后数据会丢，定时也会重复发。

## 16. 多人使用

一人一个容器，共用 Mac 上的同一个 Ollama。给第二个人加一个服务：

1. 给他建一个自己的 Discord 机器人（每人一个 bot token，不能共用），复制一份配置，例如 `config.alice.toml`，建一个空目录 `data-alice/`。
2. 在 `compose.yaml` 的 `services:` 下复制一份 `morning-brief`，改名字、`hostname` 和两个挂载：

   ```yaml
   alice:
     image: morning-brief # 用同一个镜像，不需要再 build
     hostname: morning-brief-alice
     restart: unless-stopped
     environment:
       MORNING_BRIEF_OLLAMA_HOST: http://host.docker.internal:11434
     volumes:
       - ./config.alice.toml:/app/config.toml:ro
       - ./data-alice:/app/data
     stop_grace_period: 40s
   ```

3. `docker compose up -d`。

注意：所有人用同一个模型名和相同的 `num_ctx`，否则 Ollama 会反复切换模型，非常慢；模型一次只处理一个请求，大家的定时最好错开几分钟。更多考虑见 PLAN.md 第 7 节“多用户部署”。

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
- hnrss 的摘要只有 `Article URL`、`Points` 这些元数据，清理后为空的条目标记为“只有标题”，给模型的文本里写“（只有标题）”。
- **挑新闻和写早报分成两次模型调用**（2026-11-05）。一开始让模型在写早报时从几十条候选里挑，qwen3:32b 明显偏向编号靠前的条目：44 个源、50 条候选、提示词写明“编号顺序不代表重要性”“覆盖不同地区”，3 次 `brief:dry` 选的还是前十几条（科技和美国新闻）。现在先单独调用一次，只给编号、来源和标题让它挑（`C1`、`C2`…，和早报里的 `N1`… 区分开），再把挑中的按它给的顺序重新编号交给写早报那一步，写早报时不再挑。
- 模型给的编号里，不存在和重复的忽略、多的截断；能用的不到 `brief_count` 一半算失败，够一半但不满时用按源轮流顺序里没选上的补满。
- **已知情况：热门话题会占好几条。** 筛选提示词要求同一件事只选一条，qwen3:32b 只部分做到（2026-11-05 实测，美国中期选举 10 条里占 5–6 条，同一起本地事件偶尔两家媒体各一条）。可以接受：占得多说明那个话题确实热门。
- 降级早报（模型不可用时）不调用模型挑选，直接用按源轮流的前 `brief_count` 条，全部列出。
- 链接规范化时去掉 `utm_*`、`at_*`（BBC 加的）、`fbclid`、`gclid`、`mc_cid`、`mc_eid` 和末尾的 `/`。
- BBC 中文简体 feed（`/zhongwen/simp/rss.xml`）在 2026-11-03 已经 301 跳转到繁体 feed，`fetch` 会自动跟随；模型照样用简体写早报。
- 一个源失败时拿不到 feed 标题，失败提示里用域名的主要部分指代它（例如 `www.rnz.co.nz` 写成 `rnz`）。不用完整域名，因为模型输出清理会删掉看起来像域名的文字（见“提示注入”）。

### 待办

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

`brief:dry` 不连接任何聊天渠道，所以 `config.toml` 里的 token 可以先不填（保留示例值），渠道也可以都不开。它只打印，不写归档；但待办文件不存在时会创建它。

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
