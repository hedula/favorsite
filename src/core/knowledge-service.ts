import { buildProjections, createChromeBookmarkAdapter } from './bookmark-engine';
import { extractPageContent } from './content-extractor';
import { answerKnowledgeQuestion } from './knowledge-answer';
import type { KnowledgeMessage, KnowledgeSearchInput, McpConnectionSummary } from './knowledge-protocol';
import { allowedKnowledgeBookmarks, KNOWLEDGE_MODEL_VERSION, searchKnowledge } from './knowledge-search';
import {
  defaultKnowledgeStore, sourceIdForUrl, summarizeKnowledgeSource, toKnowledgeExcerpt,
} from './knowledge-store';
import type { KnowledgeAnswer, KnowledgeSource, KnowledgeSourceSummary } from './knowledge-types';
import { classifyUrlForLinkCheck } from './link-checker';
import { mcpAccess } from './mcp-access';
import { ensureNativeBridge, nativeBridgeStatus } from './native-bridge';
import { answerFromExcerpts, embedKnowledgeTexts } from './offscreen-client';
import { probeRuntimeStatus } from './runtime-status';
import { defaultStore } from './store';
import type { BookmarkProjection } from './types';

const active = new Map<string, AbortController>();

async function readState() {
  const profileKey = await defaultStore.getOrCreateProfileKey();
  const [tree, metadata, sources] = await Promise.all([
    createChromeBookmarkAdapter().getTree(),
    defaultStore.getAllMetadata(profileKey),
    defaultKnowledgeStore.listSources(profileKey),
  ]);
  return { profileKey, projections: buildProjections(tree, profileKey).projections, metadata, sources };
}

async function notifyKnowledgeChange(): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'KNOWLEDGE_CHANGED' }).catch(() => {});
}

function validateFolders(projections: BookmarkProjection[], ids: string[]): void {
  const folders = new Set(projections.filter((node) => node.isFolder).map((node) => node.nodeId));
  if (!ids.length || ids.some((id) => !folders.has(id))) throw new Error('請選擇目前設定檔中的資料夾。');
}

async function tracked<T>(requestId: string | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const id = requestId ?? crypto.randomUUID();
  if (active.has(id)) throw new Error('同一個知識檢索請求仍在處理中。');
  const controller = new AbortController();
  active.set(id, controller);
  try {
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    active.delete(id);
  }
}

async function searchState(
  state: Awaited<ReturnType<typeof readState>>,
  input: KnowledgeSearchInput,
  signal?: AbortSignal,
  grant?: McpConnectionSummary,
) {
  const projections = [...state.projections];
  if (!grant && !input.folderId) {
    const urls = new Set(projections.map((node) => node.url));
    // Explicitly captured pages remain searchable locally after their last bookmark is removed.
    for (const source of state.sources) {
      if (urls.has(source.url)) continue;
      projections.push({
        profileKey: state.profileKey, nodeId: source.sourceId, parentId: 'captured', index: 0,
        title: source.title, url: source.url, domain: new URL(source.url).hostname,
        isFolder: false, isSystemFolder: false, writable: false, canAddChild: false,
        path: '已收錄', childCount: 0,
      });
    }
  }
  return searchKnowledge({
    ...input, profileKey: state.profileKey, projections, metadata: state.metadata,
    sources: state.sources, grant, signal, embed: embedKnowledgeTexts,
    getCachedEmbedding: (key) =>
      defaultKnowledgeStore.getEmbedding(state.profileKey, key, KNOWLEDGE_MODEL_VERSION, key),
    setCachedEmbedding: (key, vector, sourceId, sourceVersion) => defaultKnowledgeStore.putEmbedding({
      profileKey: state.profileKey, documentId: key, modelVersion: KNOWLEDGE_MODEL_VERSION,
      contentHash: key, vector, sourceId, sourceVersion, updatedAt: Date.now(),
    }),
    onProgress: input.requestId ? (progress) => {
      void chrome.runtime.sendMessage({
        type: 'KNOWLEDGE_PROGRESS', requestId: input.requestId, ...progress,
      }).catch(() => {});
    } : undefined,
  });
}

