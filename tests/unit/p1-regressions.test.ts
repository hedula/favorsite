import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  buildProjections,
  computeScopeFingerprint,
} from '@/core/bookmark-engine';
import {
  applyApprovedPlan,
  reconcileInterruptedJobs,
  resolveJobStep,
  restoreJob,
} from '@/core/executor';
import { probeBookmarkUrl, runBatchLinkCheck } from '@/core/link-checker';
import {
  generateDeadLinkCleanupPlan,
  generateRuleBasedPlan,
  overrideMoveDestination,
} from '@/core/planner';
import {
  PromptApiSessionPool,
  requestChromePromptApiPlan,
  type LanguageModelGlobal,
} from '@/core/prompt-api';
import type { PreparedAiBatch } from '@/core/ai-schema';
import { FavorsiteStore } from '@/core/store';
import type { OrganizePlan, PlanScope } from '@/core/types';
import { MockChromeBookmarks } from './mock-bookmarks';

/** Regression suite for the P1 findings of the 2026-11-25 audit. */

async function setup() {
  const mock = new MockChromeBookmarks();
  const inbox = await mock.create({ parentId: '1', title: 'Inbox' });
  const elsewhere = await mock.create({ parentId: '2', title: 'Elsewhere' });
  const figma = await mock.create({
    parentId: inbox.id,
    title: 'Figma design tips',
    url: 'https://figma.com/a',
  });
  const github = await mock.create({
    parentId: inbox.id,
    title: 'GitHub repo',
    url: 'https://github.com/x',
  });
  const store = new FavorsiteStore(`p1_${Math.random().toString(36).slice(2)}`);
  const profileKey = await store.getOrCreateProfileKey();
  const scope: PlanScope = {
    type: 'folder',
    folderId: inbox.id,
    targetFolderIds: [inbox.id],
  };
  return { mock, store, profileKey, inbox, elsewhere, figma, github, scope };
}

async function rulePlan(
  ctx: Awaited<ReturnType<typeof setup>>,
  scope: PlanScope = ctx.scope,
): Promise<OrganizePlan> {
  const flattened = buildProjections(await ctx.mock.getTree(), ctx.profileKey);
  const plan = generateRuleBasedPlan({
    flattened,
    scope,
    instruction: '',
    metadataByNodeId: new Map(),
    profileKey: ctx.profileKey,
    snapshotId: 'snap',
  });
  await ctx.store.savePlan(plan);
  return plan;
}

/** Emulates a Service Worker kill: the in-process catch ran, but the DB keeps 'running'. */
async function markKilledWhileRunning(
  store: FavorsiteStore,
  jobId: string,
): Promise<void> {
  const job = (await store.getJob(jobId))!;
  await store.saveJob({ ...job, status: 'running', conflicts: [] });
  await store.acquireJobLock(job.profileKey, jobId);
}

async function applyUntilKilled(
  ctx: Awaited<ReturnType<typeof setup>>,
  plan: OrganizePlan,
  killAt: (stepType: string, seen: number) => boolean,
  phase: 'before' | 'after',
): Promise<string> {
  let seen = 0;
  let jobId = '';
  const hook = async (step: { opType: string }) => {
    seen++;
    if (killAt(step.opType, seen)) throw new Error('SW killed');
  };
  try {
    await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan,
      approvedRevision: plan.revision,
      ...(phase === 'before'
        ? { onBeforeStepWrite: hook }
        : { onAfterApiBeforeLog: hook }),
    });
  } catch {
    // expected
  }
  const jobs = await ctx.store.listJobs(ctx.profileKey);
  jobId = jobs.find((j) => j.planId === plan.planId)!.jobId;
  await markKilledWhileRunning(ctx.store, jobId);
  return jobId;
}

