import { type BriefData, cleanSource, sanitizeOutput } from '#/llm/index.js';
import { dateLine, numberNews } from '#/sources/index.js';

/** A brief without the model: the raw sections, for when every model retry has failed. */
export function formatFallbackBrief(data: BriefData): string {
  const { gather } = data;
  const sections = [
    '⚠️ 本地模型暂时不可用，以下是原始数据',
    dateLine(gather.now, gather.location),
    `🌤 **天气**\n${sanitizeOutput(gather.weather)}`,
    `📅 **日程**\n${sanitizeOutput(gather.calendar)}`,
    `✅ **待办**\n${sanitizeOutput(gather.todos)}`,
  ];
  if (gather.review !== undefined)
    sections.push(`🗓 **本周回顾**\n${sanitizeOutput(gather.review)}`);
  if (data.news) {
    const items = numberNews(data.news.items);
    const lines = items.map(
      (item) =>
        `- **${item.id.slice(1)}** ${cleanSource(item.source)} | ${sanitizeOutput(item.title)} [原文](${item.link})`,
    );
    for (const failure of data.news.failures)
      lines.push(`（${failure.source} 获取失败：${failure.reason}）`);
    sections.push(`📰 **新闻**\n${lines.length > 0 ? lines.join('\n') : '没有新的新闻'}`);
  }
  return sections.join('\n\n');
}
