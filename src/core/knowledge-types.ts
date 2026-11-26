export interface KnowledgeSection {
  heading: string;
  text: string;
}

/** Serializable result of an explicit capture of the current browser page. */
export interface CapturedPage {
  url: string;
  title: string;
  sections: KnowledgeSection[];
  truncated: boolean;
}

export interface KnowledgeChunk {
  chunkId: string;
  sourceId: string;
  sourceVersion: string;
  heading: string;
  text: string;
  index: number;
  start: number;
  end: number;
}

export interface KnowledgeSource {
  profileKey: string;
  sourceId: string;
  url: string;
  title: string;
  contentHash: string;
  sourceVersion: string;
  capturedAt: number;
  updatedAt: number;
  truncated: boolean;
  sections: KnowledgeSection[];
  chunks: KnowledgeChunk[];
}

export interface KnowledgeSourceSummary {
  sourceId: string;
  url: string;
  title: string;
  sourceVersion: string;
  capturedAt: number;
  updatedAt: number;
  chunkCount: number;
  characterCount: number;
  truncated: boolean;
}

export interface KnowledgeEmbedding {
  profileKey: string;
  documentId: string;
  modelVersion: string;
  contentHash: string;
  vector: number[];
  sourceId?: string;
  sourceVersion?: string;
  updatedAt: number;
}

export interface KnowledgeExcerpt {
  sourceId: string;
  sourceVersion: string;
  chunkId: string;
  title: string;
  url: string;
  capturedAt: number;
  heading: string;
  text: string;
}

export interface KnowledgeCitation extends KnowledgeExcerpt {
  citationId: string;
}

export interface KnowledgeAnswer {
  mode: 'answer' | 'excerpts' | 'empty';
  answer: string;
  citations: KnowledgeCitation[];
  warnings: string[];
}