function sourceSummary(source: KnowledgeSource, projections: BookmarkProjection[]): KnowledgeSourceSummary {
  return {
    ...summarizeKnowledgeSource(source),
    ...{ bookmarkIds: projections.filter((node) => node.url === source.url).map((node) => node.nodeId) },
  };
}

function pageSource(source: KnowledgeSource, sourceVersion?: string, cursor?: string, chunkIds?: string[]) {
  if (sourceVersion && sourceVersion !== source.sourceVersion) {
    throw new Error('SOURCE_VERSION_CHANGED: 來源已更新，請重新搜尋取得目前版本。');
  }
  let offset = 0;
  if (cursor) {
    try {
      const parsed = JSON.parse(atob(cursor)) as { sourceId: string; version: string; offset: number };
      if (parsed.sourceId !== source.sourceId || parsed.version !== source.sourceVersion ||
        !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error();
      offset = parsed.offset;
    } catch {
      throw new Error('INVALID_CURSOR: 來源分頁已失效，請重新讀取。');
    }
  }
  const candidates = chunkIds?.length
    ? source.chunks.filter((chunk) => chunkIds.includes(chunk.chunkId))
    : source.chunks;
  if (chunkIds?.some((id) => !source.chunks.some((chunk) => chunk.chunkId === id))) {
    throw new Error('SOURCE_VERSION_CHANGED: 引用段落已更新，請重新搜尋。');
  }
  const chunks = [];
  let characters = 0;
  for (const chunk of candidates.slice(offset)) {
    if (characters + chunk.text.length > 8000) break;
    chunks.push(chunk);
    characters += chunk.text.length;
  }
  const nextOffset = offset + chunks.length;
  return {
    contentStatus: 'collected' as const, source: summarizeKnowledgeSource(source), chunks,
    nextCursor: nextOffset < candidates.length ? btoa(JSON.stringify({
      sourceId: source.sourceId, version: source.sourceVersion, offset: nextOffset,
    })) : undefined,
  };
}

async function captureCurrentPage(tabId?: number) {
  const tab = tabId === undefined
    ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
    : await chrome.tabs.get(tabId);
  if (!tab?.id || !classifyUrlForLinkCheck(tab.url).eligible) {
    throw new Error('請先開啟可收錄的公開文章或文件，再按「收錄本文」。');
  }
  const originalUrl = tab.url!;
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, func: extractPageContent,
  });
  const currentTab = await chrome.tabs.get(tab.id);
  if (!result || currentTab.url !== originalUrl || result.url !== originalUrl) {
    throw new Error('頁面已切換，請在目前頁面重新收錄。');
  }
  const state = await readState();
  const previous = await defaultKnowledgeStore.findSourceByUrl(state.profileKey, result.url);
  const source = await defaultKnowledgeStore.captureSource({ profileKey: state.profileKey, page: result });
  await notifyKnowledgeChange();
  return { source: sourceSummary(source, state.projections), created: !previous };
}

