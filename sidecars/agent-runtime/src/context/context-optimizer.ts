import { createHash } from "node:crypto";

export interface ContextReport {
  cache: "hit" | "miss";
  sourceBytes: number;
  packedBytes: number;
  prunedBytes: number;
  budgetBytes: number;
  retrievedBytes?: number;
  draftInputBytes?: number;
  reviewInputBytes?: number;
  estimatedInputTokens?: number;
  contextProfile?: "剧情" | "战斗" | "情感" | "转场";
  sections: Record<string, number>;
  upstreamUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    requests: number;
  };
}

type ContextProfile = "剧情" | "战斗" | "情感" | "转场";

type ContextWeights = Pick<Record<"outline" | "cards" | "memories" | "previousChapters" | "knowledgeGraph" | "skills", number>, "outline" | "cards" | "memories" | "previousChapters" | "knowledgeGraph" | "skills">;

// These weights apply only to the per-chapter dynamic pack. The stable prompt
// prefix remains byte-for-byte ordered for upstream prompt-cache reuse.
const CONTEXT_PROFILE_WEIGHTS: Record<ContextProfile, ContextWeights> = {
  剧情: { outline: 0.20, cards: 0.12, memories: 0.22, previousChapters: 0.30, knowledgeGraph: 0.09, skills: 0.07 },
  战斗: { outline: 0.16, cards: 0.21, memories: 0.16, previousChapters: 0.31, knowledgeGraph: 0.09, skills: 0.07 },
  情感: { outline: 0.18, cards: 0.16, memories: 0.28, previousChapters: 0.26, knowledgeGraph: 0.06, skills: 0.06 },
  转场: { outline: 0.23, cards: 0.10, memories: 0.17, previousChapters: 0.36, knowledgeGraph: 0.08, skills: 0.06 },
};

export function resolveContextProfile(instruction: string): ContextProfile {
  const text = instruction.toLowerCase();
  if (/战斗|打斗|厮杀|对决|追杀|战场|boss|副本|碾压/u.test(text)) return "战斗";
  if (/感情|情感|恋爱|暧昧|告白|关系|和解|亲情|心动/u.test(text)) return "情感";
  if (/转场|过渡|赶路|抵达|离开|时间跳跃|数日后|次日|场景切换/u.test(text)) return "转场";
  return "剧情";
}

export interface ContextCard {
  id?: string | number;
  type?: string;
  title: string;
  content?: string;
  currentState?: string;
  stateHistory?: Array<{ changes?: string; chapterTitle?: string; status?: string }>;
}

export interface ContextOutline {
  id?: string | number;
  kind?: string;
  title?: string;
  content?: string;
}

export interface ContextGraph {
  nodes?: Array<{ id?: string; label?: string; type?: string; category?: string }>;
  edges?: Array<{ id?: string; source?: string; target?: string; label?: string; weight?: number }>;
}

export interface PreparedChapterInput {
  worldSetting?: string;
  outline?: string;
  cards: Array<{ type: string; title: string; content: string }>;
  previousChapters: Array<{ id?: string | number; title: string; content: string }>;
  memories: Array<Record<string, unknown>>;
  memoryDocuments: Array<Record<string, unknown>>;
  knowledgeGraph?: string;
  skills: Array<{ name: string; displayName?: string; category: string; description: string; tags: string[]; content: string }>;
  report: ContextReport;
}

const truncationMarker = "\n...[已按相关性与预算裁剪]...\n";

export const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Normalize document whitespace only for model-bound context. This preserves
 * Markdown paragraph/code-fence semantics while removing editor-introduced
 * indentation, trailing whitespace and redundant empty lines that consume
 * tokens without adding meaning. Local files keep their original formatting.
 */
