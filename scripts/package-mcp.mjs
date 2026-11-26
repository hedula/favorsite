#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MCP_SERVER_VERSION, MCP_TOOLS } from './lib/mcp-protocol.mjs';
import { createZipArchive } from './lib/zip-archive.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleFiles = [
  'scripts/favorsite-mcp.mjs',
  'scripts/favorsite-native-host.mjs',
  'scripts/install-native-host.mjs',
  'scripts/lib/mcp-protocol.mjs',
  'scripts/lib/native-framing.mjs',
];

export function createMcpManifest() {
  return {
    manifest_version: '0.3',
    name: 'favorsite-knowledge',
    display_name: 'Favorsite 書籤知識庫',
    version: MCP_SERVER_VERSION,
    description: 'Search authorized Chrome bookmarks and read collected source passages from Favorsite on this computer.',
    author: { name: 'Hedula' },
    server: {
      type: 'node',
      entry_point: 'scripts/favorsite-mcp.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/scripts/favorsite-mcp.mjs'],
        env: {
          FAVORSITE_PROFILE_KEY: '${user_config.profile_key}',
          FAVORSITE_MCP_TOKEN: '${user_config.token}',
        },
      },
    },
    tools: MCP_TOOLS.map(({ name, description }) => ({ name, description })),
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.0.0' } },
    user_config: {
      profile_key: {
        type: 'string', title: 'Favorsite profile key',
        description: 'Copy the profile key shown in Favorsite Settings > Desktop AI.', required: true,
      },
      token: {
        type: 'string', title: 'Favorsite connection token',
        description: 'Create a desktop AI connection in Favorsite and copy its one-time token.', required: true, sensitive: true,
      },
    },
  };
}

export async function packageMcp(output = join(projectRoot, '.output', 'favorsite-mcp.mcpb')) {
  const destination = resolve(output);
  const entries = [['manifest.json', JSON.stringify(createMcpManifest(), null, 2) + '\n']];
  for (const name of bundleFiles) entries.push([name, await readFile(join(projectRoot, name))]);
  entries.push(['README.md', [
    '# Favorsite desktop knowledge connection',
    '',
    'Install the Favorsite Chrome extension and create a desktop AI connection in its settings.',
    'Register the local Chrome bridge once by running the bundled install-native-host.mjs script with Node.js:',
    '',
    'node scripts/install-native-host.mjs --extension-id YOUR_FAVORSITE_EXTENSION_ID',
    '',
    'Use --dry-run to review the user-level registration before installation.',
    'Reload Favorsite, then enter the profile key and connection token when installing this MCP bundle.',
    'Keep Chrome running while querying. Favorsite Studio can be closed.',
    'Only data in the folders granted to this connection can be retrieved.',
    'Retrieved passages are sent to the AI service used by the desktop client.',
    'To revoke access, remove the connection in Favorsite settings.',
    'To remove the Chrome registration, run install-native-host.mjs --uninstall with the same installation options.',
    '',
  ].join('\n')]);
  const archive = createZipArchive(entries);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, archive);
  return { file: destination, bytes: archive.length, files: entries.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  packageMcp(output).then(
    (result) => process.stdout.write(JSON.stringify(result) + '\n'),
    (error) => { process.stderr.write(`Favorsite package: ${error.message}\n`); process.exitCode = 1; },
  );
}
