import { describe, expect, it, vi } from 'vitest';
import { createPinia } from 'pinia';
import { FestivalStatus, FestivalResultsStatus } from './FestivalStatus.mjs';
import SchedulesStatus from '../social/generators/SchedulesStatus.mjs';
import StatusGenerator from '../social/generators/StatusGenerator.mjs';
import { useFestivalsDataStore, useSchedulesDataStore } from '../../src/stores/data.mjs';
import { useTimeStore } from '../../src/stores/time.mjs';
import { festivalScheduleState } from '../../src/common/festival.mjs';

vi.mock('../common/prefixedConsole.mjs', () => ({ default: () => ({ log: vi.fn() }) }));
const start = Date.parse('2026-10-31T00:00:00Z');
const end = start + 48 * 3600_000;
const midterm = start + 24.5 * 3600_000;
const iso = value => new Date(value).toISOString();
const stage = { id: 'stage', name: 'English stage', image: { url: '/image.png' } };
const rule = { id: 'rule', name: 'Turf War' };
const festival = {
  id: 'festival', __splatoon3ink_id: 'JUEA-108', title: 'English title',
  startTime: iso(start), endTime: iso(end),
  teams: ['마법사', '기사', '닌자'].map(teamName => ({ teamName, result: null })),
};
const translations = {
  festivals: { 'JUEA-108': { title: '판타지 세계로 들어간다면?', teams: festival.teams } },
  stages: { stage: { name: '석순 대협곡' } }, rules: { rule: { name: '영역 배틀' } },
};
function schedules(now, { missing = false, results = false } = {}) {
  const slot = start + Math.floor((now - start) / 7200_000) * 7200_000;
  const setting = { vsStages: [structuredClone(stage), structuredClone(stage)], vsRule: rule };
  const node = { startTime: iso(slot), endTime: iso(slot + 7200_000) };
  return {
    data: {
      // Stale ordinary schedules must not take precedence over a known active festival.
      regularSchedules: { nodes: [{ ...node, regularMatchSetting: setting }] },
      bankaraSchedules: { nodes: [{ ...node, bankaraMatchSettings: [{ ...setting, bankaraMode: 'CHALLENGE' }, { ...setting, bankaraMode: 'OPEN' }] }] },
      xSchedules: { nodes: [{ ...node, xMatchSetting: setting }] },
      festSchedules: { nodes: missing || now >= end ? [] : [{ ...node, festMatchSettings: [
        { ...setting, festMode: 'REGULAR' }, { ...setting, festMode: 'CHALLENGE' },
      ] }] },
      vsStages: { nodes: [] }, currentFest: { ...festival, midtermTime: iso(midterm), tricolorStages: [stage] },
    },
    festivals: { AP: { data: { festRecords: { nodes: [{ ...festival, teams: festival.teams.map((team, index) => ({
      ...team, result: results ? { isWinner: index === 1 } : null,
    })) }] } } } },
  };
}
function prepare(generator, now, options) {
  const data = schedules(now, options);
  generator.pinia = createPinia();
  useTimeStore(generator.pinia).setNow(now);
  useFestivalsDataStore(generator.pinia).setData(data.festivals);
  useSchedulesDataStore(generator.pinia).setData(data);
  generator._piniaPromise = Promise.resolve();
  return generator;
}

describe('public bot festival support', () => {
  it.each([
    [start - 4 * 86400_000, 'upcoming'], [start - 3 * 86400_000, 'upcoming:3d'],
    [start - 86400_000, 'upcoming:1d'], [start, 'active'], [midterm - 1, 'active'],
    [midterm, 'tricolor'], [end, 'ended'],
  ])('selects the correct phase at %s', async (now, state) => {
    const generator = prepare(new FestivalStatus({ translations }), now);
    expect(await generator.getState()).toBe(state);
    expect(await generator.getDataTime()).toBe(`JUEA-108:${state}`);
    const body = await generator._getStatus();
    expect(body).not.toContain('English');
    if (state !== 'ended') expect(body).toContain('판타지 세계로 들어간다면?');
  });

  it('emits a tricolor rotation change inside the same two-hour slot', async () => {
    const before = prepare(new SchedulesStatus({ locale: 'ko-KR', translations }), midterm - 1);
    const after = prepare(new SchedulesStatus({ locale: 'ko-KR', translations }), midterm);
    expect(await before.getDataTime()).not.toBe(await after.getDataTime());
    const body = await after._getStatus();
    expect(body).toContain('오픈: 석순 대협곡');
    expect(body).toContain('챌린지: 석순 대협곡');
    expect(body).toContain('트리컬러: 석순 대협곡');
    expect(body).not.toMatch(/카오폴리스|X 매치|English/);
  });

  it('waits for festival schedules instead of announcing stale ordinary matches', async () => {
    const generator = prepare(new SchedulesStatus({ locale: 'ko-KR', translations }), start, { missing: true });
    expect(await generator.getDataTime()).toBeNull();
    expect(festivalScheduleState(schedules(start, { missing: true }).data, start, festival).isFestival).toBe(true);
  });

  it('returns to ordinary rotations exactly at the festival end', async () => {
    const generator = prepare(new SchedulesStatus({ locale: 'ko-KR', translations }), end);
    expect(await generator.getDataTime()).toBe(end);
    expect(await generator._getStatus()).toContain('카오폴리스');
  });

  it('waits for complete results and identifies the Korean winning team', async () => {
    const empty = prepare(new FestivalResultsStatus({ translations }), end);
    expect(await empty.getDataTime()).toBeNull();
    const results = prepare(new FestivalResultsStatus({ translations }), end + 3600_000, { results: true });
    expect(await results.getDataTime()).toBe('JUEA-108:results');
    expect(await results._getStatus()).toContain('기사 팀 승리');
  });

  it('does not publish partial results even when one team already has a winner flag', async () => {
    const generator = prepare(new FestivalResultsStatus({ translations }), end + 3600_000, { results: true });
    const data = useFestivalsDataStore(generator.pinia).data;
    data.AP.data.festRecords.nodes[0].teams[0].result = null;
    expect(await generator.getDataTime()).toBeNull();
  });


  it.each([[1000, 'festival:ended', true], ['festival:active', 1000, true], ['festival:active', 'festival:active', false]])(
    'keeps legacy delivery working across numeric and festival keys', async (current, cached, expected) => {
      const generator = new StatusGenerator;
      vi.spyOn(generator, 'getDataTime').mockResolvedValue(current);
      vi.spyOn(generator, 'lastPostCache').mockReturnValue({ getData: async () => cached });
      expect(await generator.shouldPost({ key: 'client' })).toBe(expected);
    },
  );

});