export async function handleKnowledgeMessage(message: KnowledgeMessage): Promise<unknown> {
  switch (message.type) {
    case 'GET_RUNTIME_STATUS':
      return probeRuntimeStatus();
    case 'CAPTURE_CURRENT_PAGE':
      return captureCurrentPage(message.payload?.tabId);
    case 'SEARCH_KNOWLEDGE':
      return tracked(message.payload.requestId, async (signal) =>
        searchState(await readState(), message.payload, signal));
    case 'CANCEL_KNOWLEDGE_REQUEST': {
      const controller = active.get(message.payload.requestId);
      controller?.abort(new Error('已停止知識檢索。'));
      return { cancelled: Boolean(controller) };
    }
    case 'LIST_KNOWLEDGE_SOURCES': {
      const state = await readState();
      return { sources: state.sources.map((source) => sourceSummary(source, state.projections)) };
    }
    case 'READ_KNOWLEDGE_SOURCE': {
      const profileKey = await defaultStore.getOrCreateProfileKey();
      const source = await defaultKnowledgeStore.getSource(profileKey, message.payload.sourceId);
      if (!source) throw new Error('NOT_FOUND: 找不到已收錄的來源。');
      return pageSource(source, message.payload.sourceVersion, message.payload.cursor);
    }
    case 'DELETE_KNOWLEDGE_SOURCE': {
      const profileKey = await defaultStore.getOrCreateProfileKey();
      const found = await defaultKnowledgeStore.getSource(profileKey, message.payload.sourceId);
      await defaultKnowledgeStore.deleteSource(profileKey, message.payload.sourceId);
      await notifyKnowledgeChange();
      return { deleted: Boolean(found) };
    }
    case 'ASK_KNOWLEDGE':
      return tracked(message.payload.requestId, async (signal) => {
        const state = await readState();
        const result = await searchState(state, {
          query: message.payload.question, folderId: message.payload.folderId,
          mode: 'semantic', limit: 8, requestId: message.payload.requestId,
        }, signal);
        const byId = new Map(state.sources.map((source) => [source.sourceId, source]));
        const excerpts = result.results.flatMap((hit) => {
          const source = byId.get(hit.sourceId);
          if (!source) return [];
          const first = source.chunks.find((chunk) => chunk.chunkId === hit.chunkId);
          const candidates = first ? [first, ...source.chunks.filter((chunk) => chunk !== first)] : source.chunks;
          return candidates.slice(0, 2).map((chunk) => toKnowledgeExcerpt(source, chunk));
        }).slice(0, 10);
        let answer: KnowledgeAnswer;
        try {
          answer = await answerFromExcerpts(message.payload.question, excerpts, signal);
        } catch (error) {
          signal.throwIfAborted();
          answer = await answerKnowledgeQuestion({
            question: message.payload.question, excerpts, lmGlobal: undefined, signal,
          });
          answer.warnings.push(error instanceof Error ? error.message : String(error));
        }
        const latest = await readState();
        const versions = new Map(latest.sources.map((source) => [source.sourceId, source.sourceVersion]));
        if (answer.citations.some((citation) => versions.get(citation.sourceId) !== citation.sourceVersion)) {
          throw new Error('SOURCE_VERSION_CHANGED: 回答期間來源已變更，請重新提問。');
        }
        if (message.payload.folderId) {
          const urls = new Set(allowedKnowledgeBookmarks({
            ...latest, folderId: message.payload.folderId,
          }).map((node) => node.url));
          if (answer.citations.some((citation) => !urls.has(citation.url))) {
            throw new Error('SCOPE_CHANGED: 回答期間來源已移出資料夾，請重新提問。');
          }
        }
        signal.throwIfAborted();
        return answer;
      });
    case 'GET_MCP_SETTINGS': {
      const profileKey = await defaultStore.getOrCreateProfileKey();
      await ensureNativeBridge();
      return {
        profileKey, extensionId: chrome.runtime.id,
        connections: await mcpAccess.listConnections(profileKey), host: nativeBridgeStatus(),
      };
    }
    case 'CREATE_MCP_CONNECTION': {
      const state = await readState();
      validateFolders(state.projections, message.payload.folderIds);
      const result = await mcpAccess.createConnection(state.profileKey, message.payload);
      await ensureNativeBridge();
      return result;
    }
    case 'UPDATE_MCP_CONNECTION': {
      const state = await readState();
      validateFolders(state.projections, message.payload.folderIds);
      const connection = await mcpAccess.updateConnection(state.profileKey, message.payload);
      await ensureNativeBridge();
      return { connection };
    }
    case 'DELETE_MCP_CONNECTION': {
      const profileKey = await defaultStore.getOrCreateProfileKey();
      const deleted = await mcpAccess.deleteConnection(profileKey, message.payload.connectionId);
      await ensureNativeBridge();
      return { deleted };
    }
  }
}

