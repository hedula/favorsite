import modelManifest from './semantic-model-manifest.json';

export interface BuildIdentity {
  extensionVersion: string;
  buildId: string;
  protocolVersion: number;
}

export interface RuntimeStatus extends BuildIdentity {
  semanticModel: {
    state: 'ready' | 'missing' | 'error';
    modelId: string;
    revision: string;
    reason: string;
  };
}

declare const __FAVORSITE_BUILD__: BuildIdentity;

export function getBuildIdentity(): BuildIdentity {
  if (typeof __FAVORSITE_BUILD__ !== 'undefined') return { ...__FAVORSITE_BUILD__ };
  return { extensionVersion: '0.2.0', buildId: 'development', protocolVersion: 2 };
}

export function backgroundMatchesStudio(
  background: BuildIdentity | undefined,
  studio: BuildIdentity = getBuildIdentity(),
): boolean {
  return Boolean(background &&
    background.extensionVersion === studio.extensionVersion &&
    background.buildId === studio.buildId &&
    background.protocolVersion === studio.protocolVersion);
}

export async function probeRuntimeStatus(options: {
  getAssetUrl?: (path: string) => string;
  fetchAsset?: typeof fetch;
} = {}): Promise<RuntimeStatus> {
  const getAssetUrl = options.getAssetUrl ?? ((path: string) => chrome.runtime.getURL(path));
  const fetchAsset = options.fetchAsset ?? fetch;
  const identity = getBuildIdentity();
  const semanticModel = {
    modelId: modelManifest.modelId,
    revision: modelManifest.revision,
    state: 'ready' as RuntimeStatus['semanticModel']['state'],
    reason: '模型資產就緒，將在第一次語意查詢時載入。',
  };
  const paths = [
    ...modelManifest.files.map((file) => `semantic-models/${modelManifest.modelId}/${file.path}`),
    ...modelManifest.runtimeFiles.map((file) => `semantic-runtime/${file}`),
  ];
  try {
    const results = await Promise.all(paths.map((path) => fetchAsset(getAssetUrl(path), { method: 'HEAD' })));
    if (results.some((response) => !response.ok)) {
      semanticModel.state = 'missing';
      semanticModel.reason = '此版本的本機模型資產不完整。請重新安裝完整的 Favorsite，或先使用關鍵字搜尋及離線規則。';
    }
  } catch {
    semanticModel.state = 'error';
    semanticModel.reason = '目前無法讀取本機模型資產。請重新載入擴充功能後再試。';
  }
  return { ...identity, semanticModel };
}
