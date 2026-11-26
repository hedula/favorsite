#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BRIDGE_PROTOCOL_VERSION,
  getBridgeAddress,
  getBridgeDirectory,
  getRequestTimeout,
  isObject,
  readJsonLines,
  validateProfileKey,
  validateToolArguments,
  writeJsonLine,
} from './lib/mcp-protocol.mjs';
import { encodeNativeMessage, readNativeMessages } from './lib/native-framing.mjs';

async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Bridge directory must be a private directory.');
  if (process.platform !== 'win32' && info.uid !== process.getuid()) {
    throw new Error('Bridge directory must belong to the current user.');
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

async function removeStaleSocket(address) {
  if (process.platform === 'win32') return;
  const info = await lstat(address).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (!info.isSocket() || info.uid !== process.getuid()) throw new Error('Bridge address is already occupied.');
  const alive = await new Promise((resolveAlive) => {
    const probe = createConnection(address);
    probe.once('connect', () => { probe.destroy(); resolveAlive(true); });
    probe.once('error', () => resolveAlive(false));
    probe.setTimeout(500, () => { probe.destroy(); resolveAlive(true); });
  });
  if (alive) throw new Error('A Favorsite bridge is already connected for this profile.');
  await unlink(address).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

/** Routes independent desktop streams through one Chrome Native Messaging connection. */
export function createNativeRequestRouter({ sendNative, requestTimeout = 120_000 }) {
  let counter = 0;
  const clients = new Map();
  const requests = new Map();
  const instanceId = randomUUID();
  const clientWrite = (client, value) => {
    if (!client.destroyed) {
      try { writeJsonLine(client, value); } catch { client.destroy(); }
    }
  };
  const finish = (requestId, response) => {
    const request = requests.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    requests.delete(requestId);
    clients.get(request.client)?.delete(request.originalId);
    clientWrite(request.client, { type: 'mcp_response', requestId: request.originalId, ...response });
  };
  const cancel = (requestId) => {
    const request = requests.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    requests.delete(requestId);
    clients.get(request.client)?.delete(request.originalId);
    sendNative({ type: 'mcp_cancel', requestId });
  };

  const receiveClient = (client, message) => {
    if (!isObject(message) || typeof message.requestId !== 'string' || message.requestId.length > 200) {
      client.destroy();
      return;
    }
    const clientRequests = clients.get(client);
    if (message.type === 'mcp_cancel') {
      const mapped = clientRequests?.get(message.requestId);
      if (mapped) cancel(mapped);
      return;
    }
    const invalid = validateToolArguments(message.toolName, message.args);
    if (message.type !== 'mcp_request' || typeof message.token !== 'string' || !message.token || message.token.length > 4096 || invalid) {
      clientWrite(client, {
        type: 'mcp_response', requestId: message.requestId,
        error: { code: 'INVALID_ARGUMENT', message: invalid || 'Invalid bridge request.' },
      });
      return;
    }
    if (clientRequests.has(message.requestId)) {
      clientWrite(client, {
        type: 'mcp_response', requestId: message.requestId,
        error: { code: 'INVALID_ARGUMENT', message: 'Request ID is already active.' },
      });
      return;
    }
    if (requests.size >= 100 || clientRequests.size >= 20) {
      clientWrite(client, {
        type: 'mcp_response', requestId: message.requestId,
        error: { code: 'BUSY', message: 'Too many active Favorsite queries. Retry after another query completes.' },
      });
      return;
    }
    const requestId = `${instanceId}-${++counter}`;
    const timer = setTimeout(() => {
      sendNative({ type: 'mcp_cancel', requestId });
      finish(requestId, { error: { code: 'TIMEOUT', message: 'Favorsite query timed out. Retry or narrow the folder scope.' } });
    }, requestTimeout);
    requests.set(requestId, { client, originalId: message.requestId, timer });
    clientRequests.set(message.requestId, requestId);
    sendNative({ ...message, requestId });
  };

  return {
    attach(client) {
      clients.set(client, new Map());
      readJsonLines(client, (message) => receiveClient(client, message), () => client.destroy());
      client.on('error', () => client.destroy());
      client.once('close', () => {
        for (const requestId of clients.get(client)?.values() ?? []) cancel(requestId);
        clients.delete(client);
      });
    },
    receive(message) {
      if (!isObject(message) || message.type !== 'mcp_response' || typeof message.requestId !== 'string') return;
      if (message.error) {
        const valid = isObject(message.error) && typeof message.error.code === 'string' && typeof message.error.message === 'string';
        finish(message.requestId, { error: valid ? message.error : { code: 'INVALID_RESPONSE', message: 'Invalid extension response.' } });
      } else {
        finish(message.requestId, { result: message.result });
      }
    },
    close() {
      for (const requestId of [...requests.keys()]) {
        finish(requestId, { error: { code: 'SOURCE_UNAVAILABLE', message: 'Chrome disconnected. Reopen Chrome and retry.' } });
      }
      for (const client of clients.keys()) client.end();
      clients.clear();
    },
  };
}

export function startNativeHost({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  env = process.env,
} = {}) {
  let server;
  let address;
  let profileKey;
  let closed = false;
  let starting = false;
  let socketIdentity;
  let removeNativeReader = () => {};
  const router = createNativeRequestRouter({
    requestTimeout: getRequestTimeout(env),
    sendNative: (value) => {
      if (!closed && !output.destroyed) output.write(encodeNativeMessage(value));
    },
  });
  const close = async () => {
    if (closed) return;
    router.close();
    closed = true;
    clearTimeout(helloTimer);
    removeNativeReader();
    input.pause();
    input.unref?.();
    if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
    if (socketIdentity && process.platform !== 'win32') {
      const current = await lstat(address).catch(() => null);
      if (current?.ino === socketIdentity.ino) await unlink(address);
    }
  };
  const fail = (error) => {
    if (closed) return;
    errorOutput.write(`Favorsite bridge: ${error.message}\n`);
    void close();
  };

  const listen = async (hello) => {
    if (closed || starting || profileKey) throw new Error('The native bridge has already been initialized.');
    if (hello.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new Error('Update the Favorsite extension and bridge to matching versions.');
    starting = true;
    profileKey = validateProfileKey(hello.profileKey);
    address = getBridgeAddress(profileKey, env);
    await prepareDirectory(getBridgeDirectory(env));
    await removeStaleSocket(address);
    if (closed) return;
    server = createServer((client) => router.attach(client));
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen({ path: address, readableAll: false, writableAll: false }, () => {
        server.removeListener('error', reject);
        resolveListen();
      });
    });
    server.on('error', fail);
    if (process.platform !== 'win32') {
      await chmod(address, 0o600);
      socketIdentity = await lstat(address);
    }
    clearTimeout(helloTimer);
  };

  const onMessage = (message) => {
    if (!isObject(message)) { fail(new Error('Invalid native bridge message.')); return; }
    if (message.type === 'hello') {
      void listen(message).catch(fail);
    } else router.receive(message);
  };
  const helloTimer = setTimeout(() => fail(new Error('Chrome did not initialize the native bridge.')), 10_000);
  removeNativeReader = readNativeMessages(input, onMessage, fail);
  input.once('end', () => { removeNativeReader(); void close(); });
  input.once('error', fail);
  output.once('error', fail);
  return { close, get profileKey() { return profileKey; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const host = startNativeHost();
    process.once('SIGTERM', () => { void host.close(); });
    process.once('SIGINT', () => { void host.close(); });
  } catch (error) {
    process.stderr.write(`Favorsite bridge: ${error.message}\n`);
    process.exitCode = 1;
  }
}
