import { describe, expect, it, vi } from 'vitest';
import SchedulesStatus from './SchedulesStatus.mjs';
import SalmonRunStatus from './SalmonRunStatus.mjs';
import SocialMessages, { MissingTranslationError } from '../i18n/SocialMessages.mjs';
import english from '../i18n/en-US.json' with { type: 'json' };
import korean from '../i18n/ko-KR.json' with { type: 'json' };
import japanese from '../i18n/ja-JP.json' with { type: 'json' };
import { defaultClients } from '../index.mjs';

vi.mock('../../common/prefixedConsole.mjs', () => ({
  default: () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const translations = {
  stages: { stage: { name: '아라말 대교' }, coop: { name: '연어말이 요새' } },
  rules: { rule: { name: '랭크 에어리어' } },
  weapons: { weapon: { name: '스플랫 슈터' } },
  bosses: { boss: { name: '요코즈나' } },
};
const schedule = {
  startTime: '2026-10-20T12:00:00Z',
  endTime: '2026-10-20T14:00:00Z',
  settings: {
    vsRule: { id: 'rule', name: 'Splat Zones' },
    vsStages: [{ id: 'stage', name: 'English stage' }, { id: 'stage', name: 'English stage' }],
    coopStage: { id: 'coop', name: 'English coop' },
    weapons: [{ __splatoon3ink_id: 'weapon', name: 'Splattershot' }],
    boss: { id: 'boss', name: 'Cohozuna' },
  },
};

function templates(catalog, prefix = '') {
  return Object.entries(catalog).flatMap(([key, value]) => typeof value === 'string'
    ? [[prefix + key, [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1])]]
    : templates(value, `${prefix}${key}.`));
}

describe('Korean social output', () => {
  it('covers every message and uses only parameters supported by the generator', () => {
    const original = new Map(templates(english));
    const alternate = new Map(templates(japanese));
    const translated = templates(korean);

    expect(translated.map(([key]) => key).sort()).toEqual([...original.keys()].sort());
    for (const [key, parameters] of translated) {
      expect(parameters.every(parameter => [...original.get(key), ...alternate.get(key)].includes(parameter)), key).toBe(true);
    }
  });

  it('translates game names, fails on missing translations, and formats Korean dates', () => {
    const messages = new SocialMessages('ko-KR', translations);

    expect(messages.game('stages', { id: 'stage', name: 'English' })).toBe('아라말 대교');
    expect(() => messages.game('stages', { id: 'missing' })).toThrow(MissingTranslationError);
    expect(messages.date('2026-10-20T18:00:00Z')).toContain('21');
    expect(messages.date('2026-10-20T18:00:00Z')).toContain('3:00');
    expect(messages.period(schedule.startTime, schedule.endTime)).toContain('한국 시간');
  });

  it('renders Korean rotation and shift bodies through the existing generators', async () => {
    const stages = new SchedulesStatus({ locale: 'ko-KR', translations });
    vi.spyOn(stages, 'getStages').mockResolvedValue({
      regular: schedule, anarchySeries: schedule, anarchyOpen: schedule, xMatch: schedule,
    });
    const body = await stages._getStatus();

    expect(body).toContain('카오폴리스 매치(챌린지): 랭크 에어리어');
    expect(body).not.toContain('Splat Zones');

    const salmon = new SalmonRunStatus({ locale: 'ko-KR', translations });
    vi.spyOn(salmon, 'getActiveSchedule').mockResolvedValue(schedule);
    const shift = await salmon._getStatus();

    expect(shift).toContain('연어말이 요새에서 연어런 진행 중!');
    expect(shift).toContain('거물연어: 요코즈나');
    expect(shift).toContain('– 스플랫 슈터');
    expect(salmon.images.shift(schedule, Date.parse(schedule.startTime))).toContain('한국 시간');
  });

  it('assigns the Korean locale to all configured primary clients', () => {
    expect(defaultClients('ko-KR').every(client => client.locale === 'ko-KR')).toBe(true);
  });
});
