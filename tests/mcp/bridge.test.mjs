import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { duplexPair, PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { installNativeHost, planNativeInstallation } from '../../scripts/install-native-host.mjs';
import { createMcpManifest, packageMcp } from '../../scripts/package-mcp.mjs';
import { createBridgeClient, startMcpServer } from '../../scripts/favorsite-mcp.mjs';
import { createNativeRequestRouter } from '../../scripts/favorsite-native-host.mjs';
import { encodeNativeMessage, readNativeMessages } from '../../scripts/lib/native-framing.mjs';
import { getBridgeAddress, readJsonLines } from '../../scripts/lib/mcp-protocol.mjs';

const projectRoot = resolve(import.meta.dirname, '../..');
const profileKey = 'prof_mcp_test';
const token = 'test-token-held-in-process-memory';

function collect(input, reader) {
  const queued = [];
  const waiting = [];
  reader(input, (message) => {
    const index = waiting.findIndex((item) => item.predicate(message));
    if (index < 0) queued.push(message);
    else waiting.splice(index, 1)[0].resolve(message);
  }, (error) => {
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  });
  return {
    queued,
    next(predicate = () => true) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolveMessage, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error('Timed out waiting for a protocol message.'));
        }, 3000);
        const waiter = {
          predicate,
          resolve: (value) => { clearTimeout(timer); resolveMessage(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        };
        waiting.push(waiter);
      });
    },
  };
}

async function fixture(t, extraEnv = {}) {
  const directory = await mkdtemp('/tmp/favorsite-mcp-');
  const env = { ...process.env, FAVORSITE_BRIDGE_DIR: directory, FAVORSITE_PROFILE_KEY: profileKey, FAVORSITE_MCP_TOKEN: token, ...extraEnv };
  const children = [];
  const launch = (script, overrides = {}) => {
    const child = spawn(process.execPath, [join(projectRoot, 'scripts', script)], { env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => { child.diagnostics += data; });
    child.closed = new Promise((resolveClose) => child.once('close', resolveClose));
    children.push(child);
    return child;
  };
  t.after(async () => {
    for (const child of children) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
    await Promise.all(children.map((child) => child.closed));
    await rm(directory, { recursive: true, force: true });
  });
  const host = launch('favorsite-native-host.mjs');
  const native = collect(host.stdout, readNativeMessages);
  host.stdin.write(encodeNativeMessage({ type: 'hello', profileKey, protocolVersion: 2 }));
  const address = getBridgeAddress(profileKey, env);
  let listening = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await lstat(address).catch(() => null)) { listening = true; break; }
    if (host.exitCode !== null) break;
    await delay(10);
  }
  if (!listening && /listen EPERM/.test(host.diagnostics)) {
    t.skip('This execution environment blocks local IPC socket listeners (listen EPERM).');
    return null;
  }
  assert.ok(listening, host.diagnostics || 'Native host did not create its local socket.');
  const adapter = async (overrides = {}) => {
    const child = launch('favorsite-mcp.mjs', overrides);
    const messages = collect(child.stdout, readJsonLines);
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'favorsite-test', version: '1.0.0' } } });
    const init = await messages.next((message) => message.id === 1);
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.equal(init.result.serverInfo.name, 'favorsite');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { child, messages, send };
  };
  return { directory, env, host, native, adapter, launch, nativeIPC: true };
}

