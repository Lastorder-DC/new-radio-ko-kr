import path from 'node:path';
import { createHash } from 'node:crypto';
import BufferApi from '../social/buffer/BufferApi.mjs';
import { readJson, writeJson, errorMessage } from './files.mjs';

export default class BufferRelay {
  constructor({ channelId, api = new BufferApi, fetchImpl = fetch } = {}) {
    Object.assign(this, { channelId, api, fetch: fetchImpl });
  }

  async initialize(root) {
    const channel = await this.api.getDeliveryChannel(this.channelId);
    if (channel?.id !== this.channelId || channel.service !== 'twitter' || !channel.organizationId ||
        channel.isDisconnected || channel.isLocked || channel.isQueuePaused) {
      throw new Error('Buffer requires a connected, unlocked, unpaused X/Twitter channel');
    }
    // Verify postsRead before enabling a mutation path that depends on reconciliation.
    await this.api.listPostPage(channel.organizationId, channel.id);
    this.channel = channel;
    const namespace = createHash('sha256').update(this.channelId).digest('hex');
    this.root = path.join(root, 'buffer', namespace);
    console.info(`[Buffer] Connected ${channel.name}: ${channel.id}`);
  }

  async tick(bot, { now = Date.now(), dryRun = false } = {}) {
    const report = { checkedAt: now, channelId: this.channelId, results: [] };
    try {
      if (!bot.accountRoot) throw new Error('Waiting for Mastodon account initialization');
      if (!this.channel) await this.initialize(bot.root);
      const source = await readJson(bot.cache.manifestPath, {});
      if (!source.current || !source.fetchedAt) throw new Error('Waiting for public JSON snapshot');
      for (const generator of bot.generators(now)) {
        try {
          const maximumAge = generator.key === 'gear.regular' ? 90 * 60_000 : 6 * 60 * 60_000;
          if (now - source.fetchedAt > maximumAge) {
            report.results.push({ key: generator.key, result: 'source-too-old' });
            continue;
          }
          const dataTime = await generator.getDataTime();
          const result = await this.process(bot, generator.key, dataTime, { now, dryRun });
          report.results.push({ key: generator.key, ...result });
        } catch (error) {
          report.results.push({ key: generator.key, result: 'error', message: errorMessage(error) });
        }
      }
    } catch (error) {
      report.results.push({ result: 'error', message: errorMessage(error) });
    }
    // Enabling Buffer must not erase the existing Mastodon health or delivery history.
    const healthPath = path.join(bot.root, 'health.json');
    const health = await readJson(healthPath, {});
    await writeJson(healthPath, { ...health, buffer: report });
    console.info('[Buffer] Tick:', JSON.stringify(report.results));
    return report;
  }

