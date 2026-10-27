import fs from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import dotenv from 'dotenv';
import { createPinia } from 'pinia';
import { FestivalStatus, FestivalResultsStatus } from './FestivalStatus.mjs';
import { festivalScenarios } from './festivalScenarios.mjs';
import SchedulesStatus from '../social/generators/SchedulesStatus.mjs';
import ScreenshotHelper from '../screenshots/ScreenshotHelper.mjs';
import HttpServer from '../screenshots/HttpServer.mjs';
import { useTimeStore } from '../../src/stores/time.mjs';
import { useSchedulesDataStore, useGearDataStore, useCoopDataStore, useFestivalsDataStore } from '../../src/stores/data.mjs';
import { readJson, writeJson } from './files.mjs';

dotenv.config({ quiet: true });
const root = path.resolve('temp/festival-preview');
const manifest = await readJson('storage/public-bot/source.json');
const source = path.resolve('storage/public-bot', manifest.current);
const data = {};
for (const name of ['schedules', 'gear', 'coop', 'festivals']) data[name] = await readJson(path.join(source, `${name}.json`));
data.locale = await readJson(path.join(source, 'locale/ko-KR.json'));
const reports = [];
for (const scenario of festivalScenarios(data).filter(scenario => !process.argv[2] || scenario.name === process.argv[2])) {
  const site = path.join(root, scenario.name, 'site');
  await fs.mkdir(path.join(site, 'data/locale'), { recursive: true });
  for (const name of ['schedules', 'gear', 'coop', 'festivals']) await writeJson(path.join(site, 'data', `${name}.json`), scenario.data[name]);
  await writeJson(path.join(site, 'data/locale/ko-KR.json'), scenario.data.locale);
  for (const name of ['assets', 'screenshots']) {
    await fs.rm(path.join(site, name), { force: true });
    await fs.symlink(path.resolve('dist', name), path.join(site, name), 'dir');
  }
  const output = { scenario: scenario.name, now: new Date(scenario.now).toISOString(), generated: [] };
  for (const generator of [new SchedulesStatus({ locale: 'ko-KR', now: scenario.now }),
    new FestivalStatus({ now: scenario.now }), new FestivalResultsStatus({ now: scenario.now })]) {
    generator.messages.translations = scenario.data.locale;
    generator._loadData = async () => {
      generator.pinia = createPinia();
      useTimeStore(generator.pinia).setNow(scenario.now);
      for (const [name, store] of [['schedules', useSchedulesDataStore], ['gear', useGearDataStore],
        ['coop', useCoopDataStore], ['festivals', useFestivalsDataStore]]) {
        store(generator.pinia).setData(structuredClone(scenario.data[name]));
      }
    };
    const event = await generator.getDataTime();
    if (event === null || event === false) continue;
    const helper = new ScreenshotHelper({
      provider: 'browserless',
      env: { ...process.env, SCREENSHOT_HOST: process.env.FESTIVAL_PREVIEW_HOST || hostname() },
      httpServerFactory: () => new HttpServer({ root: site }),
    });
    try {
      const status = await generator.getStatus(helper);
      const target = path.join(root, scenario.name, generator.key);
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'image.png'), status.media[0].file);
      await fs.writeFile(path.join(target, 'status.txt'), `${status.status}\n\nALT:\n${status.media[0].altText}\n`);
      output.generated.push({ key: generator.key, event, text: status.status });
      console.info(`[Festival preview] ${scenario.name}/${generator.key}`);
    } finally { await helper.close(); }
  }
  reports.push(output);
}
await writeJson(path.join(root, 'report.json'), reports);
console.info('Festival previews complete. Simulated data only; no posts or delivery-history changes.');
