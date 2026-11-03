/** The menu both platforms register. `arg` names the optional/required argument. */
export const COMMANDS = [
  { name: 'brief', description: '立即生成并发送早报' },
  { name: 'todo', description: '列出未完成的待办' },
  {
    name: 'add',
    description: '添加待办',
    arg: { name: 'text', description: '待办内容', required: true },
  },
  {
    name: 'done',
    description: '完成待办',
    arg: { name: 'number', description: '待办序号', required: true },
  },
  { name: 'refresh', description: '重新获取今天的天气、日程和待办' },
  {
    name: 'history',
    description: '查看历史早报',
    arg: { name: 'date', description: '日期，例如 11-02、昨天', required: false },
  },
  {
    name: 'city',
    description: '切换城市（英文名）',
    arg: {
      name: 'name',
      description: '城市名，可以加国家，例如 Wellington New Zealand',
      required: true,
    },
  },
  { name: 'where', description: '当前城市和下次早报时间' },
  { name: 'home', description: '恢复为家里的位置' },
  { name: 'clear', description: '清空对话记忆' },
  { name: 'help', description: '帮助' },
] as const;

export const HELP_TEXT = `我是你的早报助手。每天早上把天气、日程、待办和新闻整理好发给你，有问题可以直接问我。

/brief 立即生成一份早报
/todo 看待办
/add 内容 添加待办
/done 序号 完成待办
/refresh 重新获取今天的天气、日程和待办
/history 最近有早报的日期
/history 11-02 看那天的早报
/city Shanghai 切换城市（英文名，可以加国家，例如 /city Wellington New Zealand）
/where 当前城市和下次早报时间
/home 回到家里的位置
/clear 清空对话记忆

其他文字都会当成问题，比如“今天要带伞吗”“第二条新闻展开讲讲”。`;
