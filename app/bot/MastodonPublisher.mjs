import { setTimeout as sleep } from 'node:timers/promises';

export default class MastodonPublisher {
  constructor({ url, token, fetchImpl = fetch, sleepImpl = sleep } = {}) {
    this.url = new URL(url).origin;
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
  }

  async request(endpoint, { method = 'GET', body, headers = {} } = {}) {
    const response = await this.fetch(this.url + endpoint, {
      method, body, signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${this.token}`, ...headers },
    });
    if (!response.ok) {
      const error = new Error(`Mastodon ${method} ${endpoint.split('?')[0]}: HTTP ${response.status}`);
      const retry = response.headers.get('retry-after');
      error.retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
      throw error;
    }
    return { data: await response.json(), status: response.status };
  }

  async verifyAccount() {
    const { data } = await this.request('/api/v1/accounts/verify_credentials');
    if (!data.id || !data.url) throw new Error('Invalid Mastodon account response');
    this.account = { id: data.id, acct: data.acct, url: data.url };
    return this.account;
  }

  async upload(media) {
    const body = new FormData();
    body.set('file', new Blob([media.file], { type: 'image/png' }), 'rotation.png');
    body.set('description', media.altText || '');
    const { data } = await this.request('/api/v2/media', { method: 'POST', body });
    if (!data.id) throw new Error('Mastodon did not return an attachment ID');
    return data.id;
  }

  async waitForMedia(id) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const { data, status } = await this.request(`/api/v1/media/${encodeURIComponent(id)}`);
      if (status !== 206 && data.url) return;
      await this.sleep(3000);
    }
    throw new Error('Mastodon media processing timed out');
  }

  async publish(payload, idempotencyKey) {
    const { data } = await this.request('/api/v1/statuses', {
      method: 'POST', body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    });
    if (!data.id || !data.url) throw new Error('Mastodon did not confirm the created status');
    return { id: data.id, url: data.url, visibility: data.visibility };
  }

  async findPublished(job) {
    // Reconcile ambiguous POST responses even after the server's idempotency cache expires.
    // Attachment IDs were persisted before POST and uniquely identify this generated image.
    let maxId;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: '40', exclude_reblogs: 'true' });
      if (maxId) query.set('max_id', maxId);
      const { data: statuses } = await this.request(`/api/v1/accounts/${encodeURIComponent(this.account.id)}/statuses?${query}`);
      if (!Array.isArray(statuses)) throw new Error('Invalid Mastodon timeline response');
      const match = statuses.find(status => job.mediaIds.every(id => status.media_attachments?.some(media => media.id === id)));
      if (match) return { id: match.id, url: match.url, visibility: match.visibility };
      if (!statuses.length || statuses.some(status => Date.parse(status.created_at) < job.attemptedAt - 60_000)) return null;
      maxId = statuses.at(-1).id;
    }
    throw new Error('Cannot safely reconcile pending post: timeline scan limit reached');
  }
}