describe('P1-1 overriding a move destination keeps the plan applicable', () => {
  it('does not change the fingerprinted scope and applies to the new folder', async () => {
    const ctx = await setup();
    const plan = await rulePlan(ctx);
    const move = plan.operations.find((o) => o.type === 'moveBookmark')!;
    const updated = overrideMoveDestination(plan, move.opId, ctx.elsewhere.id, 'Elsewhere');
    await ctx.store.savePlan(updated);

    const flattened = buildProjections(await ctx.mock.getTree(), ctx.profileKey);
    expect(computeScopeFingerprint(flattened, updated.scope)).toBe(
      updated.scopeFingerprint,
    );

    const job = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan: updated,
      approvedRevision: updated.revision,
    });
    expect(job.status).toBe('completed');
    const [moved] = await ctx.mock.get(
      move.type === 'moveBookmark' ? move.nodeId : '',
    );
    expect(moved.parentId).toBe(ctx.elsewhere.id);
  });
});

describe('P1-2 a live job is never reconciled or unlocked by a concurrent call', () => {
  it('rejects a concurrent restore and keeps the running job intact', async () => {
    const ctx = await setup();
    const p1 = await rulePlan(ctx);
    const jobA = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan: p1,
      approvedRevision: p1.revision,
    });
    expect(jobA.status).toBe('completed');

    const box = await ctx.mock.create({ parentId: '2', title: 'Box2' });
    await ctx.mock.create({
      parentId: box.id,
      title: 'Dribbble shots',
      url: 'https://dribbble.com/z',
    });
    const p2 = await rulePlan(ctx, {
      type: 'folder',
      folderId: box.id,
      targetFolderIds: [box.id],
    });

    let concurrentError = '';
    const statusesSeenMidRun: string[] = [];
    const jobB = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan: p2,
      approvedRevision: p2.revision,
      onBeforeStepWrite: async () => {
        if (concurrentError) return;
        try {
          await restoreJob({ adapter: ctx.mock, store: ctx.store, jobId: jobA.jobId });
          concurrentError = 'none';
        } catch (e) {
          concurrentError = (e as Error).message;
        }
        // A bootstrap-style reconcile without explicit active IDs must not touch B either
        await reconcileInterruptedJobs({
          adapter: ctx.mock,
          store: ctx.store,
          profileKey: ctx.profileKey,
        });
        const live = (await ctx.store.listJobs(ctx.profileKey)).find(
          (j) => j.planId === p2.planId,
        );
        statusesSeenMidRun.push(live!.status);
        const lock = await ctx.store.getJobLock(ctx.profileKey);
        expect(lock?.jobId).toBe(live!.jobId);
      },
    });

    expect(concurrentError).toMatch(/另一個寫入工作/);
    expect(statusesSeenMidRun.every((s) => s === 'running')).toBe(true);
    expect(jobB.status).toBe('completed');
    expect((await ctx.store.getJob(jobA.jobId))!.status).toBe('completed');
    expect(await ctx.store.getJobLock(ctx.profileKey)).toBeUndefined();
  });
});

describe('P1-3 an orphaned lock does not dead-lock the profile', () => {
  it('releases a lock whose job never got persisted', async () => {
    const ctx = await setup();
    const plan = await rulePlan(ctx);
    // SW killed between acquireJobLock and the first saveJob
    await ctx.store.acquireJobLock(ctx.profileKey, 'job_never_saved');

    const job = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan,
      approvedRevision: plan.revision,
    });
    expect(job.status).toBe('completed');
    expect(await ctx.store.getJobLock(ctx.profileKey)).toBeUndefined();
  });
});

