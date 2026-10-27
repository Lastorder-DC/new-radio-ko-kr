import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import SchedulesStatus from '../social/generators/SchedulesStatus.mjs';
import SalmonRunStatus from '../social/generators/SalmonRunStatus.mjs';
import RegularGearStatus from '../social/generators/RegularGearStatus.mjs';
import ScreenshotHelper from '../screenshots/ScreenshotHelper.mjs';
import { readJson, writeJson, errorMessage } from './files.mjs';
import { validEventKey, eventWasPosted, rememberEvent } from './events.mjs';
import { FestivalStatus, FestivalResultsStatus } from './FestivalStatus.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');

export default class PublicBot {
  constructor({ cache, publisher, root = 'storage/public-bot', visibility = 'unlisted',
    screenshots = () => new ScreenshotHelper,
    generators = now => [new SchedulesStatus({ locale: 'ko-KR', now }),
      new SalmonRunStatus({ locale: 'ko-KR', now }), new RegularGearStatus({ locale: 'ko-KR', now }),
      new FestivalStatus({ now }), new FestivalResultsStatus({ now })],
  } = {}) {
    if (!['unlisted', 'public', 'private'].includes(visibility)) throw new Error('Invalid MASTODON_VISIBILITY');
    Object.assign(this, { cache, publisher, root, visibility, screenshots, generators });
  }

  async initialize() {
    const account = await this.publisher.verifyAccount();
    this.account = account;
    this.accountRoot = path.join(this.root, 'accounts', digest(`${this.publisher.url}:${account.id}`));
    await fs.mkdir(this.accountRoot, { recursive: true });
    console.info(`[Bot] Account: ${account.url}; visibility: ${this.visibility}; locale: ko-KR`);
  }

  async tick({ dryRun = false, now = Date.now() } = {}) {
    if (!this.account) await this.initialize();
    const report = { checkedAt: now, account: this.account.url, visibility: this.visibility, results: [] };
    let source;
    try {
      source = await this.cache.refresh(now);
    } catch (error) {
      console.error('[PublicData]', errorMessage(error));
      report.sourceError = errorMessage(error);
      source = await readJson(this.cache.manifestPath, {});
    }
    report.fetchedAt = source.fetchedAt ?? null;
    if (!source.current) {
      report.results.push({ result: 'waiting-for-public-data' });
    } else {
      for (const generator of this.generators(now)) {
        try {
          // Expired source data must never cause outdated gear announcements.
          const maximumAge = generator.key === 'gear.regular' ? 90 * 60_000 : 6 * 60 * 60_000;
          if (now - source.fetchedAt > maximumAge) {
            report.results.push({ key: generator.key, result: 'source-too-old' });
            continue;
          }
          const result = await this.process(generator, { dryRun, now });
          report.results.push({ key: generator.key, ...result });
        } catch (error) {
          console.error(`[Bot] ${generator.key}:`, errorMessage(error));
          report.results.push({ key: generator.key, result: 'error', message: errorMessage(error) });
        }
      }
    }
    report.completedAt = Date.now();
    await writeJson(path.join(this.root, 'health.json'), report);
    return report;
  }

