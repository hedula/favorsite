import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAndPreviewBackup } from '@/core/backup';
import { buildProjections } from '@/core/bookmark-engine';
import {
  requestDuplicateDeletion,
  sendStudioMessage,
  UNKNOWN_STUDIO_MESSAGE,
  type StudioMessage,
} from '@/core/protocol';
import type { PlanScope } from '@/core/types';
import { MockChromeBookmarks } from './mock-bookmarks';

const ALL: PlanScope = { type: 'all', targetFolderIds: [] };

async function setupWorker(legacy = false) {
  const bookmarks = new MockChromeBookmarks();
  const origin = 'chrome-extension://test-extension/';
  type Listener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
  let receive: Listener | undefined;
  const messages: StudioMessage['type'][] = [];
  const event = { addListener: () => {} };
  vi.stubGlobal('chrome', {
    bookmarks: Object.assign(bookmarks, {
      onCreated: event,
      onChanged: event,
      onMoved: event,
      onRemoved: event,
      onChildrenReordered: event,
    }),
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => origin + path,
      onInstalled: event,
      onStartup: event,
      onMessage: { addListener: (listener: Listener) => { receive = listener; } },
      sendMessage: (message: StudioMessage | { type: 'BOOKMARKS_CHANGED' }) =>
        new Promise((resolve) => {
          if (message.type === 'BOOKMARKS_CHANGED') {
            resolve(undefined);
          } else if (legacy && message.type === 'DELETE_DUPLICATES') {
            messages.push(message.type);
            resolve({ ok: false, error: UNKNOWN_STUDIO_MESSAGE });
          } else {
            messages.push(message.type);
            if (!receive) throw new Error('Background message listener is missing');
            receive(message, { id: 'test-extension', url: origin + 'studio.html' }, resolve);
          }
        }),
    },
  });
  vi.stubGlobal('defineBackground', (main: () => void) => ({ main }));

  const { default: background } = await import('@/entrypoints/background');
  await background.main();
  const { defaultStore } = await import('@/core/store');
  const profileKey = await defaultStore.getOrCreateProfileKey();
  const list = async () => buildProjections(await bookmarks.getTree(), profileKey).projections;
  return { bookmarks, defaultStore, profileKey, list, messages };
}

describe('direct deletion through the extension background', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { legacy: false, messages: ['DELETE_DUPLICATES'] },
    { legacy: true, messages: ['DELETE_DUPLICATES', 'CREATE_DUPLICATE_PLAN', 'SAVE_PLAN', 'APPLY_PLAN'] },
  ])('backs up and deletes the exact copies in scope and can undo (legacy=$legacy)', async (scenario) => {
    const { bookmarks, defaultStore, profileKey, list, messages } = await setupWorker(scenario.legacy);
    const inbox = await bookmarks.create({ parentId: '1', title: 'Inbox' });
    const url = 'https://example.test/article';
    const keeper = await bookmarks.create({ parentId: '2', title: 'Original', url });
    const copy = await bookmarks.create({ parentId: inbox.id, title: 'Inbox copy', url });
    const outside = await bookmarks.create({ parentId: '2', title: 'Another copy', url });
    const suspected = await bookmarks.create({
      parentId: inbox.id,
      title: 'Tracking URL',
      url: url + '?utm_source=test',
    });
    const originalRemove = bookmarks.remove.bind(bookmarks);
    vi.spyOn(bookmarks, 'remove').mockImplementation(async (nodeId) => {
      const [snapshot] = await defaultStore.listSnapshots(profileKey);
      expect(snapshot.nodes.some((node) => node.id === nodeId)).toBe(true);
      await originalRemove(nodeId);
    });

    const job = await requestDuplicateDeletion({ type: 'folder', folderId: inbox.id, targetFolderIds: [] });
    expect(messages).toEqual(scenario.messages);
    expect(job?.status).toBe('completed');
    expect(job?.steps.map((step) => step.status)).toEqual(['applied']);
    expect(bookmarks.remove).toHaveBeenCalledExactlyOnceWith(copy.id);
    expect((await list()).filter((node) => node.url === url).map((node) => node.nodeId))
      .toEqual([keeper.id, outside.id]);
    expect((await bookmarks.get(suspected.id))[0].url).toBe(suspected.url);

    const restored = await sendStudioMessage({
      type: 'RESTORE_JOB',
      payload: { jobId: job!.jobId },
    });
    expect(restored.status).toBe('restored');
    expect((await list()).filter((node) => node.url === url)).toHaveLength(3);
    expect((await bookmarks.getChildren(inbox.id)).map((node) => node.title))
      .toEqual(['Inbox copy', 'Tracking URL']);
  });

  it('reports the update step when a background worker understands neither deletion command', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: UNKNOWN_STUDIO_MESSAGE });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await expect(requestDuplicateDeletion(ALL)).rejects.toThrow('重新載入 Favorsite');
    expect(sendMessage.mock.calls.map(([message]) => message.type))
      .toEqual(['DELETE_DUPLICATES', 'CREATE_DUPLICATE_PLAN']);
  });

  it('does not retry deletion when the message channel fails', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('Message channel closed'));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await expect(requestDuplicateDeletion(ALL)).rejects.toThrow('Message channel closed');
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('skips a batch with only suspected copies and makes no deletion snapshot', async () => {
    const { bookmarks, defaultStore, profileKey, list } = await setupWorker();
    const url = 'https://example.test/guide';
    await bookmarks.create({ parentId: '1', title: 'Guide', url });
    await bookmarks.create({ parentId: '2', title: 'Guide', url: url + '?utm_source=test' });
    const remove = vi.spyOn(bookmarks, 'remove');
    const result = await sendStudioMessage({
      type: 'DELETE_DUPLICATES',
      payload: { scope: ALL },
    });
    expect(result).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(await defaultStore.listSnapshots(profileKey)).toEqual([]);
    expect((await list()).filter((node) => !node.isFolder)).toHaveLength(2);
  });

  it('exports a usable backup and requires a durable snapshot before single-bookmark deletion', async () => {
    const { bookmarks, defaultStore, list } = await setupWorker();
    const node = await bookmarks.create({ parentId: '1', title: 'Keepable', url: 'https://example.test/one' });
    const backup = await sendStudioMessage({ type: 'EXPORT_BACKUP' });
    const { preview } = validateAndPreviewBackup(JSON.stringify(backup));
    expect(preview.valid).toBe(true);
    expect(preview.totalBookmarks).toBe(1);

    vi.spyOn(defaultStore, 'saveSnapshot').mockRejectedValueOnce(new Error('Backup failed'));
    const deletion = { type: 'REMOVE_BOOKMARK', payload: { nodeId: node.id } } as const;
    await expect(sendStudioMessage(deletion)).rejects.toThrow('Backup failed');
    expect((await bookmarks.get(node.id))[0].url).toBe(node.url);

    vi.spyOn(defaultStore, 'pruneSnapshots').mockRejectedValueOnce(new Error('Retention cleanup failed'));
    const result = await sendStudioMessage(deletion);
    expect(result.job?.status).toBe('completed');
    expect((await defaultStore.getSnapshot(result.snapshotId))?.nodes.some((entry) => entry.id === node.id)).toBe(true);
    expect((await list()).find((entry) => entry.nodeId === node.id)).toBeUndefined();
    await sendStudioMessage({ type: 'RESTORE_JOB', payload: { jobId: result.job!.jobId } });
    expect((await bookmarks.getChildren('1')).map((entry) => entry.url)).toEqual([node.url]);
  });
});
