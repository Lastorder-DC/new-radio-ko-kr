import { readJson } from './files.mjs';

const state = await readJson('storage/public-bot/health.json');
if (!state?.completedAt || Date.now() - state.completedAt > 5 * 60_000) process.exit(1);