async function streamFixture(t) {
  const directory = await mkdtemp('/tmp/favorsite-stream-');
  const env = { FAVORSITE_BRIDGE_DIR: directory, FAVORSITE_PROFILE_KEY: profileKey, FAVORSITE_MCP_TOKEN: token };
  const chromeInput = new PassThrough();
  const chromeOutput = new PassThrough();
  const native = collect(chromeOutput, readNativeMessages);
  const router = createNativeRequestRouter({ sendNative: (message) => chromeOutput.write(encodeNativeMessage(message)) });
  readNativeMessages(chromeInput, (message) => router.receive(message), (error) => { throw error; });
  const servers = [];
  const sockets = [];
  chromeInput.once('finish', () => router.close());
  t.after(async () => {
    for (const server of servers) server.close();
    router.close();
    for (const socket of sockets) socket.destroy();
    chromeInput.destroy();
    chromeOutput.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  const adapter = async (overrides = {}) => {
    const bridge = createBridgeClient({
      env: { ...env, ...overrides },
      connectSocket: () => {
        const [client, localServer] = duplexPair();
        sockets.push(client, localServer);
        client.connecting = true;
        client.setTimeout = () => client;
        router.attach(localServer);
        queueMicrotask(() => { client.connecting = false; client.emit('connect'); });
        return client;
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const messages = collect(output, readJsonLines);
    const server = startMcpServer({ input, output, bridgeClient: bridge });
    servers.push(server);
    const send = (message) => input.write(JSON.stringify(message) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stream-test', version: '1.0.0' } } });
    assert.equal((await messages.next((message) => message.id === 1)).result.protocolVersion, '2025-11-25');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { messages, send, child: { diagnostics: '' } };
  };
  return { directory, env, adapter, native, nativeIPC: false, host: { stdin: chromeInput, diagnostics: '' } };
}

test('Native Messaging preserves partial UTF-8 frames and rejects oversized headers', () => {
  const input = new PassThrough();
  const messages = [];
  const errors = [];
  readNativeMessages(input, (message) => messages.push(message), (error) => errors.push(error.message));
  const frame = encodeNativeMessage({ title: '書籤知識庫', value: 42 });
  for (let index = 0; index < frame.length; index++) input.write(frame.subarray(index, index + 1));
  assert.deepEqual(messages, [{ title: '書籤知識庫', value: 42 }]);
  input.write(Buffer.from([255, 255, 255, 127]));
  assert.deepEqual(errors, ['Invalid native message size.']);
});

for (const [transport, makeFixture] of [['streams', streamFixture], ['local IPC', fixture]]) {
test(`MCP exposes three read-only tools and routes concurrent clients to the correct responses (${transport})`, { timeout: 8000 }, async (t) => {
  const context = await makeFixture(t);
  if (!context) return;
  const { host, native, adapter, directory, nativeIPC } = context;
  const first = await adapter();
  const second = await adapter();
  first.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = await first.messages.next((message) => message.id === 2);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['list_folders', 'search_bookmarks', 'read_source']);
  assert.ok(listed.result.tools.every((tool) => tool.annotations.readOnlyHint));
  first.send({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'search_bookmarks', arguments: { query: '第一個' } } });
  second.send({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'search_bookmarks', arguments: { query: '第二個' } } });
  const a = await native.next((message) => message.args?.query === '第一個');
  const b = await native.next((message) => message.args?.query === '第二個');
  assert.notEqual(a.requestId, b.requestId);
  assert.equal(a.token, token);
  host.stdin.write(encodeNativeMessage({ type: 'mcp_response', requestId: b.requestId, result: { results: [{ title: '第二個結果' }] } }));
  host.stdin.write(encodeNativeMessage({ type: 'mcp_response', requestId: a.requestId, result: { results: [{ title: '第一個結果' }] } }));
  assert.equal((await first.messages.next((message) => message.id === 17)).result.structuredContent.results[0].title, '第一個結果');
  assert.equal((await second.messages.next((message) => message.id === 17)).result.structuredContent.results[0].title, '第二個結果');
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  if (nativeIPC) assert.equal((await lstat(getBridgeAddress(profileKey, { FAVORSITE_BRIDGE_DIR: directory }))).mode & 0o777, 0o600);
  assert.equal(first.child.diagnostics + second.child.diagnostics + host.diagnostics, '');
});

test(`cancelling one query keeps another client query live and never forwards a cancelled result (${transport})`, { timeout: 8000 }, async (t) => {
  const context = await makeFixture(t);
  if (!context) return;
  const { host, native, adapter } = context;
  const client = await adapter();
  client.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_folders', arguments: {} } });
  client.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'read_source', arguments: { sourceId: 'source-kept' } } });
  const first = await native.next((message) => message.toolName === 'list_folders');
  const second = await native.next((message) => message.toolName === 'read_source');
  client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10 } });
  const cancelled = await native.next((message) => message.type === 'mcp_cancel');
  assert.equal(cancelled.requestId, first.requestId);
  host.stdin.write(encodeNativeMessage({ type: 'mcp_response', requestId: second.requestId, result: { source: { sourceId: 'source-kept' } } }));
  host.stdin.write(encodeNativeMessage({ type: 'mcp_response', requestId: first.requestId, result: { folders: [] } }));
  assert.equal((await client.messages.next((message) => message.id === 11)).result.structuredContent.source.sourceId, 'source-kept');
  await delay(50);
  assert.ok(!client.messages.queued.some((message) => message.id === 10));
});