  async process(bot, key, dataTime, { now, dryRun }) {
    if (!Number.isFinite(dataTime)) return { result: 'no-current-data' };
    const file = path.join(this.root, `${key}.json`);
    const state = await readJson(file, { lastAccepted: null, pending: null });
    if (!state || !Object.hasOwn(state, 'lastAccepted') || !Object.hasOwn(state, 'pending') ||
        (state.lastAccepted && (!Number.isFinite(state.lastAccepted.dataTime) || !state.lastAccepted.id)) ||
        (state.pending && (!Number.isFinite(state.pending.dataTime) || !state.pending.text || !state.pending.assets?.length))) {
      throw new Error('Invalid Buffer delivery state; refusing to reset history');
    }
    if (state.lastAccepted?.status !== 'sent' && state.lastAccepted?.id && !dryRun) {
      const post = await this.api.getPost(state.lastAccepted.id);
      if (post?.id !== state.lastAccepted.id || post.channelId !== this.channelId) throw new Error('Invalid Buffer delivery confirmation');
      state.lastAccepted = { ...state.lastAccepted, status: post.status, url: post.externalLink || state.lastAccepted.url };
      await writeJson(file, state);
    }
    if (state.pending?.attemptedAt) {
      if (state.pending.nextAttemptAt > now) return { result: 'retry-wait' };
      const post = await this.findAccepted(state.pending);
      if (post) {
        if (!dryRun) await this.accept(file, state, post);
        else return { result: 'already-accepted', id: post.id };
      } else {
        // Buffer has no documented idempotency key. Never blindly repeat an ambiguous mutation.
        return { result: 'needs-review', message: 'Submission response was lost; inspect Buffer before resubmitting' };
      }
    }
    if (state.lastAccepted && dataTime <= state.lastAccepted.dataTime) {
      return { result: ['sent', 'scheduled', 'sending'].includes(state.lastAccepted.status) ? 'unchanged' : 'delivery-error',
        status: state.lastAccepted.status, id: state.lastAccepted.id, url: state.lastAccepted.url };
    }
    const source = await readJson(path.join(bot.accountRoot, `${key}.json`));
    if (source?.lastPosted?.dataTime !== dataTime) return { result: 'waiting-for-mastodon' };
    if (state.pending && state.pending.dataTime !== dataTime && !dryRun) {
      state.pending = null;
      await writeJson(file, state);
    }
    if (!state.pending) {
      const id = encodeURIComponent(source.lastPosted.id);
      const { data: post } = await bot.publisher.request(`/api/v1/statuses/${id}`);
      const { data: content } = await bot.publisher.request(`/api/v1/statuses/${id}/source`);
      if (!['public', 'unlisted'].includes(post.visibility) || !content.text || !post.media_attachments?.length) {
        throw new Error('Buffer requires an existing public/unlisted Mastodon post with text and images');
      }
      const assets = [];
      for (const media of post.media_attachments) {
        const url = new URL(media.url);
        if (url.protocol !== 'https:' || url.username || url.password || media.type !== 'image') {
          throw new Error('Buffer requires publicly accessible HTTPS images');
        }
        const response = await this.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
          throw new Error(`Buffer source image is not publicly accessible: HTTP ${response.status}`);
        }
        assets.push({ image: { url: url.href, metadata: { altText: media.description || '' } } });
      }
      const pending = { dataTime, sourcePostId: source.lastPosted.id, text: content.text, assets, attempts: 0 };
      if (dryRun) return { result: 'ready', sourcePostId: pending.sourcePostId, images: assets.length };
      state.pending = pending;
      await writeJson(file, state);
    }
    if (dryRun) return { result: 'ready', sourcePostId: state.pending.sourcePostId, images: state.pending.assets.length };
    const job = state.pending;
    if (job.nextAttemptAt > now) return { result: 'retry-wait' };
    job.attemptedAt = now;
    await writeJson(file, state);
    let post;
    try {
      post = await this.api.createPost(this.channelId, job.text, job.assets);
    } catch (error) {
      if (error.definitive) delete job.attemptedAt;
      job.attempts++;
      job.nextAttemptAt = now + Math.max(120_000, error.retryAfterMs || 0);
      await writeJson(file, state);
      throw error;
    }
    await this.accept(file, state, post);
    console.info(`[Buffer] Accepted ${key}: ${post.externalLink || post.id} (${post.status})`);
    return { result: 'accepted', id: post.id, status: post.status, url: post.externalLink };
  }

  async accept(file, state, post) {
    if (!post.id || post.channelId !== this.channelId) throw new Error('Unexpected Buffer channel in post');
    const updated = {
      lastAccepted: { dataTime: state.pending.dataTime, id: post.id, status: post.status,
        url: post.externalLink, sourcePostId: state.pending.sourcePostId, acceptedAt: Date.now() },
      pending: null,
    };
    await writeJson(file, updated);
    Object.assign(state, updated);
  }

  async findAccepted(job) {
    let after;
    for (let page = 0; page < 10; page++) {
      const posts = await this.api.listPostPage(this.channel.organizationId, this.channelId, after);
      const found = posts.edges.map(edge => edge.node).find(post => post.channelId === this.channelId &&
        post.text === job.text && job.assets.every(asset => post.assets?.some(image => image.source === asset.image.url)));
      if (found) return found;
      if (!posts.pageInfo.hasNextPage) return null;
      after = posts.pageInfo.endCursor;
    }
    throw new Error('Buffer reconciliation scan limit reached');
  }
}
