import type {
  AppSettings,
  BookmarkMetadata,
  BookmarkProjection,
  ExecutionJob,
  JobLock,
  OrganizePlan,
  Snapshot,
} from './types';

const DB_NAME = 'favorsite_local_store';
const DB_VERSION = 1;

const STORES = {
  projections: 'projections',
  metadata: 'metadata',
  snapshots: 'snapshots',
  plans: 'plans',
  jobs: 'jobs',
  locks: 'locks',
  kv: 'kv',
} as const;

export function createDefaultSettings(profileKey: string): AppSettings {
  return {
    profileKey,
    aiProvider: 'auto',
    includePathInAi: false,
    backupRetentionCount: 30,
    firstRunNoticeDismissed: false,
  };
}

function generateId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class FavorsiteStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;

  constructor(dbName = DB_NAME) {
    this.dbName = dbName;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.projections)) {
          const s = db.createObjectStore(STORES.projections, {
            keyPath: ['profileKey', 'nodeId'],
          });
          s.createIndex('byProfile', 'profileKey', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.metadata)) {
          const s = db.createObjectStore(STORES.metadata, {
            keyPath: ['profileKey', 'nodeId'],
          });
          s.createIndex('byProfile', 'profileKey', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.snapshots)) {
          const s = db.createObjectStore(STORES.snapshots, {
            keyPath: 'snapshotId',
          });
          s.createIndex('byProfile', 'profileKey', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.plans)) {
          const s = db.createObjectStore(STORES.plans, {
            keyPath: 'planId',
          });
          s.createIndex('byProfile', 'profileKey', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.jobs)) {
          const s = db.createObjectStore(STORES.jobs, {
            keyPath: 'jobId',
          });
          s.createIndex('byProfile', 'profileKey', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.locks)) {
          db.createObjectStore(STORES.locks, { keyPath: 'profileKey' });
        }
        if (!db.objectStoreNames.contains(STORES.kv)) {
          db.createObjectStore(STORES.kv, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    });
    return this.dbPromise;
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
  }

  async getOrCreateProfileKey(): Promise<string> {
    const db = await this.open();
    const tx = db.transaction(STORES.kv, 'readwrite');
    const store = tx.objectStore(STORES.kv);
    const existing = (await reqToPromise(store.get('profileKey'))) as
      | { key: string; value: string }
      | undefined;
    if (existing?.value) {
      await txDone(tx);
      return existing.value;
    }
    const created = generateId('prof');
    store.put({ key: 'profileKey', value: created });
    await txDone(tx);
    return created;
  }

  async getSettings(profileKey: string): Promise<AppSettings> {
    const db = await this.open();
    const tx = db.transaction(STORES.kv, 'readonly');
    const rec = (await reqToPromise(
      tx.objectStore(STORES.kv).get(`settings:${profileKey}`),
    )) as { key: string; value: AppSettings } | undefined;
    await txDone(tx);
    return rec?.value
      ? { ...createDefaultSettings(profileKey), ...rec.value, profileKey }
      : createDefaultSettings(profileKey);
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.kv, 'readwrite');
    tx.objectStore(STORES.kv).put({
      key: `settings:${settings.profileKey}`,
      value: settings,
    });
    await txDone(tx);
  }

  async replaceProjections(
    profileKey: string,
    projections: BookmarkProjection[],
  ): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.projections, 'readwrite');
    const store = tx.objectStore(STORES.projections);
    const idx = store.index('byProfile');
    const existingKeys = await reqToPromise(idx.getAllKeys(profileKey));
    for (const k of existingKeys) {
      store.delete(k);
    }
    for (const item of projections) {
      store.put(item);
    }
    await txDone(tx);
  }

  async getProjections(profileKey: string): Promise<BookmarkProjection[]> {
    const db = await this.open();
    const tx = db.transaction(STORES.projections, 'readonly');
    const items = (await reqToPromise(
      tx.objectStore(STORES.projections).index('byProfile').getAll(profileKey),
    )) as BookmarkProjection[];
    await txDone(tx);
    return items;
  }

  async getAllMetadata(profileKey: string): Promise<BookmarkMetadata[]> {
    const db = await this.open();
    const tx = db.transaction(STORES.metadata, 'readonly');
    const items = (await reqToPromise(
      tx.objectStore(STORES.metadata).index('byProfile').getAll(profileKey),
    )) as BookmarkMetadata[];
    await txDone(tx);
    return items;
  }

  async getMetadata(
    profileKey: string,
    nodeId: string,
  ): Promise<BookmarkMetadata | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORES.metadata, 'readonly');
    const item = (await reqToPromise(
      tx.objectStore(STORES.metadata).get([profileKey, nodeId]),
    )) as BookmarkMetadata | undefined;
    await txDone(tx);
    return item;
  }

  async upsertMetadata(meta: BookmarkMetadata): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.metadata, 'readwrite');
    const normalized: BookmarkMetadata = {
      ...meta,
      tags: Array.from(
        new Set(meta.tags.map((t) => t.trim()).filter(Boolean)),
      ),
      updatedAt: meta.updatedAt || Date.now(),
    };
    tx.objectStore(STORES.metadata).put(normalized);
    await txDone(tx);
  }

  async deleteMetadata(profileKey: string, nodeId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.metadata, 'readwrite');
    tx.objectStore(STORES.metadata).delete([profileKey, nodeId]);
    await txDone(tx);
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.snapshots, 'readwrite');
    tx.objectStore(STORES.snapshots).put(snapshot);
    await txDone(tx);
  }

  async getSnapshot(snapshotId: string): Promise<Snapshot | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORES.snapshots, 'readonly');
    const item = (await reqToPromise(
      tx.objectStore(STORES.snapshots).get(snapshotId),
    )) as Snapshot | undefined;
    await txDone(tx);
    return item;
  }

  async listSnapshots(profileKey: string): Promise<Snapshot[]> {
    const db = await this.open();
    const tx = db.transaction(STORES.snapshots, 'readonly');
    const items = (await reqToPromise(
      tx.objectStore(STORES.snapshots).index('byProfile').getAll(profileKey),
    )) as Snapshot[];
    await txDone(tx);
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.snapshots, 'readwrite');
    tx.objectStore(STORES.snapshots).delete(snapshotId);
    await txDone(tx);
  }

  async pruneSnapshots(profileKey: string, retainCount: number): Promise<number> {
    const snapshots = await this.listSnapshots(profileKey);
    if (snapshots.length <= retainCount) return 0;

    const jobs = await this.listJobs(profileKey);
    const protectedIds = new Set(
      jobs
        .filter((j) => j.status === 'running' || j.status === 'interrupted' || j.status === 'paused_conflict')
        .map((j) => j.snapshotId),
    );

    let removed = 0;
    const toDelete = snapshots.slice(Math.max(1, retainCount));
    for (const snap of toDelete) {
      if (protectedIds.has(snap.snapshotId)) continue;
      await this.deleteSnapshot(snap.snapshotId);
      removed++;
    }
    return removed;
  }

  async savePlan(plan: OrganizePlan): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.plans, 'readwrite');
    tx.objectStore(STORES.plans).put(plan);
    await txDone(tx);
  }

  async getPlan(planId: string): Promise<OrganizePlan | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORES.plans, 'readonly');
    const item = (await reqToPromise(
      tx.objectStore(STORES.plans).get(planId),
    )) as OrganizePlan | undefined;
    await txDone(tx);
    return item;
  }

  async listPlans(profileKey: string): Promise<OrganizePlan[]> {
    const db = await this.open();
    const tx = db.transaction(STORES.plans, 'readonly');
    const items = (await reqToPromise(
      tx.objectStore(STORES.plans).index('byProfile').getAll(profileKey),
    )) as OrganizePlan[];
    await txDone(tx);
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveJob(job: ExecutionJob): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.jobs, 'readwrite');
    tx.objectStore(STORES.jobs).put(job);
    await txDone(tx);
  }

  async getJob(jobId: string): Promise<ExecutionJob | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORES.jobs, 'readonly');
    const item = (await reqToPromise(
      tx.objectStore(STORES.jobs).get(jobId),
    )) as ExecutionJob | undefined;
    await txDone(tx);
    return item;
  }

  async listJobs(profileKey: string): Promise<ExecutionJob[]> {
    const db = await this.open();
    const tx = db.transaction(STORES.jobs, 'readonly');
    const items = (await reqToPromise(
      tx.objectStore(STORES.jobs).index('byProfile').getAll(profileKey),
    )) as ExecutionJob[];
    await txDone(tx);
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  async acquireJobLock(profileKey: string, jobId: string): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction(STORES.locks, 'readwrite');
    const store = tx.objectStore(STORES.locks);
    const existing = (await reqToPromise(store.get(profileKey))) as
      | JobLock
      | undefined;
    if (existing && existing.jobId !== jobId) {
      await txDone(tx);
      return false;
    }
    store.put({ profileKey, jobId, acquiredAt: Date.now() } satisfies JobLock);
    await txDone(tx);
    return true;
  }

  async getJobLock(profileKey: string): Promise<JobLock | undefined> {
    const db = await this.open();
    const tx = db.transaction(STORES.locks, 'readonly');
    const lock = (await reqToPromise(
      tx.objectStore(STORES.locks).get(profileKey),
    )) as JobLock | undefined;
    await txDone(tx);
    return lock;
  }

  async releaseJobLock(profileKey: string, jobId?: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES.locks, 'readwrite');
    const store = tx.objectStore(STORES.locks);
    if (jobId) {
      const existing = (await reqToPromise(store.get(profileKey))) as
        | JobLock
        | undefined;
      if (existing && existing.jobId !== jobId) {
        await txDone(tx);
        return;
      }
    }
    store.delete(profileKey);
    await txDone(tx);
  }
}

export const defaultStore = new FavorsiteStore();
