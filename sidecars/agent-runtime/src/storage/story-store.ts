import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { EmbeddingProvider } from "../embedding/embedding-provider.js";

export type MemoryType = "event" | "character_state" | "canon_fact" | "foreshadowing" | "timeline" | "style";

export interface ProjectRecord { id: string; title: string; }
export interface MemoryRecord {
  id: string;
  projectId: string;
  type: MemoryType;
  title: string;
  content: string;
  entityNames: string[];
  confirmed: boolean;
  importance: number;
}

export interface VectorSearchResult extends MemoryRecord {
  similarity: number;
}

export class StoryStore {
  private embeddingProvider?: EmbeddingProvider;
  private vectorDimensions?: number;
  /** 向量后端：vec0（sqlite-vec 扩展，KNN 索引）或 blob（JS 暴力扫兜底）。 */
  private vectorBackend: "vec0" | "blob" = "blob";
  private segmenter?: Intl.Segmenter;

  private constructor(private readonly db: Database.Database) {
    this.migrate();
  }

  static inMemory(): StoryStore {
    return new StoryStore(new Database(":memory:"));
  }

  static open(path: string): StoryStore {
    return new StoryStore(new Database(path));
  }

  /**
   * 启用向量检索功能
   * @param provider Embedding provider (API or local model)
   */
  enableVectorSearch(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    this.vectorDimensions = provider.getDimensions();
    this.migrateVectorTables();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        entity_names TEXT NOT NULL DEFAULT '[]',
        confirmed INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_memory_project_confirmed
        ON memory_items(project_id, confirmed);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        project_id UNINDEXED,
        title,
        content,
        entity_names,
        tokenize = 'unicode61'
      );
    `);
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < 2) {
      // v2：FTS 分词从"逐字拆分"升级为 ICU 词级分词（Intl.Segmenter，V8 内置 ICU）。
      // 旧索引按单字切分，与词级查询 token 不一致，必须整体重建一次。
      this.rebuildFtsIndex();
      this.db.pragma("user_version = 2");
    }
  }

  /**
   * ICU 词级分词：SQLite 内置 ICU tokenizer 需要重编译 SQLite（链接 libicu，
   * 会破坏 better-sqlite3 预编译二进制），因此用 Node/V8 自带的 ICU 引擎
   * （Intl.Segmenter）在应用层完成等价的中文分词。写入与查询共用同一套切分，
   * 保证 FTS 索引 token 与查询 token 一致；老运行时无 Segmenter 时退化为单字切分。
   */
  private segmentWords(text: string): string[] {
    if (!this.segmenter) {
      this.segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter("zh", { granularity: "word" })
        : undefined;
    }
    if (!this.segmenter) {
      return Array.from(text).filter(ch => /\S/.test(ch));
    }
    const words: string[] = [];
    for (const part of this.segmenter.segment(text)) {
      const token = part.segment.trim();
      // 只保留含字母/数字/CJK 的 token，纯标点交给 unicode61 当分隔符
      if (token && /[\p{L}\p{N}]/u.test(token)) words.push(token);
    }
    return words;
  }

  /** 旧库升级：按当前分词方案重建全部已确认记忆的 FTS 索引。 */
  private rebuildFtsIndex(): void {
    const rows = this.db.prepare(
      "SELECT id, project_id, title, content, entity_names FROM memory_items WHERE confirmed = 1",
    ).all() as Array<Record<string, unknown>>;
    const insert = this.db.prepare(
      "INSERT INTO memory_fts (memory_id, project_id, title, content, entity_names) VALUES (?, ?, ?, ?, ?)",
    );
    const indexText = (text: string) => this.segmentWords(text).join(" ");
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM memory_fts");
      for (const row of rows) {
        insert.run(
          String(row.id),
          String(row.project_id),
          indexText(String(row.title ?? "")),
          indexText(String(row.content ?? "")),
          indexText(String(row.entity_names ?? "[]")),
        );
      }
    });
    tx();
  }

  private migrateVectorTables(): void {
    if (!this.vectorDimensions) {
      throw new Error("Vector dimensions not set");
    }

    // 接入 sqlite-vec：npm 包自带各平台预编译扩展（mac/win/linux），
    // 加载成功后用 vec0 虚拟表做 KNN 索引；失败则回落到 JS 暴力扫（blob 后端）。
    this.vectorBackend = "blob";
    try {
      sqliteVec.load(this.db);
      this.vectorBackend = "vec0";
    } catch (err) {
      console.warn("sqlite-vec extension not available, vector search falls back to in-process scan:", err);
    }

    if (this.vectorBackend === "vec0") {
      // 维度变化或残留旧版普通表时重建：向量必须按新维度重新生成
      const existing = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'",
      ).get() as { sql?: string } | undefined;
      const expected = `float[${this.vectorDimensions}]`;
      if (existing?.sql && (!existing.sql.includes("USING vec0") || !existing.sql.includes(expected))) {
        this.db.exec("DROP TABLE IF EXISTS memory_vectors");
      }
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${this.vectorDimensions}] distance_metric=cosine
        );
      `);
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id TEXT PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vector_memory
        ON memory_vectors(memory_id);
    `);
  }

  createProject(project: ProjectRecord): void {
    this.db.prepare("INSERT OR REPLACE INTO projects (id, title) VALUES (?, ?)")
      .run(project.id, project.title);
  }

  saveMemory(memory: MemoryRecord): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO memory_items
          (id, project_id, type, title, content, entity_names, confirmed, importance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memory.id,
        memory.projectId,
        memory.type,
        memory.title,
        memory.content,
        JSON.stringify(memory.entityNames),
        memory.confirmed ? 1 : 0,
        memory.importance,
      );
      this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memory.id);
      if (memory.confirmed) {
        // ICU 词级分词后入索引，与查询侧 toFtsQuery 使用同一套切分
        const indexText = (text: string) => this.segmentWords(text).join(" ");
        this.db.prepare(`
          INSERT INTO memory_fts (memory_id, project_id, title, content, entity_names)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          memory.id,
          memory.projectId,
          indexText(memory.title),
          indexText(memory.content),
          indexText(memory.entityNames.join(" ")),
        );
      }
    });
    tx();
  }

  /**
   * 为记忆生成并存储向量
   */
  async saveMemoryVector(memoryId: string, content: string): Promise<void> {
    if (!this.embeddingProvider) {
      throw new Error("Embedding provider not configured");
    }

    const { embedding } = await this.embeddingProvider.embed(content);
    // sqlite-vec 的 vec0 与 blob 后端都以 float32 紧凑字节存储向量
    const buffer = Buffer.from(new Float32Array(embedding).buffer);

    this.db.prepare(`
      INSERT OR REPLACE INTO memory_vectors (memory_id, embedding)
      VALUES (?, ?)
    `).run(memoryId, buffer);
  }

  /**
   * 语义向量检索：vec0 后端走 KNN 索引，blob 后端暴力扫全量计算余弦相似度
   */
  async searchSemantic(projectId: string, query: string, limit = 10): Promise<VectorSearchResult[]> {
    if (!this.embeddingProvider) {
      throw new Error("Embedding provider not configured");
    }

    const { embedding: queryEmbedding } = await this.embeddingProvider.embed(query);
    const queryBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

    if (this.vectorBackend === "vec0") {
      // vec0 的 KNN 查询不支持外部 JOIN 过滤，先超额召回最近邻再按项目过滤
      const rows = this.db.prepare(`
        SELECT memory_id, distance
        FROM memory_vectors
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `).all(queryBuffer, Math.max(limit * 6, 60)) as Array<{ memory_id: string; distance: number }>;
      const stmt = this.db.prepare(`
        SELECT id, project_id, type, title, content, entity_names, confirmed, importance
        FROM memory_items WHERE id = ? AND confirmed = 1
      `);
      const results: VectorSearchResult[] = [];
      for (const row of rows) {
        const memory = stmt.get(row.memory_id) as Record<string, unknown> | undefined;
        if (!memory || String(memory.project_id) !== projectId) continue;
        // cosine distance = 1 - cosine similarity
        results.push({ ...this.toMemory(memory), similarity: 1 - Number(row.distance) });
        if (results.length >= limit) break;
      }
      return results;
    }

    // blob 兜底：获取所有已确认的记忆及其向量
    const rows = this.db.prepare(`
      SELECT m.id, m.project_id, m.type, m.title, m.content, m.entity_names,
             m.confirmed, m.importance, v.embedding
      FROM memory_items m
      JOIN memory_vectors v ON v.memory_id = m.id
      WHERE m.project_id = ? AND m.confirmed = 1
    `).all(projectId) as Array<Record<string, unknown>>;

    // 计算余弦相似度
    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      const embeddingBuffer = row.embedding as Buffer;
      const embedding = new Float32Array(embeddingBuffer.buffer, embeddingBuffer.byteOffset, embeddingBuffer.byteLength / 4);
      const similarity = this.cosineSimilarity(queryEmbedding, Array.from(embedding));

      results.push({
        ...this.toMemory(row),
        similarity,
      });
    }

    // 按相似度排序并返回 top-k
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * 混合检索：FTS5 关键词 + 向量语义
   */
  async searchHybrid(projectId: string, query: string, limit = 20): Promise<VectorSearchResult[]> {
    // FTS5 检索
    const ftsResults = this.searchExact(projectId, query, limit);
    
    // 向量检索
    let vectorResults: VectorSearchResult[] = [];
    if (this.embeddingProvider) {
      try {
        vectorResults = await this.searchSemantic(projectId, query, limit);
      } catch (err) {
        console.warn("Vector search failed, falling back to FTS only:", err);
      }
    }

    // 合并结果并去重
    const seen = new Set<string>();
    const merged: VectorSearchResult[] = [];

    // 先加入 FTS 结果（默认相似度 0.5）
    for (const item of ftsResults) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push({ ...item, similarity: 0.5 });
      }
    }

    // 再加入向量结果
    for (const item of vectorResults) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      } else {
        // 如果已存在，更新为更高的相似度
        const existing = merged.find(m => m.id === item.id);
        if (existing && item.similarity > existing.similarity) {
          existing.similarity = item.similarity;
        }
      }
    }

    // 按相似度和重要性综合排序
    return merged
      .sort((a, b) => {
        const scoreA = a.similarity * 0.7 + a.importance * 0.3;
        const scoreB = b.similarity * 0.7 + b.importance * 0.3;
        return scoreB - scoreA;
      })
      .slice(0, limit);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error("Vector dimensions mismatch");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  searchExact(projectId: string, query: string, limit = 20): MemoryRecord[] {
    const rows = this.db.prepare(`
      SELECT m.id, m.project_id, m.type, m.title, m.content, m.entity_names,
             m.confirmed, m.importance
      FROM memory_fts f
      JOIN memory_items m ON m.id = f.memory_id
      WHERE f.project_id = ? AND memory_fts MATCH ? AND m.confirmed = 1
      ORDER BY bm25(memory_fts), m.importance DESC
      LIMIT ?
    `).all(projectId, this.toFtsQuery(query), limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toMemory(row));
  }

  listConfirmed(projectId: string, limit = 100): MemoryRecord[] {
    const rows = this.db.prepare(`
      SELECT id, project_id, type, title, content, entity_names, confirmed, importance
      FROM memory_items WHERE project_id = ? AND confirmed = 1
      ORDER BY importance DESC, created_at DESC LIMIT ?
    `).all(projectId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toMemory(row));
  }

  /** 常见单字虚词：AND 语义下会误伤空结果，查询时过滤（索引侧保留完整分词）。 */
  private static readonly FTS_STOPWORDS = new Set([
    "的", "了", "吗", "呢", "吧", "啊", "嘛", "呀", "么", "把", "被", "和", "与", "跟",
    "从", "向", "在", "是", "有", "一", "不", "没", "也", "很", "就", "都", "还", "再",
    "才", "只", "又", "个", "这", "那", "我", "你", "他", "她", "它", "们", "之", "以",
    "于", "及", "或", "而", "且", "但", "因", "所", "其", "请", "将", "已", "要", "会",
    "能", "可", "让", "给", "比", "并",
  ]);

  private toFtsQuery(query: string): string {
    // 与索引侧共用 ICU 词级切分。人名等未登录词会被切成单字，
    // 单字用 FTS5 前缀匹配（"沈"* 可命中 token "沈砚"），虚词直接过滤。
    const terms = this.segmentWords(query)
      .filter(word => !StoryStore.FTS_STOPWORDS.has(word))
      .map(word => /^[\u4e00-\u9fff]$/.test(word)
        ? `"${word}"*`
        : `"${word.replace(/"/g, '""')}"`);
    if (!terms.length) return '""';
    return [...new Set(terms)].join(" AND ");
  }

  private toMemory(row: Record<string, unknown>): MemoryRecord {
    let entityNames: string[] = [];
    try { entityNames = JSON.parse(String(row.entity_names ?? "[]")); } catch { /* tolerate old rows */ }
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      type: String(row.type) as MemoryType,
      title: String(row.title),
      content: String(row.content),
      entityNames,
      confirmed: Boolean(row.confirmed),
      importance: Number(row.importance),
    };
  }
}
