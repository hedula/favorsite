export const semanticModel: {
  modelId: string;
  revision: string;
  files: Array<{ path: string; sha256: string }>;
  runtimeFiles: string[];
};

export function matchesModelFile(path: string, sha256: string): Promise<boolean>;
export function validateSemanticAssets(paths: {
  modelRoot: string;
  runtimeRoot: string;
}): Promise<void>;
