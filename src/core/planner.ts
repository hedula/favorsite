import {
  collectScopeNodes,
  computeScopeFingerprint,
  wouldCreateCycle,
  type FlattenedTree,
} from './bookmark-engine';
import { findDuplicateGroups } from './duplicates';
import { isDeadLinkCandidate, isLinkCheckCurrent } from './link-checker';
import type {
  AddTagOperation,
  BookmarkMetadata,
  BookmarkProjection,
  CreateFolderOperation,
  MoveBookmarkOperation,
  OrganizePlan,
  PlanOperation,
  PlanScope,
  PlanSource,
  RemoveBookmarkOperation,
  RenameBookmarkOperation,
} from './types';

export interface DraftCreateFolder {
  type: 'createFolder';
  tempFolderId: string;
  parentId: string;
  title: string;
  reason: string;
}

export interface DraftMoveBookmark {
  type: 'moveBookmark';
  nodeId: string;
  toParentId?: string;
  toTempFolderId?: string;
  reason: string;
  confidence?: number;
  requiresReview?: boolean;
  reviewReason?: string;
}

export interface DraftRenameBookmark {
  type: 'renameBookmark';
  nodeId: string;
  newTitle: string;
  reason: string;
  confidence?: number;
}

export interface DraftAddTag {
  type: 'addTag';
  nodeId: string;
  tagsToAdd: string[];
  reason: string;
  confidence?: number;
}

export type DraftOperationInput =
  | DraftCreateFolder
  | DraftMoveBookmark
  | DraftRenameBookmark
  | DraftAddTag;

const ALLOWED_OP_TYPES = new Set([
  'createFolder',
  'moveBookmark',
  'renameBookmark',
  'addTag',
]);
const MAX_OPERATIONS_PER_PLAN = 500;
const MAX_TEXT_LENGTH = 200;

function sanitizePlainText(input: unknown, maxLen = MAX_TEXT_LENGTH): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Folders a plan may write into without extra review: the folders the scope already
 * touches (scope folder + its subfolders, target folders, parents of selected bookmarks)
 * plus the direct subfolders of every target folder (existing category folders).
 */
export function collectAllowedDestinationIds(
  flattened: FlattenedTree,
  scope: PlanScope,
): Set<string> {
  const { affectedFolderIds } = collectScopeNodes(flattened, scope);
  const allowed = new Set(affectedFolderIds);
  for (const targetId of scope.targetFolderIds) {
    for (const child of flattened.childrenByParent.get(targetId) ?? []) {
      if (child.isFolder) allowed.add(child.nodeId);
    }
  }
  return allowed;
}

export interface PlanValidationResult {
  operations: PlanOperation[];
  warnings: string[];
  rejectedCount: number;
}

