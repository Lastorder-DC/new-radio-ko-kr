const postFields = 'id status channelId externalLink';

export default class BufferApi {
  constructor(apiKey = process.env.BUFFER_API_KEY) {
    this.apiKey = apiKey;
  }

  async request(query, variables = {}) {
    if (!this.apiKey) {
      throw new Error('Missing BUFFER_API_KEY');
    }

    const response = await fetch('https://api.buffer.com', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const error = new Error(`Buffer HTTP ${response.status}`);
      error.definitive = response.status >= 400 && response.status < 500 && response.status !== 408;
      error.retryAfterMs = Number(response.headers.get('retry-after') || 0) * 1000;
      throw error;
    }

    const result = await response.json();

    if (result.errors?.length || !result.data) {
      throw new Error(
        result.errors?.map(error => error.message).join('; ') || 'Buffer returned no data',
      );
    }

    return result.data;
  }

  async createPost(channelId, text, assets) {
    const data = await this.request(`
      mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess { post { ${postFields} } }
          ... on MutationError { message }
        }
      }
    `, {
      input: {
        channelId,
        text,
        assets,
        schedulingType: 'automatic',
        mode: 'shareNow',
        saveToDraft: false,
        needsApproval: false,
      },
    });

    if (data.createPost?.message) {
      const error = new Error(data.createPost.message);
      error.definitive = true;
      throw error;
    }

    const post = data.createPost?.post;

    if (!post?.id || !post.status || post.channelId !== channelId) {
      throw new Error('Buffer returned an unexpected post; check Buffer before retrying');
    }

    return post;
  }

  async getDeliveryChannel(id) {
    const data = await this.request(`
      query DeliveryChannel($input: ChannelInput!) {
        channel(input: $input) { id name service externalLink organizationId isDisconnected isLocked isQueuePaused }
      }
    `, { input: { id } });
    return data.channel;
  }

  async getPost(id) {
    const data = await this.request(`
      query DeliveryPost($input: PostInput!) {
        post(input: $input) { ${postFields} }
      }
    `, { input: { id } });
    return data.post;
  }

  async listPostPage(organizationId, channelId, after = null) {
    const data = await this.request(`
      query DeliveryPosts($input: PostsInput!, $after: String) {
        posts(first: 100, after: $after, input: $input) {
          edges { node { ${postFields} text assets { source } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { input: { organizationId, filter: { channelIds: [channelId] } }, after });
    if (!Array.isArray(data.posts?.edges) || !data.posts.pageInfo) throw new Error('Invalid Buffer post list');
    return data.posts;
  }

  async getChannel(id) {
    const data = await this.request(`
      query GetChannel($input: ChannelInput!) {
        channel(input: $input) { id service isDisconnected isLocked }
      }
    `, { input: { id } });

    return data.channel;
  }

  async listChannels() {
    const data = await this.request('query { account { organizations { id } } }');
    const channels = [];

    for (const organization of data.account.organizations) {
      const result = await this.request(`
        query GetChannels($input: ChannelsInput!) {
          channels(input: $input) { id name service isDisconnected isLocked }
        }
      `, { input: { organizationId: organization.id } });

      channels.push(...result.channels);
    }

    return channels;
  }
}
