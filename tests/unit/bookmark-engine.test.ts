import { describe, expect, it } from 'vitest';
import {
  buildProjections,
  computeScopeFingerprint,
  getEmptyWritableFolders,
  resolveMoveIndex,
  wouldCreateCycle,
} from '@/core/bookmark-engine';
import { MockChromeBookmarks } from './mock-bookmarks';

describe('bookmark-engine', () => {
  it('enforces system folder & managed ancestor writability and disambiguates local vs account folders', async () => {
    const mock = new MockChromeBookmarks({
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          parentId: '0',
          index: 0,
          title: '書籤列',
          folderType: 'bookmarks-bar',
          syncing: false,
          children: [
            {
              id: '10',
              parentId: '1',
              index: 0,
              title: 'Inbox',
              children: [],
            },
          ],
        },
        {
          id: '2',
          parentId: '0',
          index: 1,
          title: '書籤列',
          folderType: 'bookmarks-bar',
          syncing: true,
          children: [],
        },
        {
          id: '3',
          parentId: '0',
          index: 2,
          title: '企業書籤',
          folderType: 'managed',
          unmodifiable: 'managed',
          children: [
            {
              id: '30',
              parentId: '3',
              index: 0,
              title: '公司首頁',
              url: 'https://corp.example.com/',
            },
          ],
        },
      ],
    });

    const tree = await mock.getTree();
    const flattened = buildProjections(tree, 'prof_test');

    // System folders cannot be deleted/renamed, but non-managed ones can accept children
    expect(flattened.byId.get('1')?.writable).toBe(false);
    expect(flattened.byId.get('1')?.canAddChild).toBe(true);
    expect(flattened.byId.get('1')?.path).toContain('本機');
    expect(flattened.byId.get('2')?.path).toContain('帳戶');

    // Managed folder & descendants are strictly read-only
    expect(flattened.byId.get('3')?.writable).toBe(false);
    expect(flattened.byId.get('3')?.canAddChild).toBe(false);
    expect(flattened.byId.get('30')?.writable).toBe(false);

    // User folder under Bookmarks Bar is writable and detected as empty
    expect(flattened.byId.get('10')?.writable).toBe(true);
    expect(flattened.byId.get('10')?.canAddChild).toBe(true);
    const empties = getEmptyWritableFolders(flattened.projections);
    expect(empties.map((f) => f.nodeId)).toEqual(['10']);
  });

  it('resolves same-folder forward, backward, and cross-folder move indices accurately', async () => {
    const mock = new MockChromeBookmarks();
    const a = await mock.create({ parentId: '1', title: 'A', url: 'https://a.example.com' });
    const b = await mock.create({ parentId: '1', title: 'B', url: 'https://b.example.com' });
    const c = await mock.create({ parentId: '1', title: 'C', url: 'https://c.example.com' });
    const d = await mock.create({ parentId: '1', title: 'D', url: 'https://d.example.com' });

    // Move A (idx 0) to final index 2 (after C -> [B, C, A, D])
    let children = await mock.getChildren('1');
    const fwdIdx = resolveMoveIndex({
      liveTargetChildIds: children.map((x) => x.id),
      movingNodeId: a.id,
      sameParent: true,
      desiredFinalIndex: 2,
    });
    expect(fwdIdx).toBe(3); // Chrome expects pre-removal slot 3 to land at final index 2
    await mock.move(a.id, { parentId: '1', index: fwdIdx });
    children = await mock.getChildren('1');
    expect(children.map((x) => x.title)).toEqual(['B', 'C', 'A', 'D']);

    // Move D (idx 3) before B (idx 0 -> [D, B, C, A])
    const bwdIdx = resolveMoveIndex({
      liveTargetChildIds: children.map((x) => x.id),
      movingNodeId: d.id,
      sameParent: true,
      beforeSiblingId: b.id,
    });
    expect(bwdIdx).toBe(0);
    await mock.move(d.id, { parentId: '1', index: bwdIdx });
    children = await mock.getChildren('1');
    expect(children.map((x) => x.title)).toEqual(['D', 'B', 'C', 'A']);

    // Cross-folder move of C into '2' at index 0
    const otherChildren = await mock.getChildren('2');
    const crossIdx = resolveMoveIndex({
      liveTargetChildIds: otherChildren.map((x) => x.id),
      movingNodeId: c.id,
      sameParent: false,
      desiredFinalIndex: 0,
    });
    await mock.move(c.id, { parentId: '2', index: crossIdx });
    expect((await mock.getChildren('2')).map((x) => x.title)).toEqual(['C']);
  });

  it('detects folder cycles and scope fingerprint drift on reorder or rename', async () => {
    const mock = new MockChromeBookmarks();
    const f1 = await mock.create({ parentId: '1', title: 'Parent' });
    const f2 = await mock.create({ parentId: f1.id, title: 'Child' });
    const b1 = await mock.create({ parentId: f1.id, title: 'One', url: 'https://one.dev' });
    const b2 = await mock.create({ parentId: f1.id, title: 'Two', url: 'https://two.dev' });

    const flat1 = buildProjections(await mock.getTree(), 'prof_1');
    expect(wouldCreateCycle(f1.id, f2.id, flat1.byId)).toBe(true);
    expect(wouldCreateCycle(f1.id, f1.id, flat1.byId)).toBe(true);
    expect(wouldCreateCycle(f2.id, '2', flat1.byId)).toBe(false);

    const scope = { type: 'folder' as const, folderId: f1.id, targetFolderIds: [f1.id] };
    const fp1 = computeScopeFingerprint(flat1, scope);

    // Reorder b2 before b1 -> fingerprint MUST change
    await mock.move(b2.id, { parentId: f1.id, index: 1 });
    const flat2 = buildProjections(await mock.getTree(), 'prof_1');
    const fp2 = computeScopeFingerprint(flat2, scope);
    expect(fp2).not.toBe(fp1);

    // Rename b1 -> fingerprint MUST change again
    await mock.update(b1.id, { title: 'One Renamed' });
    const flat3 = buildProjections(await mock.getTree(), 'prof_1');
    const fp3 = computeScopeFingerprint(flat3, scope);
    expect(fp3).not.toBe(fp2);
  });
});
