#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { getBridgeDirectory, NATIVE_HOST_NAME } from './lib/mcp-protocol.mjs';

const execFileAsync = promisify(execFile);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeFiles = ['favorsite-native-host.mjs', 'lib/mcp-protocol.mjs', 'lib/native-framing.mjs'];

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (['--dry-run', '--uninstall', '--skip-registry'].includes(flag)) {
      options[flag.slice(2)] = true;
    } else if (['--extension-id', '--manifest-dir', '--install-dir', '--bridge-dir', '--browser', '--node-bin'].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
      options[flag.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${flag}.`);
    }
  }
  return options;
}

function defaultManifestDirectory(platform, browser, home, env) {
  if (platform === 'darwin') {
    const names = { chrome: 'Google/Chrome', 'chrome-for-testing': 'Google/ChromeForTesting', chromium: 'Chromium' };
    return join(home, 'Library', 'Application Support', names[browser], 'NativeMessagingHosts');
  }
  if (platform === 'linux') {
    const names = { chrome: 'google-chrome', 'chrome-for-testing': 'google-chrome-for-testing', chromium: 'chromium' };
    return join(env.XDG_CONFIG_HOME || join(home, '.config'), names[browser], 'NativeMessagingHosts');
  }
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Favorsite', 'NativeMessagingHosts');
  throw new Error(`Unsupported platform: ${platform}.`);
}

const shellQuote = (text) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

export function planNativeInstallation(options, {
  platform = process.platform,
  home = homedir(),
  env = process.env,
  nodeExecutable = process.execPath,
} = {}) {
  const browser = options.browser || 'chrome';
  if (!['chrome', 'chrome-for-testing', 'chromium'].includes(browser)) throw new Error('Browser must be chrome, chrome-for-testing or chromium.');
  if (!options.uninstall && !/^[a-p]{32}$/.test(options['extension-id'] || '')) {
    throw new Error('Pass --extension-id followed by the 32-letter Favorsite extension ID from chrome://extensions.');
  }
  const installDirectory = resolve(options['install-dir'] || join(home, '.favorsite', 'native-host'));
  const manifestDirectory = resolve(options['manifest-dir'] || defaultManifestDirectory(platform, browser, home, env));
  const manifestPath = join(manifestDirectory, `${NATIVE_HOST_NAME}.json`);
  const bridgeDirectory = getBridgeDirectory({ ...env, FAVORSITE_BRIDGE_DIR: options['bridge-dir'] || env.FAVORSITE_BRIDGE_DIR || join(home, '.favorsite', 'bridge') });
  const node = resolve(options['node-bin'] || nodeExecutable);
  const launcherPath = join(installDirectory, platform === 'win32' ? 'favorsite-host.cmd' : 'favorsite-host');
  const hostPath = join(installDirectory, 'favorsite-native-host.mjs');
  if ([installDirectory, bridgeDirectory, node].some((value) => /[\r\n\0]/.test(value))) throw new Error('Installation paths must contain a single valid path.');
  if (platform === 'win32' && [bridgeDirectory, node, hostPath].some((value) => /["%]/.test(value))) {
    throw new Error('Windows native host paths must not contain double quotes or percent signs.');
  }
  const launcher = platform === 'win32'
    ? `@echo off\r\nset "FAVORSITE_BRIDGE_DIR=${bridgeDirectory}"\r\n"${node}" "${hostPath}" %*\r\n`
    : `#!/bin/sh\nexport FAVORSITE_BRIDGE_DIR=${shellQuote(bridgeDirectory)}\nexec ${shellQuote(node)} ${shellQuote(hostPath)} "$@"\n`;
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Favorsite local bookmark knowledge bridge',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: options.uninstall ? [] : [`chrome-extension://${options['extension-id']}/`],
  };
  const vendor = browser === 'chromium' ? 'Chromium' : browser === 'chrome-for-testing' ? 'Google\\ChromeForTesting' : 'Google\\Chrome';
  const registryKey = `HKCU\\SOFTWARE\\${vendor}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  const registryArgs = options.uninstall
    ? ['DELETE', registryKey, '/f']
    : ['ADD', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'];
  return {
    action: options.uninstall ? 'uninstall' : 'install',
    platform, browser, installDirectory, manifestDirectory, manifestPath, bridgeDirectory, launcherPath,
    launcher, manifest,
    registry: platform === 'win32' && !options['skip-registry'] ? { command: 'reg.exe', args: registryArgs } : null,
  };
}

async function ensureOwnedDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installation directory must be a directory.');
  if (process.platform !== 'win32' && info.uid !== process.getuid()) throw new Error('Installation directory must belong to the current user.');
}

export async function installNativeHost(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const plan = planNativeInstallation(options);
  if (options['dry-run']) return { ...plan, dryRun: true };
  if (options.uninstall) {
    const existing = await readFile(plan.manifestPath, 'utf8').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && (existing.name !== NATIVE_HOST_NAME || existing.path !== plan.launcherPath)) {
      throw new Error('Native host registration belongs to another installation. Pass its original --install-dir.');
    }
    if (plan.registry) await execFileAsync(plan.registry.command, plan.registry.args);
    await rm(plan.manifestPath, { force: true });
    for (const relative of [...runtimeFiles, plan.platform === 'win32' ? 'favorsite-host.cmd' : 'favorsite-host']) {
      await rm(join(plan.installDirectory, relative), { force: true });
    }
    return { action: plan.action, manifestPath: plan.manifestPath };
  }
  await ensureOwnedDirectory(plan.installDirectory);
  await ensureOwnedDirectory(plan.manifestDirectory);
  await ensureOwnedDirectory(join(plan.installDirectory, 'lib'));
  for (const relative of runtimeFiles) {
    await copyFile(join(scriptsDirectory, relative), join(plan.installDirectory, relative));
    if (plan.platform !== 'win32') await chmod(join(plan.installDirectory, relative), 0o600);
  }
  await writeFile(plan.launcherPath, plan.launcher, { mode: 0o700 });
  if (plan.platform !== 'win32') await chmod(plan.launcherPath, 0o700);
  await writeFile(plan.manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n', { mode: 0o600 });
  if (plan.registry) await execFileAsync(plan.registry.command, plan.registry.args);
  return {
    action: plan.action,
    manifestPath: plan.manifestPath,
    bridgeDirectory: plan.bridgeDirectory,
    next: 'Reload Favorsite in chrome://extensions, then enable a desktop AI connection in Favorsite settings.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  installNativeHost().then(
    (result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'),
    (error) => { process.stderr.write(`Favorsite install: ${error.message}\n`); process.exitCode = 1; },
  );
}
