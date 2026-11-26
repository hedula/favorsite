import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPageContent } from '@/core/content-extractor';
import { KnowledgeStore, sourceIdForUrl, summarizeKnowledgeSource } from '@/core/knowledge-store';
import type { CapturedPage } from '@/core/knowledge-types';

const stores: KnowledgeStore[] = [];

function store(): KnowledgeStore {
  const created = new KnowledgeStore(`knowledge-test-${crypto.randomUUID()}`);
  stores.push(created);
  return created;
}

function page(text = 'R2 supports S3-compatible object storage.'): CapturedPage {
  return { url: 'https://developers.cloudflare.com/r2/', title: 'R2 Object Storage', sections: [{ heading: 'Overview', text }], truncated: false };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((database) => database.close()));
  vi.unstubAllGlobals();
});

describe('explicit visible page capture', () => {
  function capture(html: string): CapturedPage {
    const parsed = parseHTML(html);
    vi.stubGlobal('document', parsed.document);
    vi.stubGlobal('window', {
      location: new URL('https://developers.cloudflare.com/r2/'),
      getComputedStyle: (element: HTMLElement) => ({ display: element.style.display, visibility: element.style.visibility, opacity: element.style.opacity }),
    });
    // The same serialized function Chrome injects must have no module dependencies.
    const serialized = new Function(`return (${extractPageContent.toString()})`)() as typeof extractPageContent;
    return serialized();
  }

  it('captures article headings and text while excluding controls, hidden content and scripts', () => {
    const result = capture('<html><head><title>R2 Guide</title></head><body><nav>Site menu</nav><article><h1>Overview</h1><p>Public object storage.</p><h2>Access</h2><p>Use a presigned URL.</p><script>steal()</script><form><input value="private value"><p>Form secret</p></form><div hidden>Hidden secret</div><p style="display:none">CSS secret</p><div aria-hidden="true">ARIA secret</div><div contenteditable>Draft secret</div><footer>Footer links</footer></article></body></html>');
    expect(result.title).toBe('R2 Guide');
    expect(result.sections).toEqual([{ heading: 'Overview', text: 'Public object storage.' }, { heading: 'Access', text: 'Use a presigned URL.' }]);
    expect(result.truncated).toBe(false);
    expect(result.url).toBe('https://developers.cloudflare.com/r2/');
  });

  it('does not choose an article inside a hidden ancestor as the primary content', () => {
    const result = capture('<html><head><title>Visible document</title></head><body><div style="display:none"><article><p>' + 'private '.repeat(1000) + '</p></article></div><main><h1>Visible</h1><p>Useful public text.</p></main></body></html>');
    expect(result.sections).toEqual([{ heading: 'Visible', text: 'Useful public text.' }]);
  });

  it('bounds capture size and reports that content was truncated', () => {
    const result = capture('<html><head><title>Long document</title></head><body><article><p>' + '字'.repeat(250_000) + '</p></article></body></html>');
    expect(result.sections.reduce((sum, section) => sum + section.text.length, 0)).toBeLessThanOrEqual(200_000);
    expect(result.truncated).toBe(true);
  });
});

