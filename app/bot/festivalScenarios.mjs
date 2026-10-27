// Isolated, deliberately simulated festival data for previews; never downloaded or published.
export function festivalScenarios(data) {
  const festival = data.festivals.AP.data.festRecords.nodes[0];
  const start = Date.parse(festival.startTime);
  const end = Date.parse(festival.endTime);
  const midterm = start + 24.5 * 3600_000; // Deliberately inside a rotation, to test the transition.
  const iso = value => new Date(value).toISOString();
  const originals = data.schedules.data;
  const template = originals.regularSchedules.nodes.find(node => node.regularMatchSetting).regularMatchSetting;
  const stages = template.vsStages;
  const ratios = ['horagaiRatio', 'voteRatio', 'regularContributionRatio', 'challengeContributionRatio', 'tricolorContributionRatio'];
  return [
    ['announced', start - 4 * 86400_000], ['three-days', start - 3 * 86400_000],
    ['one-day', start - 86400_000], ['first-half', start + 10 * 60_000],
    ['before-tricolor', midterm - 1], ['tricolor', midterm],
    ['ended', end + 10 * 60_000], ['results', end + 2 * 3600_000],
  ].map(([name, now]) => {
    const sample = structuredClone(data);
    const slot = start + Math.floor((now - start) / 7200_000) * 7200_000;
    const node = { startTime: iso(slot), endTime: iso(slot + 7200_000) };
    const schedules = sample.schedules.data;
    schedules.regularSchedules.nodes = [{ ...node, regularMatchSetting: template }];
    schedules.bankaraSchedules.nodes = [{ ...node, bankaraMatchSettings: [
      { ...template, bankaraMode: 'CHALLENGE' }, { ...template, bankaraMode: 'OPEN' },
    ] }];
    schedules.xSchedules.nodes = [{ ...node, xMatchSetting: template }];
    const active = now >= start && now < end;
    schedules.festSchedules.nodes = active ? [{ ...node, festMatchSettings: [
      { ...template, festMode: 'REGULAR' }, { ...template, festMode: 'CHALLENGE' },
    ] }] : [];
    schedules.currentFest = active ? {
      ...festival, midtermTime: iso(midterm), state: now >= midterm ? 'SECOND_HALF' : 'FIRST_HALF',
      tricolorStages: structuredClone(stages),
    } : null;
    for (const region of ['AP', 'US', 'EU', 'JP']) {
      const record = sample.festivals[region].data.festRecords.nodes.find(node => node.__splatoon3ink_id === festival.__splatoon3ink_id);
      if (name === 'results' && record) {
        record.teams.forEach((team, index) => {
          team.result = { isWinner: index === 1, ...Object.fromEntries(ratios.map(key => [key, [0.3, 0.4, 0.3][index]])) };
        });
      }
    }
    return { name, now, data: sample };
  });
}
