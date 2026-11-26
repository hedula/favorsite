import { describe, expect, it, vi } from 'vitest';
import { exportSnapshotBackupPayload, restoreBackupToFolder, validateAndPreviewBackup } from '@/core/backup';
import { buildProjections, extractFullSnapshotNodes } from '@/core/bookmark-engine';
import { validateStudioMessage } from '@/core/protocol';
import { FavorsiteStore } from '@/core/store';
import type { Snapshot } from '@/core/types';
import { MockChromeBookmarks } from './mock-bookmarks';

async function setup() {
  const adapter = new MockChromeBookmarks();
  const store = new FavorsiteStore(`snapshot_recovery_${Math.random()}`);
  const profileKey = await store.getOrCreateProfileKey();
  const outside = await adapter.create({ parentId: '1', title: 'Outside', url: 'https://outside.example/' });
  const folder = await adapter.create({ parentId: '1', title: 'Research' });
  const first = await adapter.create({ parentId: folder.id, title: 'First', url: 'https://first.example/' });
  await adapter.create({ parentId: folder.id, title: 'Empty' });
  const nested = await adapter.create({ parentId: folder.id, title: 'Nested' });
  const last = await adapter.create({ parentId: nested.id, title: 'Last', url: 'https://last.example/' });
  for (const node of [first, last, outside]) {
    await store.upsertMetadata({ profileKey, nodeId: node.id, tags: [node.title], originalDateAdded: 1234, updatedAt: 1234 });
  }
  const snapshot: Snapshot = {
    snapshotId: 'snapshot-research', schemaVersion: 1, profileKey, createdAt: 12345,
    reason: 'delete', label: 'Research',
    scope: { type: 'selection', bookmarkIds: [folder.id], targetFolderIds: ['1'] },
    nodes: extractFullSnapshotNodes(buildProjections(await adapter.getTree(), profileKey)).reverse(),
    metadata: await store.getAllMetadata(profileKey),
  };
  return { adapter, store, profileKey, folder, nested, first, last, outside, snapshot };
}

describe('snapshot subtree recovery', () => {
  it('restores the captured subtree with order, empty children and tags while preserving live edits', async () => {
    const { adapter, store, profileKey, folder, first, last, snapshot } = await setup();
    await store.saveSnapshot(snapshot);
    await adapter.removeTree(folder.id);
    const later = await adapter.create({ parentId: '2', title: 'Later change', url: 'https://later.example/' });
    const backup = exportSnapshotBackupPayload(await store.getSnapshot(snapshot.snapshotId), profileKey);
    expect(backup.tree.map((node) => node.title)).toEqual(['Research']);
    expect(backup.tree[0].children?.map((node) => node.title)).toEqual(['First', 'Empty', 'Nested']);
    expect(backup.metadata.map((item) => item.nodeId).sort()).toEqual([first.id, last.id].sort());
    expect(validateAndPreviewBackup(JSON.stringify(backup)).preview).toMatchObject({ valid: true, totalFolders: 3, totalBookmarks: 2 });
    const result = await restoreBackupToFolder({ adapter, store, profileKey, payload: backup, targetParentId: '2', branchTitle: 'Recovered' });
    const [restoredBranch] = await adapter.getSubTree(result.branchFolderId);
    const restored = restoredBranch.children![0];
    expect(restored.title).toBe('Research');
    expect(restored.children?.map((node) => node.title)).toEqual(['First', 'Empty', 'Nested']);
    expect(restored.children![1].children).toEqual([]);
    const restoredLast = restored.children![2].children![0];
    expect((await store.getMetadata(profileKey, restoredLast.id))).toMatchObject({ tags: ['Last'], originalDateAdded: 1234 });
    expect((await adapter.get(later.id))[0].title).toBe('Later change');
    expect(result).toMatchObject({ createdFolders: 3, createdBookmarks: 2, relinkedTags: 2, skippedCount: 0 });
    await store.close();
  });

  it('deduplicates overlapping selections and supports folder and all scopes', async () => {
    const { profileKey, folder, nested, first, snapshot, store } = await setup();
    snapshot.scope.bookmarkIds = [first.id, nested.id, folder.id, folder.id];
    expect(exportSnapshotBackupPayload(snapshot, profileKey).tree).toHaveLength(1);
    snapshot.scope = { type: 'folder', folderId: nested.id, targetFolderIds: [] };
    expect(exportSnapshotBackupPayload(snapshot, profileKey).tree[0].title).toBe('Nested');
    snapshot.scope = { type: 'all', targetFolderIds: [] };
    const backup = exportSnapshotBackupPayload(snapshot, profileKey);
    expect(backup.tree[0].originalId).toBe('0');
    expect(backup.metadata).toHaveLength(3);
    await store.close();
  });

  it('rejects absent, foreign, malformed and incomplete snapshots', async () => {
    const { snapshot, profileKey, store } = await setup();
    expect(() => exportSnapshotBackupPayload(undefined, profileKey)).toThrow('找不到');
    expect(() => exportSnapshotBackupPayload(snapshot, 'other-profile')).toThrow('找不到');
    expect(() => exportSnapshotBackupPayload({ ...snapshot, nodes: null } as never, profileKey)).toThrow('格式無效');
    expect(() => exportSnapshotBackupPayload({ ...snapshot, nodes: [...snapshot.nodes, snapshot.nodes[0]] }, profileKey)).toThrow('識別值重複');
    expect(() => exportSnapshotBackupPayload({ ...snapshot, scope: { type: 'selection', bookmarkIds: ['missing'], targetFolderIds: [] } }, profileKey)).toThrow('缺少');
    const cycle: Snapshot = {
      ...snapshot, scope: { type: 'selection', bookmarkIds: ['a', 'b'], targetFolderIds: [] },
      nodes: [{ id: 'a', parentId: 'b', title: 'a', isFolder: true }, { id: 'b', parentId: 'a', title: 'b', isFolder: true }],
    };
    expect(() => exportSnapshotBackupPayload(cycle, profileKey)).toThrow('循環');
    await store.close();
  });

  it('can retry a snapshot restore after a partial Chrome failure', async () => {
    const { adapter, store, profileKey, snapshot } = await setup();
    const backup = exportSnapshotBackupPayload(snapshot, profileKey);
    const before = await adapter.getTree();
    const create = adapter.create.bind(adapter);
    let calls = 0;
    const spy = vi.spyOn(adapter, 'create').mockImplementation(async (details) => {
      if (++calls === 4) throw new Error('interrupted');
      return create(details);
    });
    await expect(restoreBackupToFolder({ adapter, store, profileKey, payload: backup, targetParentId: '2' })).rejects.toThrow('還原失敗');
    expect(await adapter.getTree()).toEqual(before);
    spy.mockRestore();
    const result = await restoreBackupToFolder({ adapter, store, profileKey, payload: backup, targetParentId: '2' });
    expect(result.createdBookmarks).toBe(2);
    await store.close();
  });

  it('validates snapshot messages at the boundary', () => {
    expect(validateStudioMessage({ type: 'EXPORT_SNAPSHOT', payload: { snapshotId: 'snapshot' } })).toBeNull();
    for (const payload of [undefined, {}, { snapshotId: '' }, { snapshotId: 10 }]) {
      expect(validateStudioMessage({ type: 'EXPORT_SNAPSHOT', payload })).toBe('訊息內容格式無效。');
    }
  });
});
