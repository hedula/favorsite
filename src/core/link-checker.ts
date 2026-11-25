import type {
  BookmarkProjection,
  LinkCheckRecord,
  LinkCheckStatus,
} from './types';

export interface UrlCheckEligibility {
  eligible: boolean;
  originPattern?: string;
  skipStatus?: 'skipped_private' | 'skipped_sensitive';
  reason?: string;
}

/**
 * Query parameter NAMES that suggest a secret or a one-time action. Matches the name
 * exactly (`code`, `otp`, `key`, …) or as a substring for compound names such as
 * `X-Amz-Signature`, `token_hash`, `x-goog-credential`, `client_secret`.
 */
const SENSITIVE_PARAM_NAME_RE =
  /^(?:code|otp|key|auth|session|sid|jwt|sig|ticket|nonce|state|[\w.-]*(?:token|signature|secret|password|passwd|apikey|api_key|api-key|credential)[\w.-]*)$/i;

/**
 * Paths whose GET may perform a one-time / state-changing action (unsubscribe,
 * confirm, activate, magic links, OAuth callbacks, logout). Never probed.
 */
const SENSITIVE_PATH_RE =
  /\/(?:reset-?password|password-?reset|magic-?link|verify(?:-?email)?|confirm(?:ation)?|activate|unsubscribe|opt-?out|invite|accept-?invite|oauth2?|sso|auth\/callback|callback|logout|log-?out|signout|sign-?out)(?=\/|$|\.|;)/i;

function hasSensitiveQuery(search: string): boolean {
  const params = new URLSearchParams(search);
  for (const name of params.keys()) {
    if (SENSITIVE_PARAM_NAME_RE.test(name)) return true;
  }
  return false;
}

function isReservedOrPrivateIpv4(a: number, b: number, c: number): boolean {
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
  return false;
}

/**
 * Wildcard-DNS hostnames such as `127.0.0.1.nip.io` or `10-0-0-1.sslip.io` resolve to
 * the embedded address, so a public-looking name can still point into the LAN.
 */
function embedsPrivateIpv4(host: string): boolean {
  const re = /(?:^|[.-])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?=[.-]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(host))) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
    if ([a, b, c, d].every((n) => n <= 255) && isReservedOrPrivateIpv4(a, b, c)) {
      return true;
    }
  }
  return false;
}

/** Public DNS names that are known to resolve to loopback. */
const LOOPBACK_DNS_SUFFIXES = ['localtest.me', 'lvh.me', 'vcap.me', 'lacolhost.com'];

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa') ||
    host.endsWith('.localhost')
  ) {
    return true;
  }

  // Single-label intranet hostname (no dot, not IPv6)
  if (!host.includes('.') && !host.includes(':')) {
    return true;
  }

  // IPv4 private / loopback / link-local / CGNAT / reserved / multicast ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    if (isReservedOrPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]))) {
      return true;
    }
  } else if (embedsPrivateIpv4(host)) {
    return true;
  }

  if (
    LOOPBACK_DNS_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    return true;
  }

  // IPv6 ULA (fc00::/7) and link-local (fe80::/10)
  if (
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  ) {
    return true;
  }

  return false;
}

const VALID_PUBLIC_HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Determines whether a bookmark URL is eligible for dead-link checking.
 * Excludes local/LAN/intranet hosts, non-http(s) protocols, credentials,
 * malformed/wildcard hostnames, and suspected sensitive URLs.
 *
 * Always emits port-free Chrome match patterns (`https://hostname/*`) because
 * Chrome host permissions match all ports on a host and reject invalid host characters.
 */