function folderResults(projections: BookmarkProjection[], grant: McpConnectionSummary, parentId?: string) {
  const byId = new Map(projections.map((node) => [node.nodeId, node]));
  const roots = new Set(grant.folderIds);
  const visible = (node: BookmarkProjection) => {
    const visited = new Set<string>();
    let id = node.nodeId;
    while (id && !visited.has(id)) {
      if (roots.has(id)) return true;
      visited.add(id);
      id = byId.get(id)?.parentId ?? '';
    }
    return false;
  };
  if (parentId && (!byId.get(parentId)?.isFolder || !visible(byId.get(parentId)!))) {
    throw new Error('UNAUTHORIZED: 此資料夾不在授權範圍。');
  }
  return projections.filter((node) => node.isFolder && visible(node) &&
    (parentId ? node.parentId === parentId : roots.has(node.nodeId))).map((node) => ({
      folderId: node.nodeId, title: node.title,
      parentId: roots.has(node.nodeId) ? undefined : node.parentId,
    }));
}

/** The Chrome data layer rechecks grants before returning any desktop-tool response. */
export async function executeMcpKnowledgeTool(request: {
  profileKey: string; token: string; toolName: string; args: unknown; signal: AbortSignal;
}): Promise<unknown> {
  const state = await readState();
  if (state.profileKey !== request.profileKey) throw new Error('UNAUTHORIZED: Chrome 設定檔已變更。');
  const grant = await mcpAccess.authorize(state.profileKey, request.token);
  const args = request.args ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_INPUT: 工具參數格式無效。');
  const input = args as Record<string, unknown>;
  let result: unknown;
  if (request.toolName === 'search_bookmarks') {
    if (typeof input.query !== 'string') throw new Error('INVALID_INPUT: 請提供搜尋文字。');
    const query = input.query;
    if (query.length > 2000 || (input.folderId !== undefined && typeof input.folderId !== 'string') ||
      (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 200 ||
        input.tags.some((tag) => typeof tag !== 'string' || tag.length > 200))) ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 20)) ||
      (input.cursor !== undefined && typeof input.cursor !== 'string') ||
      (input.mode !== undefined && input.mode !== 'keyword' && input.mode !== 'semantic') ||
      (input.includeDescendants !== undefined && typeof input.includeDescendants !== 'boolean')) {
      throw new Error('INVALID_INPUT: 搜尋條件無效。');
    }
    result = await searchState(state, {
      query, folderId: input.folderId as string | undefined, tags: input.tags as string[] | undefined,
      limit: input.limit as number | undefined, cursor: input.cursor as string | undefined,
      includeDescendants: input.includeDescendants as boolean | undefined,
      mode: (input.mode ?? 'semantic') as 'keyword' | 'semantic',
    }, request.signal, grant);
  } else if (request.toolName === 'list_folders') {
    if (input.parentId !== undefined && typeof input.parentId !== 'string') throw new Error('INVALID_INPUT: 資料夾條件無效。');
    const folders = folderResults(state.projections, grant, input.parentId as string | undefined);
    let offset = 0;
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string' || !/^\d{1,7}$/.test(input.cursor)) throw new Error('INVALID_CURSOR: 資料夾分頁無效。');
      offset = Number(input.cursor);
    }
    result = {
      folders: folders.slice(offset, offset + 100),
      nextCursor: offset + 100 < folders.length ? String(offset + 100) : undefined,
    };
  } else if (request.toolName === 'read_source') {
    if (typeof input.sourceId !== 'string' || input.sourceId.length > 1000 ||
      (input.sourceVersion !== undefined && typeof input.sourceVersion !== 'string') ||
      (input.cursor !== undefined && typeof input.cursor !== 'string') ||
      (input.chunkIds !== undefined && (!Array.isArray(input.chunkIds) || input.chunkIds.length > 100 ||
        input.chunkIds.some((id) => typeof id !== 'string')))) {
      throw new Error('INVALID_INPUT: 來源條件無效。');
    }
    const allowed = allowedKnowledgeBookmarks({ ...state, grant });
    const identified = await Promise.all(allowed.map(async (bookmark) => ({
      bookmark, sourceId: await sourceIdForUrl(state.profileKey, bookmark.url!),
    })));
    const match = identified.find((entry) => entry.sourceId === input.sourceId);
    if (!match) throw new Error('UNAUTHORIZED: 此來源不在授權範圍。');
    const source = state.sources.find((entry) => entry.sourceId === input.sourceId);
    if (source && grant.includeContent) {
      result = pageSource(source, input.sourceVersion as string | undefined,
        input.cursor as string | undefined, input.chunkIds as string[] | undefined);
    } else {
      result = {
        contentStatus: source ? 'not_authorized' : 'not_collected',
        source: { sourceId: match.sourceId, title: match.bookmark.title, url: match.bookmark.url },
        chunks: [],
      };
    }
  } else {
    throw new Error('UNKNOWN_TOOL: 找不到這個知識庫工具。');
  }
  request.signal.throwIfAborted();
  const current = await mcpAccess.authorize(state.profileKey, request.token);
  if (JSON.stringify(current) !== JSON.stringify(grant)) throw new Error('SCOPE_CHANGED: 授權範圍已變更，請重新查詢。');
  const latestTree = buildProjections(await createChromeBookmarkAdapter().getTree(), state.profileKey).projections;
  if (request.toolName === 'search_bookmarks') {
    const search = result as Awaited<ReturnType<typeof searchState>>;
    const allowed = new Map(allowedKnowledgeBookmarks({
      profileKey: state.profileKey, projections: latestTree, grant,
    }).map((node) => [node.nodeId, node]));
    const latestSources = new Map((await defaultKnowledgeStore.listSources(state.profileKey))
      .map((source) => [source.sourceId, source.sourceVersion]));
    search.results = search.results.filter((hit) =>
      allowed.get(hit.bookmarkId)?.url === hit.url &&
      (!hit.sourceVersion || latestSources.get(hit.sourceId) === hit.sourceVersion));
  } else if (request.toolName === 'read_source') {
    const allowed = allowedKnowledgeBookmarks({ profileKey: state.profileKey, projections: latestTree, grant });
    const ids = await Promise.all(allowed.map((node) => sourceIdForUrl(state.profileKey, node.url!)));
    if (!ids.includes(input.sourceId as string)) throw new Error('UNAUTHORIZED: 來源已移出授權範圍。');
    const returned = result as { contentStatus: string; source: { sourceVersion?: string } };
    if (returned.contentStatus === 'collected') {
      const latestSource = await defaultKnowledgeStore.getSource(state.profileKey, input.sourceId as string);
      if (latestSource?.sourceVersion !== returned.source.sourceVersion) {
        throw new Error('SOURCE_VERSION_CHANGED: 收錄來源已變更，請重新讀取。');
      }
    }
  } else {
    const listed = result as { folders: Array<{ folderId: string }> };
    const ids = new Set(folderResults(latestTree, grant, input.parentId as string | undefined).map((node) => node.folderId));
    listed.folders = listed.folders.filter((node) => ids.has(node.folderId));
  }
  const finalGrant = await mcpAccess.authorize(state.profileKey, request.token);
  if (JSON.stringify(finalGrant) !== JSON.stringify(grant)) {
    throw new Error('SCOPE_CHANGED: 授權範圍已變更，請重新查詢。');
  }
  request.signal.throwIfAborted();
  return result;
}
