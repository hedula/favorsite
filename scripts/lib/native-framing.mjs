import { endianness } from 'node:os';
import { MAX_MESSAGE_BYTES } from './mcp-protocol.mjs';

const littleEndian = endianness() === 'LE';

export function encodeNativeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (!body.length || body.length > MAX_MESSAGE_BYTES) throw new Error('Invalid native message size.');
  const header = Buffer.allocUnsafe(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function readNativeMessages(input, onMessage, onError) {
  let buffer = Buffer.alloc(0);
  const receive = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = littleEndian ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (!length || length > MAX_MESSAGE_BYTES) {
        buffer = Buffer.alloc(0);
        onError(new Error('Invalid native message size.'));
        return;
      }
      if (buffer.length < length + 4) return;
      const body = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      let message;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch {
        onError(new Error('Invalid native JSON message.'));
        return;
      }
      onMessage(message);
    }
  };
  input.on('data', receive);
  return () => input.removeListener('data', receive);
}
