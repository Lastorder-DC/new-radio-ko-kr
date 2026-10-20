import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import PublicBot from './PublicBot.mjs';
import { readJson } from './files.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radio-bot-'));
  directories.push(root);
  const publisher = {
    url: 'https://mastodon.example',
    verifyAccount: vi.fn(async () => ({ id: 'account-1', url: 'https://mastodon.example/@radio' })),
    upload: vi.fn(async () => 'media-1'), waitForMedia: vi.fn(async () => {}),
    publish: vi.fn(async () => ({ id: 'post-1', url: 'https://mastodon.example/@radio/1', visibility: 'unlisted' })),
    findPublished: vi.fn(async () => null),
  };
  const generator = {
    key: 'schedules', getDataTime: vi.fn(async () => 1000),
    getStatus: vi.fn(async () => ({ status: '한국어 일정', locale: 'ko-KR', media: [{ file: Buffer.from('png'), altText: '대체 텍스트' }] })),
  };
  const options = { root, publisher, screenshots: () => ({ close: vi.fn() }) };
  const bot = new PublicBot(options);
  await bot.initialize();
  return { bot, publisher, generator, options };
}

describe('durable bot delivery', () => {
  it('posts once with unlisted visibility and deduplicates after a process restart', async () => {
    const { bot, generator, publisher, options } = await setup();
    expect((await bot.process(generator, { now: 1000 })).result).toBe('posted');
    expect(publisher.publish.mock.calls[0][0]).toMatchObject({ visibility: 'unlisted', language: 'ko', media_ids: ['media-1'] });
    expect(publisher.publish.mock.calls[0][0].status).toContain('데이터 출처: https://splatoon3.ink');
    const restarted = new PublicBot(options);
    await restarted.initialize();
    expect((await restarted.process(generator, { now: 61_000 })).result).toBe('unchanged');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('reconciles an accepted post after a lost response without posting it again', async () => {
    const { bot, generator, publisher, options } = await setup();
    publisher.publish.mockRejectedValueOnce(new Error('response lost'));
    await expect(bot.process(generator, { now: 1000 })).rejects.toThrow('response lost');
    publisher.findPublished.mockResolvedValue({ id: 'accepted', url: 'https://mastodon.example/@radio/accepted', visibility: 'unlisted' });
    const restarted = new PublicBot(options);
    await restarted.initialize();
    expect((await restarted.process(generator, { now: 61_001 })).result).toBe('unchanged');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.upload).toHaveBeenCalledTimes(1);
    const state = await readJson(path.join(bot.accountRoot, 'schedules.json'));
    expect(state.lastPosted.id).toBe('accepted');
    expect(state.pending).toBeNull();
  });

  it('retries with the original media, idempotency key and visibility', async () => {
    const { bot, generator, publisher } = await setup();
    publisher.publish.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { retryAfterMs: 120_000 }));
    await expect(bot.process(generator, { now: 1000 })).rejects.toThrow('rate limited');
    bot.visibility = 'public';
    expect((await bot.process(generator, { now: 61_000 })).result).toBe('retry-wait');
    expect((await bot.process(generator, { now: 121_001 })).result).toBe('posted');
    expect(publisher.publish.mock.calls[0][1]).toBe(publisher.publish.mock.calls[1][1]);
    expect(publisher.publish.mock.calls[1][0].visibility).toBe('unlisted');
    expect(publisher.upload).toHaveBeenCalledTimes(1);
  });

  it('fails closed if reconciliation is unavailable', async () => {
    const { bot, generator, publisher } = await setup();
    publisher.publish.mockRejectedValueOnce(new Error('response lost'));
    await expect(bot.process(generator, { now: 1000 })).rejects.toThrow();
    publisher.findPublished.mockRejectedValue(new Error('timeline unavailable'));
    await expect(bot.process(generator, { now: 61_001 })).rejects.toThrow('timeline unavailable');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('does not share delivery state between accounts', async () => {
    const { bot, generator, publisher, options } = await setup();
    await bot.process(generator, { now: 1000 });
    publisher.verifyAccount.mockResolvedValue({ id: 'account-2', url: 'https://mastodon.example/@another' });
    const other = new PublicBot(options);
    await other.initialize();
    await other.process(generator, { now: 1000 });
    expect(other.accountRoot).not.toBe(bot.accountRoot);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it('drops an obsolete failed rotation and posts only the current one', async () => {
    const { bot, generator, publisher } = await setup();
    publisher.publish.mockRejectedValueOnce(new Error('response lost'));
    await expect(bot.process(generator, { now: 1000 })).rejects.toThrow();
    generator.getDataTime.mockResolvedValue(2000);
    await bot.process(generator, { now: 61_001 });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publisher.publish.mock.calls[0][1]).not.toBe(publisher.publish.mock.calls[1][1]);
  });

  it('refuses to silently reset a corrupt delivery state', async () => {
    const { bot, generator, publisher } = await setup();
    await fs.writeFile(path.join(bot.accountRoot, 'schedules.json'), '{broken');
    await expect(bot.process(generator, { now: 1000 })).rejects.toThrow('Cannot read bot state');
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