describe('versioned local knowledge sources', () => {
  it('keeps exact URLs and Chrome profiles distinct and uses the same ID before capture', async () => {
    const database = store();
    const source = await database.captureSource({ profileKey: 'profile-a', page: page() });
    expect(source.sourceId).toBe(await sourceIdForUrl('profile-a', source.url));
    expect(await sourceIdForUrl('profile-a', source.url + '?view=private#access')).not.toBe(source.sourceId);
    expect(await sourceIdForUrl('profile-b', source.url)).not.toBe(source.sourceId);
    expect(await database.getSource('profile-b', source.sourceId)).toBeUndefined();
  });

  it('replaces a source atomically with a new content version and invalidates its embeddings', async () => {
    const database = store();
    const first = await database.captureSource({ profileKey: 'profile-a', page: page() });
    const record = { profileKey: 'profile-a', documentId: first.chunks[0].chunkId, sourceId: first.sourceId, modelVersion: 'e5-test', contentHash: first.contentHash, vector: [0.1, 0.2], updatedAt: Date.now() };
    await database.putEmbedding(record);
    const same = await database.captureSource({ profileKey: 'profile-a', page: page() });
    expect(same.sourceVersion).toBe(first.sourceVersion);
    expect(await database.getEmbedding('profile-a', record.documentId, 'e5-test', first.contentHash)).toEqual([0.1, 0.2]);
    const second = await database.captureSource({ profileKey: 'profile-a', page: page('Use expiring presigned URLs for private downloads.') });
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    expect(second.chunks[0].chunkId).not.toBe(first.chunks[0].chunkId);
    expect(await database.listSources('profile-a')).toHaveLength(1);
    expect(await database.listEmbeddings('profile-a', 'e5-test')).toEqual([]);
    expect((await database.findSourceByUrl('profile-a', first.url))?.contentHash).toBe(second.contentHash);
  });

  it('keeps paragraphs recoverable and every chunk within its multilingual byte budget', async () => {
    const database = store();
    const text = '使用暫時簽署網址分享私有檔案。🚀 '.repeat(200);
    const source = await database.captureSource({ profileKey: 'profile-a', page: { ...page(text), sections: [{ heading: '段落標題'.repeat(100), text }] } });
    expect(source.chunks.map((chunk) => chunk.text).join('')).toBe(text.trim());
    expect(source.chunks.every((chunk) => new TextEncoder().encode(chunk.text).length <= 360)).toBe(true);
    expect(source.chunks.every((chunk) => new TextEncoder().encode(chunk.heading).length <= 80)).toBe(true);
    expect(source.chunks.every((chunk) => chunk.end - chunk.start === chunk.text.length)).toBe(true);
    expect(summarizeKnowledgeSource(source).characterCount).toBe(text.trim().length);
  });

  it('retains unlinked content until explicit clearing and clears its own index data', async () => {
    const database = store();
    const source = await database.captureSource({ profileKey: 'profile-a', page: page() });
    await database.putEmbedding({ profileKey: 'profile-a', documentId: 'chunk-one', sourceId: source.sourceId, modelVersion: 'e5', contentHash: source.contentHash, vector: [1], updatedAt: Date.now() });
    expect(await database.listSources('profile-a')).toHaveLength(1);
    await database.deleteSource('profile-b', source.sourceId);
    expect(await database.getSource('profile-a', source.sourceId)).toBeDefined();
    await database.deleteSource('profile-a', source.sourceId);
    expect(await database.listSources('profile-a')).toEqual([]);
    expect(await database.listEmbeddings('profile-a', 'e5')).toEqual([]);
  });

  it('rejects private, sensitive, malformed and empty captures before changing the stored version', async () => {
    const database = store();
    const source = await database.captureSource({ profileKey: 'profile-a', page: page() });
    for (const url of ['http://127.0.0.1/private', 'https://example.com/reset-password?token=secret', 'file:///tmp/secret']) {
      await expect(database.captureSource({ profileKey: 'profile-a', page: { ...page(), url } })).rejects.toThrow();
    }
    await expect(database.captureSource({ profileKey: 'profile-a', page: { ...page(), sections: [] } })).rejects.toThrow('沒有可收錄');
    expect((await database.getSource('profile-a', source.sourceId))?.contentHash).toBe(source.contentHash);
  });

  it('isolates grants and embedding caches by profile, model and content version', async () => {
    const database = store();
    await database.setValue('a', 'grants', [{ id: 'client-one' }]);
    await database.putEmbedding({ profileKey: 'a', documentId: 'bookmark-one', modelVersion: 'model-a', contentHash: 'version-a', vector: [1, 2], updatedAt: 1 });
    expect(await database.getValue('b', 'grants')).toBeUndefined();
    expect(await database.getValue('a', 'grants')).toEqual([{ id: 'client-one' }]);
    expect(await database.getEmbedding('a', 'bookmark-one', 'model-a', 'version-b')).toBeUndefined();
    expect(await database.getEmbedding('a', 'bookmark-one', 'model-b', 'version-a')).toBeUndefined();
    expect(await database.getEmbedding('b', 'bookmark-one', 'model-a', 'version-a')).toBeUndefined();
    await database.deleteEmbedding('a', 'bookmark-one');
    expect(await database.listEmbeddings('a', 'model-a')).toEqual([]);
  });
});
