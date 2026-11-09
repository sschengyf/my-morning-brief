# data/

一个人的程序产生的所有数据都在 `data_dir` 里（`paths.data_dir`，默认是 `data/`）。Docker 部署时每个人的数据在 `users/<名字>/data/`，挂进容器的 `/app/data`；这个 `data/` 目录是不用 Docker、在本机运行时用的。除了这个说明文件，里面的内容都不提交 git。

| 文件 | 内容 |
|---|---|
| `todo.md` | 待办（`todo.backend = "markdown"` 时），`/add`、`/done` 改的就是它 |
| `ms-token.json` | Microsoft To Do 的登录凭证（`/todo_login` 后生成，权限 600），是秘密 |
| `archive/日期/` | 每天的早报、给模型的输入和原始数据 |
| `schedules.json` | 用 `/schedule` 设置的定时 |
| `state.json` | 定时早报的状态（今天发过没有、重试） |
| `location.json` | 用 `/city` 切换城市后的临时位置，`/home` 后删除 |
| `app.lock` | 运行中的程序的锁，正常退出时删除 |

迁移或备份时复制整个目录即可；里面有日程和待办等私人数据，备份要加密。日志不在这里，用 `docker compose logs <名字>` 看。
