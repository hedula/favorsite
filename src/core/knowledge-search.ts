import type { KnowledgeChunk, KnowledgeSource } from './knowledge-types';
import { sourceIdForUrl } from './knowledge-store';
import { classifyUrlForLinkCheck } from './link-checker';
import { BookmarkSearchIndex, hybridTokenize, parseBookmarkSearchFilter } from './search';
import { SEMANTIC_MODEL_ID, type EmbeddingBatch } from './semantic-classifier';
import type { BookmarkMetadata, BookmarkProjection } from './types';

export const KNOWLEDGE_MODEL_VERSION =
  SEMANTIC_MODEL_ID + '@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8:retrieval-v2';
const EMBEDDING_BATCH_SIZE = 24;
const MAX_RESULTS = 20;
const utf8 = new TextEncoder();
const sharedIndexes = new Map<string, BookmarkSearchIndex>();

export interface KnowledgeSearchGrant {
  folderIds: string[];
  includeContent: boolean;
}

export interface SearchKnowledgeHit {
  bookmarkId: string;
  sourceId: string;
  title: string;
  url: string;
  folderPath: string;
  tags: string[];
  matchedFields: string[];
  snippet?: string;
  chunkId?: string;
  indexedAt: number;
  contentStatus: 'collected' | 'not_collected';
  sourceVersion?: string;
  capturedAt?: number;
}

export interface SearchKnowledgeResult {
  results: SearchKnowledgeHit[];
  nextCursor?: string;
  mode: 'keyword' | 'hybrid';
  warnings: string[];
  indexedAt: number;
}

export interface SearchKnowledgeParams {
  profileKey: string;
  projections: BookmarkProjection[];
  metadata: BookmarkMetadata[];
  query: string;
  folderId?: string;
  includeDescendants?: boolean;
  tags?: string[];
  limit?: number;
  cursor?: string;
  grant?: KnowledgeSearchGrant;
  sources?: KnowledgeSource[];
  mode?: 'keyword' | 'semantic';
  embed?: (texts: string[], signal?: AbortSignal) => Promise<EmbeddingBatch | number[][]>;
  signal?: AbortSignal;
  getCachedEmbedding?: (key: string) => Promise<number[] | undefined>;
  setCachedEmbedding?: (key: string, vector: number[], sourceId?: string, sourceVersion?: string) => Promise<void>;
  onProgress?: (progress: { completed: number; total: number }) => void;
}

export class KnowledgeSearchError extends Error {
  constructor(
    public readonly code: 'INVALID_INPUT' | 'INVALID_CURSOR' | 'STALE_CURSOR',
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeSearchError';
  }
}

interface KnowledgeScope {
  profileKey: string;
  projections: BookmarkProjection[];
  folderId?: string;
  includeDescendants?: boolean;
  grant?: KnowledgeSearchGrant;
}

function descendants(
  projections: BookmarkProjection[],
  rootIds: string[],
): Set<string> {
  const children = new Map<string, string[]>();
  const folders = new Set(projections.filter((node) => node.isFolder).map((node) => node.nodeId));
  for (const node of projections) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.nodeId);
    children.set(node.parentId, siblings);
  }
  const allowed = new Set<string>();
  const pending = rootIds.filter((id) => folders.has(id));
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (allowed.has(id)) continue;
    allowed.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return allowed;
}

/** Apply profile and granted-folder boundaries before indexing or embedding. */
export function allowedKnowledgeBookmarks(params: KnowledgeScope): BookmarkProjection[] {
  const projections = params.projections.filter((node) => node.profileKey === params.profileKey);
  const granted = params.grant ? descendants(projections, params.grant.folderIds) : undefined;
  const selected = params.folderId && params.includeDescendants !== false
    ? descendants(projections, [params.folderId])
    : undefined;
  return projections.filter((node) =>
    !node.isFolder &&
    (node.url?.length ?? 0) <= 8192 &&
    (!granted || granted.has(node.nodeId)) &&
    (!params.folderId || (
      params.includeDescendants === false
        ? node.parentId === params.folderId
        : selected!.has(node.nodeId)
    )) &&
    classifyUrlForLinkCheck(node.url).eligible,
  );
}

