import React, { useEffect, useRef, useState } from 'react';
import type { KnowledgeAnswer, KnowledgeChunk, KnowledgeSourceSummary } from '@/core/knowledge-types';
import type { KnowledgeResponseMap, KnowledgeSearchInput } from '@/core/knowledge-protocol';
import { sendStudioMessage } from '@/core/protocol';
import type { BookmarkProjection } from '@/core/types';
import { IconBookmark, IconSearch, IconSparkles } from './Icons';

type SearchResponse = KnowledgeResponseMap['SEARCH_KNOWLEDGE'];

interface KnowledgeViewProps {
  folders: BookmarkProjection[];
  initialFolderId: string | null;
}

function capturedTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-TW');
}

export function KnowledgeView({ folders, initialFolderId }: KnowledgeViewProps) {
  const [folderId, setFolderId] = useState(initialFolderId ?? '');
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'keyword' | 'semantic'>('semantic');
  const [searchResponse, setSearchResponse] = useState<SearchResponse | null>(null);
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([]);
  const [selectedSource, setSelectedSource] = useState<KnowledgeSourceSummary | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  const [pending, setPending] = useState<'search' | 'answer' | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const requestRef = useRef<string | null>(null);
  const searchScopeRef = useRef<KnowledgeSearchInput | null>(null);
  const sourceRequestRef = useRef(0);
  const sourceHeadingRef = useRef<HTMLHeadingElement>(null);
  const sourceReturnFocusRef = useRef<HTMLElement | null>(null);

  const refreshSources = async () => {
    try {
      const response = await sendStudioMessage({ type: 'LIST_KNOWLEDGE_SOURCES' });
      setSources(response.sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refreshSources();
    const onRuntimeMessage = (event: { type?: string; requestId?: string; completed?: number; total?: number }) => {
      if (event.type === 'KNOWLEDGE_CHANGED') void refreshSources();
      if (event.type === 'KNOWLEDGE_PROGRESS' && event.requestId === requestRef.current) {
        setMessage(`正在建立本機語意索引… ${event.completed ?? 0}／${event.total ?? 0}`);
      }
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      const requestId = requestRef.current;
      requestRef.current = null;
      if (requestId) {
        void sendStudioMessage({ type: 'CANCEL_KNOWLEDGE_REQUEST', payload: { requestId } }).catch(() => undefined);
      }
    };
  }, []);

  const cancelRequest = () => {
    const requestId = requestRef.current;
    requestRef.current = null;
    setPending(null);
    setMessage('已停止這次查詢。');
    if (requestId) {
      void sendStudioMessage({ type: 'CANCEL_KNOWLEDGE_REQUEST', payload: { requestId } }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }
  };

  const search = async () => {
    const text = query.trim();
    if (!text) return;
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setPending('search');
    setError('');
    setMessage('正在搜尋收藏…');
    const scope = { query: text, folderId: folderId || undefined, includeDescendants: true, limit: 20 };
    searchScopeRef.current = { ...scope, mode: searchMode };
    let hasKeywordResults = false;
    try {
      const keyword = await sendStudioMessage({ type: 'SEARCH_KNOWLEDGE', payload: { ...scope, mode: 'keyword', requestId } });
      if (requestRef.current !== requestId) return;
      setSearchResponse(keyword);
      hasKeywordResults = true;
      if (searchMode === 'semantic') {
        setMessage('已顯示關鍵字結果，正在更新本機語意排名…');
        const semantic = await sendStudioMessage({ type: 'SEARCH_KNOWLEDGE', payload: { ...scope, mode: 'semantic', requestId } });
        if (requestRef.current !== requestId) return;
        setSearchResponse(semantic);
      }
      setMessage('搜尋完成。');
    } catch (err) {
      if (requestRef.current === requestId) {
        setError(err instanceof Error ? err.message : String(err));
        setMessage(hasKeywordResults ? '已顯示關鍵字搜尋結果。' : '這次搜尋未完成。');
      }
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null;
        setPending(null);
      }
    }
  };

  const loadMoreSearch = async () => {
    if (!searchScopeRef.current || !searchResponse?.nextCursor) return;
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setPending('search');
    setError('');
    try {
      const response = await sendStudioMessage({
        type: 'SEARCH_KNOWLEDGE',
        payload: { ...searchScopeRef.current, cursor: searchResponse.nextCursor, requestId },
      });
      if (requestRef.current !== requestId) return;
      setSearchResponse((current) => current ? {
        ...response,
        results: [...current.results, ...response.results],
      } : response);
      setMessage('已載入更多搜尋結果。');
    } catch (err) {
      if (requestRef.current === requestId) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null;
        setPending(null);
      }
    }
  };

  const readSource = async (sourceId: string, sourceVersion?: string, cursor?: string) => {
    if (!cursor && document.activeElement instanceof HTMLElement) {
      sourceReturnFocusRef.current = document.activeElement;
    }
    const request = ++sourceRequestRef.current;
    setSourceBusy(true);
    setError('');
    setMessage('正在讀取收錄正文…');
    try {
      const response = await sendStudioMessage({ type: 'READ_KNOWLEDGE_SOURCE', payload: { sourceId, sourceVersion, cursor } });
      if (sourceRequestRef.current !== request) return;
      setSelectedSource(response.source);
      setChunks((current) => cursor ? [...current, ...response.chunks] : response.chunks);
      setNextCursor(response.nextCursor);
      setMessage('已載入收錄正文。');
      if (!cursor) requestAnimationFrame(() => sourceHeadingRef.current?.focus({ preventScroll: false }));
    } catch (err) {
      if (sourceRequestRef.current === request) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (sourceRequestRef.current === request) setSourceBusy(false);
    }
  };

  const deleteSource = async (source: KnowledgeSourceSummary) => {
    if (!window.confirm(`清除「${source.title}」的已收錄正文？`)) return;
    setSourceBusy(true);
    setError('');
    try {
      await sendStudioMessage({ type: 'DELETE_KNOWLEDGE_SOURCE', payload: { sourceId: source.sourceId } });
      if (selectedSource?.sourceId === source.sourceId) {
        setSelectedSource(null);
        setChunks([]);
        setNextCursor(undefined);
      }
      setAnswer(null);
      setSearchResponse(null);
      await refreshSources();
      setMessage('已清除收錄正文。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSourceBusy(false);
    }
  };

  const ask = async () => {
    if (!question.trim()) return;
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setPending('answer');
    setError('');
    setAnswer(null);
    setMessage('正在尋找相關段落並整理回答…');
    try {
      const response = await sendStudioMessage({ type: 'ASK_KNOWLEDGE', payload: { question: question.trim(), folderId: folderId || undefined, requestId } });
      if (requestRef.current !== requestId) return;
      setAnswer(response);
      setMessage(response.mode === 'answer' ? '回答已完成，可展開引用核對原文。' : '已列出可參考的來源。');
    } catch (err) {
      if (requestRef.current === requestId) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null;
        setPending(null);
      }
    }
  };

  return (
    <main className="page-container knowledge-page">
      <section className="section-box" aria-label="搜尋書籤知識庫">
        <div className="section-title-group">
          <span className="icon-circle primary"><IconSearch size={18} /></span>
          <h1 className="section-title">書籤知識庫</h1>
        </div>
        <form className="knowledge-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <div className="form-field">
            <label htmlFor="knowledge-folder">搜尋及提問範圍</label>
            <select id="knowledge-folder" value={folderId} disabled={pending !== null} onChange={(event) => {
              setFolderId(event.target.value);
              setSearchResponse(null);
              setAnswer(null);
            }}>
              <option value="">全部書籤</option>
              {folders.filter((folder) => folder.nodeId !== '0').map((folder) => (
                <option key={folder.nodeId} value={folder.nodeId}>{folder.path || folder.title}（含子資料夾）</option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="knowledge-search">尋找收藏</label>
            <input
              id="knowledge-search"
              type="search"
              maxLength={1000}
              required
              disabled={pending !== null}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="我存過哪些用物件儲存分享圖片的文件？"
            />
          </div>
          <div className="knowledge-actions">
            <label className="knowledge-check">
              <input
                type="checkbox"
                checked={searchMode === 'semantic'}
                disabled={pending !== null}
                onChange={(event) => setSearchMode(event.target.checked ? 'semantic' : 'keyword')}
              />
              語意搜尋
            </label>
            <button type="submit" className="primary" disabled={pending !== null || !query.trim()}>搜尋收藏</button>
            {pending === 'search' && <button type="button" onClick={cancelRequest}>停止查詢</button>}
          </div>
        </form>
        <div className="wf-muted" role="status" aria-live="polite">{message}</div>
        {error && <div className="wf-banner danger" role="alert">{error}</div>}
        {searchResponse?.warnings?.map((warning) => <p key={warning} className="wf-muted">{warning}</p>)}
        {searchResponse && (
          <div>
            <p className="wf-muted">{searchResponse.results.length} 筆結果 · {searchResponse.mode === 'hybrid' ? '關鍵字與語意排名' : '關鍵字排名'}</p>
            {searchResponse.results.length === 0 && <p>沒有符合目前範圍的收藏，請調整問句或資料夾。</p>}
            <ul className="knowledge-source-list">
              {searchResponse.results.map((result) => (
                <li className="knowledge-source-row" key={result.bookmarkId}>
                  <a href={result.url} target="_blank" rel="noopener noreferrer" className="knowledge-source-title">{result.title || result.url}</a>
                  <div className="bookmark-meta-line"><span>{result.folderPath}</span>{result.tags.map((tag) => <span key={tag} className="wf-badge">{tag}</span>)}</div>
                  {result.snippet && <p className="knowledge-excerpt">{result.snippet}</p>}
                  {result.contentStatus === 'collected' && (
                    <div>
                      <button
                        type="button"
                        className="sm"
                        disabled={sourceBusy}
                        onClick={() => void readSource(result.sourceId, result.sourceVersion)}
                      >
                        讀取收錄正文
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {searchResponse.nextCursor && <button type="button" disabled={pending !== null} onClick={() => void loadMoreSearch()}>載入更多搜尋結果</button>}
          </div>
        )}
      </section>

      <section className="section-box" aria-label="詢問來源">
        <div className="section-title-group"><span className="icon-circle secondary"><IconSparkles size={18} /></span><h2 className="section-title">詢問這個範圍</h2></div>
        <form className="knowledge-form" onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}>
          <div className="form-field">
            <label htmlFor="knowledge-question">根據已收錄的文章提問</label>
            <textarea
              id="knowledge-question"
              rows={3}
              maxLength={2000}
              required
              disabled={pending !== null}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="這些文件提到哪些私有檔案分享方式？"
            />
          </div>
          <div className="knowledge-actions">
            <button type="submit" className="primary" disabled={pending !== null || !question.trim()}>
              尋找來源並回答
            </button>
            {pending === 'answer' && <button type="button" onClick={cancelRequest}>停止回答</button>}
          </div>
        </form>
        {answer && (
          <div className="knowledge-answer" aria-live="polite">
            <p className="knowledge-excerpt">{answer.answer}</p>
            {answer.warnings.map((warning) => <p key={warning} className="wf-muted">{warning}</p>)}
            <ol className="knowledge-source-list">
              {answer.citations.map((citation) => <li key={citation.citationId} className="knowledge-source-row">
                <a href={citation.url} target="_blank" rel="noopener noreferrer">[{citation.citationId}] {citation.title}</a>
                <span className="wf-muted">收錄於 {capturedTime(citation.capturedAt)}</span>
                <details><summary>查看引用原文</summary><p className="knowledge-excerpt">{citation.text}</p></details>
              </li>)}
            </ol>
          </div>
        )}
      </section>

      <section className="section-box" aria-label="已收錄文章">
        <div className="section-header">
          <div className="section-title-group">
            <span className="icon-circle primary"><IconBookmark size={18} /></span>
            <h2 className="section-title">已收錄文章（{sources.length}）</h2>
          </div>
          <button type="button" className="sm" onClick={() => void refreshSources()}>重新整理</button>
        </div>
        {sources.length === 0 ? <p className="wf-muted">開啟要保存的文章，點 Chrome 工具列的 Favorsite，再按「收錄本文」。</p> : (
          <ul className="knowledge-source-list">
            {sources.map((source) => (
              <li key={source.sourceId} className="knowledge-source-row">
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="knowledge-source-title">
                  {source.title}
                </a>
                <div className="bookmark-meta-line">
                  <span>收錄於 {capturedTime(source.capturedAt)}</span>
                  <span>{source.characterCount.toLocaleString()} 字元</span>
                  <span>{source.chunkCount} 段</span>
                </div>
                <div className="knowledge-actions">
                  <button type="button" className="sm" disabled={sourceBusy} onClick={() => void readSource(source.sourceId)}>
                    讀取正文
                  </button>
                  <button type="button" className="sm" onClick={() => {
                    void chrome.tabs.create({ url: source.url });
                    setMessage('在開啟的頁面點 Favorsite，再按「收錄本文」即可更新。');
                  }}>
                    開啟原文以更新
                  </button>
                  <button type="button" className="sm danger" disabled={sourceBusy || pending !== null} onClick={() => void deleteSource(source)}>
                    清除正文
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedSource && (
        <section className="section-box" aria-label="收錄正文" aria-busy={sourceBusy}>
          <div className="section-header">
            <h2 className="section-title" ref={sourceHeadingRef} tabIndex={-1}>{selectedSource.title}</h2>
            <button type="button" className="sm" onClick={() => {
              sourceRequestRef.current++;
              setSelectedSource(null);
              setChunks([]);
              setSourceBusy(false);
              sourceReturnFocusRef.current?.focus();
            }}>
              關閉正文
            </button>
          </div>
          <a href={selectedSource.url} target="_blank" rel="noopener noreferrer" className="knowledge-source-url">
            {selectedSource.url}
          </a>
          <p className="wf-muted">收錄於 {capturedTime(selectedSource.capturedAt)}</p>
          {chunks.map((chunk) => (
            <section key={chunk.chunkId} className="knowledge-chunk">
              {chunk.heading && <h3>{chunk.heading}</h3>}
              <p className="knowledge-excerpt">{chunk.text}</p>
            </section>
          ))}
          {nextCursor && (
            <div>
              <button type="button" disabled={sourceBusy} onClick={() => void readSource(selectedSource.sourceId, selectedSource.sourceVersion, nextCursor)}>
                載入更多段落
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
