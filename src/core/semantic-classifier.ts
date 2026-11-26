import { buildSanitizedAiBatch } from './ai-schema';
import { collectScopeNodes, type FlattenedTree } from './bookmark-engine';
import {
  createCategoryTargetResolver,
  extractRequestedCategoriesFromInstruction,
  isTagOnlyInstruction,
  matchCategoriesForText,
  type DraftOperationInput,
} from './planner';
import type { BookmarkMetadata, PlanScope } from './types';

export const SEMANTIC_MODEL_ID = 'Xenova/multilingual-e5-small';

export interface EmbeddingBatch {
  vectors: number[][];
  backend: 'webgpu' | 'wasm';
}

export interface SemanticDraft {
  draftOps: DraftOperationInput[];
  warnings: string[];
  backend?: EmbeddingBatch['backend'];
}

const MIN_SIMILARITY = 0.84;
const MIN_SCORE_GAP = 0.03;

const CATEGORY_DESCRIPTIONS = new Map([
  ['kv', '鍵值儲存 key-value store 讀寫設定 快取 快速讀取 key-value configuration cache'],
  ['r2', '全球邊緣物件儲存 object storage S3 compatible bucket files images'],
]);

function dotProduct(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

export async function buildSemanticDraft(params: {
  flattened: FlattenedTree;
  scope: PlanScope;
  baseParentId: string;
  instruction: string;
  metadataByNodeId: Map<string, BookmarkMetadata>;
  includePath: boolean;
  embed: (texts: string[]) => Promise<EmbeddingBatch>;
}): Promise<SemanticDraft> {
  const { flattened, scope, baseParentId, instruction, metadataByNodeId, includePath, embed } = params;
  const draftOps: DraftOperationInput[] = [];
  const warnings: string[] = [];
  const prohibitsMove =
    /(?:不要|不(?:得|可|能)?|請勿|勿|避免)\s*(?:直接|自動)?\s*(?:移動|搬移|改動|更動|動資料夾)|\b(?:do not|don't|without)\s+(?:move|moving|change)\b/i.test(instruction);
  if (prohibitsMove || isTagOnlyInstruction(instruction)) {
    warnings.push('本機語意分類會產生搬移建議。只加標籤可改用其他整理引擎。');
    return { draftOps, warnings };
  }

  const categories = extractRequestedCategoriesFromInstruction(instruction);
  const distinctCategories = new Set(categories.map((category) => category.name.toLowerCase()));
  if (categories.length < 2 || distinctCategories.size !== categories.length) {
    warnings.push('請指定至少兩個不同的分類，例如「依 KV、R2 分類」。');
    return { draftOps, warnings };
  }
  if (!flattened.byId.get(baseParentId)?.canAddChild) {
    warnings.push('請選擇可寫入的新建分類資料夾位置。');
    return { draftOps, warnings };
  }

  const { inScopeBookmarks } = collectScopeNodes(flattened, scope);
  const batch = buildSanitizedAiBatch({
    bookmarks: inScopeBookmarks,
    writableFolders: [],
    metadataByNodeId,
    includePath,
  });
  if (!batch.bookmarks.length) {
    warnings.push('所選範圍沒有可分類的一般網址書籤。');
    return { draftOps, warnings };
  }

  const inputs = [
    ...categories.map(({ name, keywords }) => {
      const description = CATEGORY_DESCRIPTIONS.get(name.toLowerCase()) ?? keywords.slice(1).join(' ');
      return `query: ${name} ${description}`;
    }),
    ...batch.bookmarks.map((item) => `query: ${[
      item.title, item.domain, item.path, ...(item.existingTags ?? []),
    ].filter(Boolean).join(' ')}`),
  ];
  const { vectors, backend } = await embed(inputs);
  const dimensions = vectors[0]?.length;
  if (vectors.length !== inputs.length || !dimensions ||
    vectors.some((vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error('語意模型回傳的向量格式與本次分類資料不符。');
  }

  const categoryVectors = vectors.slice(0, categories.length);
  const ensureCategoryTarget = createCategoryTargetResolver(flattened, baseParentId, draftOps);
  let unclassified = 0;

  for (const [index, item] of batch.bookmarks.entries()) {
    const scores = categoryVectors.map((categoryVector, categoryIndex) => ({
      category: categories[categoryIndex].name,
      score: dotProduct(vectors[categories.length + index], categoryVector),
    })).sort((a, b) => b.score - a.score);
    const [best, second] = scores;
    const labelMatches = matchCategoriesForText(
      [item.title, ...(item.existingTags ?? [])].join(' '),
      categories,
    );
    const competingLabel = labelMatches.some((category) => category.name !== best.category);
    const hasLabelEvidence = labelMatches.length === 1 && !competingLabel;
    if (competingLabel || best.score < MIN_SIMILARITY ||
      (!hasLabelEvidence && best.score - second.score < MIN_SCORE_GAP)) {
      unclassified++;
      continue;
    }

    draftOps.push({
      type: 'moveBookmark',
      nodeId: batch.bookmarkIdByTemp.get(item.id)!,
      ...ensureCategoryTarget(best.category),
      reason: hasLabelEvidence
        ? `標題或標籤符合「${best.category}」的關鍵詞，與語意分類結果一致。`
        : `與「${best.category}」最接近，與次選分數差 ${(best.score - second.score).toFixed(2)}。`,
    });
  }

  if (unclassified) warnings.push(`${unclassified} 筆書籤的分類依據不足，保留原位。`);
  if (batch.skippedSpecialUrls) warnings.push(`已略過 ${batch.skippedSpecialUrls} 筆特殊協定書籤。`);
  if (batch.truncatedBookmarks) warnings.push(`模型分析了前 ${batch.bookmarks.length} 筆書籤。另有 ${batch.truncatedBookmarks} 筆可分批整理。`);
  return { draftOps, warnings, backend };
}