describe('P1-4 restoreJob is idempotent across a crash', () => {
  it('does not recreate a removed bookmark twice and relinks its tags once', async () => {
    const ctx = await setup();
    await ctx.store.upsertMetadata({
      profileKey: ctx.profileKey,
      nodeId: ctx.figma.id,
      tags: ['設計'],
      originalDateAdded: 1_600_000_000_000,
      linkCheck: {
        status: 'dead_404_410',
        httpStatus: 404,
        checkedAt: 1,
        checkedUrl: 'https://figma.com/a',
      },
      updatedAt: 1,
    });
    const flattened = buildProjections(await ctx.mock.getTree(), ctx.profileKey);
    const meta = new Map(
      (await ctx.store.getAllMetadata(ctx.profileKey)).map((m) => [m.nodeId, m]),
    );
    let plan = generateDeadLinkCleanupPlan({
      flattened,
      scope: ctx.scope,
      metadataByNodeId: meta,
      profileKey: ctx.profileKey,
      snapshotId: 'snap',
      action: 'remove',
    });
    plan = { ...plan, operations: plan.operations.map((o) => ({ ...o, enabled: true })) };
    await ctx.store.savePlan(plan);
    const job = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan,
      approvedRevision: plan.revision,
    });
    expect(job.status).toBe('completed');

    // Crash right after Chrome recreated the bookmark, before anything is logged
    const crashingAdapter = new Proxy(ctx.mock, {
      get(target, key) {
        if (key === 'create') {
          return async (details: Parameters<MockChromeBookmarks['create']>[0]) => {
            await target.create(details);
            throw new Error('SW killed');
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      restoreJob({ adapter: crashingAdapter, store: ctx.store, jobId: job.jobId }),
    ).rejects.toThrow('SW killed');

    await reconcileInterruptedJobs({
      adapter: ctx.mock,
      store: ctx.store,
      profileKey: ctx.profileKey,
    });
    const restored = await restoreJob({
      adapter: ctx.mock,
      store: ctx.store,
      jobId: job.jobId,
    });
    expect(restored.status).toBe('restored');

    const kids = await ctx.mock.getChildren(ctx.inbox.id);
    const copies = kids.filter((k) => k.url === 'https://figma.com/a');
    expect(copies).toHaveLength(1);
    const relinked = await ctx.store.getMetadata(ctx.profileKey, copies[0].id);
    expect(relinked?.tags).toEqual(['設計']);
    expect(relinked?.originalDateAdded).toBe(1_600_000_000_000);
  });
});

describe('P1-5 ambiguous / conflicted steps can be resolved instead of blocking forever', () => {
  it('adopts the folder created before the crash, finishes, and undo keeps it', async () => {
    const ctx = await setup();
    const plan = await rulePlan(ctx);
    const jobId = await applyUntilKilled(
      ctx,
      plan,
      (type) => type === 'createFolder',
      'after',
    );

    const [reconciled] = await reconcileInterruptedJobs({
      adapter: ctx.mock,
      store: ctx.store,
      profileKey: ctx.profileKey,
    });
    const ambiguous = reconciled.steps.find((s) => s.status === 'needs_confirmation')!;
    expect(ambiguous.resultCode).toBe('AMBIGUOUS_CREATE');

    // Without resolution, resume pauses again (the old dead end)
    const stuck = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan,
      approvedRevision: plan.revision,
      resumeJobId: jobId,
    });
    expect(stuck.status).toBe('paused_conflict');

    const resolved = await resolveJobStep({
      adapter: ctx.mock,
      store: ctx.store,
      jobId,
      opId: ambiguous.opId,
      resolution: 'adopt',
    });
    expect(resolved.conflicts.some((c) => c.opId === ambiguous.opId)).toBe(false);

    const finished = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan,
      approvedRevision: plan.revision,
      resumeJobId: jobId,
    });
    expect(finished.status).toBe('completed');

    const intent = ambiguous.intent;
    if (intent.type !== 'createFolder') throw new Error('unexpected');
    const siblings = await ctx.mock.getChildren(intent.parentId);
    expect(siblings.filter((c) => !c.url && c.title === intent.title)).toHaveLength(1);

    const undone = await restoreJob({ adapter: ctx.mock, store: ctx.store, jobId });
    expect(undone.status).toBe('restored');
    const adoptedStep = undone.steps.find((s) => s.opId === ambiguous.opId)!;
    expect(adoptedStep.resultCode).toBe('ADOPTED_KEPT');
    const [figmaAfterUndo] = await ctx.mock.get(ctx.figma.id);
    expect(figmaAfterUndo.parentId).toBe(ctx.inbox.id);
  });

  it('skip lets the remaining steps finish; unknown states are rejected', async () => {
    const ctx = await setup();
    const plan = await rulePlan(ctx);
    const jobId = await applyUntilKilled(
      ctx,
      plan,
      (type) => type === 'createFolder',
      'after',
    );
    const [reconciled] = await reconcileInterruptedJobs({
      adapter: ctx.mock,
      store: ctx.store,
      profileKey: ctx.profileKey,
    });
    const ambiguous = reconciled.steps.find((s) => s.status === 'needs_confirmation')!;
    const applied = reconciled.steps.find((s) => s.status === 'applied');

    await resolveJobStep({
      adapter: ctx.mock,
      store: ctx.store,
      jobId,
      opId: ambiguous.opId,
      resolution: 'skip',
    });
    const finished = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan,
      approvedRevision: plan.revision,
      resumeJobId: jobId,
    });
    expect(finished.status).toBe('completed');
    const dependents = finished.steps.filter(
      (s) => s.intent.type === 'moveBookmark' && s.intent.dependsOnOpId === ambiguous.opId,
    );
    expect(dependents.every((s) => s.resultCode === 'DEPENDENCY_SKIPPED')).toBe(true);

    if (applied) {
      await expect(
        resolveJobStep({
          adapter: ctx.mock,
          store: ctx.store,
          jobId,
          opId: applied.opId,
          resolution: 'skip',
        }),
      ).rejects.toThrow();
    }
  });
});