function scopedFolderPath(
  bookmark: BookmarkProjection,
  folders: Map<string, BookmarkProjection>,
  grant?: KnowledgeSearchGrant,
): string {
  if (!grant) return bookmark.path;
  const roots = new Set(grant.folderIds);
  const titles: string[] = [];
  const visited = new Set<string>();
  let id = bookmark.parentId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const folder = folders.get(id);
    if (!folder) break;
    if (folder.title) titles.unshift(folder.title);
    if (roots.has(id)) break;
    id = folder.parentId;
  }
  return titles.join(' / ');
}

function prefixByBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const character of text) {
    bytes += utf8.encode(character).length;
    if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}

async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function validateVector(vector: unknown): vector is number[] {
  return Array.isArray(vector) && vector.length > 0 &&
    vector.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    vector.some((value) => value !== 0);
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) throw new Error('語意索引維度已變更，請重新建立索引。');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

async function loadEmbeddings(
  texts: string[],
  params: SearchKnowledgeParams,
  sourceByText: ReadonlyMap<string, { sourceId: string; sourceVersion: string }>,
): Promise<Map<string, number[]>> {
  const unique = [...new Set(texts)];
  const keys = await Promise.all(unique.map(async (text) => ({
    text, key: await textHash(KNOWLEDGE_MODEL_VERSION + '\n' + text),
  })));
  const vectors = new Map<string, number[]>();
  const missing: { text: string; key: string }[] = [];
  await Promise.all(keys.map(async (entry) => {
    const cached = await params.getCachedEmbedding?.(entry.key);
    if (validateVector(cached)) vectors.set(entry.text, cached);
    else missing.push(entry);
  }));
  let completed = unique.length - missing.length;
  params.onProgress?.({ completed, total: unique.length });
  for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
    params.signal?.throwIfAborted();
    const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const result = await params.embed!(batch.map((entry) => entry.text), params.signal);
    params.signal?.throwIfAborted();
    const output = Array.isArray(result) ? result : result.vectors;
    if (output.length !== batch.length || output.some((vector) => !validateVector(vector))) {
      throw new Error('本機語意模型回傳的向量格式無效。');
    }
    await Promise.all(batch.map(async (entry, index) => {
      vectors.set(entry.text, output[index]);
      const source = sourceByText.get(entry.text);
      await params.setCachedEmbedding?.(entry.key, output[index], source?.sourceId, source?.sourceVersion);
    }));
    completed += batch.length;
    params.onProgress?.({ completed, total: unique.length });
  }
  return vectors;
}

function bestExcerpt(source: KnowledgeSource | undefined, query: string): KnowledgeChunk | undefined {
  if (!source) return undefined;
  const tokens = new Set(hybridTokenize(query));
  let best = source.chunks[0];
  let bestMatches = -1;
  for (const chunk of source.chunks) {
    const terms = new Set(hybridTokenize(chunk.heading + ' ' + chunk.text));
    let matches = 0;
    for (const token of tokens) {
      if (terms.has(token)) matches += token.length > 1 ? 2 : 1;
    }
    if (matches > bestMatches) {
      best = chunk;
      bestMatches = matches;
    }
  }
  return best;
}

