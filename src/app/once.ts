import { Archive } from '../archive/index.js';
import { runBrief } from '../brief/index.js';
import { sendToChannels } from '../chat/index.js';
import { loadConfig, logger } from '../infra/index.js';
import {
  createChannels,
  createLlm,
  NO_OWNER_HINT,
  prepare,
  startChannels,
  stopChannels,
} from './setup.js';

/** brief:once — sends one brief to every ready channel and exits; it counts for no schedule. */
export async function once(): Promise<void> {
  const config = await loadConfig();
  await prepare(config);
  const ready = createChannels(config).filter((channel) => channel.ready);
  if (ready.length === 0) {
    logger.error(NO_OWNER_HINT);
    process.exitCode = 1;
    return;
  }
  const llm = await createLlm(config);
  // Send-only: no handler, so a running `pnpm start` keeps receiving the messages.
  const connected = await startChannels(ready);
  try {
    if (connected.length === 0) throw new Error('没有一个聊天渠道连接成功');
    const result = await runBrief(
      { kind: 'manual', archive: true, send: (text) => sendToChannels(connected, text) },
      { config, llm, archive: new Archive(config.archive.dir) },
    );
    if (result.status === 'sent' && connected.length === ready.length) logger.info('早报已发送');
    else process.exitCode = 1;
  } finally {
    await stopChannels(connected);
  }
}
