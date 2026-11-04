import { type Channel, SCHEDULE_PROMPT, SendError, sendToChannels } from '../chat/index.js';
import { logger as defaultLogger, type Logger } from '../infra/index.js';
import { loadSchedules } from '../schedules/index.js';
import { loadState, saveState } from './state.js';

/**
 * Asks the owner to set a schedule when none was ever set (no schedules.json;
 * an emptied list is a choice and left alone). Sent once: the flag in
 * state.json keeps autostart restarts from repeating it. If no channel got
 * it, it is tried again on the next start.
 */
export async function remindToSchedule(
  dataDir: string,
  channels: Channel[],
  logger: Logger = defaultLogger,
): Promise<void> {
  if (channels.length === 0) return;
  const state = await loadState(dataDir, logger);
  if (state.schedulePromptSent) return;
  if ((await loadSchedules(dataDir, logger)).schedules !== null) return;
  try {
    await sendToChannels(channels, SCHEDULE_PROMPT, logger);
  } catch (error) {
    if (!(error instanceof SendError) || error.failed.length === channels.length) {
      logger.warn('设置定时的提醒没有发出去，下次启动再试');
      return;
    }
  }
  await saveState(dataDir, { ...state, schedulePromptSent: true });
  logger.info('还没有设置定时早报，已提醒主人用 /schedule add 设置');
}
