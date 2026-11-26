import React, { useEffect, useState } from 'react';
import { validateAndPreviewBackup } from '@/core/backup';
import type {
  BackupImportPreview,
  BackupPayload,
  BookmarkProjection,
  ExecutionJob,
  JobStep,
  JobStepResolution,
  SnapshotSummary,
} from '@/core/types';
import { IconBookmark, IconDownload, IconHistory } from './Icons';

interface HistoryBackupViewProps {
  jobs: ExecutionJob[];
  snapshots: SnapshotSummary[];
  writableFolders: BookmarkProjection[];
  busy: boolean;
  onResumeJob: (job: ExecutionJob) => Promise<void>;
  onRestoreJob: (jobId: string) => Promise<void>;
  onResolveStep: (params: {
    jobId: string;
    opId: string;
    resolution: JobStepResolution;
  }) => Promise<void>;
  onExportBackup: () => Promise<void>;
  onLoadSnapshot: (snapshotId: string) => Promise<BackupPayload | undefined>;
  onExportSnapshot: (snapshotId: string) => Promise<void>;
  onRestoreBackup: (params: {
    backup: BackupPayload;
    targetParentId: string;
    branchTitle?: string;
  }) => Promise<boolean>;
  onPruneSnapshots: (retainCount: number) => Promise<void>;
}

const JOB_STATUS_LABEL: Record<ExecutionJob['status'], string> = {
  pending: '待執行',
  running: '執行中',
  paused_conflict: '衝突暫停',
  interrupted: '中斷待核對',
  completed: '已完成',
  restoring: '復原中',
  restored: '已復原',
  failed: '執行失敗',
};

function describeStep(step: JobStep): string {
  const intent = step.intent;
  switch (intent.type) {
    case 'createFolder':
      return `新建資料夾「${intent.title}」`;
    case 'moveBookmark':
      return `移動「${intent.bookmarkTitle}」至 ${intent.toPath}`;
    case 'renameBookmark':
      return `重新命名「${intent.oldTitle}」為「${intent.newTitle}」`;
    case 'addTag':
      return `為「${intent.bookmarkTitle}」新增標籤`;
    case 'removeBookmark':
      return `移除「${intent.bookmarkTitle}」`;
    default:
      return step.opId;
  }
}

function isUnresolvedStep(step: JobStep): boolean {
  return step.status === 'needs_confirmation' || step.status === 'conflict';
}