export function validatePlanDraft(params: {
  draftOps: unknown[];
  flattened: FlattenedTree;
  scope: PlanScope;
  metadataByNodeId: Map<string, BookmarkMetadata>;
}): PlanValidationResult {
  const { draftOps, flattened, scope, metadataByNodeId } = params;
  const warnings: string[] = [];
  let rejectedCount = 0;

  if (!Array.isArray(draftOps)) {
    return {
      operations: [],
      warnings: ['草案格式無效：operations 不是陣列'],
      rejectedCount: 1,
    };
  }

  const capped = draftOps.slice(0, MAX_OPERATIONS_PER_PLAN);
  if (draftOps.length > MAX_OPERATIONS_PER_PLAN) {
    warnings.push(
      `草案操作數超過單批上限 (${MAX_OPERATIONS_PER_PLAN})，已截斷超出項目。`,
    );
  }

  const { inScopeBookmarks } = collectScopeNodes(flattened, scope);
  const inScopeIds = new Set(inScopeBookmarks.map((b) => b.nodeId));
  const allowedDestinationIds = collectAllowedDestinationIds(flattened, scope);
  const OUT_OF_SCOPE_REASON = '目的資料夾不在本次整理範圍內，請確認';

  // Count duplicate folder names to flag ambiguity
  const folderNameCounts = new Map<string, number>();
  for (const p of flattened.projections) {
    if (p.isFolder && p.canAddChild) {
      const key = p.title.trim().toLowerCase();
      folderNameCounts.set(key, (folderNameCounts.get(key) ?? 0) + 1);
    }
  }

  const createFolderOps: CreateFolderOperation[] = [];
  const tempFolderMap = new Map<
    string,
    {
      opId: string;
      parentId: string;
      title: string;
      path: string;
      syncing?: boolean;
      outOfScope: boolean;
    }
  >();
  const createdFolderKeySet = new Set<string>();

  // Pass 1: Validate createFolder operations
  let opSeq = 1;
  for (const raw of capped) {
    if (!raw || typeof raw !== 'object') {
      rejectedCount++;
      continue;
    }
    const op = raw as Record<string, unknown>;
    if (typeof op.type !== 'string' || !ALLOWED_OP_TYPES.has(op.type)) {
      rejectedCount++;
      warnings.push(`已擋下不支援的操作類型：${String(op.type)}`);
      continue;
    }
    if (op.type !== 'createFolder') continue;

    const tempFolderId = sanitizePlainText(op.tempFolderId, 64);
    const parentId = sanitizePlainText(op.parentId, 64);
    const title = sanitizePlainText(op.title, 120);
    const reason = sanitizePlainText(op.reason, 200) || '建立分類資料夾';

    if (!tempFolderId || !parentId || !title) {
      rejectedCount++;
      warnings.push('已忽略缺少欄位的新建資料夾操作。');
      continue;
    }
    if (tempFolderMap.has(tempFolderId)) {
      rejectedCount++;
      warnings.push(`重複的暫存資料夾 ID：${tempFolderId}`);
      continue;
    }
    const parent = flattened.byId.get(parentId);
    if (!parent || !parent.isFolder || !parent.canAddChild) {
      rejectedCount++;
      warnings.push(`目的父資料夾不可寫入或不存在：${parentId}`);
      continue;
    }

    const dedupeKey = `${parentId}::${title.toLowerCase()}`;
    if (createdFolderKeySet.has(dedupeKey)) {
      rejectedCount++;
      warnings.push(`重複建立同名資料夾：${parent.path} / ${title}`);
      continue;
    }
    createdFolderKeySet.add(dedupeKey);

    const opId = `op_${opSeq++}`;
    const fullPath = parent.path ? `${parent.path} / ${title}` : title;
    const outOfScope = !allowedDestinationIds.has(parentId);
    if (outOfScope) {
      warnings.push(
        `新建資料夾「${fullPath}」位於整理範圍外，已預設不勾選，請確認後再套用。`,
      );
    }
    tempFolderMap.set(tempFolderId, {
      opId,
      parentId,
      title,
      path: fullPath,
      syncing: parent.syncing,
      outOfScope,
    });

    createFolderOps.push({
      opId,
      type: 'createFolder',
      enabled: !outOfScope,
      tempFolderId,
      parentId,
      title,
      parentPath: parent.path,
      reason,
    });
  }

  // Pass 2: Validate moveBookmark, renameBookmark, addTag
  const moveOps: MoveBookmarkOperation[] = [];
  const renameOps: RenameBookmarkOperation[] = [];
  const tagOps: AddTagOperation[] = [];

  const movedNodeIds = new Set<string>();
  const renamedNodeIds = new Set<string>();
  const taggedNodeMap = new Map<string, AddTagOperation>();

  for (const raw of capped) {
    if (!raw || typeof raw !== 'object') continue;
    const op = raw as Record<string, unknown>;
    if (op.type === 'createFolder' || !ALLOWED_OP_TYPES.has(String(op.type))) {
      continue;
    }

    const nodeId = sanitizePlainText(op.nodeId, 64);
    const node = flattened.byId.get(nodeId);
    if (!node || !inScopeIds.has(nodeId)) {
      rejectedCount++;
      warnings.push(`已擋下範圍外或不存在的書籤操作：${nodeId || '(空)'}`);
      continue;
    }
    if (!node.writable) {
      rejectedCount++;
      warnings.push(`已擋下唯讀或受管理書籤的操作：${node.title}`);
      continue;
    }

    const reason = sanitizePlainText(op.reason, 200) || '依規則/指令建議';
    const confidence =
      typeof op.confidence === 'number' &&
      Number.isFinite(op.confidence) &&
      op.confidence >= 0 &&
      op.confidence <= 1
        ? op.confidence
        : undefined;

    if (op.type === 'moveBookmark') {
      if (movedNodeIds.has(nodeId)) {
        warnings.push(`略過對同一書籤「${node.title}」的重複搬移建議。`);
        continue;
      }

      const toParentId = sanitizePlainText(op.toParentId, 64) || undefined;
      const toTempFolderId =
        sanitizePlainText(op.toTempFolderId, 64) || undefined;

      if (!toParentId && !toTempFolderId) {
        rejectedCount++;
        warnings.push(`書籤「${node.title}」的搬移缺少目的資料夾。`);
        continue;
      }

      let toPath = '';
      let dependsOnOpId: string | undefined;
      let targetSyncing: boolean | undefined;
      let targetTitleLower = '';

      let destinationOutOfScope = false;
      if (toTempFolderId) {
        const tempInfo = tempFolderMap.get(toTempFolderId);
        if (!tempInfo) {
          rejectedCount++;
          warnings.push(
            `書籤「${node.title}」引用不存在的待建立資料夾：${toTempFolderId}`,
          );
          continue;
        }
        destinationOutOfScope = tempInfo.outOfScope;
        toPath = tempInfo.path;
        dependsOnOpId = tempInfo.opId;
        targetSyncing = tempInfo.syncing;
        targetTitleLower = tempInfo.title.toLowerCase();
      } else if (toParentId) {
        const targetFolder = flattened.byId.get(toParentId);
        if (!targetFolder || !targetFolder.isFolder || !targetFolder.canAddChild) {
          rejectedCount++;
          warnings.push(`目的資料夾不可寫入或不存在：${toParentId}`);
          continue;
        }
        if (node.isFolder && wouldCreateCycle(nodeId, toParentId, flattened.byId)) {
          rejectedCount++;
          warnings.push(`已擋下資料夾循環搬移：${node.title}`);
          continue;
        }
        if (node.parentId === toParentId) {
          // Already in destination folder — no-op
          continue;
        }
        destinationOutOfScope = !allowedDestinationIds.has(toParentId);
        toPath = targetFolder.path;
        targetSyncing = targetFolder.syncing;
        targetTitleLower = targetFolder.title.trim().toLowerCase();
      }

      const sourceParent = flattened.byId.get(node.parentId);
      const reviewReasons: string[] = [];
      if (op.requiresReview === true) {
        reviewReasons.push(
          sanitizePlainText(op.reviewReason, 160) || '可能跨主題或需人工判斷',
        );
      }
      if (confidence !== undefined && confidence < 0.7) {
        reviewReasons.push(`模型信心度較低 (${Math.round(confidence * 100)}%)`);
      }
      if (
        typeof sourceParent?.syncing === 'boolean' &&
        typeof targetSyncing === 'boolean' &&
        sourceParent.syncing !== targetSyncing
      ) {
        reviewReasons.push('跨本機與帳戶書籤區域搬移');
      }
      if (
        !toTempFolderId &&
        targetTitleLower &&
        (folderNameCounts.get(targetTitleLower) ?? 0) > 1
      ) {
        reviewReasons.push('目的資料夾存在同名資料夾，請確認路徑');
      }

      if (destinationOutOfScope) {
        reviewReasons.push(OUT_OF_SCOPE_REASON);
      }

      const requiresReview = reviewReasons.length > 0;
      movedNodeIds.add(nodeId);

      moveOps.push({
        opId: `op_${opSeq++}`,
        type: 'moveBookmark',
        enabled: !requiresReview,
        requiresReview,
        reviewReason: reviewReasons.join('；') || undefined,
        confidence,
        reason,
        dependsOnOpId,
        nodeId,
        bookmarkTitle: node.title,
        bookmarkUrl: node.url,
        fromParentId: node.parentId,
        fromIndex: node.index,
        fromPath: sourceParent?.path ?? '',
        toParentId: toTempFolderId ? undefined : toParentId,
        toTempFolderId,
        toPath,
      });
    } else if (op.type === 'renameBookmark') {
      if (renamedNodeIds.has(nodeId)) {
        warnings.push(`略過對「${node.title}」的重複重新命名。`);
        continue;
      }
      const newTitle = sanitizePlainText(op.newTitle, 160);
      if (!newTitle || newTitle === node.title) {
        continue;
      }
      renamedNodeIds.add(nodeId);
      // Renames only come from model output and rewrite user-visible data, so they are
      // never pre-selected: the user must read the proposed title and tick it.
      renameOps.push({
        opId: `op_${opSeq++}`,
        type: 'renameBookmark',
        enabled: false,
        requiresReview: true,
        reviewReason: '模型建議的新標題，請確認內容後再勾選',
        confidence,
        reason,
        nodeId,
        parentId: node.parentId,
        oldTitle: node.title,
        newTitle,
        path: node.path,
      });
    } else if (op.type === 'addTag') {
      const rawTags = Array.isArray(op.tagsToAdd) ? op.tagsToAdd : [];
      const existingTags = metadataByNodeId.get(nodeId)?.tags ?? [];
      const existingLower = new Set(existingTags.map((t) => t.toLowerCase()));
      const cleanedTags = Array.from(
        new Set(
          rawTags
            .map((t) => sanitizePlainText(t, 40))
            .filter((t) => t.length > 0 && !existingLower.has(t.toLowerCase())),
        ),
      ).slice(0, 8);

      if (cleanedTags.length === 0) continue;

      const existingOp = taggedNodeMap.get(nodeId);
      if (existingOp) {
        const merged = Array.from(
          new Set([...existingOp.tagsToAdd, ...cleanedTags]),
        ).slice(0, 8);
        existingOp.tagsToAdd = merged;
      } else {
        const tagOp: AddTagOperation = {
          opId: `op_${opSeq++}`,
          type: 'addTag',
          enabled: true,
          confidence,
          reason,
          nodeId,
          bookmarkTitle: node.title,
          tagsToAdd: cleanedTags,
          existingTags,
        };
        taggedNodeMap.set(nodeId, tagOp);
        tagOps.push(tagOp);
      }
    }
  }

  return {
    operations: [...createFolderOps, ...moveOps, ...renameOps, ...tagOps],
    warnings,
    rejectedCount,
  };
}

