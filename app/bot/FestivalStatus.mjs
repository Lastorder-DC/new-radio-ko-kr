import SplatfestStatus from '../social/generators/SplatfestStatus.mjs';
import SplatfestResultsStatus from '../social/generators/SplatfestResultsStatus.mjs';
import Media from '../social/Media.mjs';
import { useAPSplatfestsStore } from '../../src/stores/splatfests.mjs';
import { useSchedulesDataStore } from '../../src/stores/data.mjs';
import { useTimeStore } from '../../src/stores/time.mjs';
import { tricolorActive } from '../../src/common/festival.mjs';

async function festivalMedia(generator, screenshots) {
  const festival = await generator.getFestival();
  const media = new Media;
  media.file = await screenshots.capture('splatfest/AP', {
    params: { festivalId: festival.__splatoon3ink_id },
  });
  media.altText = [generator.images.festival(festival, { includeTheme: true }),
    generator.messages.period(festival.startTime, festival.endTime)].join('\n');
  return media;
}

export class FestivalStatus extends SplatfestStatus {
  constructor(options = {}) {
    super('AP', { locale: 'ko-KR', ...options });
  }

  async getFestival() {
    await this.preparePinia();
    const store = useAPSplatfestsStore(this.pinia);
    return store.activeFestival || store.recentFestival || store.upcomingFestival;
  }

  async getState() {
    const state = await super.getState();
    if (state !== 'active') return state;
    const festival = await this.getFestival();
    const current = useSchedulesDataStore(this.pinia).data?.currentFest;
    return Date.parse(current?.startTime) === Date.parse(festival.startTime) && tricolorActive(current, useTimeStore(this.pinia).now)
      ? 'tricolor' : state;
  }

  async getDataTime() {
    const festival = await this.getFestival();
    const state = await this.getState();
    return festival && state ? `${festival.__splatoon3ink_id}:${state}` : null;
  }

  async _getStatus() {
    const festival = await this.getFestival();
    const state = await this.getState();
    const title = this.game('festivals', festival, 'title');
    const body = state === 'upcoming'
      ? this.t('festival.announced', { title })
      : await super._getStatus();
    return state === 'ended' ? body : [body, this.messages.period(festival.startTime, festival.endTime)].join('\n\n');
  }

  async _getMedia(screenshots) { return festivalMedia(this, screenshots); }
}

export class FestivalResultsStatus extends SplatfestResultsStatus {
  constructor(options = {}) {
    super('AP', { locale: 'ko-KR', ...options });
  }

  async getDataTime() {
    const festival = await this.getFestival();
    // Wait for a complete result rather than announcing partial totals or an unknown winner.
    return festival?.hasResults && festival.teams.every(team => team.result) &&
      festival.teams.some(team => team.result.isWinner) ? `${festival.__splatoon3ink_id}:results` : null;
  }

  async _getMedia(screenshots) { return festivalMedia(this, screenshots); }
}
