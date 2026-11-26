import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeChunk, KnowledgeExcerpt, KnowledgeSource } from '@/core/knowledge-types';
import type { SearchKnowledgeResult } from '@/core/knowledge-search';
import { MockChromeBookmarks } from './mock-bookmarks';

const offscreen = vi.hoisted(() => ({ embed: vi.fn(), answer: vi.fn() }));
vi.mock('@/core/offscreen-client', () => ({
  embedKnowledgeTexts: offscreen.embed,
  answerFromExcerpts: offscreen.answer,
}));

type Stores = {
  bookmarks: MockChromeBookmarks;
  store: typeof import('@/core/store')['defaultStore'];
  knowledge: typeof import('@/core/knowledge-store')['defaultKnowledgeStore'];
};
let current: Stores | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  offscreen.embed.mockReset().mockImplementation(async (texts: string[]) => ({
    backend: 'wasm', vectors: texts.map(() => [1, 0]),
  }));
  offscreen.answer.mockReset();
});

afterEach(async () => {
  await current?.store.close();
  await current?.knowledge.close();
  current = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(includeContent = true) {
  const bookmarks = new MockChromeBookmarks();
  const tabs = { query: vi.fn(), get: vi.fn() };
  const scripting = { executeScript: vi.fn() };
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    bookmarks,
    runtime: { id: 'service-test', getURL: (path: string) => 'chrome-extension://service-test/' + path, sendMessage },
    tabs, scripting,
  });
  const { defaultStore: store } = await import('@/core/store');
  const { defaultKnowledgeStore: knowledge, sourceIdForUrl } = await import('@/core/knowledge-store');
  const { mcpAccess: access } = await import('@/core/mcp-access');
  const { executeMcpKnowledgeTool, handleKnowledgeMessage } = await import('@/core/knowledge-service');
  const profileKey = await store.getOrCreateProfileKey();
  current = { bookmarks, store, knowledge };
  const folder = await bookmarks.create({ parentId: '1', title: 'Cloudflare' });
  const child = await bookmarks.create({ parentId: folder.id, title: 'Advanced' });
  const outside = await bookmarks.create({ parentId: '2', title: 'Private folder' });
  const first = await bookmarks.create({ parentId: folder.id, title: 'R2 overview', url: 'https://developers.cloudflare.com/r2/' });
  const nested = await bookmarks.create({ parentId: child.id, title: 'KV overview', url: 'https://developers.cloudflare.com/kv/' });
  const hidden = await bookmarks.create({ parentId: outside.id, title: 'Outside secret', url: 'https://outside.example/secret' });
  await bookmarks.create({ parentId: folder.id, title: 'Local secret', url: 'http://127.0.0.1/private' });
  await bookmarks.create({ parentId: folder.id, title: 'Token secret', url: 'https://example.com/callback?token=sensitive-value' });
  const grant = await access.createConnection(profileKey, {
    label: 'Service test', folderIds: [folder.id], includeContent,
  });
  const call = <T>(toolName: string, args: unknown = {}): Promise<T> => executeMcpKnowledgeTool({
    profileKey, token: grant.token, toolName, args, signal: new AbortController().signal,
  }) as Promise<T>;
  const capture = (text = 'R2 private file downloads use expiring presigned links.'): Promise<KnowledgeSource> =>
    knowledge.captureSource({
      profileKey, page: { url: first.url!, title: 'R2 overview', truncated: false, sections: [{ heading: 'Access', text }] },
    });
  return { bookmarks, store, knowledge, access, profileKey, grant, call, capture,
    folder, child, outside, first, nested, hidden, sourceIdForUrl, executeMcpKnowledgeTool, handleKnowledgeMessage,
    tabs, scripting, sendMessage };
}

interface SourcePage {
  contentStatus: string;
  source: { sourceId: string; sourceVersion?: string; url: string };
  chunks: KnowledgeChunk[];
  nextCursor?: string;
}

