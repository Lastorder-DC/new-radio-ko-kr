import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read bot state: ${file}`, { cause: error });
  }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function errorMessage(error) {
  let message = error?.message || String(error);
  for (const secret of [process.env.MASTODON_ACCESS_TOKEN, process.env.BROWSERLESS_TOKEN]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message.replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]');
}
