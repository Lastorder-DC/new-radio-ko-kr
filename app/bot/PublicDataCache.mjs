import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './files.mjs';

const hour = 60 * 60 * 1000;
export const publicFiles = ['schedules.json', 'gear.json', 'coop.json', 'festivals.json', 'locale/ko-KR.json'];

export function validatePublicData(name, data) {
  const requiredArrays = name === 'schedules.json'
    ? [data?.data?.regularSchedules?.nodes, data?.data?.bankaraSchedules?.nodes,
      data?.data?.xSchedules?.nodes, data?.data?.festSchedules?.nodes,
      data?.data?.coopGroupingSchedule?.regularSchedules?.nodes,
      data?.data?.coopGroupingSchedule?.bigRunSchedules?.nodes]
    : name === 'gear.json' ? [data?.data?.gesotown?.limitedGears] : [];
  if (!data || typeof data !== 'object' || requiredArrays.some(value => !Array.isArray(value))) {
    throw new Error(`Invalid public JSON: ${name}`);
  }
  if (name === 'coop.json' && !data.data?.coopResult) throw new Error('Invalid coop JSON');
  if (name === 'festivals.json' && !data.US && !data.AP && !data.JP) throw new Error('Invalid festivals JSON');
  if (name === 'locale/ko-KR.json' && ['stages', 'rules', 'gear', 'weapons', 'powers', 'brands'].some(key => !data[key])) {
    throw new Error('Incomplete Korean game translations');
  }
}

export default class PublicDataCache {
  constructor({ root = 'storage/public-bot', dataPath = 'dist/data', fetchImpl = fetch,
    userAgent = 'new-radio-ko-kr/1.0 (https://github.com/Lastorder-DC/new-radio-ko-kr)' } = {}) {
    this.root = path.resolve(root);
    this.dataPath = path.resolve(dataPath);
    this.fetch = fetchImpl;
    this.userAgent = userAgent;
  }

  get manifestPath() { return path.join(this.root, 'source.json'); }

  async refresh(now = Date.now()) {
    const manifest = await readJson(this.manifestPath, {});
    if (manifest.current) await this.activate(path.resolve(this.root, manifest.current));
    if (manifest.lastAttemptAt && now - manifest.lastAttemptAt < hour) return manifest;

    // Persist before making requests: restarts and outages must not bypass the hourly limit.
    manifest.lastAttemptAt = now;
    await writeJson(this.manifestPath, manifest);
    const snapshot = path.join(this.root, 'snapshots', `${now}-${randomUUID()}`);
    await fs.mkdir(snapshot, { recursive: true });
    const validators = {};
    let committed = false;
    try {
      for (const name of publicFiles) {
        const headers = { 'User-Agent': this.userAgent, Accept: 'application/json' };
        const previous = manifest.validators?.[name];
        if (previous?.etag) headers['If-None-Match'] = previous.etag;
        if (previous?.modified) headers['If-Modified-Since'] = previous.modified;
        const response = await this.fetch(`https://splatoon3.ink/data/${name}`, {
          headers, signal: AbortSignal.timeout(30_000),
        });
        let data;
        if (response.status === 304 && manifest.current) {
          data = await readJson(path.join(this.root, manifest.current, name));
        } else {
          if (!response.ok) throw new Error(`Public data ${name}: HTTP ${response.status}`);
          data = await response.json();
        }
        validatePublicData(name, data);
        validators[name] = {
          etag: response.headers.get('etag') ?? previous?.etag,
          modified: response.headers.get('last-modified') ?? previous?.modified,
        };
        await writeJson(path.join(snapshot, name), data);
      }
      const updated = { ...manifest, current: path.relative(this.root, snapshot), fetchedAt: now, validators };
      // One pointer selects the entire validated snapshot; readers never see a partial download.
      await writeJson(this.manifestPath, updated);
      committed = true;
      await this.activate(snapshot);
      // Keep the previous snapshot as well for recovery.
      const keep = new Set([snapshot, manifest.current && path.resolve(this.root, manifest.current)]);
      for (const entry of await fs.readdir(path.join(this.root, 'snapshots'))) {
        const file = path.join(this.root, 'snapshots', entry);
        if (!keep.has(file)) await fs.rm(file, { recursive: true, force: true });
      }
      console.info('[PublicData] Snapshot updated');
      return updated;
    } catch (error) {
      if (!committed) await fs.rm(snapshot, { recursive: true, force: true });
      throw error;
    }
  }

  async activate(snapshot) {
    await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
    const temporary = `${this.dataPath}.${randomUUID()}.link`;
    await fs.symlink(snapshot, temporary, 'dir');
    try {
      const existing = await fs.lstat(this.dataPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (existing && !existing.isSymbolicLink()) {
        // Preserve the pre-bot local data on first adoption.
        await fs.rename(this.dataPath, `${this.dataPath}.before-public-bot-${randomUUID()}`);
      }
      await fs.rename(temporary, this.dataPath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
