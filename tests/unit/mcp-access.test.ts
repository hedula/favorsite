import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '@/core/knowledge-store';
import { McpAccessStore } from '@/core/mcp-access';

const databases: KnowledgeStore[] = [];

function setup() {
  const store = new KnowledgeStore('mcp-access-' + crypto.randomUUID());
  databases.push(store);
  return { store, access: new McpAccessStore(store) };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('desktop MCP connection grants', () => {
  it('serializes concurrent changes without losing grants or persisting plaintext secrets', async () => {
    const { store, access } = setup();
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      access.createConnection('profile-a', {
        label: 'Client ' + index, folderIds: ['docs', 'docs'], includeContent: index % 2 === 0,
      }),
    ));
    const listed = await access.listConnections('profile-a');
    expect(listed).toHaveLength(12);
    expect(new Set(listed.map((connection) => connection.connectionId)).size).toBe(12);
    expect(listed.every((connection) => connection.folderIds.length === 1)).toBe(true);
    const stored = await store.getValue<Array<{ tokenHash: string }>>('profile-a', 'mcp-connections');
    expect(stored?.every((connection) => /^[a-f0-9]{64}$/.test(connection.tokenHash))).toBe(true);
    for (const entry of created) {
      expect(JSON.stringify(stored)).not.toContain(entry.token);
      expect(JSON.stringify(listed)).not.toContain(entry.token);
      expect(await access.authorize('profile-a', entry.token)).toEqual(entry.connection);
    }
    await Promise.all(created.map(({ connection }, index) => access.updateConnection('profile-a', {
      connectionId: connection.connectionId, folderIds: ['folder-' + index],
      includeContent: false, enabled: index !== 0,
    })));
    const updated = await access.listConnections('profile-a');
    expect(updated).toHaveLength(12);
    expect(new Set(updated.map((connection) => connection.folderIds[0])).size).toBe(12);
    expect(updated.filter((connection) => connection.enabled)).toHaveLength(11);
  });

  it('isolates profile credentials and rejects altered, revoked and deleted tokens', async () => {
    const { access } = setup();
    const first = await access.createConnection('profile-a', {
      label: 'Claude', folderIds: ['docs'], includeContent: true,
    });
    await access.createConnection('profile-b', { label: 'ChatGPT', folderIds: ['docs'], includeContent: true });
    await expect(access.authorize('profile-b', first.token)).rejects.toThrow('UNAUTHORIZED');
    await expect(access.authorize('profile-a', first.connection.connectionId + '.altered')).rejects.toThrow('UNAUTHORIZED');
    await expect(access.authorize('profile-a', 'x'.repeat(201))).rejects.toThrow('UNAUTHORIZED');
    await access.updateConnection('profile-a', {
      connectionId: first.connection.connectionId, folderIds: ['docs'], includeContent: true, enabled: false,
    });
    await expect(access.authorize('profile-a', first.token)).rejects.toThrow('UNAUTHORIZED');
    expect(await access.deleteConnection('profile-a', first.connection.connectionId)).toBe(true);
    await expect(access.authorize('profile-a', first.token)).rejects.toThrow('UNAUTHORIZED');
    expect(await access.listConnections('profile-b')).toHaveLength(1);
  });

  it('recovers the per-profile update queue after a rejected mutation', async () => {
    const { access } = setup();
    await expect(access.updateConnection('profile-a', {
      connectionId: 'missing', folderIds: ['docs'], includeContent: true, enabled: true,
    })).rejects.toThrow('找不到');
    const created = await access.createConnection('profile-a', {
      label: 'Recovered', folderIds: ['docs'], includeContent: false,
    });
    expect(await access.authorize('profile-a', created.token)).toEqual(created.connection);
  });
});
