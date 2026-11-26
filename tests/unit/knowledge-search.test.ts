import { describe, expect, it, vi } from 'vitest';
import { buildProjections } from '@/core/bookmark-engine';
import {
  allowedKnowledgeBookmarks,
  KNOWLEDGE_MODEL_VERSION,
  KnowledgeSearchError,
  searchKnowledge,
  type SearchKnowledgeParams,
} from '@/core/knowledge-search';
import { KnowledgeStore } from '@/core/knowledge-store';
import { BookmarkSearchIndex } from '@/core/search';
import type { BookmarkProjection, ChromeBookmarkNode } from '@/core/types';

function projections(children: ChromeBookmarkNode[], profileKey = 'knowledge'): BookmarkProjection[] {
  const tree: ChromeBookmarkNode[] = [{
    id: '0', title: '', children: [{
      id: '1', title: '私人總目錄', children: [{
        id: '10', title: 'Cloudflare', children,
      }, {
        id: '20', title: 'Personal',
        children: [{ id: '21', title: 'Outside secret', url: 'https://outside.example/secret' }],
      }],
    }],
  }];
  const assignParents = (node: ChromeBookmarkNode) => {
    for (const [index, child] of (node.children ?? []).entries()) {
      child.parentId = node.id;
      child.index = index;
      assignParents(child);
    }
  };
  tree.forEach(assignParents);
  return buildProjections(tree, profileKey).projections;
}

function params(children: ChromeBookmarkNode[]): SearchKnowledgeParams {
  return { profileKey: 'knowledge', projections: projections(children), metadata: [], query: '', folderId: '10' };
}

