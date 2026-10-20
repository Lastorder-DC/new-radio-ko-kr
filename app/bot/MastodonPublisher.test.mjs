import { describe, expect, it, vi } from 'vitest';
import MastodonPublisher from './MastodonPublisher.mjs';

const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

describe('Mastodon bot transport', () => {
  it('sends an idempotency header and does not expose tokens in HTTP errors', async () => {
    const fetchImpl = vi.fn(async () => reply({ id: 'post', url: 'https://m.example/@bot/post', visibility: 'unlisted' }));
    const client = new MastodonPublisher({ url: 'https://m.example/', token: 'secret-token', fetchImpl });
    const payload = { status: '한국어', visibility: 'unlisted', language: 'ko', media_ids: ['image'] };
    await client.publish(payload, 'stable-event-key');

    expect(fetchImpl.mock.calls[0][1].headers['Idempotency-Key']).toBe('stable-event-key');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(payload);
    fetchImpl.mockResolvedValue(new Response('server echoed secret-token', { status: 429, headers: { 'retry-after': '120' } }));
    await expect(client.publish(payload, 'stable-event-key')).rejects.toMatchObject({ retryAfterMs: 120_000 });
    await expect(client.publish(payload, 'stable-event-key')).rejects.not.toThrow('secret-token');
  });

  it('finds an accepted post by persisted attachment IDs, across timeline pages', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply([{ id: '200', created_at: '2026-10-20T13:01:00Z', media_attachments: [] }]))
      .mockResolvedValueOnce(reply([{ id: '100', url: 'https://m.example/@bot/100', visibility: 'unlisted',
        created_at: '2026-10-20T13:00:00Z', media_attachments: [{ id: 'image' }] }]));
    const client = new MastodonPublisher({ url: 'https://m.example', token: 'secret', fetchImpl });
    client.account = { id: 'bot' };
    const result = await client.findPublished({ mediaIds: ['image'], attemptedAt: Date.parse('2026-10-20T13:00:00Z') });

    expect(result.id).toBe('100');
    expect(fetchImpl.mock.calls[1][0]).toContain('max_id=200');
  });

  it('waits for asynchronous image processing before posting', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply({ id: 'image', url: null }, 206))
      .mockResolvedValueOnce(reply({ id: 'image', url: 'https://media.example/image.png' }));
    const sleepImpl = vi.fn(async () => {});
    const client = new MastodonPublisher({ url: 'https://m.example', token: 'secret', fetchImpl, sleepImpl });
    await client.waitForMedia('image');

    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
