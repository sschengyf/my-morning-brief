# 早报助手

> 完整的安装和使用说明在阶段 7 补充。

## 设置 Discord 机器人

1. 打开 <https://discord.com/developers/applications>，点 **New Application**，起个名字（例如“早报”）。
2. 左边点 **Bot**：
   - 点 **Reset Token**，复制 token，填进 `config.toml` 的 `discord.bot_token`。token 等于机器人的密码，不要发给别人；泄露了就再点一次 Reset Token。
   - **Privileged Gateway Intents** 下面三个开关都不用开（私信内容不需要特权）。
3. 左边点 **Installation**：**Installation Contexts** 只勾 **Guild Install**；**Install Link** 选 **Discord Provided Link**；**Default Install Settings** 的 Scopes 选 `bot` 和 `applications.commands`，Permissions 选 `Send Messages`。保存。
4. 在 Discord 里自己建一个服务器（左边栏的“+”→ 亲自创建 → 仅供我和我的朋友使用），只有你一个人也可以。
5. 复制第 3 步页面上的 Install Link，在浏览器打开，把机器人加到这个服务器。你和机器人要在同一个服务器里，它才能私信你。
6. 确认 `config.toml` 里 `[discord]` 的 `enabled = true`，`user_id` 先留空，运行 `npm start`。
7. 在服务器成员列表里点机器人 → 发消息，随便发一句。它会回复你的用户 ID，把它填进 `discord.user_id`（要加引号），然后重启 `npm start`。
8. 再发 `/help` 试试。输入 `/` 会弹出命令菜单（第一次注册后可能要等一会儿或重启 Discord 才出现）；直接打字发 `/todo` 这样的文字也可以。

## 设计说明

代码按模块分目录，每个模块只通过 `index.ts` 对外，依赖只能指向更底层的模块；完整的目录说明和规则见 PLAN.md 第 3 节，`npm run lint` 会检查。

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

- `archive/日期/` 下：定时早报是 `brief.md`、`raw.json`、`input.txt`；手动早报（`/brief`、`brief:once`）文件名带时分秒，例如 `brief-manual-093015.md`，同一秒再生成一份会加 `-2`。
- `brief.md` 开头是 YAML front matter（生成时间、类型、城市、时区、模型、是否降级），在 Obsidian 里显示为笔记属性。
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
- `data_dir/app.lock` 保证同时只有一个 `npm start`：Discord 允许同一个 token 多个连接，两个实例会把每条消息回复两遍。进程意外退出留下的锁会被下次启动接管。`brief:once` 不加锁，它只发送、不接收消息。
- 模型正在生成早报时提的问题，会等早报发出后再回答，用的是这份新早报的新闻。
- 启动时 Ollama 检查不通过只记警告、继续运行（开机时 Ollama 可能还没起来），真正请求时再报错。
