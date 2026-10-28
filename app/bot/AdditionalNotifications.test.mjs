import { describe, expect, it, vi } from 'vitest';
import { createPinia } from 'pinia';
import PublicBot from './PublicBot.mjs';
import { useSchedulesDataStore, useGearDataStore } from '../../src/stores/data.mjs';
import { useTimeStore } from '../../src/stores/time.mjs';

const now = Date.parse('2026-10-28T00:00:00Z');
const iso = offset => new Date(now + offset).toISOString();
const node = (start, end) => ({ startTime: iso(start), endTime: iso(end), setting: {
  coopStage: { id: 'stage' }, weapons: [{ name: 'Random' }],
} });
function generators() {
  return new PublicBot().generators(now).map(generator => {
    generator.pinia = createPinia();
    generator._piniaPromise = Promise.resolve();
    useTimeStore(generator.pinia).setNow(now);
    useGearDataStore(generator.pinia).setData({ data: { gesotown: { pickupBrand: null } } });
    useSchedulesDataStore(generator.pinia).setData({ data: {
      vsStages: { nodes: [] },
      eventSchedules: { nodes: [] },
      coopGroupingSchedule: {
        regularSchedules: { nodes: [node(-3600_000, 3600_000), node(3600_000, 7200_000)] },
        bigRunSchedules: { nodes: [] }, teamContestSchedules: { nodes: [] },
      },
    } });
    return generator;
  });
}

describe('additional public bot notifications', () => {
  it('enables Korean notifications while excluding monthly reward gear', () => {
    const list = generators();
    for (const key of ['gear.dailydrop', 'challenge', 'salmonrun.upcoming', 'eggstrawork.upcoming', 'eggstrawork']) {
      expect(list.find(generator => generator.key === key)?.locale).toBe('ko-KR');
    }
    expect(list.some(generator => generator.key === 'gear.salmonrun')).toBe(false);
  });

  it('ignores absent or expired pickup gear', async () => {
    const generator = generators().find(item => item.key === 'gear.dailydrop');
    expect(await generator.getDataTime()).toBeNull();
    useGearDataStore(generator.pinia).setData({ data: { gesotown: {
      pickupBrand: { saleEndTime: iso(-1), brandGears: [] },
    } } });
    expect(await generator.getDataTime()).toBeNull();
  });

  it('announces the future special shift and waits for absent contests and challenges', async () => {
    const list = generators();
    expect(await list.find(item => item.key === 'salmonrun.upcoming').getDataTime()).toBe(now + 3600_000);
    for (const key of ['eggstrawork.upcoming', 'eggstrawork', 'challenge']) {
      expect(Number.isFinite(await list.find(item => item.key === key).getDataTime())).toBe(false);
    }
  });

  it('renders upcoming contests through the lowercase Salmon Run route with Korean ALT', async () => {
    const generator = generators().find(item => item.key === 'eggstrawork.upcoming');
    const schedule = { ...node(3600_000, 7200_000), settings: node(0, 1).setting };
    vi.spyOn(generator, 'getActiveSchedule').mockResolvedValue(schedule);
    vi.spyOn(generator.images, 'shift').mockReturnValue('한국어 팀 콘테스트 설명');
    const capture = vi.fn().mockResolvedValue(Buffer.from('image'));
    const media = await generator._getMedia({ capture });
    expect(capture).toHaveBeenCalledWith('salmonrun', { params: { startTime: iso(3600_000), eggstra: 'true' } });
    expect(media.altText).toBe('한국어 팀 콘테스트 설명');
  });
});