describe('P1-6 resuming never overrides a change made while the job was interrupted', () => {
  it('pauses on a bookmark the user moved, and applies it only after explicit retry', async () => {
    const ctx = await setup();
    const plan = await rulePlan(ctx);
    const moves = plan.operations.filter((o) => o.type === 'moveBookmark');
    expect(moves.length).toBeGreaterThanOrEqual(2);
    const jobId = await applyUntilKilled(
      ctx,
      plan,
      (type) => type === 'moveBookmark',
      'before',
    );
    await reconcileInterruptedJobs({
      adapter: ctx.mock,
      store: ctx.store,
      profileKey: ctx.profileKey,
    });

    // While interrupted, the user relocates the second bookmark by hand
    const second = moves[1];
    if (second.type !== 'moveBookmark') throw new Error('unexpected');
    await ctx.mock.move(second.nodeId, { parentId: ctx.elsewhere.id });

    const paused = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan,
      approvedRevision: plan.revision,
      resumeJobId: jobId,
    });
    expect(paused.status).toBe('paused_conflict');
    const conflicted = paused.steps.find((s) => s.opId === second.opId)!;
    expect(conflicted.resultCode).toBe('NODE_MODIFIED');
    expect((await ctx.mock.get(second.nodeId))[0].parentId).toBe(ctx.elsewhere.id);

    await resolveJobStep({
      adapter: ctx.mock,
      store: ctx.store,
      jobId,
      opId: second.opId,
      resolution: 'retry',
    });
    const done = await applyApprovedPlan({
      adapter: ctx.mock,
      store: ctx.store,
      plan,
      approvedRevision: plan.revision,
      resumeJobId: jobId,
    });
    expect(done.status).toBe('completed');
    expect((await ctx.mock.get(second.nodeId))[0].parentId).not.toBe(ctx.elsewhere.id);
  });
});

describe('P1-7 HEAD 404/410 is confirmed with a bounded GET', () => {
  it('does not report dead when GET succeeds, and reports dead when GET agrees', async () => {
    const methods: string[] = [];
    const flaky = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      methods.push(String(init?.method));
      return new Response(init?.method === 'HEAD' ? null : 'ok', {
        status: init?.method === 'HEAD' ? 404 : 200,
      });
    }) as typeof fetch;
    const ok = await probeBookmarkUrl({ url: 'https://example.com/p', fetchImpl: flaky });
    expect(ok.status).toBe('ok');
    expect(methods).toEqual(['HEAD', 'GET']);

    for (const code of [404, 410]) {
      const seen: string[] = [];
      const gone = (async (_u: RequestInfo | URL, init?: RequestInit) => {
        seen.push(String(init?.method));
        return new Response(null, { status: code });
      }) as typeof fetch;
      const rec = await probeBookmarkUrl({ url: 'https://example.com/g', fetchImpl: gone });
      expect(rec.status).toBe('dead_404_410');
      expect(rec.httpStatus).toBe(code);
      expect(seen).toEqual(['HEAD', 'GET']);
    }
  });
});

