import { classifyUrlForLinkCheck } from './link-checker';
import type {
  CapturedPage,
  KnowledgeChunk,
  KnowledgeEmbedding,
  KnowledgeExcerpt,
  KnowledgeSection,
  KnowledgeSource,
  KnowledgeSourceSummary,
} from './knowledge-types';

const MAX_CAPTURE_CHARACTERS = 200_000;
const MAX_SECTIONS = 200;
// The UTF-8 budget is deliberately small enough for a passage prefix and heading
// to remain below E5's 512-token context, including unusual multilingual input.
const CHUNK_BYTES = 360;
const HEADING_BYTES = 80;

const utf8 = new TextEncoder();

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function prefixByBytes(text: string, maxBytes: number): string {
  let length = 0;
  let result = '';
  for (const character of text) {
    length += utf8.encode(character).length;
    if (length > maxBytes) break;
    result += character;
  }
  return result;
}

async function sha256(text: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', utf8.encode(text));
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Keeps meaningful query parameters and fragments when identifying a source. */
export async function sourceIdForUrl(profileKey: string, rawUrl: string): Promise<string> {
  if (!profileKey || !rawUrl || rawUrl.length > 8192) throw new Error('來源識別資料無效。');
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('此網址類型無法收錄。');
  return `source_${(await sha256(JSON.stringify([profileKey, parsed.href]))).slice(0, 32)}`;
}

export const knowledgeSourceId = sourceIdForUrl;

function normalizePage(page: CapturedPage): CapturedPage {
  if (!page || typeof page.url !== 'string' || typeof page.title !== 'string' || !Array.isArray(page.sections)) {
    throw new Error('收錄內容格式無效。');
  }
  const eligibility = classifyUrlForLinkCheck(page.url);
  if (!eligibility.eligible) throw new Error(eligibility.reason || '此頁面無法收錄。');
  let remaining = MAX_CAPTURE_CHARACTERS;
  let truncated = Boolean(page.truncated) || page.sections.length > MAX_SECTIONS;
  const sections: KnowledgeSection[] = [];
  for (const [index, section] of page.sections.slice(0, MAX_SECTIONS).entries()) {
    if (!section || typeof section.heading !== 'string' || typeof section.text !== 'string') {
      throw new Error('收錄段落格式無效。');
    }
    const text = cleanText(section.text);
    if (!text) continue;
    const accepted = text.slice(0, remaining);
    if (accepted.length < text.length) truncated = true;
    if (accepted) sections.push({ heading: cleanText(section.heading).slice(0, 240), text: accepted });
    remaining -= accepted.length;
    if (remaining === 0) {
      if (index + 1 < page.sections.length) truncated = true;
      break;
    }
  }
  if (!sections.length) throw new Error('此頁面沒有可收錄的正文。');
  return {
    url: new URL(page.url).href,
    title: cleanText(page.title).slice(0, 512) || new URL(page.url).hostname,
    sections,
    truncated,
  };
}

function makeChunks(sourceId: string, version: string, sections: KnowledgeSection[]): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let offset = 0;
  for (const section of sections) {
    let rest = section.text;
    const heading = prefixByBytes(section.heading, HEADING_BYTES);
    while (rest) {
      let text = prefixByBytes(rest, CHUNK_BYTES);
      // Prefer a complete sentence or word near the end of this bounded window.
      if (text.length < rest.length) {
        const boundary = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('。'), text.lastIndexOf('. '), text.lastIndexOf(' '));
        if (boundary >= text.length / 2) text = text.slice(0, boundary + 1);
      }
      const index = chunks.length;
      chunks.push({
        chunkId: `${sourceId}/${version.slice(0, 16)}/${index}`,
        sourceId,
        sourceVersion: version,
        heading,
        text,
        index,
        start: offset,
        end: offset + text.length,
      });
      offset += text.length;
      rest = rest.slice(text.length);
    }
    offset += 2;
  }
  return chunks;
}

