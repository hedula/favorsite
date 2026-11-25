import type { BookmarkProjection, DuplicateGroup } from './types';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  'ref',
  'ref_src',
  'ref_url',
]);

/**
 * Normalizes a URL ONLY for suspected-duplicate grouping:
 * - Preserves protocol, hostname, port, meaningful query parameters, and hash fragments.
 * - Strips only well-known tracking parameters and trailing slash on path.
 */
export function stripTrackingParams(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    const keptParams: [string, string][] = [];
    parsed.searchParams.forEach((val, key) => {
      if (!TRACKING_PARAMS.has(key.toLowerCase())) {
        keptParams.push([key, val]);
      }
    });
    keptParams.sort(([a], [b]) => a.localeCompare(b));
    parsed.search = '';
    for (const [k, v] of keptParams) {
      parsed.searchParams.append(k, v);
    }
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeTitleKey(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[|–—-]\s*[^|–—-]+$/, (match) => (match.length < 24 ? '' : match))
    .trim();
}

export function findDuplicateGroups(
  projections: BookmarkProjection[],
): DuplicateGroup[] {
  const bookmarks = projections.filter((p) => !p.isFolder && Boolean(p.url));
  const groups: DuplicateGroup[] = [];

  // 1. Exact URL duplicates (strict equality)
  const exactMap = new Map<string, BookmarkProjection[]>();
  for (const b of bookmarks) {
    const url = b.url!;
    const list = exactMap.get(url) ?? [];
    list.push(b);
    exactMap.set(url, list);
  }

  const exactGroupedIds = new Set<string>();
  let idx = 1;
  for (const [url, list] of exactMap.entries()) {
    if (list.length > 1) {
      const nodeIds = list.map((b) => b.nodeId);
      nodeIds.forEach((id) => exactGroupedIds.add(id));
      groups.push({
        groupId: `dup_exact_${idx++}`,
        kind: 'exact',
        reason: '完全相同網址',
        normalizedKey: url,
        nodeIds,
      });
    }
  }

  // 2. Suspected duplicates: same URL after ignoring known tracking params / trailing slash
  // Only emits a suspected group if the group contains at least two distinct raw URLs.
  const trackingMap = new Map<string, BookmarkProjection[]>();
  for (const b of bookmarks) {
    const stripped = stripTrackingParams(b.url!);
    if (!stripped) continue;
    const list = trackingMap.get(stripped) ?? [];
    list.push(b);
    trackingMap.set(stripped, list);
  }

  const trackingGroupedPairs = new Set<string>();
  for (const [normUrl, list] of trackingMap.entries()) {
    const distinctRawUrls = new Set(list.map((b) => b.url));
    if (list.length > 1 && distinctRawUrls.size > 1) {
      const nodeIds = list.map((b) => b.nodeId);
      const pairKey = [...nodeIds].sort().join(',');
      trackingGroupedPairs.add(pairKey);
      groups.push({
        groupId: `dup_track_${idx++}`,
        kind: 'suspected',
        reason: '忽略追蹤參數或尾端斜線後網址一致（請人工確認）',
        normalizedKey: normUrl,
        nodeIds,
      });
    }
  }

  // 3. Suspected duplicates: identical normalized title on different URLs
  const titleMap = new Map<string, BookmarkProjection[]>();
  for (const b of bookmarks) {
    const key = normalizeTitleKey(b.title);
    if (key.length < 4) continue;
    const list = titleMap.get(key) ?? [];
    list.push(b);
    titleMap.set(key, list);
  }

  for (const [titleKey, list] of titleMap.entries()) {
    if (list.length <= 1) continue;
    const distinctRawUrls = new Set(list.map((b) => b.url));
    if (distinctRawUrls.size <= 1) continue;
    const nodeIds = list.map((b) => b.nodeId);
    const pairKey = [...nodeIds].sort().join(',');
    if (trackingGroupedPairs.has(pairKey)) continue;
    groups.push({
      groupId: `dup_title_${idx++}`,
      kind: 'suspected',
      reason: '標題相似但網址不同（可能含不同頁面、參數或協定，請人工確認）',
      normalizedKey: titleKey,
      nodeIds,
    });
  }

  return groups;
}
