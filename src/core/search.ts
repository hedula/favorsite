import MiniSearch from 'minisearch';
import type { BookmarkMetadata, BookmarkProjection } from './types';

interface IndexedBookmarkDoc {
  id: string;
  title: string;
  domain: string;
  path: string;
  tags: string;
  url: string;
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
}

export class BookmarkSearchIndex {
  private miniSearch: MiniSearch<IndexedBookmarkDoc>;
  private docsById = new Map<string, BookmarkProjection>();
  private tagsById = new Map<string, string[]>();

  constructor() {
    this.miniSearch = new MiniSearch<IndexedBookmarkDoc>({
      fields: ['title', 'domain', 'path', 'tags', 'url'],
      storeFields: ['id'],
      tokenize: hybridTokenize,
      searchOptions: {
        boost: { title: 3, tags: 2.5, domain: 2, path: 1.2, url: 0.8 },
        prefix: true,
        fuzzy: (term) => (CJK_REGEX.test(term) || term.length <= 3 ? false : 0.2),
      },
    });
  }

  rebuild(
    projections: BookmarkProjection[],
    metadataList: BookmarkMetadata[],
  ): void {
    this.miniSearch.removeAll();
    this.docsById.clear();
    this.tagsById.clear();

    for (const meta of metadataList) {
      this.tagsById.set(meta.nodeId, meta.tags);
    }

    const docs: IndexedBookmarkDoc[] = [];
    for (const p of projections) {
      if (p.isFolder) continue;
      this.docsById.set(p.nodeId, p);
      const tags = this.tagsById.get(p.nodeId) ?? [];
      docs.push({
        id: p.nodeId,
        title: p.title,
        domain: p.domain,
        path: p.path,
        tags: tags.join(' '),
        url: p.url ?? '',
      });
    }

    this.miniSearch.addAll(docs);
  }

  search(filter: SearchFilter): BookmarkProjection[] {
    const rawQuery = (filter.query ?? '').trim();
    let exactDomain = filter.exactDomain?.trim().toLowerCase() ?? '';
    let tagFilter = filter.tag?.trim().toLowerCase() ?? '';

    // Parse inline `domain:example.com` and `tag:foo` syntax from query
    const remainingParts: string[] = [];
    for (const part of rawQuery.split(/\s+/).filter(Boolean)) {
      if (part.toLowerCase().startsWith('domain:')) {
        exactDomain = part.slice(7).toLowerCase();
      } else if (part.toLowerCase().startsWith('tag:')) {
        tagFilter = part.slice(4).toLowerCase();
      } else {
        remainingParts.push(part);
      }
    }

    const textQuery = remainingParts.join(' ').trim();

    let candidates: BookmarkProjection[];
    if (textQuery) {
      const results = this.miniSearch.search(textQuery);
      candidates = [];
      for (const r of results) {
        const doc = this.docsById.get(r.id);
        if (doc) candidates.push(doc);
      }
    } else {
      candidates = Array.from(this.docsById.values());
    }

    if (exactDomain) {
      candidates = candidates.filter(
        (b) => b.domain === exactDomain || b.domain.endsWith(`.${exactDomain}`),
      );
    }

    if (tagFilter) {
      candidates = candidates.filter((b) =>
        (this.tagsById.get(b.nodeId) ?? []).some(
          (t) => t.toLowerCase() === tagFilter,
        ),
      );
    }

    if (filter.folderId) {
      candidates = candidates.filter((b) => b.parentId === filter.folderId);
    }

    return candidates;
  }
}
