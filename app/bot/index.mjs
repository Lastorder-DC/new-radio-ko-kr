import dotenv from 'dotenv';
import { setTimeout as sleep } from 'node:timers/promises';
import PublicDataCache from './PublicDataCache.mjs';
import MastodonPublisher from './MastodonPublisher.mjs';
import PublicBot from './PublicBot.mjs';
import BufferRelay from './BufferRelay.mjs';
import { errorMessage } from './files.mjs';

// This entry point deliberately imports no Nintendo data updater or other social client.
dotenv.config({ quiet: true });
const mode = process.argv[2] || 'run';
if (!['run', 'once', 'preview', 'fetch'].includes(mode)) throw new Error('Expected run, once, preview or fetch');
const cache = new PublicDataCache({ userAgent: process.env.PUBLIC_DATA_USER_AGENT || undefined });
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort());

if (mode === 'fetch') {
  await cache.refresh();
} else {
  if (!process.env.MASTODON_URL || !process.env.MASTODON_ACCESS_TOKEN) throw new Error('Missing Mastodon credentials');
  const bot = new PublicBot({
    cache,
    publisher: new MastodonPublisher({ url: process.env.MASTODON_URL, token: process.env.MASTODON_ACCESS_TOKEN }),
    visibility: process.env.MASTODON_VISIBILITY || 'unlisted',
  });
  const buffer = process.env.BUFFER_API_KEY && process.env.BUFFER_TWITTER_CHANNEL_ID
    ? new BufferRelay({ channelId: process.env.BUFFER_TWITTER_CHANNEL_ID }) : null;
  do {
    try {
      const report = await bot.tick({ dryRun: mode === 'preview' });
      if (buffer) {
        const result = await buffer.tick(bot, { dryRun: mode === 'preview' });
        if (mode !== 'run' && result.results.some(item => ['error', 'needs-review', 'delivery-error'].includes(item.result))) process.exitCode = 1;
      }
      console.info('[Bot] Tick:', JSON.stringify(report.results));
      if (mode !== 'run' && (report.sourceError || report.results.some(item => item.result === 'error' || item.result === 'waiting-for-public-data'))) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error('[Bot]', errorMessage(error));
      if (mode !== 'run') process.exitCode = 1;
    }
    if (mode !== 'run' || abort.signal.aborted) break;
    await sleep(60_000, undefined, { signal: abort.signal }).catch(error => {
      if (error.name !== 'AbortError') throw error;
    });
  } while (!abort.signal.aborted);
}
