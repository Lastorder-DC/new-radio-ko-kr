import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import PublicDataCache, { publicFiles } from './PublicDataCache.mjs';
import { readJson } from './files.mjs';

const fixtures = {
  'schedules.json': { data: { regularSchedules: { nodes: [] }, bankaraSchedules: { nodes: [] },
    xSchedules: { nodes: [] }, festSchedules: { nodes: [] },
    coopGroupingSchedule: { regularSchedules: { nodes: [] }, bigRunSchedules: { nodes: [] } } } },
  'gear.json': { data: { gesotown: { limitedGears: [] } } },
  'coop.json': { data: { coopResult: {} } },
  'festivals.json': { AP: {} },
  'locale/ko-KR.json': Object.fromEntries(['stages', 'rules', 'gear', 'weapons', 'powers', 'brands'].map(key => [key, {}])),
};
const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radio-data-'));
  directories.push(root);
  const fetchImpl = vi.fn(async url => new Response(JSON.stringify(fixtures[url.split('/data/')[1]]), {
    headers: { etag: 'version-1', 'content-type': 'application/json' },
  }));
  return { cache: new PublicDataCache({ root, dataPath: path.join(root, 'dist/data'), fetchImpl }), fetchImpl };
}

describe('public data snapshots', () => {
  it('publishes a validated snapshot and preserves the hourly limit across restarts', async () => {
    const { cache, fetchImpl } = await setup();
    const source = await cache.refresh(1000);

    expect(fetchImpl).toHaveBeenCalledTimes(publicFiles.length);
    expect((await fs.lstat(cache.dataPath)).isSymbolicLink()).toBe(true);
    expect(await readJson(path.join(cache.dataPath, 'gear.json'))).toEqual(fixtures['gear.json']);
    const restarted = new PublicDataCache({ root: cache.root, dataPath: cache.dataPath, fetchImpl });
    await restarted.refresh(61_000);
    expect(fetchImpl).toHaveBeenCalledTimes(publicFiles.length);
    expect((await readJson(cache.manifestPath)).current).toBe(source.current);
  });

  it('retains the complete previous snapshot when a later file is invalid', async () => {
    const { cache, fetchImpl } = await setup();
    const original = await cache.refresh(1000);
    fetchImpl.mockImplementation(async url => new Response(JSON.stringify(
      url.endsWith('gear.json') ? { error: 'bad upstream response' } : fixtures[url.split('/data/')[1]],
    )));

    await expect(cache.refresh(3_601_000)).rejects.toThrow('Invalid public JSON');
    expect((await readJson(cache.manifestPath)).current).toBe(original.current);
    expect(await fs.realpath(cache.dataPath)).toBe(path.resolve(cache.root, original.current));
    expect(await readJson(path.join(cache.dataPath, 'gear.json'))).toEqual(fixtures['gear.json']);
    const requests = fetchImpl.mock.calls.length;
    await cache.refresh(3_661_000);
    expect(fetchImpl).toHaveBeenCalledTimes(requests);
  });

  it('reuses cached data on 304 and sends conditional request headers', async () => {
    const { cache, fetchImpl } = await setup();
    await cache.refresh(1000);
    fetchImpl.mockImplementation(async () => new Response(null, { status: 304 }));
    await cache.refresh(3_601_000);

    expect(fetchImpl.mock.calls.at(-1)[1].headers['If-None-Match']).toBe('version-1');
    expect(await readJson(path.join(cache.dataPath, 'gear.json'))).toEqual(fixtures['gear.json']);
  });

  it('does not retry a failed initial request immediately after a restart', async () => {
    const { cache, fetchImpl } = await setup();
    fetchImpl.mockRejectedValue(new Error('offline'));
    await expect(cache.refresh(1000)).rejects.toThrow('offline');
    await cache.refresh(61_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