export function HistoryBackupView({
  jobs,
  snapshots,
  writableFolders,
  busy,
  onResumeJob,
  onRestoreJob,
  onResolveStep,
  onExportBackup,
  onLoadSnapshot,
  onExportSnapshot,
  onRestoreBackup,
  onPruneSnapshots,
}: HistoryBackupViewProps) {
  const [importPreview, setImportPreview] = useState<BackupImportPreview | null>(
    null,
  );
  const [importPayload, setImportPayload] = useState<BackupPayload | null>(null);
  const [targetFolderId, setTargetFolderId] = useState<string>(
    writableFolders[0]?.nodeId ?? '',
  );
  const [branchTitle, setBranchTitle] = useState('');
  const [previewSource, setPreviewSource] = useState('');
  // Element id to focus once the refreshed job list has rendered and is no longer busy
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFocusId || busy) return;
    const target = document.getElementById(pendingFocusId) as HTMLButtonElement | HTMLSelectElement | null;
    if (target && !target.disabled) {
      target.focus();
    }
    setPendingFocusId(null);
  }, [pendingFocusId, busy, jobs]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { preview, payload } = validateAndPreviewBackup(text);
    setImportPreview(preview);
    setImportPayload(payload ?? null);
    setPreviewSource(file.name);
    if (!targetFolderId && writableFolders[0]) {
      setTargetFolderId(writableFolders[0].nodeId);
    }
  };

  const handleSnapshotPreview = async (snapshot: SnapshotSummary) => {
    const backup = await onLoadSnapshot(snapshot.snapshotId);
    if (!backup) return;
    const { preview, payload } = validateAndPreviewBackup(JSON.stringify(backup));
    setImportPreview(preview);
    setImportPayload(payload ?? null);
    setPreviewSource(snapshot.label);
    setBranchTitle('');
    if (!writableFolders.some((folder) => folder.nodeId === targetFolderId)) {
      setTargetFolderId(writableFolders[0]?.nodeId ?? '');
    }
    setPendingFocusId('restore-target-folder');
  };

  return (
    <div className="page-container">
      <section className="section-box">
        <div className="section-title-group">
          <span className="icon-circle primary">
            <IconHistory size={18} />
          </span>
          <h2 className="section-title">整理歷程與復原</h2>
        </div>
        {jobs.length === 0 ? (
          <div className="empty-well">
            <span className="empty-well-icon">
              <IconHistory size={20} />
            </span>
            <span>尚無批次整理執行紀錄。</span>
          </div>
        ) : (
            <table className="job-table">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>指令 / 方案</th>
                  <th>狀態</th>
                  <th>進度</th>
                  <th>衝突 / 備註</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.jobId}>
                    <td className="wf-mono" data-label="時間">
                      {new Date(job.createdAt).toLocaleString('zh-TW')}
                    </td>
                    <td data-label="指令 / 方案">
                      <div>{job.instruction}</div>
                      <div className="wf-mono wf-muted">
                        {job.planId} (v{job.approvedRevision})
                      </div>
                    </td>
                    <td data-label="狀態">
                      <span
                        className={`wf-badge ${
                          job.status === 'completed'
                            ? 'ok'
                            : job.status === 'paused_conflict' ||
                                job.status === 'interrupted'
                              ? 'warn'
                              : job.status === 'failed'
                                ? 'danger'
                                : ''
                        }`}
                      >
                        {job.status === 'restored' && job.conflicts.length > 0
                          ? `部分復原（${job.conflicts.length} 筆保留現狀）`
                          : JOB_STATUS_LABEL[job.status]}
                      </span>
                    </td>
                    <td data-label="進度">
                      {job.completedCount} / {job.totalCount}
                    </td>
                    <td data-label="衝突 / 備註">
                      {(() => {
                        const canResolve =
                          job.status === 'paused_conflict' ||
                          job.status === 'interrupted';
                        const unresolved = canResolve
                          ? job.steps.filter(isUnresolvedStep)
                          : [];
                        const unresolvedIds = new Set(unresolved.map((st) => st.opId));
                        const otherConflicts = job.conflicts.filter(
                          (c) => !c.opId || !unresolvedIds.has(c.opId),
                        );
                        if (otherConflicts.length === 0 && unresolved.length === 0) {
                          return <span className="wf-muted">無</span>;
                        }
                        const resolve = async (
                          step: JobStep,
                          resolution: JobStepResolution,
                        ) => {
                          await onResolveStep({
                            jobId: job.jobId,
                            opId: step.opId,
                            resolution,
                          });
                          // The step's buttons unmount; keep keyboard focus in this row
                          setPendingFocusId(`resume-${job.jobId}`);
                        };
                        return (
                          <>
                            {otherConflicts.length > 0 && (
                              <ul style={{ margin: 0, paddingLeft: 16 }}>
                                {otherConflicts.map((c, idx) => (
                                  <li key={idx}>{c.message}</li>
                                ))}
                              </ul>
                            )}
                            {unresolved.length > 0 && (
                              <ul
                                className="step-resolve-list"
                                aria-label="待確認步驟"
                                style={{ margin: '6px 0 0', paddingLeft: 16 }}
                              >
                                {unresolved.map((step) => {
                                  const label = describeStep(step);
                                  const canAdopt =
                                    step.intent.type === 'createFolder' &&
                                    step.resultCode === 'AMBIGUOUS_CREATE';
                                  return (
                                    <li key={step.opId} style={{ marginBottom: 6 }}>
                                      <div>
                                        <strong>{label}</strong>
                                      </div>
                                      {step.errorMessage && (
                                        <div className="wf-muted">{step.errorMessage}</div>
                                      )}
                                      <div
                                        style={{
                                          display: 'flex',
                                          gap: 6,
                                          flexWrap: 'wrap',
                                          marginTop: 4,
                                        }}
                                      >
                                        {canAdopt && (
                                          <button
                                            type="button"
                                            className="sm"
                                            disabled={busy}
                                            aria-label={`沿用既有資料夾：${label}`}
                                            onClick={() => void resolve(step, 'adopt')}
                                          >
                                            沿用既有資料夾
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          className="sm"
                                          disabled={busy}
                                          aria-label={`仍要套用：${label}`}
                                          onClick={() => void resolve(step, 'retry')}
                                        >
                                          {step.intent.type === 'createFolder'
                                            ? '仍建立新資料夾'
                                            : '仍要套用'}
                                        </button>
                                        <button
                                          type="button"
                                          className="sm"
                                          disabled={busy}
                                          aria-label={`略過此步驟：${label}`}
                                          onClick={() => void resolve(step, 'skip')}
                                        >
                                          略過此步驟
                                        </button>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td data-label="操作">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(job.status === 'interrupted' ||
                          job.status === 'paused_conflict') && (
                          <button
                            id={`resume-${job.jobId}`}
                            type="button"
                            className="sm"
                            disabled={busy || job.steps.some(isUnresolvedStep)}
                            title={
                              job.steps.some(isUnresolvedStep)
                                ? '請先處理待確認步驟'
                                : undefined
                            }
                            onClick={() => void onResumeJob(job)}
                          >
                            繼續剩餘項目
                          </button>
                        )}
                        {(job.status === 'completed' ||
                          job.status === 'interrupted' ||
                          job.status === 'paused_conflict') &&
                          job.completedCount > 0 && (
                            <button
                              type="button"
                              className="sm danger"
                              disabled={busy}
                              onClick={() => void onRestoreJob(job.jobId)}
                            >
                              復原此批次
                            </button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="section-box">
          <div className="section-title-group">
            <span className="icon-circle primary">
              <IconDownload size={18} />
            </span>
            <h2 className="section-title">本機 JSON 備份與還原</h2>
          </div>
          <div className="wf-banner warn">
            <span>
              提醒：匯出的 JSON 備份檔包含完整書籤樹、網址與本機標籤內容，請妥善保存於本機。
            </span>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void onExportBackup()}
            >
              <IconDownload size={15} />
              匯出 JSON 備份
            </button>
          </div>

          <div className="form-field">
            <label htmlFor="backup-file">匯入備份檔預覽與還原</label>
            <input
              id="backup-file"
              type="file"
              accept="application/json,.json"
              onChange={(e) => void handleFileChange(e)}
            />
          </div>

          {importPreview && (
            <div className="section-box">
              {!importPreview.valid ? (
                <div className="wf-banner danger">
                  <div>
                    <strong>備份檔驗證失敗</strong>
                    <ul style={{ margin: '4px 0 0 16px' }}>
                      {importPreview.errors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <strong>備份檔驗證通過 (schema v{importPreview.schemaVersion})</strong>
                  </div>
                  <div className="wf-muted">還原來源為 {previewSource}</div>
                  <div className="wf-muted">
                    資料夾 {importPreview.totalFolders} 個 · 書籤{' '}
                    {importPreview.totalBookmarks} 筆 · 可重建{' '}
                    {importPreview.reconstructableCount} 筆 · 略過{' '}
                    {importPreview.skippedCount} 筆 · 含標籤{' '}
                    {importPreview.taggedBookmarkCount} 筆
                  </div>
                  {importPreview.warnings.map((w, i) => (
                    <div key={i} className="wf-muted">
                      • {w}
                    </div>
                  ))}
                  {importPreview.skippedReasons.length > 0 && (
                    <ul className="wf-muted" style={{ margin: 0, paddingLeft: 18 }}>
                      {importPreview.skippedReasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}

                  <div className="form-field">
                    <label htmlFor="restore-target-folder">還原目的資料夾（將建立新分支）</label>
                    <select
                      id="restore-target-folder"
                      value={targetFolderId}
                      onChange={(e) => setTargetFolderId(e.target.value)}
                    >
                      {writableFolders.map((f) => (
                        <option key={f.nodeId} value={f.nodeId}>
                          {f.path || f.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-field">
                    <label htmlFor="restore-branch-title">新分支名稱（選填）</label>
                    <input
                      id="restore-branch-title"
                      type="text"
                      value={branchTitle}
                      onChange={(e) => setBranchTitle(e.target.value)}
                      placeholder="留空則自動加上時間戳記"
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || !importPayload || !targetFolderId}
                      onClick={() => {
                        if (!importPayload || !targetFolderId) return;
                        void onRestoreBackup({
                          backup: importPayload,
                          targetParentId: targetFolderId,
                          branchTitle: branchTitle.trim() || undefined,
                        }).then((restored) => {
                          if (!restored) return;
                          setImportPreview(null);
                          setImportPayload(null);
                          setBranchTitle('');
                          setPreviewSource('');
                        });
                      }}
                    >
                      確認還原至新分支
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setImportPreview(null);
                        setImportPayload(null);
                        setPreviewSource('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <section className="section-box">
          <div className="section-header">
            <div className="section-title-group">
              <span className="icon-circle primary">
                <IconBookmark size={17} />
              </span>
              <h2 className="section-title">本機快照 ({snapshots.length})</h2>
            </div>
            <button
              type="button"
              className="sm"
              disabled={busy || snapshots.length <= 10}
              onClick={() => void onPruneSnapshots(10)}
            >
              僅保留最新 10 筆快照
            </button>
          </div>
          {snapshots.length === 0 ? (
            <div className="empty-well">
              <span className="empty-well-icon">
                <IconBookmark size={20} />
              </span>
              <span>尚無本機快照。</span>
            </div>
          ) : (
            <table className="job-table">
              <thead>
                <tr>
                  <th>建立時間</th>
                  <th>類型</th>
                  <th>說明</th>
                  <th>節點數</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.slice(0, 20).map((s) => (
                  <tr key={s.snapshotId}>
                    <td className="wf-mono" data-label="建立時間">
                      {new Date(s.createdAt).toLocaleString('zh-TW')}
                    </td>
                    <td data-label="類型">{s.reason}</td>
                    <td data-label="說明">{s.label}</td>
                    <td data-label="節點數">{s.nodeCount}</td>
                    <td data-label="操作">
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="sm"
                          disabled={busy}
                          aria-label={`還原快照 ${s.label}`}
                          onClick={() => void handleSnapshotPreview(s)}
                        >
                          還原
                        </button>
                        <button
                          type="button"
                          className="sm"
                          disabled={busy}
                          aria-label={`匯出快照 ${s.label}`}
                          onClick={() => void onExportSnapshot(s.snapshotId)}
                        >
                          匯出 JSON
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
    </div>
  );
}