interface RuleCategory {
  name: string;
  keywords: string[];
}

function extractRequestedCategoriesFromInstruction(
  instruction: string,
): RuleCategory[] {
  const trimmed = instruction.trim();
  if (!trimmed) return [];

  // Pattern 1: Chinese "依 A、B、C 分類" / "按 A, B, C 整理"
  const zhMatch = trimmed.match(
    /(?:依|照|按|分成|分為|歸類為|分類為)\s*([^\n。！？]+?)(?:分類|整理|歸類|$)/,
  );
  // Pattern 2: English "by A, B, and C" / "into A, B, C"
  const enMatch = trimmed.match(
    /(?:by|into)\s+([A-Za-z0-9\u3400-\u9fff_\-,\s/、]+?)(?:\s+folders?|\.|$)/i,
  );

  const rawList = zhMatch?.[1] ?? enMatch?.[1] ?? '';
  if (!rawList) return [];

  const parts = rawList
    .split(/[、,，/]|(?:\s+(?:and|與|和|及)\s*)|(?:與|和|及)/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1 && s.length <= 32);

  const uniqueNames = Array.from(new Set(parts));
  return uniqueNames.map((name) => {
    const lower = name.toLowerCase();
    const keywords = [lower];
    // Add helpful well-known aliases for common developer topics
    if (lower === 'kv') keywords.push('workers-kv', 'key-value', '/kv');
    if (lower === 'r2') keywords.push('r2-storage', 'object storage', '/r2');
    if (lower === 'queues' || lower === 'queue')
      keywords.push('queue', 'queues', '/queues');
    if (lower === 'd1') keywords.push('d1 database', '/d1');
    if (lower === 'durable objects') keywords.push('durable-objects');
    return { name, keywords };
  });
}

