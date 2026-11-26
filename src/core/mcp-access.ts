import type { McpConnectionSummary } from './knowledge-protocol';
import { defaultKnowledgeStore, type KnowledgeStore } from './knowledge-store';

interface StoredConnection extends McpConnectionSummary {
  tokenHash: string;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function publicConnection({ tokenHash: _, ...connection }: StoredConnection): McpConnectionSummary {
  return connection;
}

/** Grants are stored separately from the Studio's saved AI preferences. */
export class McpAccessStore {
  private readonly updates = new Map<string, Promise<unknown>>();

  constructor(private readonly store: Pick<KnowledgeStore, 'getValue' | 'setValue'> = defaultKnowledgeStore) {}

  private read(profileKey: string): Promise<StoredConnection[]> {
    return this.store.getValue<StoredConnection[]>(profileKey, 'mcp-connections').then((value) => value ?? []);
  }

  private async mutate<T>(
    profileKey: string,
    change: (connections: StoredConnection[]) => Promise<T> | T,
  ): Promise<T> {
    const previous = this.updates.get(profileKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const connections = await this.read(profileKey);
      const result = await change(connections);
      await this.store.setValue(profileKey, 'mcp-connections', connections);
      return result;
    });
    this.updates.set(profileKey, operation);
    try {
      return await operation;
    } finally {
      if (this.updates.get(profileKey) === operation) this.updates.delete(profileKey);
    }
  }

  async listConnections(profileKey: string): Promise<McpConnectionSummary[]> {
    await this.updates.get(profileKey)?.catch(() => undefined);
    return (await this.read(profileKey)).map(publicConnection);
  }

  async createConnection(
    profileKey: string,
    input: { label: string; folderIds: string[]; includeContent: boolean },
  ): Promise<{ connection: McpConnectionSummary; token: string }> {
    const connectionId = crypto.randomUUID();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (value) => value.toString(16).padStart(2, '0')).join('');
    const token = connectionId + '.' + secret;
    const now = Date.now();
    const stored: StoredConnection = {
      connectionId, label: input.label.trim(), folderIds: [...new Set(input.folderIds)],
      includeContent: input.includeContent, enabled: true, createdAt: now, updatedAt: now,
      tokenHash: await hashToken(token),
    };
    return this.mutate(profileKey, (connections) => {
      if (connections.length >= 50) throw new Error('已達 50 個桌面 AI 連線，請先移除舊連線。');
      connections.push(stored);
      return { connection: publicConnection(stored), token };
    });
  }

  async updateConnection(
    profileKey: string,
    input: { connectionId: string; folderIds: string[]; includeContent: boolean; enabled: boolean },
  ): Promise<McpConnectionSummary> {
    return this.mutate(profileKey, (connections) => {
      const connection = connections.find((entry) => entry.connectionId === input.connectionId);
      if (!connection) throw new Error('找不到這個桌面 AI 連線。');
      Object.assign(connection, input, { folderIds: [...new Set(input.folderIds)], updatedAt: Date.now() });
      return publicConnection(connection);
    });
  }

  async deleteConnection(profileKey: string, connectionId: string): Promise<boolean> {
    return this.mutate(profileKey, (connections) => {
      const index = connections.findIndex((entry) => entry.connectionId === connectionId);
      if (index < 0) return false;
      connections.splice(index, 1);
      return true;
    });
  }

  async authorize(profileKey: string, token: string): Promise<McpConnectionSummary> {
    if (typeof token !== 'string' || token.length > 200) throw new Error('UNAUTHORIZED: 桌面 AI 配對憑證無效。');
    const connectionId = token.split('.')[0];
    await this.updates.get(profileKey)?.catch(() => undefined);
    const connection = (await this.read(profileKey)).find((entry) => entry.connectionId === connectionId);
    if (!connection?.enabled) throw new Error('UNAUTHORIZED: 桌面 AI 連線已停用或尚未配對。');
    const hash = await hashToken(token);
    let difference = hash.length ^ connection.tokenHash.length;
    for (let index = 0; index < hash.length; index++) {
      difference |= hash.charCodeAt(index) ^ connection.tokenHash.charCodeAt(index);
    }
    if (difference !== 0) throw new Error('UNAUTHORIZED: 桌面 AI 配對憑證無效。');
    return publicConnection(connection);
  }
}

export const mcpAccess = new McpAccessStore();
