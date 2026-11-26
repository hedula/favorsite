import { describe, expect, it, vi } from 'vitest';
import { answerKnowledgeQuestion } from '@/core/knowledge-answer';
import type { KnowledgeExcerpt } from '@/core/knowledge-types';
import type { LanguageModelGlobal, LanguageModelSession } from '@/core/prompt-api';

const excerpts: KnowledgeExcerpt[] = [{ sourceId: 'source-one', sourceVersion: 'v1', chunkId: 'chunk-one', title: 'R2 guide', url: 'https://developers.cloudflare.com/r2/', capturedAt: 123, heading: 'Private files', text: 'Use expiring presigned URLs to share private objects.' }];

function model(output: string): { global: LanguageModelGlobal; session: LanguageModelSession } {
  const session: LanguageModelSession = { prompt: vi.fn().mockResolvedValue(output), destroy: vi.fn() };
  return { global: { availability: vi.fn().mockResolvedValue('available'), create: vi.fn().mockResolvedValue(session) }, session };
}

describe('grounded local source answers', () => {
  it('returns original excerpts when the local model is unavailable and no sources when none match', async () => {
    const lmGlobal: LanguageModelGlobal = { availability: vi.fn().mockResolvedValue('unavailable'), create: vi.fn() };
    const result = await answerKnowledgeQuestion({ question: '如何分享私有檔案？', excerpts, lmGlobal });
    expect(result.mode).toBe('excerpts');
    expect(result.citations[0].text).toBe(excerpts[0].text);
    expect(lmGlobal.create).not.toHaveBeenCalled();
    const empty = await answerKnowledgeQuestion({ question: 'How?', excerpts: [], lmGlobal });
    expect(empty.mode).toBe('empty');
    expect(empty.citations).toEqual([]);
  });

  it('renders only model claims with valid supplied citations and owns citation metadata', async () => {
    const fixture = model('{"claims":[{"text":"可用有期限的簽署網址。","citationIds":["c1"]}]}');
    const result = await answerKnowledgeQuestion({ question: '如何分享私有檔案？', excerpts, lmGlobal: fixture.global });
    expect(result.mode).toBe('answer');
    expect(result.answer).toContain('[c1]');
    expect(result.citations[0]).toMatchObject({ ...excerpts[0], citationId: 'c1' });
    expect(fixture.session.destroy).toHaveBeenCalledOnce();
    expect(fixture.global.create).toHaveBeenCalledWith(expect.objectContaining({ expectedInputs: [{ type: 'text', languages: ['en'] }] }));
  });

  it.each([
    '{"claims":[{"text":"Invented detail","citationIds":["c900"]}]}',
    '{"claims":[{"text":"No grounding","citationIds":[]}]}',
    '{"claims":[{"text":"Injected metadata","citationIds":["c1"],"url":"https://evil.example"}]}',
    '{"claims":[]}',
    'plain unstructured answer',
  ])('falls back to exact snippets for invalid answers (%s)', async (output) => {
    const fixture = model(output);
    const result = await answerKnowledgeQuestion({ question: 'How?', excerpts, lmGlobal: fixture.global });
    expect(result.mode).toBe('excerpts');
    expect(result.answer).not.toContain('Invented detail');
    expect(result.citations[0].url).toBe(excerpts[0].url);
    expect(fixture.session.destroy).toHaveBeenCalledOnce();
  });

  it('checks quota before inference and releases the session on the fallback path', async () => {
    const fixture = model('');
    fixture.session.inputQuota = 100;
    fixture.session.measureInputUsage = vi.fn().mockResolvedValue(200);
    const result = await answerKnowledgeQuestion({ question: 'How?', excerpts, lmGlobal: fixture.global });
    expect(result.mode).toBe('excerpts');
    expect(fixture.session.prompt).not.toHaveBeenCalled();
    expect(fixture.session.destroy).toHaveBeenCalledOnce();
  });

  it('cancels a stalled availability probe and keeps cancellation visible to the caller', async () => {
    const controller = new AbortController();
    const lmGlobal: LanguageModelGlobal = { availability: () => new Promise(() => undefined), create: vi.fn() };
    const pending = answerKnowledgeQuestion({ question: 'How?', excerpts, lmGlobal, signal: controller.signal });
    controller.abort(new DOMException('Stopped', 'AbortError'));
    await expect(pending).rejects.toThrow('Stopped');
  });

  it('times out inference even when the model ignores AbortSignal', async () => {
    const fixture = model('');
    fixture.session.prompt = () => new Promise(() => undefined);
    const result = await answerKnowledgeQuestion({ question: 'How?', excerpts, lmGlobal: fixture.global, timeoutMs: 10 });
    expect(result.mode).toBe('excerpts');
    expect(result.warnings[0]).toContain('逾時');
    expect(fixture.session.destroy).toHaveBeenCalledOnce();
  });
});