function defaultKeywordCategories(): RuleCategory[] {
  return [
    {
      name: '開發與技術',
      keywords: [
        'github.com',
        'gitlab.com',
        'stackoverflow',
        'npmjs',
        'developer.',
        'docs.',
        'mdn',
        'cloudflare',
        'workers',
        'vercel',
        'typescript',
        'react',
        'api',
      ],
    },
    {
      name: '設計與靈感',
      keywords: [
        'figma',
        'dribbble',
        'behance',
        'awwwards',
        'design',
        'ux',
        'ui',
        '設計',
        '配色',
        '字體',
        'pinterest',
      ],
    },
    {
      name: 'AI 與工具',
      keywords: [
        'lmstudio',
        'openai',
        'gemini',
        'anthropic',
        'claude',
        'huggingface',
        'notion',
        'llm',
        'ai',
        '工具',
      ],
    },
    {
      name: '新聞與閱讀',
      keywords: [
        'news',
        'medium.com',
        'substack',
        'blog',
        'article',
        'wiki',
        '新聞',
        '專欄',
        '文章',
        '閱讀',
      ],
    },
    {
      name: '購物與生活',
      keywords: [
        'amazon',
        'shopee',
        'momo',
        'pchome',
        'shop',
        'store',
        '電商',
        '購物',
        '銀行',
        'bank',
      ],
    },
  ];
}

