import {
  buildOrganizerSystemPrompt,
  parseAndMapAiResponse,
  PLAN_RESPONSE_JSON_SCHEMA,
  type AiPlanResult,
  type PreparedAiBatch,
} from './ai-schema';

export type ChromePromptAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported';

export interface LanguageModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

export interface LanguageModelDownloadProgressEvent {
  loaded?: number;
  total?: number;
}

export interface LanguageModelMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (e: LanguageModelDownloadProgressEvent) => void,
  ): void;
}

export interface LanguageModelSession {
  prompt(
    input: string,
    options?: {
      responseConstraint?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<string>;
  clone?: () => Promise<LanguageModelSession>;
  destroy(): void;
  /** Total tokens this session accepts (Chrome 138+; optional for older builds) */
  inputQuota?: number;
  /** Tokens already consumed by initialPrompts / history */
  inputUsage?: number;
  measureInputUsage?: (
    input: string,
    options?: { responseConstraint?: Record<string, unknown> },
  ) => Promise<number>;
}

export class PromptApiInputTooLargeError extends Error {
  constructor(needed: number, available: number) {
    super(
      `整理範圍超出本機模型可處理的輸入量（需要 ${Math.round(needed)}、可用 ${Math.round(available)} tokens），請縮小範圍分批整理。`,
    );
    this.name = 'PromptApiInputTooLargeError';
  }
}

export interface LanguageModelGlobal {
  availability(options?: {
    expectedInputs?: Array<{ type: 'text'; languages?: string[] }>;
    expectedOutputs?: Array<{ type: 'text'; languages?: string[] }>;
  }): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
  params?: () => Promise<LanguageModelParams>;
  create(options?: {
    expectedInputs?: Array<{ type: 'text'; languages?: string[] }>;
    expectedOutputs?: Array<{ type: 'text'; languages?: string[] }>;
    initialPrompts?: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>;
    temperature?: number;
    topK?: number;
    monitor?: (monitor: LanguageModelMonitor) => void;
  }): Promise<LanguageModelSession>;
}

export interface PromptApiStatus {
  supported: boolean;
  availability: ChromePromptAvailability;
  params?: LanguageModelParams;
  reason: string;
}

function getGlobalLanguageModel(): LanguageModelGlobal | undefined {
  if (!('LanguageModel' in globalThis)) return undefined;
  const g = globalThis as unknown as { LanguageModel?: LanguageModelGlobal };
  return g.LanguageModel;
}

const DEFAULT_EXPECTED_IO = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};

export function normalizeDownloadProgress(
  e: LanguageModelDownloadProgressEvent,
): number {
  const loaded = typeof e.loaded === 'number' && Number.isFinite(e.loaded) ? e.loaded : 0;
  if (typeof e.total === 'number' && e.total > 0) {
    return Math.max(0, Math.min(1, loaded / e.total));
  }
  return Math.max(0, Math.min(1, loaded));
}

export async function probePromptApiAvailability(
  lmGlobal: LanguageModelGlobal | undefined = getGlobalLanguageModel(),
): Promise<PromptApiStatus> {
  if (!lmGlobal || typeof lmGlobal.availability !== 'function') {
    return {
      supported: false,
      availability: 'unsupported',
      reason:
        '此 Chrome 版本或環境尚未啟用內建 LanguageModel API（擴充功能需桌面版 Chrome 138 以上，且裝置支援 Gemini Nano）。',
    };
  }

  try {
    const availability = await lmGlobal.availability(DEFAULT_EXPECTED_IO);
    let params: LanguageModelParams | undefined;
    if (typeof lmGlobal.params === 'function') {
      try {
        params = await lmGlobal.params();
      } catch {
        // params() is optional or may fail if model is unavailable
      }
    }

    if (availability === 'available') {
      return {
        supported: true,
        availability,
        params,
        reason: 'Chrome 內建 Gemini Nano 已就緒（完全本機、零費用、無外部連線）。',
      };
    }
    if (availability === 'downloadable') {
      return {
        supported: true,
        availability,
        params,
        reason:
          '裝置支援 Chrome 內建 Gemini Nano，點擊整理時將由 Chrome 於本機下載模型（需 22 GB 可用空間）。',
      };
    }
    if (availability === 'downloading') {
      return {
        supported: true,
        availability,
        params,
        reason: 'Chrome 正在本機下載內建 Gemini Nano 模型，請稍候。',
      };
    }
    return {
      supported: false,
      availability: 'unavailable',
      params,
      reason:
        '目前裝置硬體、磁碟空間或瀏覽器原則不支援 Chrome 內建 Gemini Nano，將自動降級。',
    };
  } catch (err) {
    return {
      supported: false,
      availability: 'unavailable',
      reason: `偵測 Chrome Prompt API 失敗：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Maintains a baseline Prompt API session containing only system instructions
 * and clones it per task to avoid re-parsing initialPrompts on repeated runs.
 * Always destroys each cloned session when finished, and exposes `dispose()` for page unload.
 */
export class PromptApiSessionPool {
  private baseSession: LanguageModelSession | null = null;
  private baseSystemPrompt = '';
  /** In-flight base creation, shared by concurrent callers so only ONE base is created */
  private basePending: Promise<LanguageModelSession> | null = null;

  async acquireTaskSession(params: {
    lmGlobal: LanguageModelGlobal;
    probe: PromptApiStatus;
    onDownloadProgress?: (fraction: number) => void;
    onDownloadComplete?: () => void;
  }): Promise<{ session: LanguageModelSession; isClone: boolean }> {
    const { lmGlobal, probe, onDownloadProgress, onDownloadComplete } = params;
    const systemPrompt = buildOrganizerSystemPrompt();

    if (
      this.baseSession &&
      this.baseSystemPrompt === systemPrompt &&
      typeof this.baseSession.clone === 'function'
    ) {
      try {
        const cloned = await this.baseSession.clone();
        return { session: cloned, isClone: true };
      } catch {
        // Base session may have been invalidated — dispose and recreate cleanly
        this.dispose();
      }
    }

    if (this.basePending) {
      // Another task is already creating the shared base: wait instead of creating a second one
      const shared = await this.basePending;
      if (typeof shared.clone === 'function' && this.baseSession === shared) {
        return { session: await shared.clone(), isClone: true };
      }
      // Non-clonable base belongs to its creator — create a private session
      return {
        session: await createSession(lmGlobal, probe, systemPrompt),
        isClone: false,
      };
    }

    let resolveShared!: (s: LanguageModelSession) => void;
    let rejectShared!: (e: unknown) => void;
    this.basePending = new Promise<LanguageModelSession>((res, rej) => {
      resolveShared = res;
      rejectShared = rej;
    });
    // Waiters handle their own failure path; never leave an unhandled rejection
    this.basePending.catch(() => undefined);

    let created: LanguageModelSession;
    try {
      created = await createSession(lmGlobal, probe, systemPrompt, {
        onDownloadProgress,
        onDownloadComplete,
      });
      if (typeof created.clone === 'function') {
        this.baseSession = created;
        this.baseSystemPrompt = systemPrompt;
      }
      resolveShared(created);
    } catch (err) {
      rejectShared(err);
      throw err;
    } finally {
      this.basePending = null;
    }

    if (typeof created.clone === 'function') {
      const cloned = await created.clone();
      return { session: cloned, isClone: true };
    }

    return { session: created, isClone: false };
  }

  dispose(): void {
    if (this.baseSession) {
      try {
        this.baseSession.destroy();
      } catch {
        // ignore cleanup errors
      }
      this.baseSession = null;
      this.baseSystemPrompt = '';
    }
  }
}

async function createSession(
  lmGlobal: LanguageModelGlobal,
  probe: PromptApiStatus,
  systemPrompt: string,
  callbacks: {
    onDownloadProgress?: (fraction: number) => void;
    onDownloadComplete?: () => void;
  } = {},
): Promise<LanguageModelSession> {
  const temperature = probe.params
    ? Math.min(0.2, probe.params.maxTemperature)
    : 0.2;
  const topK = probe.params ? Math.min(8, probe.params.maxTopK) : 3;
  let sawDownload = false;
  // Per language-model guide: do NOT pass `signal` to LanguageModel.create();
  // pass AbortSignal only to session.prompt() / promptStreaming().
  const created = await lmGlobal.create({
    ...DEFAULT_EXPECTED_IO,
    temperature,
    topK,
    initialPrompts: [{ role: 'system', content: systemPrompt }],
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        sawDownload = true;
        callbacks.onDownloadProgress?.(normalizeDownloadProgress(e));
      });
    },
  });
  if (sawDownload) callbacks.onDownloadComplete?.();
  return created;
}

export class PromptApiUserAbortError extends Error {
  constructor() {
    super('使用者已停止產生整理方案。');
    this.name = 'PromptApiUserAbortError';
  }
}

export async function requestChromePromptApiPlan(params: {
  instruction: string;
  batch: PreparedAiBatch;
  lmGlobal?: LanguageModelGlobal;
  sessionPool?: PromptApiSessionPool;
  /** True only when invoked directly from a foreground click/user gesture */
  hasUserGesture?: boolean;
  /** External AbortSignal for user-initiated "Stop" button */
  signal?: AbortSignal;
  /** Receives normalized 0..1 fraction for `<progress max="1">` */
  onDownloadProgress?: (fraction: number) => void;
  onDownloadComplete?: () => void;
  timeoutMs?: number;
}): Promise<AiPlanResult> {
  const {
    instruction,
    batch,
    lmGlobal = getGlobalLanguageModel(),
    sessionPool,
    hasUserGesture = true,
    signal: externalSignal,
    onDownloadProgress,
    onDownloadComplete,
    timeoutMs = 45_000,
  } = params;

  const probe = await probePromptApiAvailability(lmGlobal);
  if (!probe.supported || !lmGlobal || typeof lmGlobal.create !== 'function') {
    throw new Error(probe.reason);
  }

  // Per language-model guide: when availability is 'downloadable' or 'downloading',
  // LanguageModel.create() requires a user gesture or rejects with NotAllowedError.
  if (
    (probe.availability === 'downloadable' ||
      probe.availability === 'downloading') &&
    !hasUserGesture
  ) {
    throw new Error(
      'Chrome 內建模型需由前景按鈕點擊手勢啟動下載，背景執行環境無法自動下載。',
    );
  }

  if (externalSignal?.aborted) {
    throw new PromptApiUserAbortError();
  }

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  // The inference timeout starts only once a session exists: a first-run on-device model
  // download (create() + monitor) can legitimately take minutes and must not consume it.
  let timer: ReturnType<typeof setTimeout> | undefined;

  let taskSession: LanguageModelSession | null = null;
  try {
    if (sessionPool) {
      const acquired = await sessionPool.acquireTaskSession({
        lmGlobal,
        probe,
        onDownloadProgress,
        onDownloadComplete,
      });
      taskSession = acquired.session;
    } else {
      // Single-use path (e.g. Service Worker): create & destroy directly without caching
      taskSession = await createSession(lmGlobal, probe, buildOrganizerSystemPrompt(), {
        onDownloadProgress,
        onDownloadComplete,
      });
    }

    if (externalSignal?.aborted) {
      throw new PromptApiUserAbortError();
    }

    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const userPayload = JSON.stringify({
      instruction: instruction.slice(0, 500),
      existingFolders: batch.folders,
      bookmarks: batch.bookmarks,
    });

    // Fail fast with an actionable message instead of a QuotaExceededError mid-prompt
    if (
      typeof taskSession.measureInputUsage === 'function' &&
      typeof taskSession.inputQuota === 'number'
    ) {
      const needed = await taskSession.measureInputUsage(userPayload, {
        responseConstraint: PLAN_RESPONSE_JSON_SCHEMA.schema,
      });
      const available = taskSession.inputQuota - (taskSession.inputUsage ?? 0);
      if (needed > available) {
        throw new PromptApiInputTooLargeError(needed, available);
      }
    }

    let rawOutput: string;
    try {
      rawOutput = await taskSession.prompt(userPayload, {
        responseConstraint: PLAN_RESPONSE_JSON_SCHEMA.schema,
        signal: controller.signal,
      });
    } catch (constraintErr) {
      if (
        constraintErr instanceof Error &&
        constraintErr.name === 'AbortError'
      ) {
        throw constraintErr;
      }
      rawOutput = await taskSession.prompt(
        `${userPayload}\n\nRespond ONLY with valid JSON: {"operations":[...]}`,
        { signal: controller.signal },
      );
    }

    if (typeof rawOutput !== 'string' || !rawOutput.trim()) {
      throw new Error('Chrome 內建模型未回傳有效內容');
    }

    return parseAndMapAiResponse(rawOutput, batch);
  } catch (err) {
    if (err instanceof PromptApiUserAbortError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      if (externalSignal?.aborted && !timedOut) {
        throw new PromptApiUserAbortError();
      }
      throw new Error('Chrome 內建模型推理逾時，將改用降級模式。');
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    if (taskSession) {
      try {
        taskSession.destroy();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