describe('P1-8 dead-link results only apply to the URL that was checked', () => {
  it('stamps checkedUrl and excludes edited or legacy records from cleanup plans', async () => {
    const ctx = await setup();
    const batch = await runBatchLinkCheck({
      bookmarks: buildProjections(await ctx.mock.getTree(), ctx.profileKey).projections,
      isOriginAuthorized: async () => true,
      fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
    });
    expect(batch.results[ctx.figma.id].checkedUrl).toBe('https://figma.com/a');
    expect(batch.results[ctx.github.id].status).toBe('dead_404_410');

    for (const [nodeId, linkCheck] of Object.entries(batch.results)) {
      await ctx.store.upsertMetadata({
        profileKey: ctx.profileKey,
        nodeId,
        tags: [],
        linkCheck,
        updatedAt: 1,
      });
    }
    // The user fixes figma's URL after the check
    await ctx.mock.update(ctx.figma.id, { url: 'https://figma.com/fixed' });
    // A legacy record without checkedUrl
    const legacy = await ctx.mock.create({
      parentId: ctx.inbox.id,
      title: 'Legacy',
      url: 'https://legacy.example.com/',
    });
    await ctx.store.upsertMetadata({
      profileKey: ctx.profileKey,
      nodeId: legacy.id,
      tags: [],
      linkCheck: { status: 'dead_404_410', httpStatus: 404, checkedAt: 1 },
      updatedAt: 1,
    });

    const meta = new Map(
      (await ctx.store.getAllMetadata(ctx.profileKey)).map((m) => [m.nodeId, m]),
    );
    const plan = generateDeadLinkCleanupPlan({
      flattened: buildProjections(await ctx.mock.getTree(), ctx.profileKey),
      scope: ctx.scope,
      metadataByNodeId: meta,
      profileKey: ctx.profileKey,
      snapshotId: 'snap',
      action: 'remove',
    });
    const targets = plan.operations.map((o) =>
      o.type === 'removeBookmark' ? o.nodeId : '',
    );
    expect(targets).toEqual([ctx.github.id]);
    expect(plan.warnings.some((w) => w.includes('已過期'))).toBe(true);
  });
});

describe('P1-9 Prompt API timeout does not include the on-device model download', () => {
  const batch: PreparedAiBatch = {
    bookmarks: [{ id: 'b1', title: 't', domain: 'a.com' }],
    folders: [{ id: 'f1', title: 'F', path: 'F' }],
    bookmarkIdByTemp: new Map([['b1', '10']]),
    folderIdByTemp: new Map([['f1', '20']]),
    skippedSpecialUrls: 0,
  };

  function fakeModel(downloadMs: number, promptMs: number): LanguageModelGlobal {
    return {
      availability: async () => 'downloadable',
      create: async () => {
        await new Promise((r) => setTimeout(r, downloadMs));
        const session = {
          prompt: (_input: string, options?: { signal?: AbortSignal }) =>
            new Promise<string>((resolve, reject) => {
              // Like Chrome: an already-aborted signal rejects immediately
              if (options?.signal?.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
                return;
              }
              const t = setTimeout(() => resolve('{"operations":[]}'), promptMs);
              options?.signal?.addEventListener('abort', () => {
                clearTimeout(t);
                reject(new DOMException('aborted', 'AbortError'));
              });
            }),
          destroy() {},
          clone: async () => session,
        };
        return session;
      },
    };
  }

  it('succeeds when the download is longer than the inference timeout', async () => {
    const res = await requestChromePromptApiPlan({
      instruction: 'x',
      batch,
      lmGlobal: fakeModel(80, 1),
      sessionPool: new PromptApiSessionPool(),
      hasUserGesture: true,
      timeoutMs: 30,
    });
    expect(res.draftOps).toEqual([]);
  });

  it('still times out a slow inference', async () => {
    await expect(
      requestChromePromptApiPlan({
        instruction: 'x',
        batch,
        lmGlobal: fakeModel(1, 200),
        hasUserGesture: true,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/逾時/);
  });
});
