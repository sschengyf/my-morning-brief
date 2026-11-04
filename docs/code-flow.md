# 代码流程

这份文档说明程序启动后做了什么、一份早报怎么生成、聊天消息怎么处理、定时怎么触发。对应的是阶段 6 完成时的代码（提交 `c4f1a87`），阶段 7 的 Docker 部署还没有写进来。

图用 Mermaid 写，GitHub 和 VS Code（装 Markdown Preview Mermaid Support 插件）都能直接显示。

## 1. 模块和依赖方向

`src/` 下每个顶层目录是一个模块，依赖只能从上往下指；别的模块只能通过 `index.ts` 引用它。`pnpm lint` 会检查这两条。

```mermaid
flowchart TD
    app["app<br/>start / once / dry 三种运行方式"]
    scheduler["scheduler<br/>按时运行、重试、state.json"]
    chat["chat<br/>core（命令、对话）+ telegram / discord 适配"]
    brief["brief<br/>runBrief：一份早报的完整流程"]
    archive["archive<br/>data/archive/日期/ 读写"]
    llm["llm<br/>提示词、Ollama、输出清理"]
    sources["sources<br/>天气、日历、待办、新闻"]
    schedules["schedules<br/>定时的存储、校验、发送窗口"]
    location["location<br/>当前生效的城市和时区"]
    infra["infra<br/>配置、日志、原子写入、锁"]

    app --> scheduler --> chat --> brief --> archive --> llm --> sources --> schedules --> location --> infra
```

图里只画了相邻的一层，实际上任何模块都可以引用比它低的模块，例如 `chat` 直接引用 `schedules`（`/schedule` 命令）和 `location`（`/city`）。

## 2. 入口和三种运行方式

`src/index.ts` 只看命令行参数，然后交给 `app/`：

| 命令              | 函数                   | 做什么                                                         |
| ----------------- | ---------------------- | -------------------------------------------------------------- |
| `pnpm start`      | `app/start.ts` `start` | 常驻运行：连聊天渠道、回复消息、按定时发早报                   |
| `pnpm brief:once` | `app/once.ts` `once`   | 生成一份早报发到所有渠道，写归档，然后退出；不算任何一个定时   |
| `pnpm brief:dry`  | `app/dry.ts` `dryRun`  | 生成一份早报，只在终端打印给模型的数据和早报；不发送、不写归档 |

三种方式生成早报都调用同一个 `runBrief`（第 4 节）。

## 3. `pnpm start` 启动过程

```mermaid
sequenceDiagram
    autonumber
    participant S as app/start.ts
    participant I as infra
    participant O as Ollama
    participant C as ChatCore
    participant Ch as Discord / Telegram
    participant Sc as Scheduler

    S->>I: loadConfig()：读 config.toml，环境变量覆盖，zod 校验
    S->>I: prepare()：登记要脱敏的密钥，创建 data/
    S->>I: acquireLock()：写 data/app.lock，已有实例在跑就退出
    S->>I: cleanupLeftovers()：删掉上次中断写入留下的 .tmp
    Note over S: 注册 SIGINT / SIGTERM 处理（见第 7 节）
    S->>O: check()：模型在不在；失败只记警告，继续运行
    S->>C: new ChatCore() + restore()：从归档读回今天的早报
    S->>Ch: startChannels()：逐个连接，失败的跳过
    alt 没有一个渠道配置了主人 id
        Note over S: 只回复“你的 id 是…”，不启动定时
    else 有可发送的渠道
        S->>Ch: remindToSchedule()：从没设过定时就私信提醒一次
        S->>Sc: new Scheduler().start()：每 30 秒检查一次
    end
```

## 4. 一份早报怎么生成：`runBrief`

`brief/run.ts` 的 `runBrief` 是整个程序的核心，定时、`/brief`、`brief:once`、`brief:dry` 都用它。它本身不重试，重试由调用者（定时器）决定。

