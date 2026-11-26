import { answerKnowledgeQuestion } from '@/core/knowledge-answer';
import type { OffscreenWork } from '@/core/offscreen-client';
import { embedWithTransformers } from '@/core/semantic-client';

const active = new Map<string, AbortController>();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (message?.type !== 'FAVORSITE_OFFSCREEN' || typeof message.requestId !== 'string') return false;
  if (message.action === 'cancel') {
    active.get(message.requestId)?.abort(new Error('已停止知識檢索。'));
    sendResponse({ ok: true });
    return false;
  }
  const controller = new AbortController();
  active.set(message.requestId, controller);
  const work = message as OffscreenWork;
  const run = async () => {
    if (work.action === 'embed') {
      if (!Array.isArray(work.texts) || work.texts.length > 10_000 ||
        work.texts.some((text) => typeof text !== 'string' || text.length > 16_000)) {
        throw new Error('語意檢索文字格式或範圍無效。');
      }
      return embedWithTransformers(work.texts, controller.signal);
    }
    if (work.action === 'answer') {
      return answerKnowledgeQuestion({
        question: work.question, excerpts: work.excerpts, signal: controller.signal,
      });
    }
    throw new Error('未知的本機知識檢索操作。');
  };
  void run().then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  ).finally(() => active.delete(message.requestId));
  return true;
});
