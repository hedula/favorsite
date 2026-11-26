import {
  buildSanitizedAiBatch,
} from './ai-schema';
import {
  collectScopeNodes,
  getWritableFolders,
  type FlattenedTree,
} from './bookmark-engine';
import {
  collectAllowedDestinationIds,
  createPlanFromValidatedDraft,
  generateDuplicateCleanupPlan,
  generateRuleBasedPlan,
  getDuplicateInstructionIntent,
  isCategoryGroupingInstruction,
  isDomainGroupingInstruction,
  isTagOnlyInstruction,
  type DraftOperationInput,
} from './planner';
import {
  probePromptApiAvailability,
  requestChromePromptApiPlan,
  type LanguageModelGlobal,
} from './prompt-api';
import type { SemanticDraft } from './semantic-classifier';
import type {
  AiProviderPreference,
  AppSettings,
  BookmarkMetadata,
  OrganizePlan,
  PlanScope,
} from './types';

export interface OrchestratePlanParams {
  preferredProvider: AiProviderPreference;
  flattened: FlattenedTree;
  scope: PlanScope;
  instruction: string;
  metadataByNodeId: Map<string, BookmarkMetadata>;
  profileKey: string;
  snapshotId: string;
  baseParentId?: string;
  settings: AppSettings;
  /** Optional pre-generated draft from Studio foreground user-gesture LanguageModel session */
  precomputedChromeAiDraft?: {
    draftOps: DraftOperationInput[];
    warnings: string[];
  };
  /** Optional error captured if foreground Chrome Prompt API attempt failed, triggering automatic fallback */
  precomputedChromeAiError?: string;
  semanticDraft?: SemanticDraft;
  lmGlobal?: LanguageModelGlobal;
}

/**
 * Privacy-first, zero-cost AI orchestration with automatic 2-tier degradation:
 *   1. Chrome Prompt API (LanguageModel / Gemini Nano) — on-device, zero server, zero cost
 *   2. Local Offline Rules — guaranteed deterministic fallback on unsupported hardware
 */
