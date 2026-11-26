import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const NATIVE_HOST_NAME = 'com.favorsite.knowledge';
export const BRIDGE_PROTOCOL_VERSION = 2;
export const MCP_SERVER_VERSION = '0.2.0';
export const MAX_MESSAGE_BYTES = 1024 * 1024 - 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function getBridgeDirectory(env = process.env) {
  return resolve(env.FAVORSITE_BRIDGE_DIR || join(homedir(), '.favorsite', 'bridge'));
}

export function validateProfileKey(profileKey) {
  if (typeof profileKey !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(profileKey)) {
    throw new Error('FAVORSITE_PROFILE_KEY must be the profile key shown in Favorsite settings.');
  }
  return profileKey;
}

export function getBridgeAddress(profileKey, env = process.env, platform = process.platform) {
  validateProfileKey(profileKey);
  const directory = getBridgeDirectory(env);
  const profileHash = createHash('sha256').update(profileKey).digest('hex').slice(0, 24);
  if (platform === 'win32') {
    const directoryHash = createHash('sha256').update(directory).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\favorsite-${directoryHash}-${profileHash}`;
  }
  const address = join(directory, `${profileHash}.sock`);
  if (Buffer.byteLength(address) > 103) {
    throw new Error('FAVORSITE_BRIDGE_DIR is too long for a local socket. Choose a shorter private directory.');
  }
  return address;
}

export function getRequestTimeout(env = process.env) {
  const value = Number(env.FAVORSITE_MCP_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS);
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new Error('FAVORSITE_MCP_TIMEOUT_MS must be between 100 and 300000.');
  }
  return value;
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function writeJsonLine(output, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('Bridge message exceeds the size limit.');
  output.write(text + '\n');
}

/** Decode complete UTF-8 JSON lines while retaining partial bytes between reads. */
export function readJsonLines(input, onMessage, onError) {
  let buffer = Buffer.alloc(0);
  const receive = (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline = buffer.indexOf(10);
    while (newline >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > MAX_MESSAGE_BYTES) {
        onError(new Error('Bridge message exceeds the size limit.'));
        return;
      }
      if (line.toString('utf8').trim()) {
        try {
          onMessage(JSON.parse(line.toString('utf8')));
        } catch {
          onError(new Error('Invalid JSON message.'));
        }
      }
      newline = buffer.indexOf(10);
    }
    if (buffer.length > MAX_MESSAGE_BYTES) {
      buffer = Buffer.alloc(0);
      onError(new Error('Bridge message exceeds the size limit.'));
    }
  };
  input.on('data', receive);
  return () => input.removeListener('data', receive);
}

const textId = { type: 'string', minLength: 1, maxLength: 512 };
const cursor = { type: 'string', minLength: 1, maxLength: 4096 };
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const MCP_TOOLS = [
  {
    name: 'list_folders',
    title: 'List authorized bookmark folders',
    description: 'List the Favorsite bookmark folders this connection can read. Use folder IDs to narrow searches.',
    inputSchema: {
      type: 'object', properties: { parentId: textId, cursor }, additionalProperties: false,
    },
    annotations: readonly,
  },
  {
    name: 'search_bookmarks',
    title: 'Search saved bookmarks',
    description: 'Search authorized Favorsite bookmarks using a question or keywords. Returns original URLs and available source excerpts. Searches stay within the connection’s granted folders.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000 },
        folderId: textId,
        includeDescendants: { type: 'boolean', default: true },
        tags: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 200 } },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        cursor,
        mode: { type: 'string', enum: ['keyword', 'semantic'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: readonly,
  },
  {
    name: 'read_source',
    title: 'Read a saved source',
    description: 'Read a source returned by search_bookmarks. Collected articles include bounded text chunks, source versions, original URLs and capture times for citations. Uncollected bookmarks return their metadata and content status.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: textId,
        sourceVersion: textId,
        chunkIds: { type: 'array', maxItems: 20, items: textId },
        cursor,
      },
      required: ['sourceId'],
      additionalProperties: false,
    },
    annotations: readonly,
  },
];

export function validateToolArguments(toolName, args) {
  const tool = MCP_TOOLS.find((item) => item.name === toolName);
  if (!tool) return 'Unknown Favorsite tool.';
  if (!isObject(args)) return 'Tool arguments must be an object.';
  const { properties, required = [] } = tool.inputSchema;
  for (const field of required) {
    if (!(field in args)) return `Missing required argument: ${field}.`;
  }
  for (const [field, value] of Object.entries(args)) {
    const rule = properties[field];
    if (!rule) return `Unknown argument: ${field}.`;
    if (rule.type === 'string' && (
      typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > rule.maxLength ||
      (rule.enum && !rule.enum.includes(value))
    )) return `Invalid argument: ${field}.`;
    if (rule.type === 'boolean' && typeof value !== 'boolean') return `Invalid argument: ${field}.`;
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) {
      return `Invalid argument: ${field}.`;
    }
    if (rule.type === 'array' && (!Array.isArray(value) || value.length > rule.maxItems || value.some((item) => (
      typeof item !== 'string' || item.length < (rule.items.minLength ?? 0) || item.length > rule.items.maxLength
    )))) return `Invalid argument: ${field}.`;
  }
  return null;
}
