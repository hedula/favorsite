import MiniSearch from 'minisearch';
import type { BookmarkMetadata, BookmarkProjection } from './types';

interface IndexedBookmarkDoc {
  id: string;
  title: string;
  domain: string;
  path: string;
  tags: string;
  url: string;
  content: string;
}

const CJK_REGEX = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Hybrid tokenizer supporting mixed Traditional Chinese + English/alphanumeric text.
 * - Splits Latin/numeric words by punctuation/whitespace and dots/slashes.
 * - Emits CJK unigrams and overlapping bigrams so queries like "書籤", "雲端", "整理" match reliably.
 */
export function hybridTokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // Extract Latin/numeric tokens
  const latinMatches = lower.match(/[a-z0-9]+/g);
  if (latinMatches) {
    for (const m of latinMatches) {
      tokens.push(m);
    }
  }

  // Extract CJK contiguous runs -> unigrams + bigrams
  const cjkRuns = lower.match(/[\u3400-\u9fff\uf900-\ufaff]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i]);
        if (i + 1 < run.length) {
          tokens.push(run.slice(i, i + 2));
        }
      }
    }
  }

  // Keep domain-like dotted strings as exact tokens too
  const hostMatches = lower.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g);
  if (hostMatches) {
    for (const h of hostMatches) {
      tokens.push(h);
    }
  }

  return tokens;
}

export interface SearchFilter {
  query?: string;
  exactDomain?: string;
  tag?: string;
  folderId?: string;
  includeDescendants?: boolean;
}

export interface RankedBookmarkMatch {
  bookmark: BookmarkProjection;
  score: number;
  matchedFields: string[];
}

export function parseBookmarkSearchFilter(filter: SearchFilter): {
  textQuery: string;
  exactDomain: string;
  tagFilter: string;
} {
  let exactDomain = filter.exactDomain?.trim().toLowerCase() ?? '';
  let tagFilter = filter.tag?.trim().toLowerCase() ?? '';
  const terms: string[] = [];
  for (const part of (filter.query ?? '').trim().split(/\s+/).filter(Boolean)) {
    if (part.toLowerCase().startsWith('domain:')) exactDomain = part.slice(7).toLowerCase();
    else if (part.toLowerCase().startsWith('tag:')) tagFilter = part.slice(4).toLowerCase();
    else terms.push(part);
  }
  return { textQuery: terms.join(' ').trim(), exactDomain, tagFilter };
}

export class BookmarkSearchIndex {
  private miniSearch: MiniSearch<IndexedBookmarkDoc>;
  private docsById = new Map<string, BookmarkProjection>();
  private tagsById = new Map<string, string[]>();
  private documentsById = new Map<string, IndexedBookmarkDoc>();
  private parentsById = new Map<string, string>();

  constructor() {
    this.miniSearch = new MiniSearch<IndexedBookmarkDoc>({
      fields: ['title', 'domain', 'path', 'tags', 'url', 'content'],
      storeFields: ['id'],
      tokenize: hybridTokenize,
      searchOptions: {
        boost: { title: 3, tags: 2.5, domain: 2, path: 1.2, url: 0.8, content: 1 },
        prefix: true,
        fuzzy: (term) => (CJK_REGEX.test(term) || term.length <= 3 ? false : 0.2),
      },
    });
  }

  rebuild(
    projections: BookmarkProjection[],
    metadataList: BookmarkMetadata[],
    contentByNodeId: ReadonlyMap<string, string> = new Map(),
  ): void {
    this.miniSearch.removeAll();
    this.documentsById.clear();
    this.sync(projections, metadataList, contentByNodeId);
  }

  /** Update changed documents while preserving the index for unchanged bookmarks. */
  sync(
    projections: BookmarkProjection[],
    metadataList: BookmarkMetadata[],
    contentByNodeId: ReadonlyMap<string, string> = new Map(),
  ): void {
    this.docsById.clear();
    this.tagsById.clear();
    this.parentsById.clear();

    for (const meta of metadataList) {
      this.tagsById.set(meta.nodeId, meta.tags);
    }

    const nextIds = new Set<string>();
    for (const p of projections) {
      this.parentsById.set(p.nodeId, p.parentId);
      if (p.isFolder) continue;
      nextIds.add(p.nodeId);
      this.docsById.set(p.nodeId, p);
      const tags = this.tagsById.get(p.nodeId) ?? [];
      const doc: IndexedBookmarkDoc = {
        id: p.nodeId,
        title: p.title,
        domain: p.domain,
        path: p.path,
        tags: tags.join(' '),
        url: p.url ?? '',
        content: contentByNodeId.get(p.nodeId) ?? '',
      };
      const previous = this.documentsById.get(p.nodeId);
      if (!previous) this.miniSearch.add(doc);
      else if (JSON.stringify(previous) !== JSON.stringify(doc)) this.miniSearch.replace(doc);
      this.documentsById.set(p.nodeId, doc);
    }
    for (const [id, document] of this.documentsById) {
      if (nextIds.has(id)) continue;
      this.miniSearch.remove(document);
      this.documentsById.delete(id);
    }
  }

  search(filter: SearchFilter): BookmarkProjection[] {
    return this.searchRanked(filter).map((match) => match.bookmark);
  }

  searchRanked(filter: SearchFilter): RankedBookmarkMatch[] {
    const { textQuery, exactDomain, tagFilter } = parseBookmarkSearchFilter(filter);
    let candidates: RankedBookmarkMatch[];
    if (textQuery) {
      const results = this.miniSearch.search(textQuery);
      candidates = [];
      for (const r of results) {
        const doc = this.docsById.get(r.id);
        if (doc) candidates.push({
          bookmark: doc,
          score: r.score,
          matchedFields: Array.from(new Set(Object.values(r.match).flat())),
        });
      }
    } else {
      candidates = Array.from(this.docsById.values(), (bookmark) => ({
        bookmark, score: 0, matchedFields: [],
      }));
    }

    if (exactDomain) {
      candidates = candidates.filter(
        ({ bookmark: b }) => b.domain === exactDomain || b.domain.endsWith(`.${exactDomain}`),
      );
    }

    if (tagFilter) {
      candidates = candidates.filter(({ bookmark: b }) =>
        (this.tagsById.get(b.nodeId) ?? []).some(
          (t) => t.toLowerCase() === tagFilter,
        ),
      );
    }

    if (filter.folderId) {
      const folderId = filter.folderId;
      candidates = candidates.filter(({ bookmark }) => {
        let parentId = bookmark.parentId;
        const visited = new Set<string>();
        while (parentId && !visited.has(parentId)) {
          if (parentId === folderId) return true;
          if (!filter.includeDescendants) return false;
          visited.add(parentId);
          parentId = this.parentsById.get(parentId) ?? '';
        }
        return false;
      });
    }

    return candidates;
  }
}