```mermaid
flowchart TD
    A["getEffectiveLocation()<br/>location.json 有就用它，否则用 config 里的家"] --> B
    B["并行抓取 4 个数据源<br/>天气 Open-Meteo · 日历 .ics · 待办 todo.md · 新闻 RSS<br/>（周末且 weekend_news = false 时不抓新闻）"] --> C
    C{"有新闻？"} -- 有 --> D["selectNews()<br/>去掉最近 dedup_days 天早报里用过的链接<br/>按源轮流挑 select_count 条"]
    C -- 没有 --> E
    D --> E{"fallback？<br/>（定时器重试用完时）"}
    E -- 否 --> F["llm.writeBrief()<br/>拼成 #60;数据#62; 文本，超过 num_ctx 75% 就减新闻<br/>Ollama 生成 → sanitizeOutput()"]
    E -- 是 --> G["formatFallbackBrief()<br/>不经过模型，直接排版原始数据"]
    F -- 模型失败 --> X["返回 llm_failed"]
    F --> H
    G --> H["archive.write()<br/>data/archive/日期/ 下写 raw、input、brief 三个文件<br/>（brief:dry 不写；写失败也照常发送）"]
    H --> I["options.send(text)<br/>定时 / once：发到所有渠道 · /brief：回复到发起的对话 · dry：什么都不做"]
    I -- 成功 --> J["返回 sent"]
    I -- 失败 --> K["返回 send_failed（带上早报文本，方便重发）"]
```

几个要点：

- **数据源从不抛错。** 每个数据源返回 `SourceResult`：`text` 给模型看，`raw` 存进归档，`ok` 表示成功没有。失败时 `text` 是“（天气获取失败：请求超时）”这样的中文，早报照样生成。
- **新闻编号在挑选之后才分配。** 交给模型的新闻编号是 `N1`、`N2`……，`numberNews()` 记下每个编号对应的真实链接。
- **模型输出不可信。** `sanitizeOutput()` 先删掉模型写的所有网址，再把 `[N3]` 换成 `[原文](真实链接)`。所以消息里的链接只能来自订阅的 feed。
- **只有早报里实际提到的新闻才算“用过”**（`usedIds`），没提到的第二天还能出现。

### 模型这一层：`llm/`

```mermaid
flowchart LR
    D["BriefData<br/>天气、日程、待办文本 + 挑好的新闻"] --> G["gatherText()<br/>每节包进 #60;数据#62; 标签<br/>内容里的标签被换成全角"]
    G --> Q["LlmService 排队<br/>一次只发一个请求"]
    Q --> O["OllamaClient.chat()<br/>system：BRIEF_PROMPT（llm/prompts.ts）<br/>user：数据文本"]
    O --> T["stripThink()<br/>去掉思考过程"]
    T --> S["sanitizeOutput()<br/>删网址，N 编号换成链接"]
```

`LlmService` 把早报和聊天的请求串成一个队列，并记住当前在做什么。用户提问时如果正在生成早报，机器人会先回一句“正在生成早报，稍后回复你”。

## 5. 聊天消息怎么处理

```mermaid
sequenceDiagram
    autonumber
    actor U as 你
    participant A as 平台适配<br/>chat/discord 或 chat/telegram
    participant D as dispatch()
    participant C as ChatCore.handle()
    participant L as LlmService

    U->>A: 私信一条消息
    A->>D: 翻译成 Incoming（文字、发送者、是否私聊、回复方法 io）
    alt 群组或服务器频道
        D-->>A: 忽略，记日志
    else 还没配置主人 id
        D-->>U: “你的 id 是：xxx”
    else 不是主人
        D-->>A: 忽略，记日志
    else 主人的私信
        D->>C: handle(text, io)
        alt 以 / 开头：命令
            C->>C: commands 表里找到对应函数执行<br/>/todo /add /done /schedule /city /history …
            C-->>U: io.reply()
        else 普通文字：提问
            C->>C: 等正在生成的早报完成
            C->>C: context()：今天的天气、日程、待办（缓存 30 分钟）<br/>+ 今天早报里的新闻（不重新抓）
            C->>L: answer(context, 对话记忆, 问题)
            L-->>C: 清理过的回答
            C-->>U: io.reply()
        end
    end
```

- **平台无关。** `chat/core/` 不知道消息来自 Discord 还是 Telegram，适配器只负责收发、检查发送者（`dispatch()`）和格式转换（Telegram 要转 HTML，长消息按平台上限切分）。
- **对话记忆**（`chat/core/conversation.ts`）：以今天的早报开头，保留最近 10 轮问答。新早报发出后重新开始；`/clear` 只清问题，保留早报。重启后 `restore()` 从归档读回今天的早报。
- **`/brief`** 也走 `runBrief`，但早报只回复到发起的那个对话；同一时间只允许一份在生成。

## 6. 定时怎么触发

### 数据