export function summarizeKnowledgeSource(source: KnowledgeSource): KnowledgeSourceSummary {
  return {
    sourceId: source.sourceId,
    title: source.title,
    url: source.url,
    sourceVersion: source.sourceVersion,
    capturedAt: source.capturedAt,
    updatedAt: source.updatedAt,
    chunkCount: source.chunks.length,
    characterCount: source.sections.reduce((total, section) => total + section.text.length, 0),
    truncated: source.truncated,
  };
}

export function toKnowledgeExcerpt(source: KnowledgeSource, chunk: KnowledgeChunk): KnowledgeExcerpt {
  return {
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    chunkId: chunk.chunkId,
    title: source.title,
    url: source.url,
    capturedAt: source.capturedAt,
    heading: chunk.heading,
    text: chunk.text,
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('本機知識庫讀取失敗。'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('本機知識庫儲存失敗。'));
  });
  // A request can reject before its transaction aborts. Its caller still receives
  // that failure while the completion promise remains safely observed.
  void completion.catch(() => undefined);
  return completion;
}

/** A separate database keeps existing bookmark backups and jobs compatible. */
export class KnowledgeStore {
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(private readonly name = 'favorsite_knowledge_store') {}

  private open(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const sources = request.result.createObjectStore('sources', { keyPath: ['profileKey', 'sourceId'] });
        sources.createIndex('byProfile', 'profileKey');
        sources.createIndex('byUrl', ['profileKey', 'url'], { unique: true });
        const embeddings = request.result.createObjectStore('embeddings', { keyPath: ['profileKey', 'documentId', 'modelVersion'] });
        embeddings.createIndex('byProfileModel', ['profileKey', 'modelVersion']);
        embeddings.createIndex('bySource', ['profileKey', 'sourceId']);
        embeddings.createIndex('byDocument', ['profileKey', 'documentId']);
        request.result.createObjectStore('kv', { keyPath: ['profileKey', 'key'] });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); this.databasePromise = undefined; };
        resolve(database);
      };
      request.onerror = () => { this.databasePromise = undefined; reject(request.error); };
    });
    return this.databasePromise;
  }

  async close(): Promise<void> {
    if (!this.databasePromise) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = undefined;
  }

  async captureSource(params: { profileKey: string; page: CapturedPage }): Promise<KnowledgeSource> {
    const page = normalizePage(params.page);
    const sourceId = await sourceIdForUrl(params.profileKey, page.url);
    const contentHash = await sha256(JSON.stringify([page.title, page.sections]));
    const now = Date.now();
    const source: KnowledgeSource = {
      profileKey: params.profileKey,
      sourceId,
      title: page.title,
      url: page.url,
      sections: page.sections,
      truncated: page.truncated,
      contentHash,
      sourceVersion: contentHash,
      capturedAt: now,
      updatedAt: now,
      chunks: makeChunks(sourceId, contentHash, page.sections),
    };
    const database = await this.open();
    const transaction = database.transaction(['sources', 'embeddings'], 'readwrite');
    const completion = transactionDone(transaction);
    const previous = await requestResult(transaction.objectStore('sources').get([params.profileKey, sourceId])) as KnowledgeSource | undefined;
    if (previous?.contentHash !== source.contentHash) {
      const keys = await requestResult(transaction.objectStore('embeddings').index('bySource').getAllKeys([params.profileKey, sourceId]));
      for (const key of keys) transaction.objectStore('embeddings').delete(key);
    }
    transaction.objectStore('sources').put(source);
    await completion;
    return source;
  }

  async getSource(profileKey: string, sourceId: string): Promise<KnowledgeSource | undefined> {
    const database = await this.open();
    const transaction = database.transaction('sources', 'readonly');
    const completion = transactionDone(transaction);
    const source = await requestResult(transaction.objectStore('sources').get([profileKey, sourceId])) as KnowledgeSource | undefined;
    await completion;
    return source;
  }

  async findSourceByUrl(profileKey: string, url: string): Promise<KnowledgeSource | undefined> {
    return this.getSource(profileKey, await sourceIdForUrl(profileKey, url));
  }

  async listSources(profileKey: string): Promise<KnowledgeSource[]> {
    const database = await this.open();
    const transaction = database.transaction('sources', 'readonly');
    const completion = transactionDone(transaction);
    const sources = await requestResult(transaction.objectStore('sources').index('byProfile').getAll(profileKey)) as KnowledgeSource[];
    await completion;
    return sources.sort((left, right) => right.updatedAt - left.updatedAt || left.sourceId.localeCompare(right.sourceId));
  }

  async deleteSource(profileKey: string, sourceId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(['sources', 'embeddings'], 'readwrite');
    const completion = transactionDone(transaction);
    const keys = await requestResult(transaction.objectStore('embeddings').index('bySource').getAllKeys([profileKey, sourceId]));
    for (const key of keys) transaction.objectStore('embeddings').delete(key);
    transaction.objectStore('sources').delete([profileKey, sourceId]);
    await completion;
  }

  async getEmbedding(profileKey: string, documentId: string, modelVersion: string, contentHash: string): Promise<number[] | undefined> {
    const database = await this.open();
    const transaction = database.transaction('embeddings', 'readonly');
    const completion = transactionDone(transaction);
    const record = await requestResult(transaction.objectStore('embeddings').get([profileKey, documentId, modelVersion])) as KnowledgeEmbedding | undefined;
    await completion;
    return record?.contentHash === contentHash ? record.vector : undefined;
  }

  async putEmbedding(record: KnowledgeEmbedding): Promise<void> {
    if (!record.vector.length || record.vector.some((value) => !Number.isFinite(value))) {
      throw new Error('語意索引向量格式無效。');
    }
    const database = await this.open();
    const transaction = database.transaction(['sources', 'embeddings'], 'readwrite');
    const completion = transactionDone(transaction);
    if (record.sourceId) {
      const source = await requestResult(
        transaction.objectStore('sources').get([record.profileKey, record.sourceId]),
      ) as KnowledgeSource | undefined;
      if (!source || record.sourceVersion && record.sourceVersion !== source.sourceVersion) {
        await completion;
        return;
      }
    }
    transaction.objectStore('embeddings').put(record);
    await completion;
  }

  async listEmbeddings(profileKey: string, modelVersion: string): Promise<KnowledgeEmbedding[]> {
    const database = await this.open();
    const transaction = database.transaction('embeddings', 'readonly');
    const completion = transactionDone(transaction);
    const records = await requestResult(transaction.objectStore('embeddings').index('byProfileModel').getAll([profileKey, modelVersion])) as KnowledgeEmbedding[];
    await completion;
    return records;
  }

  async deleteEmbedding(profileKey: string, documentId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction('embeddings', 'readwrite');
    const completion = transactionDone(transaction);
    const keys = await requestResult(transaction.objectStore('embeddings').index('byDocument').getAllKeys([profileKey, documentId]));
    for (const key of keys) transaction.objectStore('embeddings').delete(key);
    await completion;
  }

  async getValue<T>(profileKey: string, key: string): Promise<T | undefined> {
    const database = await this.open();
    const transaction = database.transaction('kv', 'readonly');
    const completion = transactionDone(transaction);
    const record = await requestResult(transaction.objectStore('kv').get([profileKey, key])) as { value: T } | undefined;
    await completion;
    return record?.value;
  }

  async setValue(profileKey: string, key: string, value: unknown): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction('kv', 'readwrite');
    const completion = transactionDone(transaction);
    transaction.objectStore('kv').put({ profileKey, key, value });
    await completion;
  }
}

export const defaultKnowledgeStore = new KnowledgeStore();
