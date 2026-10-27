import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import BufferRelay from './BufferRelay.mjs';
import { readJson, writeJson } from './files.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radio-buffer-'));
  directories.push(root);
  const bot = { root, accountRoot: path.join(root, 'mastodon'), publisher: {
    request: vi.fn(async endpoint => ({ data: endpoint.endsWith('/source') ? { text: '한국어 일정\n출처: https://splatoon3.ink' } : {
      visibility: 'unlisted', media_attachments: [{ type: 'image', url: 'https://media.example/rotation.png', description: '한국어 대체 텍스트' }],
    } })),
  } };
  const sourcePath = path.join(bot.accountRoot, 'schedules.json');
  await writeJson(sourcePath, { lastPosted: { dataTime: 1000, id: 'mastodon-1' }, pending: null });
  const api = {
    getDeliveryChannel: vi.fn(async () => ({ id: 'channel', name: 'radio', service: 'twitter', organizationId: 'org' })),
    listPostPage: vi.fn(async () => ({ edges: [], pageInfo: { hasNextPage: false } })),
    createPost: vi.fn(async () => ({ id: 'buffer-1', channelId: 'channel', status: 'scheduled' })),
    getPost: vi.fn(async () => ({ id: 'buffer-1', channelId: 'channel', status: 'sent', externalLink: 'https://x.com/radio/status/1' })),
  };
  const fetchImpl = vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } }));
  const relay = new BufferRelay({ channelId: 'channel', api, fetchImpl });
  await relay.initialize(root);
  return { bot, api, relay, fetchImpl, sourcePath };
}

describe('durable Buffer relay', () => {
  it('reuses the Mastodon image and alt text, preserves Mastodon history, and records final delivery', async () => {
    const { bot, api, relay, fetchImpl, sourcePath } = await setup();
    const source = await readJson(sourcePath);
    expect((await relay.process(bot, 'schedules', 1000, { now: 1000 })).result).toBe('accepted');
    expect(api.createPost).toHaveBeenCalledWith('channel', '한국어 일정\n출처: https://splatoon3.ink', [{
      image: { url: 'https://media.example/rotation.png', metadata: { altText: '한국어 대체 텍스트' } },
    }]);
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('headers');
    expect((await relay.process(bot, 'schedules', 1000, { now: 61_000 })).result).toBe('unchanged');
    expect(api.createPost).toHaveBeenCalledTimes(1);
    expect(await readJson(sourcePath)).toEqual(source);
    expect((await readJson(path.join(relay.root, 'schedules.json'))).lastAccepted.status).toBe('sent');
  });

  it('does not blindly resubmit after losing a mutation response', async () => {
    const { bot, api, relay } = await setup();
    api.createPost.mockRejectedValueOnce(new Error('Response lost'));
    await expect(relay.process(bot, 'schedules', 1000, { now: 1000 })).rejects.toThrow('Response lost');
    expect((await relay.process(bot, 'schedules', 1000, { now: 121_001 })).result).toBe('needs-review');
    expect(api.createPost).toHaveBeenCalledTimes(1);
  });

  it('recovers an accepted mutation by matching the channel, body and source image URL', async () => {
    const { bot, api, relay } = await setup();
    api.createPost.mockRejectedValueOnce(new Error('Response lost'));
    await expect(relay.process(bot, 'schedules', 1000, { now: 1000 })).rejects.toThrow();
    api.listPostPage.mockResolvedValue({ edges: [{ node: {
      id: 'recovered', channelId: 'channel', status: 'sent', text: '한국어 일정\n출처: https://splatoon3.ink',
      assets: [{ source: 'https://media.example/rotation.png' }],
    } }], pageInfo: { hasNextPage: false } });
    expect((await relay.process(bot, 'schedules', 1000, { now: 121_001 })).result).toBe('unchanged');
    expect(api.createPost).toHaveBeenCalledTimes(1);
    expect((await readJson(path.join(relay.root, 'schedules.json'))).lastAccepted.id).toBe('recovered');
  });

  it('retries a definitive rejection after the backoff without creating new media', async () => {
    const { bot, api, relay, fetchImpl } = await setup();
    api.createPost.mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { definitive: true }));
    await expect(relay.process(bot, 'schedules', 1000, { now: 1000 })).rejects.toThrow();
    expect((await relay.process(bot, 'schedules', 1000, { now: 61_000 })).result).toBe('retry-wait');
    expect((await relay.process(bot, 'schedules', 1000, { now: 121_001 })).result).toBe('accepted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(api.createPost).toHaveBeenCalledTimes(2);
  });

  it('waits for the matching Mastodon rotation and refuses private posts', async () => {
    const { bot, api, relay } = await setup();
    expect((await relay.process(bot, 'schedules', 2000, { now: 1000 })).result).toBe('waiting-for-mastodon');
    bot.publisher.request.mockResolvedValue({ data: { visibility: 'private' } });
    await expect(relay.process(bot, 'schedules', 1000, { now: 1000 })).rejects.toThrow('public/unlisted');
    expect(api.createPost).not.toHaveBeenCalled();
  });

  it('refuses inaccessible images before creating a Buffer post', async () => {
    const { bot, api, relay, fetchImpl } = await setup();
    fetchImpl.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(relay.process(bot, 'schedules', 1000, { now: 1000 })).rejects.toThrow('not publicly accessible');
    expect(api.createPost).not.toHaveBeenCalled();
  });

  it('never submits a pending retry during a preview', async () => {
    const { bot, api, relay } = await setup();
    api.createPost.mockRejectedValueOnce(Object.assign(new Error('Rejected'), { definitive: true }));
    await expect(relay.process(bot, 'schedules', 1000, { now: 1000 })).rejects.toThrow();
    const statePath = path.join(relay.root, 'schedules.json');
    const before = await readJson(statePath);
    expect((await relay.process(bot, 'schedules', 1000, { now: 121_001, dryRun: true })).result).toBe('ready');
    expect(api.createPost).toHaveBeenCalledTimes(1);
    expect(await readJson(statePath)).toEqual(before);
  });


  it('accepts string festival keys without replaying an earlier accepted phase', async () => {
    const { bot, api, relay, sourcePath } = await setup();
    for (const dataTime of ['JUEA-108:active', 'JUEA-108:tricolor']) {
      await writeJson(sourcePath, { lastPosted: { dataTime, id: 'mastodon-1' }, pending: null });
      expect((await relay.process(bot, 'schedules', dataTime, { now: 1000 })).result).toBe('accepted');
    }
    expect((await relay.process(bot, 'schedules', 'JUEA-108:active', { now: 2000 })).result).toBe('unchanged');
    expect(api.createPost).toHaveBeenCalledTimes(2);
  });

});
