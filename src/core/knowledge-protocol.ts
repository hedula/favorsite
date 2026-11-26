import type { KnowledgeAnswer, KnowledgeChunk, KnowledgeSourceSummary } from './knowledge-types';
import type { SearchKnowledgeResult } from './knowledge-search';
import type { RuntimeStatus } from './runtime-status';

export interface McpConnectionSummary {
  connectionId: string;
  label: string;
  folderIds: string[];
  includeContent: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface McpSettings {
  profileKey: string;
  extensionId: string;
  connections: McpConnectionSummary[];
  host: { connected: boolean; hostName: string; error?: string };
}

export interface KnowledgeSourceDetails {
  source: KnowledgeSourceSummary;
  chunks: KnowledgeChunk[];
  nextCursor?: string;
  contentStatus: 'collected';
}

export interface KnowledgeSearchInput {
  query: string;
  folderId?: string;
  includeDescendants?: boolean;
  tags?: string[];
  mode?: 'keyword' | 'semantic';
  limit?: number;
  cursor?: string;
  requestId?: string;
}

export type KnowledgeMessage =
  | { type: 'GET_RUNTIME_STATUS' }
  | { type: 'SEARCH_KNOWLEDGE'; payload: KnowledgeSearchInput }
  | { type: 'LIST_KNOWLEDGE_SOURCES' }
  | { type: 'READ_KNOWLEDGE_SOURCE'; payload: { sourceId: string; sourceVersion?: string; cursor?: string } }
  | { type: 'DELETE_KNOWLEDGE_SOURCE'; payload: { sourceId: string } }
  | { type: 'CAPTURE_CURRENT_PAGE'; payload?: { tabId?: number } }
  | { type: 'ASK_KNOWLEDGE'; payload: { question: string; folderId?: string; requestId?: string } }
  | { type: 'CANCEL_KNOWLEDGE_REQUEST'; payload: { requestId: string } }
  | { type: 'GET_MCP_SETTINGS' }
  | { type: 'CREATE_MCP_CONNECTION'; payload: { label: string; folderIds: string[]; includeContent: boolean } }
  | { type: 'UPDATE_MCP_CONNECTION'; payload: { connectionId: string; folderIds: string[]; includeContent: boolean; enabled: boolean } }
  | { type: 'DELETE_MCP_CONNECTION'; payload: { connectionId: string } };

export interface KnowledgeResponseMap {
  GET_RUNTIME_STATUS: RuntimeStatus;
  SEARCH_KNOWLEDGE: SearchKnowledgeResult;
  LIST_KNOWLEDGE_SOURCES: { sources: KnowledgeSourceSummary[] };
  READ_KNOWLEDGE_SOURCE: KnowledgeSourceDetails;
  DELETE_KNOWLEDGE_SOURCE: { deleted: boolean };
  CAPTURE_CURRENT_PAGE: { source: KnowledgeSourceSummary; created: boolean };
  ASK_KNOWLEDGE: KnowledgeAnswer;
  CANCEL_KNOWLEDGE_REQUEST: { cancelled: boolean };
  GET_MCP_SETTINGS: McpSettings;
  CREATE_MCP_CONNECTION: { connection: McpConnectionSummary; token: string };
  UPDATE_MCP_CONNECTION: { connection: McpConnectionSummary };
  DELETE_MCP_CONNECTION: { deleted: boolean };
}

const messageTypes = new Set([
  'GET_RUNTIME_STATUS', 'SEARCH_KNOWLEDGE', 'LIST_KNOWLEDGE_SOURCES',
  'READ_KNOWLEDGE_SOURCE', 'DELETE_KNOWLEDGE_SOURCE', 'CAPTURE_CURRENT_PAGE',
  'ASK_KNOWLEDGE', 'CANCEL_KNOWLEDGE_REQUEST', 'GET_MCP_SETTINGS',
  'CREATE_MCP_CONNECTION', 'UPDATE_MCP_CONNECTION', 'DELETE_MCP_CONNECTION',
]);

export function isKnowledgeMessage(message: { type: string }): message is KnowledgeMessage {
  return messageTypes.has(message.type);
}

export function validateKnowledgeMessage(message: Record<string, unknown>): string | null {
  const payload = message.payload;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown, max = 1000): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  const optionalText = (value: unknown) => value === undefined || text(value);
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length <= 1000 && value.every((entry) => text(entry));
  const bad = '知識庫訊息內容格式無效。';
  switch (message.type) {
    case 'GET_RUNTIME_STATUS':
    case 'LIST_KNOWLEDGE_SOURCES':
    case 'GET_MCP_SETTINGS':
      return null;
    case 'CAPTURE_CURRENT_PAGE':
      return payload === undefined || (isObject(payload) &&
        (payload.tabId === undefined || Number.isInteger(payload.tabId) && Number(payload.tabId) >= 0))
        ? null : bad;
    case 'SEARCH_KNOWLEDGE':
      return isObject(payload) && typeof payload.query === 'string' && payload.query.length <= 2000 &&
        optionalText(payload.folderId) && optionalText(payload.cursor) && optionalText(payload.requestId) &&
        (payload.includeDescendants === undefined || typeof payload.includeDescendants === 'boolean') &&
        (payload.tags === undefined || strings(payload.tags)) &&
        (payload.mode === undefined || payload.mode === 'keyword' || payload.mode === 'semantic') &&
        (payload.limit === undefined || Number.isInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 20)
        ? null : bad;
    case 'READ_KNOWLEDGE_SOURCE':
      return isObject(payload) && text(payload.sourceId) &&
        optionalText(payload.sourceVersion) && optionalText(payload.cursor) ? null : bad;
    case 'DELETE_KNOWLEDGE_SOURCE':
      return isObject(payload) && text(payload.sourceId) ? null : bad;
    case 'ASK_KNOWLEDGE':
      return isObject(payload) && text(payload.question, 2000) &&
        optionalText(payload.folderId) && optionalText(payload.requestId) ? null : bad;
    case 'CANCEL_KNOWLEDGE_REQUEST':
      return isObject(payload) && text(payload.requestId) ? null : bad;
    case 'CREATE_MCP_CONNECTION':
      return isObject(payload) && text(payload.label, 80) && strings(payload.folderIds) &&
        payload.folderIds.length > 0 && typeof payload.includeContent === 'boolean' ? null : bad;
    case 'UPDATE_MCP_CONNECTION':
      return isObject(payload) && text(payload.connectionId) && strings(payload.folderIds) &&
        payload.folderIds.length > 0 && typeof payload.includeContent === 'boolean' &&
        typeof payload.enabled === 'boolean' ? null : bad;
    case 'DELETE_MCP_CONNECTION':
      return isObject(payload) && text(payload.connectionId) ? null : bad;
    default:
      return bad;
  }
}