  async process(generator, { dryRun, now }) {
    // These generators select only an active rotation or unexpired gear at the supplied time.
    const dataTime = await generator.getDataTime();
    if (!validEventKey(dataTime)) return { result: 'no-current-data' };
    const statePath = path.join(this.accountRoot, `${generator.key}.json`);
    const state = await readJson(statePath, { lastPosted: null, pending: null });
    if (!state || !Object.hasOwn(state, 'lastPosted') || !Object.hasOwn(state, 'pending') ||
        (state.lastPosted && !validEventKey(state.lastPosted.dataTime)) ||
        (state.pending && (!validEventKey(state.pending.dataTime) || !state.pending.idempotencyKey ||
          !Array.isArray(state.pending.mediaIds) || !state.pending.images?.length || !state.pending.payload))) {
      throw new Error('Invalid delivery state; refusing to reset posting history');
    }

    if (state.pending?.attemptedAt && !dryRun) {
      if (state.pending.nextAttemptAt > now) return { result: 'retry-wait' };
      let published;
      try {
        published = await this.publisher.findPublished(state.pending);
      } catch (error) {
        await this.defer(statePath, state, error, now);
        throw error;
      }
      if (published) {
        await this.complete(statePath, state, published);
        console.info(`[Bot] Recovered confirmed post ${generator.key}: ${published.url}`);
      }
    }
    if (state.pending && state.pending.dataTime !== dataTime) {
      // Do not replay missed rotations or an item that is no longer the newest one.
      if (!dryRun) {
        state.pending = null;
        await writeJson(statePath, state);
      }
    }
    if (state.lastPosted && eventWasPosted(dataTime, state.lastPosted.dataTime, state.postedKeys)) return { result: 'unchanged' };
    if (dryRun) {
      const helper = this.screenshots();
      try {
        const status = await generator.getStatus(helper);
        const directory = path.join('temp/public-bot-preview', generator.key);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'image.png'), status.media[0].file);
        await fs.writeFile(path.join(directory, 'status.txt'), status.status + '\n\n' + status.media[0].altText);
        return { result: 'preview', directory, dataTime };
      } finally {
        await helper.close();
      }
    }

    if (!state.pending) {
      const helper = this.screenshots();
      try {
        const status = await generator.getStatus(helper);
        if (!status.media?.length || !status.status) throw new Error('Generated post is empty');
        const idempotencyKey = digest(`${this.accountRoot}:ko-KR:${generator.key}:${dataTime}`);
        const directory = path.join(this.accountRoot, 'outbox', idempotencyKey);
        await fs.mkdir(directory, { recursive: true });
        const images = [];
        for (const [index, media] of status.media.entries()) {
          const file = path.join(directory, `${index}.png`);
          await fs.writeFile(file, media.file);
          images.push({ file, altText: media.altText });
        }
        state.pending = {
          dataTime, idempotencyKey, images, mediaIds: [], attempts: 0, createdAt: now,
          payload: {
            status: `${status.status}\n\n데이터 출처: https://splatoon3.ink`,
            spoiler_text: status.contentWrapper || '', sensitive: !!status.contentWrapper,
            language: 'ko', visibility: this.visibility,
          },
        };
        await writeJson(statePath, state);
      } finally {
        await helper.close();
      }
    }

    const job = state.pending;
    if (job.nextAttemptAt > now) return { result: 'retry-wait' };
    try {
      for (let index = job.mediaIds.length; index < job.images.length; index++) {
        const image = job.images[index];
        const id = await this.publisher.upload({ file: await fs.readFile(image.file), altText: image.altText });
        job.mediaIds.push(id);
        await writeJson(statePath, state);
      }
      for (const id of job.mediaIds) await this.publisher.waitForMedia(id);
      job.payload.media_ids = job.mediaIds;
      job.attemptedAt ??= now;
      await writeJson(statePath, state);
      const result = await this.publisher.publish(job.payload, job.idempotencyKey);
      await this.complete(statePath, state, result);
      console.info(`[Bot] Posted ${generator.key}: ${result.url} (${result.visibility})`);
      return { result: 'posted', ...result };
    } catch (error) {
      await this.defer(statePath, state, error, now);
      throw error;
    }
  }

  async defer(statePath, state, error, now) {
    const job = state.pending;
    job.attempts++;
    job.nextAttemptAt = now + Math.max(Math.min(60_000 * 2 ** Math.min(job.attempts - 1, 4), 15 * 60_000), error.retryAfterMs || 0);
    await writeJson(statePath, state);
  }

  async complete(statePath, state, result) {
    const updated = {
      lastPosted: { dataTime: state.pending.dataTime, ...result, confirmedAt: Date.now() },
      pending: null,
      postedKeys: rememberEvent(state.pending.dataTime, state.postedKeys),
    };
    const images = state.pending.images;
    await writeJson(statePath, updated);
    Object.assign(state, updated);
    for (const image of images) await fs.rm(image.file, { force: true }).catch(() => {});
  }
}