function matchCategoriesForBookmark(
  b: BookmarkProjection,
  categories: RuleCategory[],
): RuleCategory[] {
  const haystack = `${b.title} ${b.domain} ${b.url ?? ''}`.toLowerCase();
  const matched: RuleCategory[] = [];
  for (const cat of categories) {
    const hit = cat.keywords.some((kw) => {
      if (kw.length <= 3 && /^[a-z0-9]+$/.test(kw)) {
        const boundaryRe = new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`, 'i');
        return boundaryRe.test(haystack);
      }
      return haystack.includes(kw);
    });
    if (hit) matched.push(cat);
  }
  return matched;
}

export function generateRuleBasedPlan(params: {
  flattened: FlattenedTree;
  scope: PlanScope;
  instruction: string;
  metadataByNodeId: Map<string, BookmarkMetadata>;
  profileKey: string;
  snapshotId: string;
  baseParentId?: string;
}): OrganizePlan {
  const {
    flattened,
    scope,
    instruction,
    metadataByNodeId,
    profileKey,
    snapshotId,
  } = params;

  const { inScopeBookmarks } = collectScopeNodes(flattened, scope);
  const writableBookmarks = inScopeBookmarks.filter((b) => b.writable);

  // Choose base parent folder for new category subfolders
  let baseParentId = params.baseParentId;
  if (!baseParentId || !flattened.byId.get(baseParentId)?.canAddChild) {
    if (scope.type === 'folder' && scope.folderId) {
      baseParentId = scope.folderId;
    } else if (scope.targetFolderIds.length > 0) {
      baseParentId = scope.targetFolderIds[0];
    } else {
      const firstWritable = flattened.projections.find(
        (p) => p.isFolder && p.canAddChild,
      );
      baseParentId = firstWritable?.nodeId ?? '1';
    }
  }

  const parsedCategories = extractRequestedCategoriesFromInstruction(instruction);
  const tagOnlyMode =
    /(?:只|僅).*(?:標籤|tag)|不動資料夾|補上.*標籤/i.test(instruction);
  const groupByDomainMode =
    parsedCategories.length === 0 &&
    !tagOnlyMode &&
    /(?:依|按).*(?:網域|網站|domain)/i.test(instruction);

  const categories =
    parsedCategories.length > 0 ? parsedCategories : defaultKeywordCategories();

  // Check existing subfolders under baseParentId
  const existingChildren = flattened.childrenByParent.get(baseParentId) ?? [];
  const existingFolderByName = new Map<string, BookmarkProjection>();
  for (const child of existingChildren) {
    if (child.isFolder && child.canAddChild) {
      existingFolderByName.set(child.title.trim().toLowerCase(), child);
    }
  }

  const draftOps: DraftOperationInput[] = [];
  const createdTempByCat = new Map<string, string>();
  let tempSeq = 1;

  const ensureCategoryTarget = (
    catName: string,
  ): { toParentId?: string; toTempFolderId?: string } => {
    const existing = existingFolderByName.get(catName.toLowerCase());
    if (existing) {
      return { toParentId: existing.nodeId };
    }
    let tempId = createdTempByCat.get(catName.toLowerCase());
    if (!tempId) {
      tempId = `temp_folder_${tempSeq++}`;
      createdTempByCat.set(catName.toLowerCase(), tempId);
      draftOps.push({
        type: 'createFolder',
        tempFolderId: tempId,
        parentId: baseParentId!,
        title: catName,
        reason: `建立「${catName}」分類資料夾`,
      });
    }
    return { toTempFolderId: tempId };
  };

  if (groupByDomainMode) {
    const byDomain = new Map<string, BookmarkProjection[]>();
    for (const b of writableBookmarks) {
      if (!b.domain) continue;
      const rootDomain = b.domain.replace(/^www\./, '');
      const list = byDomain.get(rootDomain) ?? [];
      list.push(b);
      byDomain.set(rootDomain, list);
    }
    for (const [domain, list] of byDomain.entries()) {
      if (list.length < 2) continue;
      const target = ensureCategoryTarget(domain);
      for (const b of list) {
        draftOps.push({
          type: 'moveBookmark',
          nodeId: b.nodeId,
          ...target,
          confidence: 0.92,
          reason: `同網域「${domain}」集中整理`,
        });
      }
    }
  } else {
    for (const b of writableBookmarks) {
      const matched = matchCategoriesForBookmark(b, categories);
      if (matched.length === 1) {
        const cat = matched[0];
        if (!tagOnlyMode) {
          const target = ensureCategoryTarget(cat.name);
          draftOps.push({
            type: 'moveBookmark',
            nodeId: b.nodeId,
            ...target,
            confidence: 0.9,
            reason: `標題/網址符合關鍵字「${cat.name}」`,
          });
        }
        draftOps.push({
          type: 'addTag',
          nodeId: b.nodeId,
          tagsToAdd: [cat.name],
          confidence: 0.9,
          reason: `標記主題標籤「${cat.name}」`,
        });
      } else if (matched.length > 1) {
        // Multi-topic bookmark: suggest tags for all matched topics, and mark move as requiresReview
        const names = matched.map((m) => m.name);
        if (!tagOnlyMode) {
          const primary = matched[0];
          const target = ensureCategoryTarget(primary.name);
          draftOps.push({
            type: 'moveBookmark',
            nodeId: b.nodeId,
            ...target,
            confidence: 0.55,
            requiresReview: true,
            reviewReason: `同時符合多個分類（${names.join('、')}），留待人工選擇`,
            reason: `跨服務/跨主題內容（${names.join('、')}）`,
          });
        }
        draftOps.push({
          type: 'addTag',
          nodeId: b.nodeId,
          tagsToAdd: names,
          confidence: 0.85,
          reason: `跨主題書籤加上多標籤（${names.join('、')}）`,
        });
      }
    }
  }

  const effectiveScope: PlanScope = {
    ...scope,
    targetFolderIds: Array.from(new Set([...scope.targetFolderIds, baseParentId])),
  };

  const validated = validatePlanDraft({
    draftOps,
    flattened,
    scope: effectiveScope,
    metadataByNodeId,
  });

  const now = Date.now();
  return {
    planId: makeId('plan'),
    profileKey,
    revision: 1,
    snapshotId,
    scope: effectiveScope,
    scopeFingerprint: computeScopeFingerprint(flattened, effectiveScope),
    instruction: instruction.trim() || '本機關鍵字與網域分類',
    source: 'rule',
    operations: validated.operations,
    status: 'draft',
    warnings: validated.warnings,
    createdAt: now,
    updatedAt: now,
  };
}

export function createPlanFromValidatedDraft(params: {
  draftOps: unknown[];
  flattened: FlattenedTree;
  scope: PlanScope;
  instruction: string;
  source: PlanSource;
  fallbackFrom?: string;
  metadataByNodeId: Map<string, BookmarkMetadata>;
  profileKey: string;
  snapshotId: string;
  extraWarnings?: string[];
}): OrganizePlan {
  const {
    draftOps,
    flattened,
    scope,
    instruction,
    source,
    fallbackFrom,
    metadataByNodeId,
    profileKey,
    snapshotId,
    extraWarnings = [],
  } = params;

  const validated = validatePlanDraft({
    draftOps,
    flattened,
    scope,
    metadataByNodeId,
  });

  const now = Date.now();
  return {
    planId: makeId('plan'),
    profileKey,
    revision: 1,
    snapshotId,
    scope,
    scopeFingerprint: computeScopeFingerprint(flattened, scope),
    instruction,
    source,
    fallbackFrom,
    operations: validated.operations,
    status: 'draft',
    warnings: [...extraWarnings, ...validated.warnings],
    createdAt: now,
    updatedAt: now,
  };
}

export function getDependentOperations(
  plan: OrganizePlan,
  createFolderOpId: string,
): MoveBookmarkOperation[] {
  return plan.operations.filter(
    (op): op is MoveBookmarkOperation =>
      op.type === 'moveBookmark' && op.dependsOnOpId === createFolderOpId,
  );
}

export function togglePlanOperation(
  plan: OrganizePlan,
  opId: string,
  enabled: boolean,
): { plan: OrganizePlan; affectedDependentOpIds: string[] } {
  const target = plan.operations.find((o) => o.opId === opId);
  if (!target) return { plan, affectedDependentOpIds: [] };

  const affectedDependentOpIds: string[] = [];
  const nextOps = plan.operations.map((op) => {
    if (op.opId === opId) {
      return { ...op, enabled };
    }
    if (
      target.type === 'createFolder' &&
      !enabled &&
      op.type === 'moveBookmark' &&
      op.dependsOnOpId === target.opId
    ) {
      affectedDependentOpIds.push(op.opId);
      return { ...op, enabled: false };
    }
    // Re-enabling a move that depends on a disabled createFolder automatically re-enables the folder
    if (
      target.type === 'moveBookmark' &&
      enabled &&
      target.dependsOnOpId &&
      op.opId === target.dependsOnOpId &&
      !op.enabled
    ) {
      affectedDependentOpIds.push(op.opId);
      return { ...op, enabled: true };
    }
    return op;
  });

  return {
    plan: {
      ...plan,
      revision: plan.revision + 1,
      operations: nextOps,
      updatedAt: Date.now(),
    },
    affectedDependentOpIds,
  };
}

export type DeadLinkCleanupAction = 'quarantine' | 'remove';

export const DEFAULT_QUARANTINE_FOLDER_NAME = '失效連結待清理';

/**
 * Generates a previewable cleanup plan for bookmarks flagged by dead-link checks.
 * Supports BOTH:
 * - 'quarantine' (Option A): move into a writable quarantine folder + tag `#失效待查` (reversible to original folder)
 * - 'remove' (Option B): explicit `removeBookmark` ops (always `requiresReview: true`, `enabled: false` until user ticks them, reversible via snapshot & recreate)
 *
 * Note: `removeBookmark` is strictly generated here from verified link-check records and
 * NEVER allowed from AI model output (`ALLOWED_OP_TYPES` excludes `removeBookmark`).
 */
export function generateDeadLinkCleanupPlan(params: {
  flattened: FlattenedTree;
  scope: PlanScope;
  metadataByNodeId: Map<string, BookmarkMetadata>;
  profileKey: string;
  snapshotId: string;
  action: DeadLinkCleanupAction;
  baseParentId?: string;
  quarantineFolderName?: string;
  includeUnreachable?: boolean;
}): OrganizePlan {
  const {
    flattened,
    scope,
    metadataByNodeId,
    profileKey,
    snapshotId,
    action,
    quarantineFolderName = DEFAULT_QUARANTINE_FOLDER_NAME,
    includeUnreachable = false,
  } = params;

  const { inScopeBookmarks } = collectScopeNodes(flattened, scope);
  let staleCheckCount = 0;
  const deadBookmarks = inScopeBookmarks.filter((b) => {
    if (b.isFolder || !b.writable) return false;
    const linkCheck = metadataByNodeId.get(b.nodeId)?.linkCheck;
    if (!isDeadLinkCandidate(linkCheck?.status, includeUnreachable)) return false;
    // Never act on a result that was recorded for a different (since edited) URL
    if (!isLinkCheckCurrent(linkCheck, b.url)) {
      staleCheckCount++;
      return false;
    }
    return true;
  });

  const warnings: string[] = [];
  if (staleCheckCount > 0) {
    warnings.push(
      `有 ${staleCheckCount} 筆書籤的失效檢查結果已過期（網址已變更或為舊版紀錄），已排除；請重新執行「檢查失效連結」。`,
    );
  }
  if (deadBookmarks.length === 0) {
    warnings.push(
      includeUnreachable
        ? '所選範圍內沒有標記為 404/410 或無法連線的書籤，請先執行「檢查失效連結」。'
        : '所選範圍內沒有標記為 404/410 的書籤；請先執行「檢查失效連結」，或勾選納入「無法連線」項目。',
    );
  }

  let baseParentId = params.baseParentId;
  if (!baseParentId || !flattened.byId.get(baseParentId)?.canAddChild) {
    if (scope.type === 'folder' && scope.folderId && flattened.byId.get(scope.folderId)?.canAddChild) {
      baseParentId = scope.folderId;
    } else if (scope.targetFolderIds.length > 0 && flattened.byId.get(scope.targetFolderIds[0])?.canAddChild) {
      baseParentId = scope.targetFolderIds[0];
    } else {
      baseParentId =
        flattened.projections.find((p) => p.isFolder && p.canAddChild)?.nodeId ??
        '1';
    }
  }

  const operations: PlanOperation[] = [];
  let opSeq = 1;

  if (action === 'quarantine' && deadBookmarks.length > 0) {
    const baseFolder = flattened.byId.get(baseParentId)!;
    const existingChildren = flattened.childrenByParent.get(baseParentId) ?? [];
    const existingQuarantine = existingChildren.find(
      (c) =>
        c.isFolder &&
        c.canAddChild &&
        c.title.trim().toLowerCase() === quarantineFolderName.toLowerCase(),
    );

    let createOpId: string | undefined;
    let tempFolderId: string | undefined;
    let targetFolderId: string | undefined;
    let targetPath: string;

    if (existingQuarantine) {
      targetFolderId = existingQuarantine.nodeId;
      targetPath = existingQuarantine.path || existingQuarantine.title;
    } else {
      createOpId = `op_dead_${opSeq++}`;
      tempFolderId = 'temp_dead_quarantine';
      targetPath = baseFolder.path
        ? `${baseFolder.path} / ${quarantineFolderName}`
        : quarantineFolderName;
      operations.push({
        opId: createOpId,
        type: 'createFolder',
        enabled: true,
        tempFolderId,
        parentId: baseParentId,
        title: quarantineFolderName,
        parentPath: baseFolder.path,
        reason: '建立失效連結待清理資料夾（可一鍵復原原位置）',
      });
    }

    for (const b of deadBookmarks) {
      if (targetFolderId && b.parentId === targetFolderId) continue;
      const check = metadataByNodeId.get(b.nodeId)?.linkCheck;
      const statusText =
        check?.status === 'dead_404_410'
          ? `HTTP ${check.httpStatus ?? 404} 失效`
          : '無法連線 / DNS 失敗';
      const sourceParent = flattened.byId.get(b.parentId);

      operations.push({
        opId: `op_dead_${opSeq++}`,
        type: 'moveBookmark',
        // Default 404/410 enabled for quarantine (safe non-destructive move), unreachable requires explicit review
        enabled: check?.status === 'dead_404_410',
        requiresReview: check?.status !== 'dead_404_410',
        reviewReason:
          check?.status !== 'dead_404_410'
            ? '無法連線可能為暫時性離線或網路限制，請確認後再移入待清理區'
            : undefined,
        reason: `失效連結檢查結果：${statusText}${check?.note ? `（${check.note}）` : ''}`,
        dependsOnOpId: createOpId,
        nodeId: b.nodeId,
        bookmarkTitle: b.title,
        bookmarkUrl: b.url,
        fromParentId: b.parentId,
        fromIndex: b.index,
        fromPath: sourceParent?.path ?? '',
        toParentId: targetFolderId,
        toTempFolderId: tempFolderId,
        toPath: targetPath,
      });

      const existingTags = metadataByNodeId.get(b.nodeId)?.tags ?? [];
      if (!existingTags.includes('失效待查')) {
        operations.push({
          opId: `op_dead_${opSeq++}`,
          type: 'addTag',
          enabled: check?.status === 'dead_404_410',
          reason: `標記失效狀態（${statusText}）`,
          nodeId: b.nodeId,
          bookmarkTitle: b.title,
          tagsToAdd: ['失效待查'],
          existingTags,
        });
      }
    }
  } else if (action === 'remove' && deadBookmarks.length > 0) {
    warnings.push(
      '為避免誤刪，所有「直接移除」項目預設皆未勾選；請逐筆確認（或點「全選 404/410」）後再套用。移除前會保存快照並可於歷程頁復原重建。',
    );
    for (const b of deadBookmarks) {
      const check = metadataByNodeId.get(b.nodeId)?.linkCheck;
      const statusText =
        check?.status === 'dead_404_410'
          ? `HTTP ${check.httpStatus ?? 404}`
          : '無法連線 / DNS 失敗';
      const removeOp: RemoveBookmarkOperation = {
        opId: `op_dead_${opSeq++}`,
        type: 'removeBookmark',
        enabled: false,
        requiresReview: true,
        reviewReason: `高風險刪除確認（${statusText}）`,
        reason: check?.note || `失效連結檢查：${statusText}`,
        nodeId: b.nodeId,
        bookmarkTitle: b.title,
        bookmarkUrl: b.url,
        parentId: b.parentId,
        index: b.index,
        path: b.path,
        linkStatus: check?.status,
        httpStatus: check?.httpStatus,
        removalKind: 'dead_link',
      };
      operations.push(removeOp);
    }
  }

  const effectiveScope: PlanScope = {
    ...scope,
    targetFolderIds: Array.from(
      new Set([...scope.targetFolderIds, ...(action === 'quarantine' ? [baseParentId] : [])]),
    ),
  };

  const now = Date.now();
  return {
    planId: makeId('plan'),
    profileKey,
    revision: 1,
    snapshotId,
    scope: effectiveScope,
    scopeFingerprint: computeScopeFingerprint(flattened, effectiveScope),
    instruction:
      action === 'quarantine'
        ? `失效連結整理：移至「${quarantineFolderName}」`
        : '失效連結整理：人工確認後移除失效書籤',
    source: 'rule',
    operations,
    status: 'draft',
    warnings,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * True when an organize instruction asks to remove / clean up duplicate bookmarks.
 * Such requests are answered by the deterministic duplicate planner, never by the model
 * (model output is not allowed to remove bookmarks).
 */
export function isDuplicateCleanupInstruction(instruction: string): boolean {
  const text = instruction.trim();
  if (!text) return false;
  if (/去重|dedup|de-dup|(remove|delete|clean\s*up|merge)\s+(the\s+)?duplicates?/i.test(text)) {
    return true;
  }
  return (
    /重複/.test(text) &&
    /移除|刪除|刪掉|清理|清除|只留|只保留|保留一|合併|整理/.test(text)
  );
}

/**
 * Builds a previewable cleanup plan for duplicate bookmarks:
 * - exact duplicates (identical URL): keep the earliest-added copy, propose removing the
 *   other copies (pre-ticked) and merge their tags into the kept copy;
 * - suspected duplicates (tracking params / same title): proposed but never pre-ticked.
 * Only copies inside `scope` are removed; the kept copy may live anywhere, so at least one
 * copy of every URL always survives. Removals are snapshotted and reversible.
 */
export function generateDuplicateCleanupPlan(params: {
  flattened: FlattenedTree;
  scope: PlanScope;
  metadataByNodeId: Map<string, BookmarkMetadata>;
  profileKey: string;
  snapshotId: string;
  instruction?: string;
}): OrganizePlan {
  const { flattened, scope, metadataByNodeId, profileKey, snapshotId } = params;
  const { inScopeBookmarks } = collectScopeNodes(flattened, scope);
  const inScopeIds = new Set(inScopeBookmarks.map((b) => b.nodeId));

  const effectiveDate = (b: BookmarkProjection) =>
    metadataByNodeId.get(b.nodeId)?.originalDateAdded ??
    b.dateAdded ??
    Number.MAX_SAFE_INTEGER;
  const pickKeeper = (members: BookmarkProjection[]) =>
    [...members].sort(
      (a, b) =>
        effectiveDate(a) - effectiveDate(b) ||
        Number(a.nodeId) - Number(b.nodeId) ||
        a.nodeId.localeCompare(b.nodeId),
    )[0];

  const groups = findDuplicateGroups(flattened.projections);
  const operations: PlanOperation[] = [];
  const removedIds = new Set<string>();
  const keptIds = new Set<string>();
  const mergedTagsByKeeper = new Map<string, Set<string>>();
  let opSeq = 1;
  let exactGroups = 0;
  let suspectedGroups = 0;

  const proposeRemoval = (
    victim: BookmarkProjection,
    keeper: BookmarkProjection,
    kind: 'duplicate_exact' | 'duplicate_suspected',
    groupReason: string,
  ) => {
    const keeperPath = flattened.byId.get(keeper.parentId)?.path ?? '';
    operations.push({
      opId: `op_dup_${opSeq++}`,
      type: 'removeBookmark',
      enabled: kind === 'duplicate_exact',
      requiresReview: kind === 'duplicate_suspected',
      reviewReason:
        kind === 'duplicate_suspected' ? `疑似重複：${groupReason}` : undefined,
      reason:
        kind === 'duplicate_exact'
          ? `與「${keeper.title || keeper.url}」網址完全相同，保留最早加入的一筆`
          : `${groupReason}；建議保留「${keeper.title || keeper.url}」`,
      nodeId: victim.nodeId,
      bookmarkTitle: victim.title,
      bookmarkUrl: victim.url,
      parentId: victim.parentId,
      index: victim.index,
      // Folder path, matching how the kept copy's location is shown
      path: flattened.byId.get(victim.parentId)?.path ?? victim.path,
      removalKind: kind,
      keepNodeId: keeper.nodeId,
      keepTitle: keeper.title,
      keepPath: keeperPath,
    });
    removedIds.add(victim.nodeId);
  };

  // Exact duplicates first: they are unambiguous.
  for (const group of groups.filter((g) => g.kind === 'exact')) {
    const members = group.nodeIds
      .map((id) => flattened.byId.get(id))
      .filter((m): m is BookmarkProjection => Boolean(m));
    if (members.length < 2) continue;
    const keeper = pickKeeper(members);
    let proposed = 0;
    for (const m of members) {
      if (m.nodeId === keeper.nodeId || !m.writable || !inScopeIds.has(m.nodeId)) continue;
      proposeRemoval(m, keeper, 'duplicate_exact', group.reason);
      proposed++;
      const tags = metadataByNodeId.get(m.nodeId)?.tags ?? [];
      if (tags.length > 0) {
        const merged = mergedTagsByKeeper.get(keeper.nodeId) ?? new Set<string>();
        tags.forEach((t) => merged.add(t));
        mergedTagsByKeeper.set(keeper.nodeId, merged);
      }
    }
    if (proposed > 0) {
      exactGroups++;
      keptIds.add(keeper.nodeId);
    }
  }

  // Suspected duplicates: consider only copies that survive the exact pass.
  for (const group of groups.filter((g) => g.kind === 'suspected')) {
    const members = group.nodeIds
      .map((id) => flattened.byId.get(id))
      .filter((m): m is BookmarkProjection => Boolean(m) && !removedIds.has(m!.nodeId));
    if (members.length < 2) continue;
    const keeper = pickKeeper(members);
    let proposed = 0;
    for (const m of members) {
      if (
        m.nodeId === keeper.nodeId ||
        keptIds.has(m.nodeId) ||
        !m.writable ||
        !inScopeIds.has(m.nodeId) ||
        removedIds.has(m.nodeId)
      ) {
        continue;
      }
      proposeRemoval(m, keeper, 'duplicate_suspected', group.reason);
      proposed++;
    }
    if (proposed > 0) suspectedGroups++;
  }

  // Keep the tags of removed exact copies on the surviving bookmark.
  for (const [keeperId, tagSet] of mergedTagsByKeeper) {
    const keeper = flattened.byId.get(keeperId);
    if (!keeper) continue;
    const existingTags = metadataByNodeId.get(keeperId)?.tags ?? [];
    const toAdd = [...tagSet].filter((t) => !existingTags.includes(t));
    if (toAdd.length === 0) continue;
    operations.push({
      opId: `op_dup_${opSeq++}`,
      type: 'addTag',
      enabled: true,
      reason: '合併被移除之重複書籤的標籤',
      nodeId: keeperId,
      bookmarkTitle: keeper.title,
      tagsToAdd: toAdd,
      existingTags,
    });
  }

  const exactRemovals = operations.filter(
    (o) => o.type === 'removeBookmark' && o.removalKind === 'duplicate_exact',
  ).length;
  const suspectedRemovals = operations.filter(
    (o) => o.type === 'removeBookmark' && o.removalKind === 'duplicate_suspected',
  ).length;

  const warnings: string[] = [];
  if (exactRemovals + suspectedRemovals === 0) {
    warnings.push('所選範圍內沒有可清理的重複書籤。');
  } else {
    warnings.push(
      `精確重複 ${exactGroups} 組：每組保留最早加入的一筆，其餘 ${exactRemovals} 筆已預設勾選移除。` +
        (suspectedRemovals > 0
          ? ` 疑似重複 ${suspectedGroups} 組（${suspectedRemovals} 筆）未預設勾選，請逐筆確認。`
          : '') +
        ' 移除前會保存快照，可於歷程頁復原。',
    );
  }

  const now = Date.now();
  return {
    planId: makeId('plan'),
    profileKey,
    revision: 1,
    snapshotId,
    scope,
    scopeFingerprint: computeScopeFingerprint(flattened, scope),
    instruction: params.instruction?.trim() || '重複書籤清理：每組保留最早加入的一筆',
    source: 'rule',
    operations,
    status: 'draft',
    warnings,
    createdAt: now,
    updatedAt: now,
  };
}

export function enableDead404Removals(plan: OrganizePlan): OrganizePlan {
  const nextOps = plan.operations.map((op) => {
    if (op.type === 'removeBookmark' && op.linkStatus === 'dead_404_410') {
      return { ...op, enabled: true };
    }
    return op;
  });
  return {
    ...plan,
    revision: plan.revision + 1,
    operations: nextOps,
    updatedAt: Date.now(),
  };
}

export function overrideMoveDestination(
  plan: OrganizePlan,
  opId: string,
  newParentId: string,
  newPath: string,
): OrganizePlan {
  const nextOps = plan.operations.map((op) => {
    if (op.opId !== opId || op.type !== 'moveBookmark') return op;
    return {
      ...op,
      toParentId: newParentId,
      toTempFolderId: undefined,
      dependsOnOpId: undefined,
      toPath: newPath,
      requiresReview: false,
      reviewReason: undefined,
      enabled: true,
    };
  });

  // NOTE: `plan.scope` is deliberately left untouched. It is the input of
  // `scopeFingerprint`; mutating it here made every overridden plan look stale and
  // permanently blocked apply. The executor re-validates the new destination live.
  return {
    ...plan,
    revision: plan.revision + 1,
    operations: nextOps,
    updatedAt: Date.now(),
  };
}
