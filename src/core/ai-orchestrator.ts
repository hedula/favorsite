import {
  buildSanitizedAiBatch,
} from './ai-schema';
import {
  collectScopeNodes,
  getWritableFolders,
  type FlattenedTree,
} from './bookmark-engine';
import { collectAllowedDestinationIds } from './planner';
import {
  createPlanFromValidatedDraft,
  generateDuplicateCleanupPlan,
  generateRuleBasedPlan,
  isDuplicateCleanupInstruction,
  type DraftOperationInput,
} from './planner';
import {
  probePromptApiAvailability,
  requestChromePromptApiPlan,
  type LanguageModelGlobal,
} from './prompt-api';
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
    lmGlobal,
  } = params;

  // "Remove duplicates" needs removals, which model output may never contain:
  // answer it with the deterministic duplicate planner regardless of the engine.
  if (isDuplicateCleanupInstruction(instruction)) {
    return generateDuplicateCleanupPlan({
      flattened,
      scope,
      metadataByNodeId,
      profileKey,
      snapshotId,
      instruction,
    });
  }

  // Direct rule mode — never touches any model
  if (preferredProvider === 'rule') {
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

  const { inScopeBookmarks } = collectScopeNodes(flattened, scope);
  const writableFolders = getWritableFolders(flattened.projections);
  const batch = buildSanitizedAiBatch({
    bookmarks: inScopeBookmarks,
    writableFolders,
    metadataByNodeId,
    includePath: settings.includePathInAi,
    priorityFolderIds: collectAllowedDestinationIds(flattened, scope),
  });

  const fallbackNotes: string[] = [];
  if ((batch.truncatedBookmarks ?? 0) > 0) {
    fallbackNotes.push(
      `本次僅分析前 ${batch.bookmarks.length} 筆書籤，另有 ${batch.truncatedBookmarks} 筆未送入模型；請縮小範圍分批整理。`,
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

  // Tier 1: Chrome Prompt API (Gemini Nano)
  if (precomputedChromeAiDraft) {
    return createPlanFromValidatedDraft({
      draftOps: precomputedChromeAiDraft.draftOps,
      flattened,
      scope,
      instruction,
      source: 'chrome-prompt-api',
      metadataByNodeId,
      profileKey,
      snapshotId,
      extraWarnings: [...fallbackNotes, ...precomputedChromeAiDraft.warnings],
    });
  }

  if (precomputedChromeAiError) {
    fallbackNotes.push(`Chrome Prompt API 無法使用：${precomputedChromeAiError}`);
  } else if (batch.bookmarks.length > 0) {
    const probe = await probePromptApiAvailability(lmGlobal);
    if (probe.supported && probe.availability === 'available') {
      try {
        const aiRes = await requestChromePromptApiPlan({
          instruction,
          batch,
          lmGlobal,
          hasUserGesture: false,
        });
        return createPlanFromValidatedDraft({
          draftOps: aiRes.draftOps,
          flattened,
          scope,
          instruction,
          source: 'chrome-prompt-api',
          metadataByNodeId,
          profileKey,
          snapshotId,
          extraWarnings: [...fallbackNotes, ...aiRes.warnings],
        });
      } catch (err) {
        fallbackNotes.push(
          `Chrome Prompt API 執行失敗（${err instanceof Error ? err.message : String(err)}）`,
        );
      }
    } else if (probe.supported) {
      fallbackNotes.push(
        `Chrome 內建模型狀態為 ${probe.availability}，需透過頁面點擊手勢下載；已改用本機離線規則模式。`,
      );
    } else {
      fallbackNotes.push(`Chrome Prompt API 不可用：${probe.reason}`);
    }
  } else {
    fallbackNotes.push('所選範圍內無一般 http/https 書籤可供模型分析。');
  }

  // Tier 2: Guaranteed offline local rule engine degradation
  const rulePlan = generateRuleBasedPlan({
    flattened,
    scope,
    instruction,
    metadataByNodeId,
    profileKey,
    snapshotId,
    baseParentId,
  });

  const degradationReason =
    fallbackNotes.length > 0
      ? [
          ...fallbackNotes,
          '已自動降級為「本機離線規則模式」，所有整理仍於本機完成且無外部網路連線。',
        ]
      : ['已使用本機離線規則模式產生預覽方案。'];

  return {
    ...rulePlan,
    fallbackFrom: 'chrome-prompt-api',
    warnings: [...degradationReason, ...rulePlan.warnings],
  };
}
