/**
 * Embedding Provider Interface
 * 使用本地 Transformers.js 轻量模型生成向量，全程离线、零 API 费用
 */

export interface EmbeddingVector {
  embedding: number[];
  dimensions: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingVector>;
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>;
  getDimensions(): number;
}

/**
 * Local Embedding Provider
 * 使用 Transformers.js 在本地运行轻量级模型
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private model: any;
  private dimensions: number;
  private initialized = false;

  constructor(
    private modelName: string = "Xenova/all-MiniLM-L6-v2",
    dimensions?: number
  ) {
    // all-MiniLM-L6-v2: 384 维
    // paraphrase-multilingual-MiniLM-L12-v2: 384 维
    this.dimensions = dimensions || 384;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  private async init() {
    if (this.initialized) return;
    
    const { pipeline } = await import("@xenova/transformers");
    this.model = await pipeline("feature-extraction", this.modelName);
    this.initialized = true;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    await this.init();
    
    const output = await this.model(text, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data) as number[];
    
    return {
      embedding,
      dimensions: embedding.length,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    await this.init();
    
    const results: EmbeddingVector[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}