- `data/schedules.json`：你用 `/schedule add` 设的定时，每个有 `id`、`time`（如 `08:00`）、`days`（每天、工作日、周末）、`createdAt`。
- `data/state.json`：定时器自己的记录，包括每个定时今天发过没有（`sent`）、失败次数和下次重试时间（`attempts`）、做好了但没送到的早报（`pendingBrief`）。

### 发送窗口

每个定时从它的时间开始，有一个“可以发”的窗口，长度是 `catch_up_hours`（默认 4 小时），但不超过当天下一个定时，也不跨过午夜。例如每天 08:00 和 10:00 两个定时：

```mermaid
gantt
    dateFormat HH:mm
    axisFormat %H:%M
    section 08:00 定时
    窗口（被下一个定时截断）  :08:00, 10:00
    section 10:00 定时
    窗口（catch_up_hours = 4）:10:00, 14:00
```

所以任何时刻最多只有一个定时在窗口里；Mac 睡过几个定时醒来，只补最近的那一个。当天新加的定时从下一次才开始算。

### 每 30 秒一次检查：`Scheduler.check()`

```mermaid
flowchart TD
    T["定时器触发（每 30 秒；上一次没完就跳过）"] --> R["重新读：当前位置、schedules.json、state.json<br/>所以 /city、/schedule 立刻生效，重启也不会重复发"]
    R --> Ti["tidy()：清掉别的日期、已删除的定时、<br/>窗口已经关闭的重试（记一条 error）"]
    Ti --> B{"/brief 正在生成？"}
    B -- 是 --> W["这次不做，下次再看"]
    B -- 否 --> Du{"dueSchedule()<br/>现在有定时在窗口里、今天没发过、<br/>没到等待中的重试时间？"}
    Du -- 没有 --> W
    Du -- 有 --> P{"有这个定时的 pendingBrief？"}
    P -- 有 --> RS["resend()：只发给上次失败的渠道"]
    P -- 没有 --> F{"失败次数 ≥ retry_minutes 的个数？"}
    F -- 是 --> FB["runBrief(fallback)：降级早报"]
    F -- 否 --> RB["runBrief()：正常早报<br/>（期间 caffeinate 防止 Mac 睡眠）"]
    RB --> AR{"结果"}
    FB --> AR
    RS --> AR
    AR -- sent --> MS["markSent()：记为已发送<br/>清理过期归档"]
    AR -- llm_failed --> FL["failed()：失败次数 +1<br/>按 2、5、10 分钟排下次重试<br/>来不及重试就立刻改发降级早报"]
    AR -- send_failed --> FP["failed()：保存 pendingBrief<br/>只记下失败的渠道"]
```

先发送、成功后才记为已发送。如果正好在这两步之间被杀，重启后会再发一份：宁可重复，不要漏发。

## 7. 退出

收到 Ctrl-C（SIGINT）或 SIGTERM 时，`start.ts` 的 `shutdown()`：

1. 停止定时器，等正在生成的定时早报完成；
2. 等正在处理的消息和 `/brief` 完成（`ChatCore.settle()`）；
3. 第 1、2 步最多等 30 秒，超时直接继续；
4. 断开所有聊天渠道，删除 `app.lock`，退出。

中途被强行结束也不会弄坏数据：所有文件都通过 `writeFileAtomic` 先写临时文件再改名，没发出去的早报下次启动会重新生成。

## 8. data/ 里的文件

| 文件                       | 谁写                          | 内容                                       |
| -------------------------- | ----------------------------- | ------------------------------------------ |
| `schedules.json`           | `/schedule` 命令              | 定时列表                                   |
| `state.json`               | 定时器                        | 每个定时的发送和重试记录、首次提醒发过没有 |
| `location.json`            | `/city`，`/home` 时删除       | 旅行时的临时位置                           |
| `todo.md`                  | `/add`、`/done`，或你直接编辑 | 待办                                       |
| `archive/日期/brief-*.md`  | `runBrief`                    | 早报正文，开头是 YAML 属性                 |
| `archive/日期/raw-*.json`  | `runBrief`                    | 各数据源的原始数据、新闻候选和挑选结果     |
| `archive/日期/input-*.txt` | `runBrief`                    | 发给模型的完整提示词和数据                 |
| `app.lock`                 | `pnpm start`                  | 运行中实例的进程号，退出时删除             |

归档文件名里，定时早报带定时的时间（`brief-scheduled-0800.md`），手动早报带生成时的时分秒（`brief-manual-093015.md`）。
