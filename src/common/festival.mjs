export function activePeriod(period, now) {
  return !!period && Date.parse(period.startTime) <= now && now < Date.parse(period.endTime);
}

export function tricolorActive(festival, now) {
  return activePeriod(festival, now) && Number.isFinite(Date.parse(festival.midtermTime)) && now >= Date.parse(festival.midtermTime);
}

// Both the bot and screenshot use this decision, including when the two JSON files lag.
export function festivalScheduleState(schedules, now, knownFestival = null) {
  const rotation = schedules?.festSchedules?.nodes?.find(node => activePeriod(node, now) && node.festMatchSettings?.length);
  const current = activePeriod(schedules?.currentFest, now) ? schedules.currentFest : null;
  return {
    isFestival: !!rotation || !!current || activePeriod(knownFestival, now),
    rotation,
    tricolor: current,
    isTricolorActive: tricolorActive(current, now),
  };
}