export async function orchestrateOrganizePlan(
  params: OrchestratePlanParams,
): Promise<OrganizePlan> {
  const {
    preferredProvider,
    flattened,
    scope,
    instruction,
    metadataByNodeId,
    profileKey,
    snapshotId,
    baseParentId,
    settings,
    precomputedChromeAiDraft,
    precomputedChromeAiError,
    semanticDraft,
    lmGlobal,
  } = params;

  const duplicateIntent = getDuplicateInstructionIntent(instruction);
  if (duplicateIntent === 'inspect') {
    return createPlanFromValidatedDraft({
      draftOps: [],
      flattened,
      scope,
      instruction,
      source: 'rule',
      metadataByNodeId,
      profileKey,
      snapshotId,
      extraWarnings: ['請到「重複書籤」檢視重複項目。'],
    });
  }

  if (duplicateIntent === 'cleanup') {
    return generateDuplicateCleanupPlan({
      flattened,
      scope,
      metadataByNodeId,
      profileKey,
      snapshotId,
      instruction,
    });
  }

  if (preferredProvider === 'rule' || isDomainGroupingInstruction(instruction)) {
    return generateRuleBasedPlan({
      flattened,
      scope,
      instruction,
      metadataByNodeId,
      profileKey,
      snapshotId,
      baseParentId,
    });
  }

  if (preferredProvider === 'transformers-js') {
    const warnings = semanticDraft?.warnings ?? ['未取得本機語意分類結果，請重新產生預覽。'];
    const backend = semanticDraft?.backend;
    const draftOps = semanticDraft?.draftOps.filter((operation) =>
      operation?.type === 'createFolder' || operation?.type === 'moveBookmark'
    ) ?? [];
    return createPlanFromValidatedDraft({
      draftOps,
      flattened,
      scope,
      instruction,
      source: 'transformers-js',
      metadataByNodeId,
      profileKey,
      snapshotId,
      extraWarnings: backend
        ? [`本機模型使用 ${backend === 'webgpu' ? 'WebGPU' : 'WASM'} 推論。`, ...warnings]
        : warnings,
    });
  }

  const { inScopeBookmarks } = collectScopeNodes(flattened, scope);
  const writableFolders = getWritableFolders(flattened.projections);
  const selectedBaseParentId = baseParentId || scope.targetFolderIds[0];
  const batch = buildSanitizedAiBatch({
    bookmarks: inScopeBookmarks,
    writableFolders,
    metadataByNodeId,
    includePath: settings.includePathInAi,
    baseParentId: selectedBaseParentId,
    priorityFolderIds: collectAllowedDestinationIds(flattened, scope),
  });

  const fallbackNotes: string[] = [];
  if ((batch.truncatedBookmarks ?? 0) > 0) {
    fallbackNotes.push(
      `Gemini Nano 單批僅分析前 ${batch.bookmarks.length} 筆書籤，另有 ${batch.truncatedBookmarks} 筆未送入模型。可縮小範圍分批整理。`,
    );
  }
  if ((batch.truncatedFolders ?? 0) > 0) {
    fallbackNotes.push(
      `可寫資料夾較多，僅提供 ${batch.folders.length} 個（優先為整理範圍內）作為目的地候選。`,
    );
  }
  if (batch.skippedSpecialUrls > 0) {
    fallbackNotes.push(
      `已略過 ${batch.skippedSpecialUrls} 筆非 http/https 特殊協定書籤，未傳送給模型。`,
    );
  }

  let modelDraft = precomputedChromeAiDraft;
  if (!modelDraft && precomputedChromeAiError) {
    fallbackNotes.push(`Gemini Nano 無法產生方案：${precomputedChromeAiError}`);
  } else if (!modelDraft && batch.bookmarks.length > 0) {
    const probe = await probePromptApiAvailability(lmGlobal);
    if (probe.supported && probe.availability === 'available') {
      try {
        modelDraft = await requestChromePromptApiPlan({
          instruction,
          batch,
          lmGlobal,
          hasUserGesture: false,
        });
      } catch (err) {
        fallbackNotes.push(
          `Chrome Prompt API 執行失敗（${err instanceof Error ? err.message : String(err)}）`,
        );
      }
    } else if (probe.supported) {
      fallbackNotes.push(
        `Chrome 內建模型狀態為 ${probe.availability}，需透過頁面點擊手勢下載。`,
      );
    } else {
      fallbackNotes.push(`Chrome Prompt API 不可用：${probe.reason}`);
    }
  } else if (!modelDraft) {
    fallbackNotes.push('所選範圍內無一般 http/https 書籤可供模型分析。');
  }

  if (modelDraft) {
    const tagOnly = isTagOnlyInstruction(instruction);
    const warnings = [...modelDraft.warnings];
    const draftOps = modelDraft.draftOps.filter((op) =>
      (!tagOnly || op?.type === 'addTag') &&
      (op?.type !== 'createFolder' || !selectedBaseParentId || op.parentId === selectedBaseParentId)
    );
    if (draftOps.length !== modelDraft.draftOps.length) {
      warnings.push('已略過與整理指令或所選新建位置不相符的模型操作。');
    }
    const modelPlan = createPlanFromValidatedDraft({
      draftOps,
      flattened,
      scope,
      instruction,
      source: 'chrome-prompt-api',
      metadataByNodeId,
      profileKey,
      snapshotId,
      extraWarnings: warnings,
    });
    const needsMove = !tagOnly && isCategoryGroupingInstruction(instruction);
    const hasMove = modelPlan.operations.some((op) => op.type === 'moveBookmark');
    if (modelPlan.operations.length > 0 && (!needsMove || hasMove)) {
      return { ...modelPlan, warnings: [...fallbackNotes, ...modelPlan.warnings] };
    }
    fallbackNotes.push(
      ...modelPlan.warnings,
      needsMove && modelPlan.operations.length > 0
        ? 'Gemini Nano 未產生分類所需的搬移。'
        : 'Gemini Nano 未產生可用的變更。',
    );
  }

  const rulePlan = generateRuleBasedPlan({
    flattened,
    scope,
    instruction,
    metadataByNodeId,
    profileKey,
    snapshotId,
    baseParentId,
  });

  if (rulePlan.operations.length > 0) {
    fallbackNotes.push('已自動降級為「本機離線規則模式」，依指令產生可預覽的變更。');
  }

  return {
    ...rulePlan,
    fallbackFrom: 'chrome-prompt-api',
    warnings: [...fallbackNotes, ...rulePlan.warnings],
  };
}