test(`tool argument errors stay local, extension authorization errors stay structured, disconnect is recoverable (${transport})`, { timeout: 8000 }, async (t) => {
  const context = await makeFixture(t);
  if (!context) return;
  const { host, native, adapter } = context;
  const client = await adapter({ FAVORSITE_MCP_TOKEN: 'revoked-token' });
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_bookmarks', arguments: { query: 'R2', limit: 21 } } });
  assert.equal((await client.messages.next((message) => message.id === 2)).error.code, -32602);
  client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_folders', arguments: {} } });
  const request = await native.next((message) => message.toolName === 'list_folders');
  assert.equal(request.token, 'revoked-token');
  host.stdin.write(encodeNativeMessage({ type: 'mcp_response', requestId: request.requestId, error: { code: 'NOT_AUTHORIZED', message: 'Connection revoked.' } }));
  const denied = await client.messages.next((message) => message.id === 3);
  assert.equal(denied.result.isError, true);
  assert.deepEqual(JSON.parse(denied.result.content[0].text), { code: 'NOT_AUTHORIZED', message: 'Connection revoked.' });
  client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_folders', arguments: {} } });
  await native.next((message) => message.toolName === 'list_folders');
  host.stdin.end();
  const disconnected = await client.messages.next((message) => message.id === 4);
  assert.equal(JSON.parse(disconnected.result.content[0].text).code, 'SOURCE_UNAVAILABLE');
});
}

test('installer dry run is read-only and isolated install/uninstall keeps exact extension registration', async (t) => {
  const directory = await mkdtemp('/tmp/favorsite-install-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installDirectory = join(directory, 'native host');
  const manifestDirectory = join(directory, 'manifests');
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const options = ['--extension-id', extensionId, '--install-dir', installDirectory, '--manifest-dir', manifestDirectory, '--bridge-dir', join(directory, 'bridge')];
  const planned = await installNativeHost([...options, '--dry-run']);
  assert.equal(planned.dryRun, true);
  assert.equal(await lstat(manifestDirectory).catch(() => null), null);
  const installed = await installNativeHost(options);
  const manifest = JSON.parse(await readFile(installed.manifestPath, 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal(manifest.name, 'com.favorsite.knowledge');
  assert.match(await readFile(manifest.path, 'utf8'), /exec .*node.*favorsite-native-host/);
  assert.equal((await lstat(manifest.path)).mode & 0o777, 0o700);
  await installNativeHost([...options, '--uninstall']);
  assert.equal(await lstat(installed.manifestPath).catch(() => null), null);
  const windows = planNativeInstallation({ 'extension-id': extensionId }, { platform: 'win32', home: directory, env: {} });
  assert.equal(windows.registry.command, 'reg.exe');
  assert.ok(windows.registry.args.includes('HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\com.favorsite.knowledge'));
});

test('MCP bundle is a valid ZIP with a sensitive token config and every runtime dependency', async (t) => {
  const directory = await mkdtemp('/tmp/favorsite-package-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await packageMcp(join(directory, 'knowledge.mcpb'));
  const data = await readFile(result.file);
  const files = new Map();
  let offset = 0;
  while (data.readUInt32LE(offset) === 0x04034b50) {
    const size = data.readUInt32LE(offset + 18);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const name = data.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    files.set(name, inflateRawSync(data.subarray(start, start + size)).toString('utf8'));
    offset = start + size;
  }
  assert.equal(data.readUInt32LE(offset), 0x02014b50);
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.deepEqual(manifest, createMcpManifest());
  assert.equal(manifest.user_config.token.sensitive, true);
  assert.ok(files.has(manifest.server.entry_point));
  assert.ok(files.has('scripts/favorsite-native-host.mjs'));
  assert.ok(files.has('scripts/lib/mcp-protocol.mjs'));
  assert.ok(files.has('scripts/lib/native-framing.mjs'));
  assert.equal(result.files, 7);
});