describe('scoped bookmark knowledge retrieval', () => {
  it('applies profile, descendant scope and sensitive URL rules before indexing or embedding', async () => {
    const input = params([
      { id: '11', title: 'R2', url: 'https://developers.cloudflare.com/r2/' },
      {
        id: '12', title: 'Advanced', children: [
          { id: '13', title: 'R2 presigned', url: 'https://developers.cloudflare.com/r2/presigned-urls/' },
        ],
      },
      { id: '14', title: 'Private server', url: 'http://127.0.0.1/docs' },
      { id: '15', title: 'Token', url: 'https://cloudflare.com/callback?token=secret' },
    ]);
    input.projections.push(...projections([
      { id: '31', title: 'Another profile', url: 'https://foreign.example/' },
    ], 'foreign'));
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const result = await searchKnowledge({
      ...input, query: 'Cloudflare resources', mode: 'semantic', embed,
      grant: { folderIds: ['10'], includeContent: true },
    });
    expect(result.results.map((hit) => hit.bookmarkId).sort()).toEqual(['11', '13']);
    expect(result.results.every((hit) => hit.folderPath.startsWith('Cloudflare'))).toBe(true);
    expect(result.results.some((hit) => hit.folderPath.includes('私人總目錄'))).toBe(false);
    const encoded = embed.mock.calls.flatMap(([texts]) => texts).join('\n');
    expect(encoded).not.toMatch(/Outside secret|Another profile|Private server|token=secret|私人總目錄/);
    expect(allowedKnowledgeBookmarks({
      ...input, folderId: '10', includeDescendants: false,
      grant: { folderIds: ['10'], includeContent: true },
    }).map((node) => node.nodeId)).toEqual(['11']);
    expect((await searchKnowledge({
      ...input, grant: { folderIds: [], includeContent: true },
    })).results).toEqual([]);
  });

  it('enforces inline domains, all requested tags and recursive folder filters in semantic mode', async () => {
    const input = params([
      { id: '11', title: 'R2', url: 'https://developers.cloudflare.com/r2/' },
      { id: '12', title: 'R2 copy', url: 'https://other.example/r2/' },
      { id: '13', title: 'KV', url: 'https://developers.cloudflare.com/kv/' },
    ]);
    const result = await searchKnowledge({
      ...input, query: 'object storage domain:developers.cloudflare.com tag:reference', tags: ['STORAGE'],
      metadata: [
        { profileKey: 'knowledge', nodeId: '11', tags: ['Reference', 'Storage'], updatedAt: 1 },
        { profileKey: 'knowledge', nodeId: '12', tags: ['Reference', 'Storage'], updatedAt: 1 },
        { profileKey: 'foreign', nodeId: '13', tags: ['Reference', 'Storage'], updatedAt: 1 },
      ],
      mode: 'semantic', embed: async (texts) => texts.map(() => [1, 0]),
    });
    expect(result.results.map((hit) => hit.bookmarkId)).toEqual(['11']);
  });

  it('finds a natural-language match beyond the first 80 records and uses E5 retrieval prefixes', async () => {
    const children: ChromeBookmarkNode[] = Array.from({ length: 101 }, (_, index) => ({
      id: String(100 + index), title: 'Recipe ' + index, url: 'https://recipes.example/' + index,
    }));
    children.push({ id: 'target', title: 'R2 Presigned URLs', url: 'https://developers.cloudflare.com/r2/presigned-urls/' });
    const embed = vi.fn(async (texts: string[]) => texts.map((text) =>
      text.startsWith('query:') || text.includes('Presigned') ? [1, 0] : [0, 1],
    ));
    const result = await searchKnowledge({
      ...params(children), query: '讓別人在有限時間內下載物件儲存的檔案',
      folderId: '10', mode: 'semantic', embed,
    });
    expect(result.mode).toBe('hybrid');
    expect(result.results[0].bookmarkId).toBe('target');
    const texts = embed.mock.calls.flatMap(([batch]) => batch);
    expect(texts).toHaveLength(103);
    expect(texts.filter((text) => text.startsWith('query:'))).toHaveLength(1);
    expect(texts.filter((text) => text.startsWith('passage:'))).toHaveLength(102);
  });

  it('reuses cached embeddings and refreshes only the passage changed by an edit', async () => {
    const input = params([
      { id: '11', title: 'R2', url: 'https://developers.cloudflare.com/r2/' },
      { id: '12', title: 'KV', url: 'https://developers.cloudflare.com/kv/' },
    ]);
    const cache = new Map<string, number[]>();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const options = {
      ...input, query: 'storage', mode: 'semantic' as const, embed,
      getCachedEmbedding: async (key: string) => cache.get(key),
      setCachedEmbedding: async (key: string, vector: number[]) => { cache.set(key, vector); },
    };
    await searchKnowledge(options);
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(3);
    embed.mockClear();
    await searchKnowledge(options);
    expect(embed).not.toHaveBeenCalled();
    const changed = input.projections.map((bookmark) =>
      bookmark.nodeId === '11' ? { ...bookmark, title: 'R2 Private Files' } : bookmark,
    );
    await searchKnowledge({ ...options, projections: changed });
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(1);
    expect(embed.mock.calls[0][0][0]).toContain('R2 Private Files');
  });

  it('keeps an exact title or URL ahead of conflicting semantic scores and falls back on encoder failure', async () => {
    const input = params([
      { id: '11', title: 'R2', url: 'https://developers.cloudflare.com/r2/' },
      { id: '12', title: 'KV', url: 'https://developers.cloudflare.com/kv/' },
    ]);
    const exact = await searchKnowledge({
      ...input, query: 'R2', mode: 'semantic',
      embed: async (texts) => texts.map((text) => text.includes('KV') || text.startsWith('query:') ? [1, 0] : [0, 1]),
    });
    expect(exact.results[0].bookmarkId).toBe('11');
    const fallback = await searchKnowledge({
      ...input, query: 'R2', mode: 'semantic', embed: async () => { throw new Error('Model unavailable'); },
    });
    expect(fallback.mode).toBe('keyword');
    expect(fallback.results.map((hit) => hit.bookmarkId)).toEqual(['11']);
    expect(fallback.warnings).toContain('Model unavailable');
  });

  it('returns real collected snippets with stable IDs, while metadata-only grants hide content', async () => {
    const input = params([{ id: '11', title: 'R2 docs', url: 'https://developers.cloudflare.com/r2/' }]);
    const store = new KnowledgeStore('knowledge-search-' + crypto.randomUUID());
    try {
      const source = await store.captureSource({
        profileKey: input.profileKey,
        page: {
          url: 'https://developers.cloudflare.com/r2/', title: 'R2 docs', truncated: false,
          sections: [
            { heading: 'Overview', text: 'R2 stores objects in buckets.' },
            { heading: 'Access', text: 'Presigned links grant temporary access to private files.' },
          ],
        },
      });
      const result = await searchKnowledge({ ...input, sources: [source], query: 'temporary access' });
      expect(result.results[0]).toMatchObject({
        sourceId: source.sourceId, sourceVersion: source.sourceVersion,
        capturedAt: source.capturedAt, contentStatus: 'collected',
        snippet: 'Presigned links grant temporary access to private files.',
      });
      expect(source.chunks.some((chunk) => chunk.chunkId === result.results[0].chunkId)).toBe(true);
      const restricted = await searchKnowledge({
        ...input, sources: [source], query: 'R2',
        grant: { folderIds: ['10'], includeContent: false },
      });
      expect(restricted.results[0].contentStatus).toBe('not_collected');
      expect(restricted.results[0].snippet).toBeUndefined();
      expect(restricted.results[0].sourceId).toBe(source.sourceId);
      expect((await searchKnowledge({
        ...input, sources: [{ ...source, profileKey: 'foreign' }], query: 'temporary access',
      })).results).toEqual([]);
      await searchKnowledge({
        ...input, sources: [source], query: 'private downloads', mode: 'semantic',
        embed: async (texts) => texts.map(() => [1, 0]),
        getCachedEmbedding: (key) => store.getEmbedding(input.profileKey, key, KNOWLEDGE_MODEL_VERSION, key),
        setCachedEmbedding: (key, vector, sourceId) => store.putEmbedding({
          profileKey: input.profileKey, documentId: key, modelVersion: KNOWLEDGE_MODEL_VERSION,
          contentHash: key, vector, sourceId, updatedAt: Date.now(),
        }),
      });
      expect((await store.listEmbeddings(input.profileKey, KNOWLEDGE_MODEL_VERSION))
        .filter((entry) => entry.sourceId === source.sourceId)).toHaveLength(2);
      await store.deleteSource(input.profileKey, source.sourceId);
      expect((await store.listEmbeddings(input.profileKey, KNOWLEDGE_MODEL_VERSION))
        .some((entry) => entry.sourceId === source.sourceId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('binds pagination to current content, query and authorization', async () => {
    const input = params(Array.from({ length: 5 }, (_, index) => ({
      id: String(11 + index), title: 'R2 docs ' + index, url: 'https://developers.cloudflare.com/r2/' + index,
    })));
    const first = await searchKnowledge({ ...input, limit: 2 });
    const second = await searchKnowledge({ ...input, limit: 2, cursor: first.nextCursor });
    expect(first.results).toHaveLength(2);
    expect(second.results).toHaveLength(2);
    expect(second.results.some((hit) => first.results.some((previous) => previous.bookmarkId === hit.bookmarkId))).toBe(false);
    await expect(searchKnowledge({
      ...input, limit: 2, cursor: first.nextCursor, grant: { folderIds: ['20'], includeContent: false },
    })).rejects.toMatchObject({ code: 'STALE_CURSOR' });
    await expect(searchKnowledge({ ...input, cursor: 'invalid' })).rejects.toBeInstanceOf(KnowledgeSearchError);
    await expect(searchKnowledge({ ...input, cursor: first.nextCursor, query: 'R2' })).rejects.toMatchObject({ code: 'STALE_CURSOR' });
    await expect(searchKnowledge({ ...input, limit: 21 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('propagates cancellation without displaying a completed keyword fallback', async () => {
    const controller = new AbortController();
    await expect(searchKnowledge({
      ...params([{ id: '11', title: 'R2', url: 'https://developers.cloudflare.com/r2/' }]),
      query: 'R2', mode: 'semantic', signal: controller.signal,
      embed: async () => { controller.abort(); throw controller.signal.reason; },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('incremental keyword index', () => {
  it('updates changed fields, removes deleted records and keeps direct-folder behavior available', () => {
    const input = params([
      { id: '11', title: 'R2', url: 'https://developers.cloudflare.com/r2/' },
      { id: '12', title: 'Nested', children: [{ id: '13', title: 'KV', url: 'https://developers.cloudflare.com/kv/' }] },
    ]);
    const index = new BookmarkSearchIndex();
    index.rebuild(input.projections, []);
    expect(index.search({ folderId: '10' }).map((node) => node.nodeId)).toEqual(['11']);
    expect(index.search({ folderId: '10', includeDescendants: true }).map((node) => node.nodeId)).toEqual(['11', '13']);
    index.sync(input.projections.filter((node) => node.nodeId !== '11'), [{
      profileKey: 'knowledge', nodeId: '13', tags: ['Durable'], updatedAt: 1,
    }], new Map([['13', 'Key value store']]));
    expect(index.search({ query: 'R2' })).toEqual([]);
    expect(index.search({ query: 'tag:durable' }).map((node) => node.nodeId)).toEqual(['13']);
    expect(index.searchRanked({ query: 'value' })[0].matchedFields).toContain('content');
  });
});