function encodeCursor(offset: number, fingerprint: string): string {
  return btoa(JSON.stringify({ version: 1, offset, fingerprint }))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function readCursor(cursor: string | undefined, fingerprint: string): number {
  if (!cursor) return 0;
  let value: { version?: unknown; offset?: unknown; fingerprint?: unknown };
  try {
    if (cursor.length > 400) throw new Error();
    value = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    throw new KnowledgeSearchError('INVALID_CURSOR', '搜尋分頁無效，請重新搜尋。');
  }
  if (!value || value.version !== 1 || !Number.isInteger(value.offset) ||
      typeof value.offset !== 'number' || value.offset < 0 || typeof value.fingerprint !== 'string') {
    throw new KnowledgeSearchError('INVALID_CURSOR', '搜尋分頁無效，請重新搜尋。');
  }
  if (value.fingerprint !== fingerprint) {
    throw new KnowledgeSearchError('STALE_CURSOR', '搜尋範圍或來源已變更，請重新搜尋。');
  }
  return value.offset;
}

interface SearchDocument {
  bookmark: BookmarkProjection;
  tags: string[];
  path: string;
  source?: KnowledgeSource;
  passage: string;
}

/** Same scoped retrieval for Studio and MCP, with keyword fallback when an encoder fails. */
export async function searchKnowledge(params: SearchKnowledgeParams): Promise<SearchKnowledgeResult> {
  params.signal?.throwIfAborted();
  if (!params.profileKey || typeof params.query !== 'string' || params.query.length > 2000 ||
      (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_RESULTS))) {
    throw new KnowledgeSearchError('INVALID_INPUT', '搜尋內容或結果筆數無效。');
  }
  const limit = params.limit ?? 10;
  const { textQuery, exactDomain, tagFilter } = parseBookmarkSearchFilter({ query: params.query });
  const requestedTags = [...(params.tags ?? []), ...(tagFilter ? [tagFilter] : [])]
    .map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const metadata = params.metadata.filter((item) => item.profileKey === params.profileKey);
  const tagsById = new Map(metadata.map((item) => [item.nodeId, item.tags]));
  const bookmarks = allowedKnowledgeBookmarks(params).filter((bookmark) =>
    (!exactDomain || bookmark.domain === exactDomain || bookmark.domain.endsWith('.' + exactDomain)) &&
    requestedTags.every((tag) => (tagsById.get(bookmark.nodeId) ?? []).some((value) => value.toLowerCase() === tag)),
  );
  const canReadContent = !params.grant || params.grant.includeContent;
  const sourcesByUrl = new Map(
    (canReadContent ? params.sources ?? [] : [])
      .filter((source) => source.profileKey === params.profileKey)
      .map((source) => [source.url, source]),
  );
  const folders = new Map(params.projections
    .filter((node) => node.profileKey === params.profileKey && node.isFolder)
    .map((node) => [node.nodeId, node]));
  const documents: SearchDocument[] = bookmarks.map((bookmark) => {
    const path = scopedFolderPath(bookmark, folders, params.grant);
    const tags = tagsById.get(bookmark.nodeId) ?? [];
    // Short titles and tags gave better cross-language retrieval than adding URL
    // hosts and folder breadcrumbs. Domains and paths remain keyword-searchable.
    const passage = 'passage: ' + [
      prefixByBytes(bookmark.title, 320), prefixByBytes(tags.join(' '), 140),
    ].filter(Boolean).join('\n');
    return {
      bookmark: { ...bookmark, path }, tags, path,
      source: sourcesByUrl.get(new URL(bookmark.url!).href),
      passage: prefixByBytes(passage, 480),
    };
  });
  const contentById = new Map(documents
    .filter((document) => document.source)
    .map((document) => [
      document.bookmark.nodeId,
      document.source!.chunks.map((chunk) => chunk.heading + '\n' + chunk.text).join('\n'),
    ]));
  let index = sharedIndexes.get(params.profileKey);
  if (!index) {
    index = new BookmarkSearchIndex();
    sharedIndexes.set(params.profileKey, index);
  }
  index.sync(documents.map((document) => document.bookmark), metadata, contentById);
  const keywordMatches = index.searchRanked({ query: textQuery });
  const keywordById = new Map(keywordMatches.map((match) => [match.bookmark.nodeId, match]));
  const maxKeywordScore = keywordMatches[0]?.score || 1;
  const warnings: string[] = [];
  let mode: SearchKnowledgeResult['mode'] = 'keyword';
  const similarities = new Map<string, number>();
  const semanticExcerpts = new Map<string, KnowledgeChunk>();
  if (params.mode === 'semantic' && textQuery && documents.length) {
    if (!params.embed) warnings.push('語意模型尚未就緒，已顯示關鍵字結果。');
    else {
      try {
        const query = 'query: ' + prefixByBytes(textQuery, 480);
        const chunkPassages = new Map<string, { chunk: KnowledgeChunk; passage: string }[]>();
        const sourceByText = new Map<string, { sourceId: string; sourceVersion: string }>();
        for (const document of documents) {
          const passages = (document.source?.chunks ?? []).map((chunk) => ({
            chunk,
            passage: 'passage: ' + prefixByBytes(chunk.heading + '\n' + chunk.text, 480),
          }));
          chunkPassages.set(document.bookmark.nodeId, passages);
          if (document.source) {
            for (const { passage } of passages) sourceByText.set(passage, {
              sourceId: document.source.sourceId, sourceVersion: document.source.sourceVersion,
            });
          }
        }
        const vectors = await loadEmbeddings([
          query, ...documents.map((document) => document.passage),
          ...Array.from(chunkPassages.values()).flat().map((entry) => entry.passage),
        ], params, sourceByText);
        const queryVector = vectors.get(query)!;
        for (const document of documents) {
          let best = cosine(queryVector, vectors.get(document.passage)!);
          for (const { chunk, passage } of chunkPassages.get(document.bookmark.nodeId) ?? []) {
            const score = cosine(queryVector, vectors.get(passage)!);
            if (score > best) {
              best = score;
              semanticExcerpts.set(document.bookmark.nodeId, chunk);
            }
          }
          similarities.set(document.bookmark.nodeId, best);
        }
        mode = 'hybrid';
      } catch (error) {
        params.signal?.throwIfAborted();
        warnings.push(error instanceof Error ? error.message : '語意搜尋暫時無法使用，已顯示關鍵字結果。');
      }
    }
  }
  params.signal?.throwIfAborted();
  const semanticScores = Array.from(similarities.values());
  const minimum = semanticScores.reduce((value, score) => Math.min(value, score), semanticScores[0] ?? 0);
  const maximum = semanticScores.reduce((value, score) => Math.max(value, score), semanticScores[0] ?? 0);
  const normalizedQuery = textQuery.toLowerCase();
  const ranked = documents.filter((document) =>
    !textQuery || mode === 'hybrid' || keywordById.has(document.bookmark.nodeId),
  ).map((document) => {
    const bookmark = document.bookmark;
    const keyword = keywordById.get(bookmark.nodeId);
    const semantic = similarities.get(bookmark.nodeId) ?? minimum;
    const semanticScore = maximum > minimum ? (semantic - minimum) / (maximum - minimum) : 0;
    let score = mode === 'hybrid'
      ? semanticScore * 0.8 + ((keyword?.score ?? 0) / maxKeywordScore) * 0.2
      : keyword?.score ?? 0;
    if (normalizedQuery && [bookmark.title.toLowerCase(), bookmark.url!.toLowerCase()].includes(normalizedQuery)) {
      score += 100;
    }
    return { document, score };
  }).sort((left, right) =>
    right.score - left.score || left.document.bookmark.nodeId.localeCompare(right.document.bookmark.nodeId, 'en'),
  );
  const fingerprint = await textHash(JSON.stringify({
    profileKey: params.profileKey, query: params.query, folderId: params.folderId,
    includeDescendants: params.includeDescendants !== false,
    tags: requestedTags.slice().sort(), grant: params.grant,
    mode, model: KNOWLEDGE_MODEL_VERSION,
    documents: documents.map((document) => [
      document.bookmark.nodeId, document.bookmark.title, document.bookmark.url,
      document.path, document.tags, document.source?.sourceVersion,
    ]),
  }));
  const offset = readCursor(params.cursor, fingerprint);
  if (offset > ranked.length) throw new KnowledgeSearchError('INVALID_CURSOR', '搜尋分頁無效，請重新搜尋。');
  const indexedAt = Date.now();
  const results = await Promise.all(ranked.slice(offset, offset + limit).map(async ({ document }) => {
    const keyword = keywordById.get(document.bookmark.nodeId);
    const excerpt = semanticExcerpts.get(document.bookmark.nodeId) ?? bestExcerpt(document.source, textQuery);
    const hit: SearchKnowledgeHit = {
      bookmarkId: document.bookmark.nodeId,
      sourceId: document.source?.sourceId ?? await sourceIdForUrl(params.profileKey, document.bookmark.url!),
      title: document.bookmark.title,
      url: document.bookmark.url!,
      folderPath: document.path,
      tags: document.tags,
      matchedFields: keyword?.matchedFields ?? (mode === 'hybrid' ? ['semantic'] : []),
      indexedAt,
      contentStatus: document.source ? 'collected' : 'not_collected',
    };
    if (document.source) {
      hit.sourceVersion = document.source.sourceVersion;
      hit.capturedAt = document.source.capturedAt;
    }
    if (excerpt) {
      hit.snippet = excerpt.text.slice(0, 300);
      hit.chunkId = excerpt.chunkId;
    }
    return hit;
  }));
  return {
    results, mode, warnings, indexedAt,
    ...(offset + limit < ranked.length
      ? { nextCursor: encodeCursor(offset + limit, fingerprint) }
      : {}),
  };
}