export function normalizePromptWhitespace(value: unknown): string {
  const lines = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .split("\n");
  let inCodeFence = false;
  let emptyLines = 0;
  const normalized: string[] = [];

  for (const rawLine of lines) {
    const fence = /^\s*```/.test(rawLine);
    const line = inCodeFence
      ? rawLine.replace(/[ \t]+$/g, "")
      : rawLine
        .replace(/^[ \t]+|[ \t]+$/g, "")
        .replace(/[ \t]{2,}/g, " ");
    if (!line) {
      emptyLines += 1;
      if (emptyLines <= 1) normalized.push("");
    } else {
      emptyLines = 0;
      normalized.push(line);
    }
    if (fence) inCodeFence = !inCodeFence;
  }
  return normalized.join("\n").trim();
}

function sliceToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";
  if (byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/** Preserve both the premise and the most recent state when a source is oversized. */
export function compactText(value: unknown, maxBytes: number): string {
  const text = normalizePromptWhitespace(value);
  if (!text || maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  if (maxBytes <= byteLength(truncationMarker) + 24) return sliceToBytes(text, maxBytes);
  const available = maxBytes - byteLength(truncationMarker);
  const head = sliceToBytes(text, Math.floor(available * 0.62));
  const tailBudget = Math.max(0, available - byteLength(head));
  const reversed = Array.from(text).reverse().join("");
  const tail = Array.from(sliceToBytes(reversed, tailBudget)).reverse().join("");
  return `${head}${truncationMarker}${tail}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export class LruCache<Value> {
  private readonly entries = new Map<string, Value>();

  constructor(private readonly maxEntries = 64) {}

  get(key: string): Value | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export function contextBudgetBytes(contextWindowKB?: number, capKB = 18, minimumKB = 6): number {
  const configured = Math.max(16, Number(contextWindowKB) || 128) * 1024;
  return Math.min(capKB * 1024, Math.max(minimumKB * 1024, Math.floor(configured * 0.16)));
}

function compactList(value: unknown, maxItems: number, itemBytes: number): string[] {
  return Array.isArray(value)
    ? value.map(item => compactText(item, itemBytes)).filter(Boolean).slice(0, maxItems)
    : [];
}

function queryText(instruction: string, outlines: ContextOutline[], memories: Array<Record<string, unknown>>, cards: ContextCard[]): string {
  return [
    instruction,
    ...outlines.map(outline => `${outline.kind || ""} ${outline.title || ""} ${outline.content || ""}`),
    ...memories.flatMap(memory => [memory.title, memory.summary, ...(Array.isArray(memory.keywords) ? memory.keywords : [])]),
    ...cards.map(card => `${card.title} ${card.currentState || ""}`),
  ].filter(Boolean).join("\n").toLowerCase();
}

function relevanceScore(label: string, text: string): number {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return 0;
  if (text.includes(normalized)) return 12;
  const chunks = normalized.match(/[\p{L}\p{N}]{2,}/gu) || [];
  return chunks.reduce((score, chunk) => score + (text.includes(chunk) ? 3 : 0), 0);
}

function graphEdgeWeight(edge: { weight?: number; label?: string }): number {
  const parsed = Number(edge.weight);
  if (Number.isFinite(parsed)) return Math.max(0.1, Math.min(1, parsed));
  if (edge.label === "本章引用") return 1;
  if (edge.label === "状态更新") return 0.95;
  if (edge.label === "章节主角") return 0.92;
  if (edge.label === "状态引用") return 0.88;
  if (edge.label === "正文提及") return 0.75;
  if (edge.label === "章节提及") return 0.7;
  return 0.65;
}

function compactOutlines(outlines: ContextOutline[], activeOutlineId: unknown, text: string, maxBytes: number): string {
  const ordered = outlines
    .filter(outline => String(outline.content || "").trim())
    .map(outline => ({
      outline,
      score: (String(outline.id ?? "") === String(activeOutlineId ?? "") ? 100 : 0)
        + relevanceScore(`${outline.kind || ""} ${outline.title || ""}`, text)
        + (outline.kind === "章纲" || outline.kind === "细纲" ? 8 : outline.kind === "总纲" ? 4 : 0),
    }))
    .sort((left, right) => right.score - left.score || String(left.outline.id ?? "").localeCompare(String(right.outline.id ?? "")));
  let remaining = maxBytes;
  const sections: string[] = [];
  for (const { outline } of ordered.slice(0, 4)) {
    if (remaining < 180) break;
    const heading = `## ${compactText(outline.kind || outline.title || "大纲", 80)}\n`;
    const body = compactText(outline.content, Math.max(120, remaining - byteLength(heading)));
    const section = `${heading}${body}`;
    sections.push(section);
    remaining -= byteLength(section) + 2;
  }
  return sections.join("\n\n");
}

function compactCards(cards: ContextCard[], text: string, maxBytes: number): Array<{ type: string; title: string; content: string }> {
  const ranked = cards
    .filter(card => card && card.title?.trim())
    .map(card => ({ card, score: relevanceScore(`${card.title} ${card.currentState || ""} ${card.content || ""}`, text) }))
    .sort((left, right) => right.score - left.score || left.card.title.localeCompare(right.card.title));
  let remaining = maxBytes;
  const packed: Array<{ type: string; title: string; content: string }> = [];
  for (const { card } of ranked.slice(0, 8)) {
    if (remaining < 160) break;
    const history = (card.stateHistory || []).slice(-2)
      .map(item => `${compactText(item.chapterTitle || "最近章节", 70)}：${compactText(item.changes || item.status || "", 180)}`)
      .filter(Boolean).join("；");
    const state = compactText(card.currentState || "", 360);
    const label = `[${compactText(card.type || "知识卡", 40)}] ${compactText(card.title, 100)}`;
    const fixed = [label, state && `当前状态：${state}`, history && `近期变化：${history}`].filter(Boolean).join("\n");
    const knowledge = compactText(card.content || "", Math.max(120, Math.min(900, remaining - byteLength(fixed) - 20)));
    const content = [fixed, knowledge && `知识：${knowledge}`].filter(Boolean).join("\n");
    packed.push({ type: compactText(card.type || "知识卡", 40), title: compactText(card.title, 100), content });
    remaining -= byteLength(content) + 2;
  }
  return packed;
}

export function compactKnowledgeGraph(graph: unknown, text: string, maxBytes = 2800): string {
  if (!graph || typeof graph !== "object") return "";
  const source = graph as ContextGraph;
  const nodes = (source.nodes || []).filter(node => node?.id && node.label);
  const nodeById = new Map(nodes.map(node => [String(node.id), node]));
  const scored = nodes.map(node => ({ node, score: relevanceScore(`${node.label || ""} ${node.category || ""}`, text) }));
  const seeds = scored.filter(item => item.score > 0).sort((left, right) => right.score - left.score).slice(0, 10);
  const fallback = scored.sort((left, right) => String(left.node.label).localeCompare(String(right.node.label))).slice(0, 5);
  const selected = new Set((seeds.length ? seeds : fallback).map(item => String(item.node.id)));
  const edges = (source.edges || []).filter(edge => edge?.source && edge?.target)
    .sort((left, right) => graphEdgeWeight(right) - graphEdgeWeight(left));
  for (const edge of edges) {
    const sourceId = String(edge.source);
    const targetId = String(edge.target);
    if (!selected.has(sourceId) && !selected.has(targetId)) continue;
    // 留出空间给强关系；较弱的扩散关系不会挤掉当前写作的直接证据。
    if (selected.size >= 18 && (!selected.has(sourceId) || !selected.has(targetId))) continue;
    selected.add(sourceId);
    selected.add(targetId);
  }
  const selectedNodes = Array.from(selected).map(id => nodeById.get(id)).filter((node): node is NonNullable<typeof node> => Boolean(node))
    .sort((left, right) => relevanceScore(`${right.label || ""} ${right.category || ""}`, text) - relevanceScore(`${left.label || ""} ${left.category || ""}`, text) || String(left.label).localeCompare(String(right.label)))
    .slice(0, 18);
  const selectedIds = new Set(selectedNodes.map(node => String(node.id)));
  const selectedEdges = edges.filter(edge => selectedIds.has(String(edge.source)) && selectedIds.has(String(edge.target))).slice(0, 28);
  const nodeLines = selectedNodes.map(node => `- ${compactText(node.label || "实体", 80)}${node.category ? `（${compactText(node.category, 40)}）` : ""}`);
  const edgeLines = selectedEdges.map(edge => {
    const sourceLabel = nodeById.get(String(edge.source))?.label || edge.source;
    const targetLabel = nodeById.get(String(edge.target))?.label || edge.target;
    return `- ${compactText(sourceLabel || "实体", 70)} -[${compactText(edge.label || "关联", 50)}；权重 ${graphEdgeWeight(edge).toFixed(2)}]-> ${compactText(targetLabel || "实体", 70)}`;
  });
  return compactText([nodeLines.length ? `实体：\n${nodeLines.join("\n")}` : "", edgeLines.length ? `关系：\n${edgeLines.join("\n")}` : ""].filter(Boolean).join("\n"), maxBytes);
}

function compactMemories(memories: unknown, maxBytes: number): Array<Record<string, unknown>> {
  const source = Array.isArray(memories) ? memories.filter(item => item && typeof item === "object") : [];
  let remaining = maxBytes;
  const packed: Array<Record<string, unknown>> = [];
  for (const item of source.slice(-6).reverse()) {
    if (remaining < 180) break;
    const memory = item as Record<string, unknown>;
    const value: Record<string, unknown> = {
      id: memory.id,
      title: compactText(memory.title || "章节记忆", 100),
      summary: compactText(memory.summary || "", 480),
      keywords: compactList(memory.keywords, 8, 70),
      characterStateChanges: compactList(memory.characterStateChanges, 4, 180),
      knowledgeChanges: compactList(memory.knowledgeChanges, 3, 180),
      foreshadowingChanges: compactList(memory.foreshadowingChanges, 3, 180),
      timelineEvents: compactList(memory.timelineEvents, 3, 180),
      canonFacts: compactList(memory.canonFacts, 3, 180),
      conflicts: compactList(memory.conflicts, 2, 180),
      endingHook: compactText(memory.endingHook || "", 220),
    };
    const size = byteLength(JSON.stringify(value));
    if (size > remaining && packed.length) break;
    packed.push(value);
    remaining -= size;
  }
  return packed.reverse();
}

function compactPreviousChapters(chapters: unknown, maxBytes: number): Array<{ id?: string | number; title: string; content: string }> {
  const source = Array.isArray(chapters) ? chapters.filter(item => item && typeof item === "object") : [];
  let remaining = maxBytes;
  const packed: Array<{ id?: string | number; title: string; content: string }> = [];
  for (const item of source.slice(-2).reverse()) {
    if (remaining < 180) break;
    const chapter = item as Record<string, unknown>;
    const title = compactText(chapter.title || "上一章", 100);
    const content = compactText(chapter.content || "", Math.max(160, Math.min(5400, remaining - byteLength(title) - 30)));
    if (!content) continue;
    packed.push({ id: typeof chapter.id === "string" || typeof chapter.id === "number" ? chapter.id : undefined, title, content });
    remaining -= byteLength(title) + byteLength(content) + 30;
  }
  return packed.reverse();
}

function compactSkills(skills: unknown, instruction: string, maxBytes: number): Array<{ name: string; displayName?: string; category: string; description: string; tags: string[]; content: string }> {
  const source = Array.isArray(skills) ? skills.filter(item => item && typeof item === "object") : [];
  const query = instruction.toLowerCase();
  const ranked = source.map(item => {
    const skill = item as Record<string, unknown>;
    const tags = Array.isArray(skill.tags) ? skill.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const terms = [skill.name, skill.displayName, skill.category, skill.description, ...tags].join(" ").toLowerCase();
    return { skill, tags, score: relevanceScore(terms, query) };
  }).sort((left, right) => right.score - left.score || String(left.skill.name || "").localeCompare(String(right.skill.name || "")));
  let remaining = maxBytes;
  const packed: Array<{ name: string; category: string; description: string; tags: string[]; content: string }> = [];
  const writingRequest = /章节|正文|续写|创作|写作|下一章/u.test(instruction);
  const priorityNames = writingRequest
    ? ["chapter-continuity", "next-chapter-plan"]
    : [];
  const priority = priorityNames
    .map(name => ranked.find(item => String(item.skill.name || "") === name))
    .filter((item): item is (typeof ranked)[number] => Boolean(item));
  const ordered = [...priority, ...ranked.filter(item => !priorityNames.includes(String(item.skill.name || "")))];
  for (const { skill, tags } of ordered.slice(0, 12)) {
    if (remaining < 120) break;
    const name = compactText(skill.displayName || skill.name || "技能", 90);
    const category = compactText(skill.category || "write", 40);
    const description = compactText(skill.description || "", 160);
    const contentLimit = skill.name === "chapter-continuity" ? 1800 : 700;
    const content = compactText(skill.content || "", Math.max(100, Math.min(contentLimit, remaining - byteLength(name) - byteLength(description) - 50)));
    packed.push({ name, category, description, tags: compactList(tags, 8, 50), content });
    remaining -= byteLength(name) + byteLength(category) + byteLength(description) + byteLength(content) + 60;
  }
  return packed;
}

export function prepareChapterInput(input: {
  instruction: string;
  outline?: unknown;
  outlines?: unknown;
  activeOutlineId?: unknown;
  cards?: unknown;
  previousChapters?: unknown;
  memories?: unknown;
  memoryDocuments?: unknown;
  knowledgeGraph?: unknown;
  skills?: unknown;
  contextWindowKB?: number;
}): PreparedChapterInput {
  const budgetBytes = contextBudgetBytes(input.contextWindowKB);
  const contextProfile = resolveContextProfile(input.instruction);
  const weights = CONTEXT_PROFILE_WEIGHTS[contextProfile];
  const allOutlines = Array.isArray(input.outlines)
    ? input.outlines.filter(item => item && typeof item === "object") as ContextOutline[]
    : input.outline ? [{ kind: "作品大纲", title: "作品大纲", content: String(input.outline) }] : [];
  // Canon is fixed by the author and must stay outside relevance sorting so it
  // remains a stable upstream prompt-cache prefix across chapter requests.
  const worldSetting = allOutlines
    .filter(item => item.kind === "世界观与作品设定" && String(item.content || "").trim())
    .sort((left, right) => String(left.id ?? left.title ?? "").localeCompare(String(right.id ?? right.title ?? ""), "zh-CN"))
    .map(item => `## ${compactText(item.kind || "世界观与作品设定", 80)}\n${compactText(item.content, 6000)}`)
    .join("\n\n");
  const outlines = allOutlines.filter(item => item.kind !== "世界观与作品设定");
  const cards = Array.isArray(input.cards) ? input.cards.filter(item => item && typeof item === "object") as ContextCard[] : [];
  const raw = {
    outline: allOutlines,
    cards,
    previousChapters: input.previousChapters,
    memories: input.memories,
    memoryDocuments: input.memoryDocuments,
    knowledgeGraph: input.knowledgeGraph,
    skills: input.skills,
  };
  const sourceBytes = byteLength(JSON.stringify(raw));
  const text = queryText(input.instruction, outlines, Array.isArray(input.memories) ? input.memories as Array<Record<string, unknown>> : [], cards);
  const outline = compactOutlines(outlines, input.activeOutlineId, text, Math.floor(budgetBytes * weights.outline));
  const packedCards = compactCards(cards, text, Math.floor(budgetBytes * weights.cards));
  const memories = compactMemories(input.memories, Math.floor(budgetBytes * weights.memories));
  const previousChapters = compactPreviousChapters(input.previousChapters, Math.floor(budgetBytes * weights.previousChapters));
  const knowledgeGraph = compactKnowledgeGraph(input.knowledgeGraph, text, Math.floor(budgetBytes * weights.knowledgeGraph));
  const skills = compactSkills(input.skills, input.instruction, Math.floor(budgetBytes * weights.skills));
  const memoryDocuments = Array.isArray(input.memoryDocuments)
    ? input.memoryDocuments.filter(item => item && typeof item === "object").slice(0, 4).map(item => {
      const document = item as Record<string, unknown>;
      const title = compactText(document.title || "", 100);
      // Earlier-chapter memory is already a single deterministic, compact
      // document. Preserve enough of it to be useful while keeping ordinary
      // editable memory documents at the smaller budget.
      const contentLimit = /前\s*\d+\s*章.*摘要|memory-summary/iu.test(`${title} ${String(document.id || "")}`) ? 4500 : 900;
      return { kind: compactText(document.kind || "记忆文档", 80), title, content: compactText(document.content || "", contentLimit) };
    })
    : [];
  const sections = {
    worldSetting: byteLength(worldSetting),
    outline: byteLength(outline),
    cards: byteLength(JSON.stringify(packedCards)),
    memories: byteLength(JSON.stringify(memories)),
    previousChapters: byteLength(JSON.stringify(previousChapters)),
    knowledgeGraph: byteLength(knowledgeGraph),
    skills: byteLength(JSON.stringify(skills)),
    memoryDocuments: byteLength(JSON.stringify(memoryDocuments)),
  };
  const packedBytes = Object.values(sections).reduce((total, size) => total + size, 0);
  return {
    worldSetting: worldSetting || undefined,
    outline: outline || undefined,
    cards: packedCards,
    previousChapters,
    memories,
    memoryDocuments,
    knowledgeGraph: knowledgeGraph || undefined,
    skills,
    report: {
      cache: "miss",
      sourceBytes,
      packedBytes,
      prunedBytes: Math.max(0, sourceBytes - packedBytes),
      budgetBytes,
      contextProfile,
      sections,
    },
  };
}

export function formatContextReport(report: ContextReport): string {
  const cache = report.cache === "hit" ? "缓存命中" : "缓存未命中";
  const packedKB = (report.packedBytes / 1024).toFixed(1);
  const prunedKB = (report.prunedBytes / 1024).toFixed(1);
  return `${cache}；上下文 ${packedKB} KB，已裁剪 ${prunedKB} KB`;
}