export function classifyUrlForLinkCheck(rawUrl?: string): UrlCheckEligibility {
  if (!rawUrl) {
    return {
      eligible: false,
      skipStatus: 'skipped_private',
      reason: '缺少網址',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      eligible: false,
      skipStatus: 'skipped_private',
      reason: '網址格式無效',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      eligible: false,
      skipStatus: 'skipped_private',
      reason: `略過特殊協定 (${parsed.protocol})`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      eligible: false,
      skipStatus: 'skipped_sensitive',
      reason: '網址含帳密憑證，已略過檢查',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateOrLocalHostname(hostname)) {
    return {
      eligible: false,
      skipStatus: 'skipped_private',
      reason: '本機或內網網址，已略過檢查',
    };
  }

  if (!VALID_PUBLIC_HOSTNAME_RE.test(hostname)) {
    return {
      eligible: false,
      skipStatus: 'skipped_private',
      reason: `略過非標準主機名稱 (${hostname})`,
    };
  }

  if (
    hasSensitiveQuery(parsed.search) ||
    hasSensitiveQuery(parsed.hash.replace(/^#/, '')) ||
    SENSITIVE_PATH_RE.test(parsed.pathname)
  ) {
    return {
      eligible: false,
      skipStatus: 'skipped_sensitive',
      reason: '疑似含敏感權杖或驗證連結，已略過檢查',
    };
  }

  return {
    eligible: true,
    originPattern: `${parsed.protocol}//${hostname}/*`,
  };
}

export function collectCheckableOrigins(bookmarks: BookmarkProjection[]): {
  origins: string[];
  eligibleBookmarkIds: string[];
  skippedCount: number;
} {
  const originSet = new Set<string>();
  const eligibleBookmarkIds: string[] = [];
  let skippedCount = 0;

  for (const b of bookmarks) {
    if (b.isFolder) continue;
    const c = classifyUrlForLinkCheck(b.url);
    if (c.eligible && c.originPattern) {
      originSet.add(c.originPattern);
      eligibleBookmarkIds.push(b.nodeId);
    } else {
      skippedCount++;
    }
  }

  return {
    origins: Array.from(originSet),
    eligibleBookmarkIds,
    skippedCount,
  };
}

/**
 * A link-check record is only trusted for the exact URL it probed. Records without
 * `checkedUrl` (older versions) or for a URL the user has since edited are stale.
 */
export function isLinkCheckCurrent(
  record: LinkCheckRecord | undefined,
  url: string | undefined,
): record is LinkCheckRecord {
  return Boolean(record && url && record.checkedUrl === url);
}

export function isDeadLinkCandidate(
  status?: LinkCheckStatus,
  includeUnreachable = false,
): boolean {
  if (status === 'dead_404_410') return true;
  if (includeUnreachable && status === 'dead_unreachable') return true;
  return false;
}

function mapHttpStatusToRecord(
  res: Response,
  now: number,
): LinkCheckRecord {
  // With redirect: 'manual', browser fetch returns status 0 & type 'opaqueredirect' for 3xx
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    const location = res.headers.get('location') || undefined;
    return {
      status: 'redirect',
      httpStatus: res.status || 302,
      checkedAt: now,
      redirectTo: location,
      note: location ? `重導至 ${location}` : '網站回傳重導向（3xx），不建議直接刪除',
    };
  }

  if (res.status >= 200 && res.status < 300) {
    return {
      status: 'ok',
      httpStatus: res.status,
      checkedAt: now,
      note: '網站可正常回應',
    };
  }

  if (res.status === 404 || res.status === 410) {
    return {
      status: 'dead_404_410',
      httpStatus: res.status,
      checkedAt: now,
      note:
        res.status === 410
          ? '頁面已永久移除 (410 Gone)'
          : '找不到頁面 (404 Not Found)',
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'auth_blocked',
      httpStatus: res.status,
      checkedAt: now,
      note: `需要登入或受存取限制 (${res.status})，請人工確認`,
    };
  }

  if (res.status === 429) {
    return {
      status: 'rate_limited',
      httpStatus: 429,
      checkedAt: now,
      note: '遭網站限流 (429)，稍後再試',
    };
  }

  if (res.status >= 500) {
    return {
      status: 'server_error',
      httpStatus: res.status,
      checkedAt: now,
      note: `伺服器暫時異常 (${res.status})，不建議直接刪除`,
    };
  }

  return {
    status: 'auth_blocked',
    httpStatus: res.status,
    checkedAt: now,
    note: `回傳非預期狀態碼 (${res.status})，請人工確認`,
  };
}

/**
 * Probes one public bookmark URL:
 * - HEAD first with credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual'
 * - Falls back to bounded GET (cancels body immediately after headers) when HEAD returns 400/403/405/501,
 *   and always confirms HEAD 404/410 with GET before reporting a dead link
 */
export async function probeBookmarkUrl(params: {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LinkCheckRecord> {
  const record = await probeBookmarkUrlInner(params);
  return { ...record, checkedUrl: params.url };
}

async function probeBookmarkUrlInner(params: {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LinkCheckRecord> {
  const { url, fetchImpl = fetch, timeoutMs = 8000 } = params;
  const now = Date.now();
  const eligibility = classifyUrlForLinkCheck(url);
  if (!eligibility.eligible) {
    return {
      status: eligibility.skipStatus ?? 'skipped_private',
      checkedAt: now,
      note: eligibility.reason,
    };
  }

  const runProbe = async (method: 'HEAD' | 'GET'): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      });
      // For GET fallback, immediately cancel body stream so we never download large payloads
      if (method === 'GET' && res.body) {
        try {
          await res.body.cancel();
        } catch {
          // ignore stream cancel errors
        }
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const headRes = await runProbe('HEAD');
    // Some servers reject HEAD with 400, 403, 405, or 501 — verify with bounded GET.
    // 404/410 are deletion candidates, so they are ALWAYS confirmed with a bounded GET:
    // some servers answer HEAD with 404 while GET serves the page normally.
    if (
      headRes.status === 400 ||
      headRes.status === 403 ||
      headRes.status === 404 ||
      headRes.status === 405 ||
      headRes.status === 410 ||
      headRes.status === 501
    ) {
      const getRes = await runProbe('GET');
      return mapHttpStatusToRecord(getRes, Date.now());
    }
    return mapHttpStatusToRecord(headRes, Date.now());
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        status: 'timeout',
        checkedAt: Date.now(),
        note: '連線逾時，請稍後重試或人工確認',
      };
    }
    // Retry once with GET if HEAD failed with network error on servers closing HEAD sockets
    try {
      const getRes = await runProbe('GET');
      return mapHttpStatusToRecord(getRes, Date.now());
    } catch (getErr) {
      if (getErr instanceof Error && getErr.name === 'AbortError') {
        return {
          status: 'timeout',
          checkedAt: Date.now(),
          note: '連線逾時，請稍後重試或人工確認',
        };
      }
      return {
        status: 'dead_unreachable',
        checkedAt: Date.now(),
        note: '無法連線或網域無法解析（請人工確認是否暫時離線）',
      };
    }
  }
}

export interface BatchLinkCheckResult {
  results: Record<string, LinkCheckRecord>;
  checkedCount: number;
  dead404Count: number;
  unreachableCount: number;
  skippedCount: number;
  unauthorizedCount: number;
  /**
   * True when the device looked offline (navigator.onLine === false, or every probed
   * site was unreachable). Results are then recorded as `timeout`, never as dead links.
   */
  offlineSuspected: boolean;
}

export async function runBatchLinkCheck(params: {
  bookmarks: BookmarkProjection[];
  isOriginAuthorized: (originPattern: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
  /** Defaults to `navigator.onLine` where available. */
  isOnline?: () => boolean;
}): Promise<BatchLinkCheckResult> {
  const {
    bookmarks,
    isOriginAuthorized,
    fetchImpl = fetch,
    concurrency = 5,
    timeoutMs = 8000,
    isOnline = () =>
      typeof navigator === 'undefined' || navigator.onLine !== false,
  } = params;

  const results: Record<string, LinkCheckRecord> = {};
  const queue: BookmarkProjection[] = [];
  let skippedCount = 0;
  let unauthorizedCount = 0;

  const authCache = new Map<string, boolean>();
  const checkAuth = async (originPattern: string): Promise<boolean> => {
    if (authCache.has(originPattern)) return authCache.get(originPattern)!;
    const ok = await isOriginAuthorized(originPattern);
    authCache.set(originPattern, ok);
    return ok;
  };

  for (const b of bookmarks) {
    if (b.isFolder) continue;
    const elig = classifyUrlForLinkCheck(b.url);
    if (!elig.eligible || !elig.originPattern) {
      results[b.nodeId] = {
        status: elig.skipStatus ?? 'skipped_private',
        checkedAt: Date.now(),
        note: elig.reason,
        checkedUrl: b.url,
      };
      skippedCount++;
      continue;
    }

    const authorized = await checkAuth(elig.originPattern);
    if (!authorized) {
      results[b.nodeId] = {
        status: 'not_authorized',
        checkedAt: Date.now(),
        note: `尚未授予 ${elig.originPattern} 的選用檢查權限`,
        checkedUrl: b.url,
      };
      unauthorizedCount++;
      continue;
    }

    queue.push(b);
  }

  const offlineRecord = (url: string | undefined): LinkCheckRecord => ({
    status: 'timeout',
    checkedAt: Date.now(),
    note: '裝置疑似離線或網路中斷，未判定為失效；請恢復連線後重新檢查',
    checkedUrl: url,
  });

  if (queue.length > 0 && !isOnline()) {
    for (const item of queue) results[item.nodeId] = offlineRecord(item.url);
    return {
      results,
      checkedCount: 0,
      dead404Count: 0,
      unreachableCount: 0,
      skippedCount,
      unauthorizedCount,
      offlineSuspected: true,
    };
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const idx = cursor++;
      const item = queue[idx];
      results[item.nodeId] = await probeBookmarkUrl({
        url: item.url!,
        fetchImpl,
        timeoutMs,
      });
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    () => worker(),
  );
  await Promise.all(workers);

  // Canary: when at least three different sites were probed and NONE answered, the
  // problem is almost certainly the local network, not the bookmarks.
  const probedHosts = new Set(
    queue.map((item) => {
      try {
        return new URL(item.url!).hostname;
      } catch {
        return '';
      }
    }),
  );
  const offlineSuspected =
    probedHosts.size >= 3 &&
    queue.every((item) => {
      const st = results[item.nodeId]?.status;
      return st === 'dead_unreachable' || st === 'timeout';
    });
  if (offlineSuspected) {
    for (const item of queue) results[item.nodeId] = offlineRecord(item.url);
  }

  let dead404Count = 0;
  let unreachableCount = 0;
  for (const rec of Object.values(results)) {
    if (rec.status === 'dead_404_410') dead404Count++;
    if (rec.status === 'dead_unreachable') unreachableCount++;
  }

  return {
    results,
    checkedCount: queue.length,
    dead404Count,
    unreachableCount,
    skippedCount,
    unauthorizedCount,
    offlineSuspected,
  };
}

export const ALL_SITES_ORIGINS = ['https://*/*', 'http://*/*'] as const;

/**
 * Decides which host permissions to request for a check and which broad grants to
 * revoke right after it. Up to 15 distinct origins are requested one by one (and kept,
 * revocable in Settings). Beyond that, the scheme wildcards are requested so Chrome's
 * prompt stays usable — but an all-sites grant must not outlive the check that needed it.
 */
export function planHostPermissionRequest(
  origins: string[],
  maxIndividualOrigins = 15,
): { requestOrigins: string[]; revokeAfterCheck: string[] } {
  if (origins.length <= maxIndividualOrigins) {
    return { requestOrigins: origins, revokeAfterCheck: [] };
  }
  const wildcards: string[] = [];
  if (origins.some((o) => o.startsWith('https://'))) wildcards.push(ALL_SITES_ORIGINS[0]);
  if (origins.some((o) => o.startsWith('http://'))) wildcards.push(ALL_SITES_ORIGINS[1]);
  return { requestOrigins: wildcards, revokeAfterCheck: wildcards };
}