function pauseEmbedding() {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  offscreen.embed.mockImplementation(async (texts: string[]) => {
    entered.resolve();
    await resume.promise;
    return { backend: 'wasm', vectors: texts.map(() => [1, 0]) };
  });
  return { entered: entered.promise, resume: () => resume.resolve() };
}

describe('desktop knowledge tools through the Chrome data layer', () => {
  it('lists only granted folders and searches descendants while excluding sensitive URLs', async () => {
    const env = await setup();
    const initialTree = await env.bookmarks.getTree();
    const roots = await env.call<{ folders: { folderId: string }[] }>('list_folders');
    expect(roots.folders.map((folder) => folder.folderId)).toEqual([env.folder.id]);
    const children = await env.call<{ folders: { folderId: string }[] }>('list_folders', { parentId: env.folder.id });
    expect(children.folders.map((folder) => folder.folderId)).toEqual([env.child.id]);
    await expect(env.call('list_folders', { parentId: env.outside.id })).rejects.toThrow('UNAUTHORIZED');
    const results = await env.call<SearchKnowledgeResult>('search_bookmarks', { query: '', mode: 'keyword' });
    expect(results.results.map((hit) => hit.bookmarkId).sort()).toEqual([env.first.id, env.nested.id].sort());
    expect(JSON.stringify(results)).not.toMatch(/Private folder|Outside secret|Local secret|sensitive-value/);
    const direct = await env.call<SearchKnowledgeResult>('search_bookmarks', {
      query: '', folderId: env.folder.id, includeDescendants: false, mode: 'keyword',
    });
    expect(direct.results.map((hit) => hit.bookmarkId)).toEqual([env.first.id]);
    expect(await env.bookmarks.getTree()).toEqual(initialTree);
  });

  it('returns metadata before capture and enforces content permission for the same source ID', async () => {
    const env = await setup(false);
    const sourceId = await env.sourceIdForUrl(env.profileKey, env.first.url!);
    expect(await env.call<SourcePage>('read_source', { sourceId })).toMatchObject({
      contentStatus: 'not_collected', source: { sourceId, url: env.first.url }, chunks: [],
    });
    await env.capture();
    expect(await env.call<SourcePage>('read_source', { sourceId })).toMatchObject({
      contentStatus: 'not_authorized', source: { sourceId }, chunks: [],
    });
    const results = await env.call<SearchKnowledgeResult>('search_bookmarks', { query: 'R2', mode: 'semantic' });
    expect(results.results[0].snippet).toBeUndefined();
    expect(JSON.stringify(offscreen.embed.mock.calls)).not.toContain('expiring presigned');
    const outsideId = await env.sourceIdForUrl(env.profileKey, env.hidden.url!);
    await expect(env.call('read_source', { sourceId: outsideId })).rejects.toThrow('UNAUTHORIZED');
    await expect(env.executeMcpKnowledgeTool({
      profileKey: 'another-profile', token: env.grant.token, toolName: 'list_folders', args: {},
      signal: new AbortController().signal,
    })).rejects.toThrow('UNAUTHORIZED');
  });

  it('bounds source pages and rejects invalid, stale and cross-source references', async () => {
    const env = await setup();
    const source = await env.capture('R2 objects and private downloads. '.repeat(500));
    const first = await env.call<SourcePage>('read_source', { sourceId: source.sourceId });
    expect(first.contentStatus).toBe('collected');
    expect(first.chunks.reduce((total, chunk) => total + chunk.text.length, 0)).toBeLessThanOrEqual(8000);
    expect(first.nextCursor).toBeTruthy();
    const second = await env.call<SourcePage>('read_source', { sourceId: source.sourceId, cursor: first.nextCursor });
    expect(second.chunks[0].index).toBeGreaterThan(first.chunks.at(-1)!.index);
    await expect(env.call('read_source', { sourceId: source.sourceId, cursor: 'invalid-cursor' })).rejects.toThrow('INVALID_CURSOR');
    await expect(env.call('read_source', { sourceId: source.sourceId, chunkIds: ['missing'] })).rejects.toThrow('SOURCE_VERSION_CHANGED');
    const changed = await env.capture('Updated storage access guidance.');
    expect(changed.sourceVersion).not.toBe(source.sourceVersion);
    await expect(env.call('read_source', {
      sourceId: source.sourceId, sourceVersion: source.sourceVersion,
    })).rejects.toThrow('SOURCE_VERSION_CHANGED');
    await expect(env.call('read_source', {
      sourceId: source.sourceId, cursor: first.nextCursor,
    })).rejects.toThrow('INVALID_CURSOR');
  });

  it('rejects a revoked grant before returning a search that was already embedding', async () => {
    const env = await setup();
    const pause = pauseEmbedding();
    const pending = env.call<SearchKnowledgeResult>('search_bookmarks', { query: 'storage', mode: 'semantic' });
    await pause.entered;
    await env.access.updateConnection(env.profileKey, {
      connectionId: env.grant.connection.connectionId, folderIds: [env.folder.id], includeContent: true, enabled: false,
    });
    pause.resume();
    await expect(pending).rejects.toThrow('UNAUTHORIZED');
  });

  it('rejects a grant revoked while the final Chrome tree is being checked', async () => {
    const env = await setup();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const getTree = env.bookmarks.getTree.bind(env.bookmarks);
    let reads = 0;
    vi.spyOn(env.bookmarks, 'getTree').mockImplementation(async () => {
      const tree = await getTree();
      if (++reads === 2) {
        entered.resolve();
        await resume.promise;
      }
      return tree;
    });
    const pending = env.call<SearchKnowledgeResult>('search_bookmarks', { query: 'R2', mode: 'keyword' });
    await entered.promise;
    await env.access.updateConnection(env.profileKey, {
      connectionId: env.grant.connection.connectionId, folderIds: [env.folder.id], includeContent: true, enabled: false,
    });
    resume.resolve();
    await expect(pending).rejects.toThrow('UNAUTHORIZED');
  });

  it('does not return or recache a source cleared while its embeddings were being calculated', async () => {
    const env = await setup();
    const source = await env.capture('Expiring downloads in a source that will be cleared.');
    const pause = pauseEmbedding();
    const pending = env.call<SearchKnowledgeResult>('search_bookmarks', { query: 'storage', mode: 'semantic' });
    await pause.entered;
    await env.handleKnowledgeMessage({ type: 'DELETE_KNOWLEDGE_SOURCE', payload: { sourceId: source.sourceId } });
    pause.resume();
    const result = await pending;
    expect(result.results.some((hit) => hit.sourceVersion === source.sourceVersion)).toBe(false);
    const { KNOWLEDGE_MODEL_VERSION } = await import('@/core/knowledge-search');
    const cached = await env.knowledge.listEmbeddings(env.profileKey, KNOWLEDGE_MODEL_VERSION);
    expect(cached.some((entry) => entry.sourceId === source.sourceId)).toBe(false);
  });

  it('rejects content changed after a source read was assembled', async () => {
    const env = await setup();
    const source = await env.capture('Original source content.');
    const authorize = env.access.authorize.bind(env.access);
    let reads = 0;
    vi.spyOn(env.access, 'authorize').mockImplementation(async (profileKey, token) => {
      const grant = await authorize(profileKey, token);
      if (++reads === 2) await env.capture('New source content.');
      return grant;
    });
    await expect(env.call('read_source', { sourceId: source.sourceId })).rejects.toThrow('SOURCE_VERSION_CHANGED');
  });

  it('drops bookmarks moved outside the granted folder before returning', async () => {
    const env = await setup();
    const pause = pauseEmbedding();
    const pending = env.call<SearchKnowledgeResult>('search_bookmarks', { query: 'storage', mode: 'semantic' });
    await pause.entered;
    await env.bookmarks.move(env.first.id, { parentId: env.outside.id });
    pause.resume();
    const result = await pending;
    expect(result.results.map((hit) => hit.bookmarkId)).not.toContain(env.first.id);
    expect(result.results.map((hit) => hit.bookmarkId)).toContain(env.nested.id);
  });

  it('drops the previous URL and its collected content if the last linked bookmark changes URL', async () => {
    const env = await setup();
    await env.capture('Sensitive old source that was explicitly removed from the scope.');
    const pause = pauseEmbedding();
    const pending = env.call<SearchKnowledgeResult>('search_bookmarks', { query: 'storage', mode: 'semantic' });
    await pause.entered;
    await env.bookmarks.update(env.first.id, { url: 'https://developers.cloudflare.com/workers/' });
    pause.resume();
    const result = await pending;
    expect(result.results.some((hit) => hit.url === env.first.url)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Sensitive old source');
  });

  it('rejects invalid query types instead of silently enumerating all granted bookmarks', async () => {
    const env = await setup();
    await expect(env.call('search_bookmarks', { query: 42, mode: 'keyword' })).rejects.toThrow('INVALID_INPUT');
  });

  it('rejects a page navigation during explicit capture before saving any content', async () => {
    const env = await setup();
    env.tabs.query.mockResolvedValue([{ id: 7, url: env.first.url }]);
    env.tabs.get.mockResolvedValue({ id: 7, url: 'https://other.example/new-page' });
    env.scripting.executeScript.mockResolvedValue([{ result: {
      url: env.first.url, title: 'R2', truncated: false, sections: [{ heading: 'Access', text: 'Captured visible text.' }],
    } }]);
    await expect(env.handleKnowledgeMessage({ type: 'CAPTURE_CURRENT_PAGE' })).rejects.toThrow('頁面已切換');
    expect(await env.knowledge.listSources(env.profileKey)).toEqual([]);
    env.tabs.get.mockResolvedValue({ id: 7, url: env.first.url });
    await expect(env.handleKnowledgeMessage({ type: 'CAPTURE_CURRENT_PAGE' })).resolves.toMatchObject({ created: true });
    expect(await env.knowledge.listSources(env.profileKey)).toHaveLength(1);
  });

  it('clears a captured source and its embeddings through the Studio message handler', async () => {
    const env = await setup();
    const source = await env.capture();
    await env.knowledge.putEmbedding({
      profileKey: env.profileKey, sourceId: source.sourceId, documentId: 'passage',
      modelVersion: 'test-model', contentHash: source.contentHash, vector: [1, 0], updatedAt: Date.now(),
    });
    expect(await env.handleKnowledgeMessage({
      type: 'DELETE_KNOWLEDGE_SOURCE', payload: { sourceId: source.sourceId },
    })).toEqual({ deleted: true });
    expect(await env.knowledge.getSource(env.profileKey, source.sourceId)).toBeUndefined();
    expect(await env.knowledge.listEmbeddings(env.profileKey, 'test-model')).toEqual([]);
    expect(env.sendMessage).toHaveBeenCalledWith({ type: 'KNOWLEDGE_CHANGED' });
  });

  it('rejects a Studio answer if its source is cleared while model inference is pending', async () => {
    const env = await setup();
    const source = await env.capture('Original private download instructions.');
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    offscreen.answer.mockImplementation(async (_question: string, excerpts: KnowledgeExcerpt[]) => {
      entered.resolve();
      await resume.promise;
      return {
        mode: 'answer', answer: 'Use the original private download instructions.', warnings: [],
        citations: excerpts.map((excerpt, index) => ({ ...excerpt, citationId: 'S' + index })),
      };
    });
    const pending = env.handleKnowledgeMessage({ type: 'ASK_KNOWLEDGE', payload: { question: 'R2' } });
    await entered.promise;
    await env.handleKnowledgeMessage({ type: 'DELETE_KNOWLEDGE_SOURCE', payload: { sourceId: source.sourceId } });
    resume.resolve();
    await expect(pending).rejects.toThrow('SOURCE_VERSION_CHANGED');
  });
});
