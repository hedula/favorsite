import { describe, expect, it } from 'vitest';
import { buildProjections } from '@/core/bookmark-engine';
import { findDuplicateGroups } from '@/core/duplicates';
import { BookmarkSearchIndex } from '@/core/search';
import type { BookmarkMetadata, ChromeBookmarkNode } from '@/core/types';

function makeSyntheticTree(count: number): {
  tree: ChromeBookmarkNode[];
  metadata: BookmarkMetadata[];
} {
  const children: ChromeBookmarkNode[] = [];
  const metadata: BookmarkMetadata[] = [];
  const domains = [
    'developers.cloudflare.com',
    'github.com',
    'developer.mozilla.org',
    'wxt.dev',
    'lmstudio.ai',
  ];
  const topics = ['Workers KV 教學', 'R2 物件儲存', 'Queues 佇列', 'TypeScript 指南', 'Chrome 擴充開發'];

  for (let i = 0; i < count; i++) {
    const id = String(1000 + i);
    const domain = domains[i % domains.length];
    const topic = topics[i % topics.length];
    const url =
      i % 25 === 0
        ? `https://${domain}/shared-doc`
        : i % 37 === 0
          ? `https://${domain}/article/${Math.floor(i / 37)}?utm_source=newsletter`
          : `https://${domain}/docs/item-${i}`;

    children.push({
      id,
      parentId: '1',
      index: i,
      title: `${topic} #${i}`,
      url,
      dateAdded: 1700000000000 + i * 1000,
    });

    if (i % 5 === 0) {
      metadata.push({
        profileKey: 'perf',
        nodeId: id,
        tags: [i % 10 === 0 ? 'KV' : 'R2'],
        updatedAt: Date.now(),
      });
    }
  }

  return {
    tree: [
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            parentId: '0',
            index: 0,
            title: '書籤列',
            folderType: 'bookmarks-bar',
            children,
          },
        ],
      },
    ],
    metadata,
  };
}

describe('search & duplicates', () => {
  it('supports mixed Traditional Chinese + English, exact domain:, and tag: search', () => {
    const tree: ChromeBookmarkNode[] = [
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            parentId: '0',
            index: 0,
            title: '書籤列',
            folderType: 'bookmarks-bar',
            children: [
              {
                id: '10',
                parentId: '1',
                index: 0,
                title: 'Cloudflare Workers KV 快取教學',
                url: 'https://developers.cloudflare.com/kv/get-started/',
              },
              {
                id: '11',
                parentId: '1',
                index: 1,
                title: 'R2 物件儲存設定指南',
                url: 'https://developers.cloudflare.com/r2/',
              },
              {
                id: '12',
                parentId: '1',
                index: 2,
                title: 'GitHub Actions 部署範例',
                url: 'https://github.com/example/deploy',
              },
            ],
          },
        ],
      },
    ];

    const flat = buildProjections(tree, 'prof');
    const idx = new BookmarkSearchIndex();
    idx.rebuild(flat.projections, [
      { profileKey: 'prof', nodeId: '10', tags: ['KV', '快取'], updatedAt: 1 },
    ]);

    expect(idx.search({ query: '快取教學' }).map((b) => b.nodeId)).toEqual(['10']);
    expect(idx.search({ query: '物件儲存' }).map((b) => b.nodeId)).toEqual(['11']);
    expect(
      idx.search({ query: 'domain:github.com' }).map((b) => b.nodeId),
    ).toEqual(['12']);
    expect(idx.search({ query: 'tag:KV' }).map((b) => b.nodeId)).toEqual(['10']);
  });

  it('separates exact URL duplicates from suspected tracking-param and title duplicates while preserving meaningful query/fragment differences', () => {
    const tree: ChromeBookmarkNode[] = [
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            parentId: '0',
            index: 0,
            title: '書籤列',
            folderType: 'bookmarks-bar',
            children: [
              { id: '10', parentId: '1', index: 0, title: 'KV Docs', url: 'https://developers.cloudflare.com/kv/' },
              { id: '11', parentId: '1', index: 1, title: 'KV Docs Copy', url: 'https://developers.cloudflare.com/kv/' },
              { id: '12', parentId: '1', index: 2, title: 'KV Tracked', url: 'https://developers.cloudflare.com/kv/?utm_source=x&fbclid=123' },
              // Meaningful query differences MUST NOT be marked exact duplicate
              { id: '13', parentId: '1', index: 3, title: 'Search A', url: 'https://example.com/search?q=kv' },
              { id: '14', parentId: '1', index: 4, title: 'Search B', url: 'https://example.com/search?q=r2' },
              // Meaningful fragment differences MUST NOT be marked exact duplicate
              { id: '15', parentId: '1', index: 5, title: 'Section 1', url: 'https://example.com/guide#part1' },
              { id: '16', parentId: '1', index: 6, title: 'Section 2', url: 'https://example.com/guide#part2' },
            ],
          },
        ],
      },
    ];

    const flat = buildProjections(tree, 'prof');
    const groups = findDuplicateGroups(flat.projections);

    const exact = groups.filter((g) => g.kind === 'exact');
    expect(exact).toHaveLength(1);
    expect(exact[0].nodeIds).toEqual(['10', '11']);

    const tracking = groups.filter(
      (g) => g.kind === 'suspected' && g.groupId.startsWith('dup_track_'),
    );
    expect(tracking).toHaveLength(1);
    expect(tracking[0].nodeIds).toEqual(['10', '11', '12']);

    // Meaningful query/fragment nodes should not be grouped together
    const groupedIds = new Set(groups.flatMap((g) => g.nodeIds));
    expect(groupedIds.has('13')).toBe(false);
    expect(groupedIds.has('14')).toBe(false);
    expect(groupedIds.has('15')).toBe(false);
    expect(groupedIds.has('16')).toBe(false);
  });

  it('indexes and searches 1,000 and 5,000 synthetic bookmarks within practical latency', () => {
    for (const count of [1000, 5000]) {
      const { tree, metadata } = makeSyntheticTree(count);
      const flat = buildProjections(tree, 'perf');
      const index = new BookmarkSearchIndex();

      const t0 = performance.now();
      index.rebuild(flat.projections, metadata);
      const indexMs = performance.now() - t0;

      const latencies: number[] = [];
      const queries = ['Workers KV', '物件儲存', 'domain:wxt.dev', 'tag:KV', 'TypeScript'];
      for (let i = 0; i < 20; i++) {
        const q = queries[i % queries.length];
        const s0 = performance.now();
        const res = index.search({ query: q });
        latencies.push(performance.now() - s0);
        expect(res.length).toBeGreaterThan(0);
      }

      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      // Generous upper guard for CI/local variance while still catching O(n^2) regressions
      expect(indexMs).toBeLessThan(5000);
      expect(p95).toBeLessThan(250);
    }
  });
});
