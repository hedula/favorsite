import type { KnowledgeAnswer, KnowledgeExcerpt } from './knowledge-types';
import type { EmbeddingBatch } from './semantic-classifier';

export type OffscreenWork =
  | { action: 'embed'; texts: string[] }
  | { action: 'answer'; question: string; excerpts: KnowledgeExcerpt[] };

let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  if (!chrome.offscreen) throw new Error('目前瀏覽器無法啟動本機知識檢索，請更新 Chrome。');
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  });
  if (contexts.length > 0) return;
  if (!creating) {
    let setupTimer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      setupTimer = setTimeout(() => reject(new Error('本機檢索環境啟動逾時，請重試。')), 30_000);
    });
    const setup = Promise.race([
      Promise.resolve().then(() => chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Run the bundled local semantic model for bookmark knowledge search.',
      })), timeout,
    ]);
    creating = setup;
    void setup.finally(() => {
      clearTimeout(setupTimer);
      if (creating === setup) creating = undefined;
    }).catch(() => {});
  }
  await creating;
}

async function runOffscreen<T>(work: OffscreenWork, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let sent = false;
    const finish = (error?: unknown, data?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(data as T);
    };
    const notifyCancellation = () => {
      if (!sent) return;
      try {
        void chrome.runtime.sendMessage({
          type: 'FAVORSITE_OFFSCREEN', action: 'cancel', requestId,
        }).catch(() => {});
      } catch {
        // The extension may have reloaded while the query was active.
      }
    };
    const cancel = () => {
      notifyCancellation();
      finish(signal?.reason ?? new Error('已停止知識檢索。'));
    };
    const timer = setTimeout(() => {
      notifyCancellation();
      finish(new Error('本機知識檢索逾時，可重試或縮小範圍。'));
    }, 125_000);
    signal?.addEventListener('abort', cancel, { once: true });
    void ensureOffscreen().then(() => {
      if (settled) return undefined;
      signal?.throwIfAborted();
      sent = true;
      return chrome.runtime.sendMessage({ type: 'FAVORSITE_OFFSCREEN', requestId, ...work });
    })
      .then((response: { ok: boolean; data?: T; error?: string } | undefined) => {
        if (!response?.ok) finish(new Error(response?.error ?? '本機知識檢索暫時無法回應。'));
        else finish(undefined, response.data);
      }, finish);
  });
}

export function embedKnowledgeTexts(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch> {
  return runOffscreen({ action: 'embed', texts }, signal);
}

export function answerFromExcerpts(
  question: string,
  excerpts: KnowledgeExcerpt[],
  signal?: AbortSignal,
): Promise<KnowledgeAnswer> {
  return runOffscreen({ action: 'answer', question, excerpts }, signal);
}
