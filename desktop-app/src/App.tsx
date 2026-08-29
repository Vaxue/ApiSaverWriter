import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke, isDirectBaiduRuntime, isMobileRuntime } from './platform';
import './App.css';
import { countNovelCharacters } from './utils/text';
import { builtinSkills } from './data/builtin-skills';

export interface Skill {
  id: number | string;
  name: string;
  /** Stable routing key; built-in skills use displayName for Chinese UI text. */
  displayName?: string;
  category: string;
  description: string;
  tags: string[];
  rating: number;
  usageCount: number;
  content: string;
  builtin?: boolean;
}

interface Chapter {
  id: number;
  title: string;
  content: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

interface OutlineNode {
  id: number;
  title: string;
  description: string;
  type: 'arc' | 'chapter' | 'scene';
  children?: OutlineNode[];
  status: 'planned' | 'writing' | 'completed';
}

type OutlineKind = '总纲' | '章纲' | '世界观与作品设定';

interface OutlineDocument {
  id: number;
  kind: OutlineKind;
  chapterId?: number;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

type CardType = '角色卡' | '物品卡' | '地点卡' | '势力卡' | '金手指卡';

interface KnowledgeCard {
  id: number;
  type: CardType;
  title: string;
  content: string;
  currentState?: string;
  stateHistory?: Array<{ chapterId: number; chapterTitle: string; status: string; changes: string; updatedAt: string }>;
  createdAt: string;
  updatedAt: string;
}

interface ChapterMemory {
  id: number;
  chapterId: number;
  chapterTitle: string;
  summary: string;
  keywords: string[];
  characterStateChanges: string[];
  knowledgeChanges: string[];
  foreshadowingChanges: string[];
  foreshadowingItems?: Array<{ text: string; status: 'active' | 'progressing' | 'resolved' | 'overdue'; priority: 'high' | 'normal' | 'low'; plantedChapter?: number; targetChapter?: number }>;
  timelineEvents: string[];
  canonFacts: string[];
  conflicts: string[];
  endingHook: string;
  sourceChapterNumber?: number;
  createdAt: string;
  updatedAt: string;
}

interface BatchGenerationItem {
  chapterNumber: number;
  title: string;
  status: 'pending' | 'outline' | 'writing' | 'memory' | 'complete' | 'error';
  outline?: string;
  content?: string;
  memory?: string;
}

interface AIDetectionChapter {
  chapterId: number;
  chapterTitle: string;
  wordCount: number;
  sentenceUniformity: number;
  logicFrequency: number;
  colloquialFrequency: number;
  psychologicalFrequency: number;
  paragraphUniformity: number;
  aiRate: number;
  humanRate: number;
  segments: AIDetectionSegment[];
  label: AIDetectionLabel;
}

type AIDetectionLabel = '人工' | '疑似 AI' | 'AI 特征';

interface AIDetectionSegment {
  order: number;
  text: string;
  confidence: number;
  label: AIDetectionLabel;
}

interface AIDetectionReport {
  updatedAt: string;
  scope: 'chapter' | 'book';
  chapters: AIDetectionChapter[];
  averageAIRate: number;
  level: string;
  suggestion: string;
  provider: '本地启发式';
}

type MemoryDocumentKind = '章节快照' | '人物状态' | '角色认知' | '伏笔追踪' | '时间线' | '设定事实' | '冲突';

interface MemoryDocument {
  id: string;
  kind: MemoryDocumentKind;
  title: string;
  content: string;
  updatedAt: string;
  manuallyEdited?: boolean;
}

interface CloudBackupFile {
  name: string;
  path: string;
  fsId?: string;
  size: number;
  modifiedAt: string;
  isBundle: boolean;
  source: 'bundle';
}

interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: 'chapter' | 'card' | 'outline' | 'entity';
  category?: string;
  content?: string;
  sourcePath?: string;
  status?: string;
  sourceChapterIds?: number[];
  updatedAt?: string;
}

interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  weight?: number;
  sourceChapterId?: number;
  updatedAt?: string;
}

// 权重代表关系证据强度，不是模型猜测的“重要程度”。高权重关系会优先进入写作上下文。
const defaultKnowledgeGraphWeight = (label: string): number => {
  if (label === '本章引用') return 1;
  if (label === '状态更新') return 0.95;
  if (label === '章节主角') return 0.92;
  if (label === '状态引用') return 0.88;
  if (label === '正文提及') return 0.75;
  if (label === '章节提及') return 0.7;
  return 0.65;
};

const normalizeKnowledgeGraphWeight = (value: unknown, label: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  const weight = Number.isFinite(parsed) ? parsed : defaultKnowledgeGraphWeight(label);
  return Math.round(Math.max(0.1, Math.min(1, weight)) * 100) / 100;
};

const normalizeKnowledgeGraphEdges = (value: unknown): KnowledgeGraphEdge[] => Array.isArray(value)
  ? value.filter((edge): edge is Partial<KnowledgeGraphEdge> => Boolean(edge && typeof edge === 'object'))
    .map(edge => ({
      id: String(edge.id || `${edge.source || 'unknown'}->${edge.target || 'unknown'}:${edge.label || '关联'}`),
      source: String(edge.source || ''),
      target: String(edge.target || ''),
      label: String(edge.label || '关联'),
      weight: normalizeKnowledgeGraphWeight(edge.weight, String(edge.label || '关联')),
      sourceChapterId: edge.sourceChapterId,
      updatedAt: edge.updatedAt,
    })).filter(edge => edge.source && edge.target)
  : [];

const upsertKnowledgeGraphEdge = (edges: KnowledgeGraphEdge[], next: KnowledgeGraphEdge) => {
  const nextWeight = normalizeKnowledgeGraphWeight(next.weight, next.label);
  const index = edges.findIndex(edge => edge.id === next.id);
  if (index < 0) {
    edges.push({ ...next, weight: nextWeight });
    return;
  }
  const existing = edges[index];
  // 同一关系出现多次时，只提高已有证据强度，避免一次弱抽取覆盖明确引用。
  edges[index] = {
    ...existing,
    ...next,
    weight: Math.max(normalizeKnowledgeGraphWeight(existing.weight, existing.label), nextWeight),
    updatedAt: next.updatedAt || existing.updatedAt,
  };
};

const graphNodeTypeLabel = (node: KnowledgeGraphNode) => {
  if (node.type === 'chapter') return '章节';
  if (node.type === 'outline') return '大纲';
  if (node.type === 'card') return node.category || '知识卡';
  return node.category || '实体';
};

const graphNodeGroup = (node: KnowledgeGraphNode) => {
  const type = graphNodeTypeLabel(node);
  if (/角色|人物/u.test(type)) return '重要角色';
  if (/地点|场景/u.test(type)) return '地点与场景';
  if (/势力|组织/u.test(type)) return '组织与势力';
  if (/物品|金手指/u.test(type)) return '物品与设定';
  if (node.type === 'chapter') return '章节事件';
  if (node.type === 'outline') return '大纲设定';
  return '其他实体';
};

const graphNodeRelativePath = (node: KnowledgeGraphNode) => node.sourcePath || `图谱/${graphNodeGroup(node)}/${node.label}.md`;

const graphNodeProfile = (node: KnowledgeGraphNode) => node.content?.trim() || `## 基础信息\n- 节点类型：${graphNodeTypeLabel(node)}\n- 当前状态：${node.status || '待补充'}\n\n## 档案\n待补充。`;

const createGraphNodeProfile = (type: KnowledgeGraphNode['type'], category?: string) => `## 基础信息\n- 节点类型：${type === 'entity' ? category || '实体' : type === 'card' ? category || '知识卡' : type === 'chapter' ? '章节' : '大纲'}\n- 当前状态：待补充\n\n## 档案\n待补充。`;

interface Project {
  id: number;
  title: string;
  genre: string;
  subgenre?: string;
  tags?: Partial<Record<TagTab, string[]>>;
  cover?: string;
  protagonist1?: string;
  protagonist2?: string;
  synopsis?: string;
  status: 'writing' | 'completed';
  chapters: Chapter[];
  outline: OutlineNode[];
  outlines: OutlineDocument[];
  cards: KnowledgeCard[];
  memories: ChapterMemory[];
  memoryDocuments: MemoryDocument[];
  graphNodes: KnowledgeGraphNode[];
  graphEdges: KnowledgeGraphEdge[];
  createdAt: string;
  updatedAt: string;
  wordCount: number;
  // Legacy metadata is retained verbatim when an existing project is saved.
  // Automatic publishing is no longer part of the application.
  publishConfig?: unknown;
  publishRecords?: unknown;
  aiDetection?: AIDetectionReport;
  chapterTargetWords?: number;
  styleProfileId?: string;
  sourceDismantleBookId?: string;
  authorPreferences?: string[];
}

type DismantleChapterStatus = 'pending' | 'analyzing' | 'analyzed' | 'rewritten';

interface DismantleChapter {
  id: string;
  number: number;
  title: string;
  sourceContent: string;
  wordCount: number;
  summary: string;
  detailedOutline: string;
  plotBeats: string[];
  characterDynamics: string[];
  setupPayoff: string[];
  pacing: string;
  rewriteContent: string;
  status: DismantleChapterStatus;
  sourcePath?: string;
  outlinePath?: string;
  rewritePath?: string;
  updatedAt: string;
}

interface DismantleBook {
  id: string;
  title: string;
  sourceFileName: string;
  chapters: DismantleChapter[];
  boundProjectId?: number;
  sourceLibraryBookId?: string;
  createdAt: string;
  updatedAt: string;
}

interface LibraryBookChapter {
  id: string;
  number: number;
  title: string;
  url: string;
  content: string;
  wordCount: number;
  downloaded: boolean;
  unavailableReason?: string;
  outline?: string;
}

interface LibraryBook {
  id: string;
  title: string;
  author: string;
  source: string;
  sourceId?: string;
  sourceBookId?: string;
  url: string;
  intro: string;
  cover?: string;
  category?: string;
  wordCount?: number;
  chapters: LibraryBookChapter[];
  downloadedAt?: string;
  createdAt: string;
  updatedAt: string;
  localPath?: string;
  fontCss?: string;
}

type RankingPlatform = 'fanqie' | 'qidian' | 'faloo';
type RankingType = 'read' | 'new' | 'hot' | 'completed' | 'collect';
type FanqieSection = 'male-read' | 'male-new' | 'female-read' | 'female-new';

const fanqieSectionOptions: Array<{ value: FanqieSection; label: string; gender: 'male' | 'female'; list: 'read' | 'new' }> = [
  { value: 'male-read', label: '男频阅读', gender: 'male', list: 'read' },
  { value: 'male-new', label: '男频新书', gender: 'male', list: 'new' },
  { value: 'female-read', label: '女频阅读', gender: 'female', list: 'read' },
  { value: 'female-new', label: '女频新书', gender: 'female', list: 'new' },
];

interface RankingCategoryOption {
  id: string;
  label: string;
  url: string;
  gender: 'male' | 'female';
  list: 'read' | 'new';
}

const rankingTypeOptions = (platform: RankingPlatform): Array<{ value: RankingType; label: string }> => {
  if (platform === 'fanqie') return [{ value: 'read', label: '阅读榜' }, { value: 'new', label: '新书榜' }];
  if (platform === 'qidian') return [{ value: 'hot', label: '月票榜' }, { value: 'new', label: '签约作者新书榜' }, { value: 'read', label: '阅读指数榜' }];
  if (platform === 'faloo') return [{ value: 'read', label: '24小时畅销榜' }];
  return [{ value: 'read', label: '阅读榜' }];
};

const rankingTypeLabel = (platform: RankingPlatform, type: RankingType) => rankingTypeOptions(platform).find(item => item.value === type)?.label || '榜单';

interface RankingBook {
  id: string;
  title: string;
  author: string;
  intro: string;
  cover?: string;
  category?: string;
  rank: number;
  rankType: RankingType;
  gender: 'male' | 'female' | 'all';
  platform: 'fanqie' | 'qidian' | 'faloo';
  sourceBookId?: string;
  url: string;
  wordCount?: number;
  readCount?: number;
  fetchedAt: string;
  sourceName?: string;
}

interface WritingStyle {
  id: string;
  name: string;
  description: string;
  tags: string[];
  content: string;
  sourceBookId?: string;
  createdAt: string;
  updatedAt: string;
  sourcePath?: string;
}

interface AIToolResult {
  mode: 'polish' | 'de-ai' | 'continue';
  content: string;
  projectId: number;
  chapterId: number;
  scope: 'chapter' | 'selection';
  source?: string;
  start?: number;
  end?: number;
  maxWords?: number;
}

interface AgentReviewResult {
  consistent: boolean;
  issues: string[];
  suggestions: string[];
}

interface AgentDraftResult {
  draftContent?: string;
  summary?: string;
  chapterPlan?: string;
  prewriteCheck?: { blockers: string[]; warnings: string[]; summary: string };
  reviewResult?: AgentReviewResult;
  retrievedContext?: string[];
  recognizedIntent?: string;
  selectedSkills?: string[];
  contextReport?: {
    cache?: 'hit' | 'miss';
    sourceBytes?: number;
    packedBytes?: number;
    prunedBytes?: number;
    budgetBytes?: number;
    retrievedBytes?: number;
    draftInputBytes?: number;
    reviewInputBytes?: number;
    estimatedInputTokens?: number;
    contextProfile?: '剧情' | '战斗' | '情感' | '转场';
    sections?: Record<string, number>;
    upstreamUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      requests: number;
    };
  };
}

/**
 * Chapter writing uses a JSON envelope so the runtime can retain a compact
 * chapter summary. During SSE that envelope arrives a few characters at a
 * time. Keep the JSON transport out of the writer-facing preview while still
 * allowing ordinary (non-JSON) provider fallbacks to render immediately.
 */
const chapterDraftFromStream = (raw: string, depth = 0): string => {
  if (depth > 4) return raw.trim();
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return raw;
  const withoutFence = trimmed.replace(/^```(?:json|markdown|text)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  try {
    const parsed = JSON.parse(withoutFence) as Record<string, unknown>;
    const nested = typeof parsed.draftContent === 'string' ? parsed.draftContent : typeof parsed.content === 'string' ? parsed.content : '';
    if (nested) return chapterDraftFromStream(nested, depth + 1);
  } catch {
    // SSE commonly arrives mid-JSON; decode the visible content field below.
  }
  const field = /"(?:draftContent|content)"\s*:\s*"/u.exec(raw);
  if (!field) return '';

  let value = '';
  for (let index = (field.index || 0) + field[0].length; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"') break;
    if (character !== '\\') {
      value += character;
      continue;
    }
    const escape = raw[index + 1];
    if (!escape) break;
    if (escape === 'u') {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-f]{4}$/iu.test(hex)) break;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    const escaped: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    value += escaped[escape] ?? escape;
    index += 1;
  }
  return value.trimStart().startsWith('{') || value.trimStart().startsWith('```')
    ? chapterDraftFromStream(value, depth + 1)
    : value;
};

const batchChapterTitleFromOutline = (raw: string, chapterNumber: number, preferredTitle?: string): string => {
  const chapterDigits = '\\d+|[零〇一二三四五六七八九十百千]+';
  const cleanTitle = (value: string) => value
    .replace(new RegExp(`^第\\s*(?:${chapterDigits})\\s*章\\s*[：:、-]?\\s*`, 'u'), '')
    .replace(/^章纲\s*[|｜:：-]\s*/u, '')
    .replace(/^(?:章节标题|标题)\s*[：:]?/u, '')
    .replace(/^《(.+?)》$/u, '$1')
    .trim();
  const preferred = cleanTitle(String(preferredTitle || '').trim());
  if (preferred && !/^(?:正文|内容|未命名|未命名章节|章节)$/u.test(preferred)) return `第 ${chapterNumber} 章 ${preferred}`;
  const text = chapterDraftFromStream(raw).replace(/```(?:markdown|text)?/giu, '').trim();
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const heading = lines.find(line => new RegExp(`^#{1,6}\\s*(?:章纲\\s*[|｜:：-]\\s*)?第\\s*(?:${chapterDigits})\\s*章`, 'u').test(line))
    || lines.find(line => /^#{1,6}\s*章纲/u.test(line));
  const labelIndex = lines.findIndex(line => /^(?:章节标题|标题)\s*[：:]/u.test(line));
  const labeled = labelIndex >= 0 ? lines[labelIndex] : '';
  const labeledValue = labeled.replace(/^(?:章节标题|标题)\s*[：:]\s*/u, '').trim() || (labelIndex >= 0 ? lines[labelIndex + 1] || '' : '');
  const candidate = cleanTitle((heading || labeledValue || '').replace(/^#{1,6}\s*/u, '').trim());
  if (!candidate) {
    const summaryIndex = lines.findIndex(line => /^(?:核心主线与目标|本章目标|章节定位|核心事件)(?:\s*[：:].*)?$/u.test(line.replace(/^#{1,6}\s*/u, '')));
    const summaryLine = summaryIndex >= 0 ? (lines[summaryIndex].match(/[：:]\s*(.+)$/u)?.[1] || lines[summaryIndex + 1] || '') : '';
    const summary = summaryLine.replace(/^[-*]\s*/u, '').replace(/[。！？.!?].*$/u, '').trim();
    if (summary && !/^(?:暂无|无|待定|待揭示)$/u.test(summary)) return `第 ${chapterNumber} 章 ${Array.from(summary).slice(0, 24).join('')}`;
    return `第 ${chapterNumber} 章`;
  }
  const numbered = candidate.match(/^第\s*\d+\s*章(?:\s+|[：:、-])?(.*)$/u);
  if (numbered) return `第 ${chapterNumber} 章${numbered[1]?.trim() ? ` ${numbered[1].trim()}` : ''}`;
  return `第 ${chapterNumber} 章 ${candidate}`.trim();
};

const clampChapterContent = (content: string, maxCharacters: number) => {
  const normalized = content.trim();
  if (countNovelCharacters(normalized) <= maxCharacters) return normalized;
  const characters = Array.from(normalized).slice(0, maxCharacters).join('');
  const lastBreak = Math.max(characters.lastIndexOf('。'), characters.lastIndexOf('！'), characters.lastIndexOf('？'), characters.lastIndexOf('\n'));
  return (lastBreak > maxCharacters * 0.72 ? characters.slice(0, lastBreak + 1) : characters).trim();
};

interface RuntimeUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requests: number;
  startedAt: string;
}
interface UsageDay extends RuntimeUsageSummary { date: string }
interface GatewayUsageAccount {
  keyIndex: number;
  keyHint: string;
  usage?: Record<string, unknown>;
  logs: Array<Record<string, unknown>>;
  pricing?: Array<Record<string, unknown>>;
  group?: string;
  groupRatios?: Record<string, number>;
  usableGroups?: Record<string, unknown>;
  error?: string;
}
interface GatewayUsageSnapshot {
  fetchedAt: string;
  status?: Record<string, unknown>;
  pricing?: Array<Record<string, unknown>>;
  accounts: GatewayUsageAccount[];
  errors: string[];
}
interface GatewayPricingEntry extends Record<string, unknown> {
  __account: GatewayUsageAccount;
  __group?: string;
  __groupRatio?: number;
  __groupKnown: boolean;
}
interface AgentChatMessage { role: 'user' | 'assistant'; content: string; createdAt: string }

interface AgentMemoryResult {
  summary?: string;
  keywords?: string[];
  characterStateChanges?: string[];
  knowledgeChanges?: string[];
  foreshadowingChanges?: string[];
  foreshadowingItems?: ChapterMemory['foreshadowingItems'];
  timelineEvents?: string[];
  canonFacts?: string[];
  conflicts?: string[];
  endingHook?: string;
  entities?: Array<{ name?: string; type?: string }>;
  relations?: Array<{ source?: string; target?: string; label?: string; weight?: number }>;
  cardUpdates?: Array<{ cardId?: number | string; cardTitle?: string; status?: string; changes?: string }>;
  authorPreferences?: string[];
  contextReport?: AgentDraftResult['contextReport'];
}

type AgentStage = 'idle' | 'starting' | 'intent' | 'retrieve' | 'plan' | 'draft' | 'review' | 'done' | 'error';
type ApiMode = 'openai' | 'responses' | 'anthropic';
type ReasoningMode = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max' | 'custom';
type AgentProgressStatus = 'pending' | 'active' | 'complete' | 'error';

const skillCategoryLabels: Record<string, string> = {
  setup: '项目设置', write: '写作', review: '审查', polish: '润色',
  import: '导入', analyze: '分析', tool: '工具', creator: '创建器',
};

interface AgentConfig {
  serviceName: string;
  enabled: boolean;
  apiMode: ApiMode;
  baseURL: string;
  apiKey: string;
  apiKeys: string[];
  // Model IDs returned by /v1/models are scoped to the authenticated key.
  // Keep the relationship so calls never default to an unrelated first key.
  modelKeyMap: Record<string, string[]>;
  model: string;
  contextWindow: number;
  reasoningMode: ReasoningMode;
  proxyEnabled: boolean;
  proxyURL: string;
  proxyBypassLocal: boolean;
  /** Number of chapters before the immediate predecessor to merge into one summary. */
  memorySummaryChapterCount: number;
}

const agentStageLabel: Record<AgentStage, string> = {
  idle: '待命',
  starting: '启动智能体',
  intent: '识别创作意图',
  retrieve: '检索上下文',
  plan: '制定下一章计划',
  draft: '生成正文',
  review: '审查一致性',
  done: '草稿完成',
  error: '运行失败',
};

const agentWorkflowSteps = [
  { id: 'starting', label: '准备运行环境', description: '整理章节、卡片和已选记忆' },
  { id: 'intent', label: '识别创作意图', description: '选择适用的写作技能' },
  { id: 'retrieve', label: '检索故事记忆', description: '读取相关人物、设定和时间线' },
  { id: 'plan', label: '制定下一章计划', description: '梳理承接、事件链、节奏、伏笔和章末钩子' },
  { id: 'draft', label: '生成章节草稿', description: '组织上下文并调用模型写作' },
  { id: 'review', label: '审查一致性', description: '检查人物、逻辑与时间线' },
] as const;

type AgentWorkflowStepId = typeof agentWorkflowSteps[number]['id'];

interface AgentProgressItem {
  id: AgentWorkflowStepId;
  label: string;
  description: string;
  status: AgentProgressStatus;
  message: string;
  progress: number;
}

interface AgentProgressEvent {
  runId?: string;
  type?: 'progress' | 'context' | 'chunk' | 'complete' | 'error';
  data?: {
    step?: string;
    progress?: number;
    text?: string;
    message?: string;
    error?: string;
    context?: {
      action: string;
      source?: string;
      status?: 'searching' | 'selected' | 'pruned' | 'loaded' | 'cached';
      bytes?: number;
      items?: number;
    };
  };
}

interface ContextTraceEvent {
  id: string;
  step: string;
  action: string;
  source?: string;
  status?: 'searching' | 'selected' | 'pruned' | 'loaded' | 'cached';
  bytes?: number;
  items?: number;
  timestamp: number;
}

const createAgentProgressItems = (): AgentProgressItem[] => agentWorkflowSteps.map(step => ({
  ...step,
  status: 'pending',
  message: '',
  progress: 0,
}));

const isAgentWorkflowStep = (value: string | undefined): value is AgentWorkflowStepId => Boolean(value && agentWorkflowSteps.some(step => step.id === value));
const agentRunning = (stage: AgentStage) => !['idle', 'done', 'error'].includes(stage);

const defaultBaseURL = 'https://api.apisaver.com/v1';
const memoryQuotaCooldownMs = 5 * 60 * 1000;
let memoryQuotaRetryAt = 0;
const isQuotaExceededError = (value: unknown) => /quota\s+(?:has\s+been\s+)?exceeded|insufficient[\s_-]*quota|billing[\s_-]*(?:limit|quota)|额度(?:已)?用尽|余额不足/iu.test(String(value));
// These records can contain complete novels and downloaded books. Tauri writes
// them to the iOS app-data directory; keeping a second WebView copy exhausts
// the WKWebView quota and is only needed by the plain-browser development mode.
const deviceBackedStateKeys = new Set([
  'projects',
  'writer-library-books',
  'writer-ranking-books',
  'writer-dismantle-books',
  'writer-writing-styles',
]);
const normalizeAgentConfig = (value: unknown): AgentConfig => {
  const parsed = value && typeof value === 'object' ? value as Partial<AgentConfig> & Record<string, unknown> : {};
  const apiKeys = Array.from(new Set([
    typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    ...(Array.isArray(parsed.apiKeys) ? parsed.apiKeys : []),
  ].filter((key): key is string => typeof key === 'string' && Boolean(key.trim())).map(key => key.trim())));
  const savedModelKeyMap = parsed.modelKeyMap && typeof parsed.modelKeyMap === 'object' ? parsed.modelKeyMap as Record<string, unknown> : {};
  const modelKeyMap = Object.fromEntries(Object.entries(savedModelKeyMap).flatMap(([model, values]) => {
    const mappedKeys = Array.isArray(values)
      ? values.filter((key): key is string => typeof key === 'string' && apiKeys.includes(key))
      : [];
    return mappedKeys.length ? [[model, Array.from(new Set(mappedKeys))]] : [];
  }));
  return {
    serviceName: typeof parsed.serviceName === 'string' ? parsed.serviceName : 'ApiSaver（省API）',
    enabled: parsed.enabled !== false,
    // ApiSaverWriter is a managed OpenAI-compatible gateway. Model selection
    // chooses its matching key; it must not also switch the wire protocol.
    apiMode: 'openai',
    // ApiSaverWriter uses one managed gateway. Keep legacy/custom values from
    // leaking into requests or making the settings UI appear configurable.
    baseURL: defaultBaseURL,
    apiKey: typeof parsed.apiKey === 'string' && parsed.apiKey.trim() ? parsed.apiKey.trim() : apiKeys[0] || '',
    apiKeys,
    modelKeyMap,
    model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : fallbackModels[0],
    contextWindow: Number((parsed as Record<string, unknown>).contextWindowKB ?? (Number(parsed.contextWindow) > 1024 ? Number(parsed.contextWindow) / 1024 : parsed.contextWindow)) || 128,
    reasoningMode: parsed.reasoningMode === 'off' || parsed.reasoningMode === 'low' || parsed.reasoningMode === 'medium' || parsed.reasoningMode === 'high' || parsed.reasoningMode === 'max' || parsed.reasoningMode === 'custom' ? parsed.reasoningMode : 'auto',
    proxyEnabled: parsed.proxyEnabled === true,
    proxyURL: typeof parsed.proxyURL === 'string' && parsed.proxyURL.trim() ? parsed.proxyURL : 'http://127.0.0.1:7897',
    proxyBypassLocal: parsed.proxyBypassLocal === true,
    memorySummaryChapterCount: Math.max(0, Math.min(20, Number(parsed.memorySummaryChapterCount) || 5)),
  };
};
const agentNetworkParams = (config: AgentConfig) => ({
  proxyEnabled: config.proxyEnabled,
  proxyURL: config.proxyURL.trim(),
  proxyBypassLocal: config.proxyBypassLocal,
});
const orderApiKeysForModel = (config: Pick<AgentConfig, 'apiKey' | 'apiKeys' | 'modelKeyMap'>, model: string) => {
  const all = Array.from(new Set([config.apiKey, ...(config.apiKeys || [])].map(key => key.trim()).filter(Boolean)));
  const preferred = (config.modelKeyMap?.[model] || []).filter(key => all.includes(key));
  return Array.from(new Set([...preferred, ...all]));
};
const applyModelKeyRouting = <T extends AgentConfig>(config: T, model: string): T => {
  const keys = orderApiKeysForModel(config, model);
  return { ...config, model, apiKey: keys[0] || '', apiKeys: keys };
};
const fallbackModels = ['gpt-5.6-luna', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4'];
const outlineKinds: OutlineKind[] = ['总纲', '章纲', '世界观与作品设定'];
const memoryDocumentKinds: MemoryDocumentKind[] = ['章节快照', '人物状态', '角色认知', '伏笔追踪', '时间线', '设定事实', '冲突'];

const memoryDocumentId = (kind: MemoryDocumentKind) => `memory-document:${kind}`;
const asTextList = (value: unknown, limit = 20) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, limit)
  : [];
const memoryTextList = (value: string) => value.split(/\r?\n|、/).map(item => item.trim()).filter(Boolean).slice(0, 30);

const localResourceId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const splitTxtIntoDismantleChapters = (text: string): Array<{ title: string; sourceContent: string }> => {
  const cleaned = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').trim();
  if (!cleaned) return [];
  // 兼容网文 TXT 常见的标题行：第X章、Chapter X、1、标题、1. 标题、1 标题。
  // 仅识别独立行，避免正文中的普通数字被错误切分。
  const heading = new RegExp('^[\\t 　]*(?:第[\\t 　]*[0-9０-９一二三四五六七八九十百千万零〇两]+[\\t 　]*[章节卷回部篇集].*|(?:chapter|chap\\.?)\\s*[0-9０-９]+(?:[\\t 　]*[-—:：、.．][\\t 　]*.*)?|(?:[0-9０-９]{1,5}|[一二三四五六七八九十百千万零〇两]{1,8})[\\t 　]*[、.．:：\\-—][\\t 　]*(?:\\S.*)?|(?:[0-9０-９]{1,5}|[一二三四五六七八九十百千万零〇两]{1,8})[\\t 　]*$|[0-9０-９]{1,5}[\\t 　]+\\S.*)$', 'gimu');
  const matches = Array.from(cleaned.matchAll(heading));
  if (!matches.length) return [{ title: '第1章', sourceContent: cleaned }];
  const chapters: Array<{ title: string; sourceContent: string }> = [];
  const preface = cleaned.slice(0, matches[0].index).trim();
  if (preface) chapters.push({ title: '序章', sourceContent: preface });
  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? cleaned.length;
    const sourceContent = cleaned.slice(start, end).trim();
    const firstBreak = sourceContent.indexOf('\n');
    const title = (firstBreak >= 0 ? sourceContent.slice(0, firstBreak) : sourceContent).trim().slice(0, 100) || `第${chapters.length + 1}章`;
    const body = (firstBreak >= 0 ? sourceContent.slice(firstBreak + 1) : '').trim();
    chapters.push({ title, sourceContent: body || sourceContent });
  });
  return chapters.filter(chapter => chapter.sourceContent.trim());
};

const readLocalTxtFile = async (file: File): Promise<string> => {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try { return new TextDecoder('gb18030').decode(bytes); }
    catch { return new TextDecoder().decode(bytes); }
  }
};

const normalizeDismantleChapter = (chapter: Partial<DismantleChapter>, index: number): DismantleChapter => ({
  id: typeof chapter.id === 'string' ? chapter.id : localResourceId('dismantle-chapter'),
  number: Number(chapter.number) || index + 1,
  title: typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title.trim() : `第${index + 1}章`,
  sourceContent: typeof chapter.sourceContent === 'string' ? chapter.sourceContent : '',
  wordCount: countNovelCharacters(typeof chapter.sourceContent === 'string' ? chapter.sourceContent : ''),
  summary: typeof chapter.summary === 'string' ? chapter.summary : '',
  detailedOutline: typeof chapter.detailedOutline === 'string' ? chapter.detailedOutline : '',
  plotBeats: asTextList(chapter.plotBeats, 10),
  characterDynamics: asTextList(chapter.characterDynamics, 10),
  setupPayoff: asTextList(chapter.setupPayoff, 10),
  pacing: typeof chapter.pacing === 'string' ? chapter.pacing : '',
  rewriteContent: typeof chapter.rewriteContent === 'string' ? chapter.rewriteContent : '',
  status: chapter.status === 'analyzing' || chapter.status === 'analyzed' || chapter.status === 'rewritten' ? chapter.status : 'pending',
  sourcePath: typeof chapter.sourcePath === 'string' ? chapter.sourcePath : undefined,
  outlinePath: typeof chapter.outlinePath === 'string' ? chapter.outlinePath : undefined,
  rewritePath: typeof chapter.rewritePath === 'string' ? chapter.rewritePath : undefined,
  updatedAt: typeof chapter.updatedAt === 'string' ? chapter.updatedAt : new Date().toISOString(),
});

const normalizeDismantleBook = (book: Partial<DismantleBook>): DismantleBook => {
  const now = new Date().toISOString();
  return {
    id: typeof book.id === 'string' ? book.id : localResourceId('dismantle'),
    title: typeof book.title === 'string' && book.title.trim() ? book.title.trim() : '未命名拆书',
    sourceFileName: typeof book.sourceFileName === 'string' ? book.sourceFileName : '',
    chapters: Array.isArray(book.chapters) ? book.chapters.map((chapter, index) => normalizeDismantleChapter(chapter, index)) : [],
    boundProjectId: typeof book.boundProjectId === 'number' ? book.boundProjectId : undefined,
    sourceLibraryBookId: typeof book.sourceLibraryBookId === 'string' ? book.sourceLibraryBookId : undefined,
    createdAt: typeof book.createdAt === 'string' ? book.createdAt : now,
    updatedAt: typeof book.updatedAt === 'string' ? book.updatedAt : now,
  };
};

const normalizeLibraryBookChapter = (chapter: Partial<LibraryBookChapter>, index: number): LibraryBookChapter => ({
  id: typeof chapter.id === 'string' ? chapter.id : localResourceId('book-chapter'),
  number: Number(chapter.number) || index + 1,
  title: typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title.trim() : `第${index + 1}章`,
  url: typeof chapter.url === 'string' ? chapter.url : '',
  content: typeof chapter.content === 'string' ? chapter.content : '',
  wordCount: countNovelCharacters(typeof chapter.content === 'string' ? chapter.content : ''),
  downloaded: chapter.downloaded === true && Boolean(chapter.content?.trim()),
  unavailableReason: typeof chapter.unavailableReason === 'string' ? chapter.unavailableReason : undefined,
  outline: typeof chapter.outline === 'string' ? chapter.outline : undefined,
});

const normalizeLibraryBook = (book: Partial<LibraryBook>): LibraryBook => {
  const now = new Date().toISOString();
  return {
    id: typeof book.id === 'string' ? book.id : localResourceId('book'),
    title: typeof book.title === 'string' && book.title.trim() ? book.title.trim() : '未命名书籍',
    author: typeof book.author === 'string' ? book.author : '未知作者',
    source: typeof book.source === 'string' ? book.source : '番茄小说',
    sourceId: typeof book.sourceId === 'string' ? book.sourceId : undefined,
    sourceBookId: typeof book.sourceBookId === 'string' ? book.sourceBookId : undefined,
    url: typeof book.url === 'string' ? book.url : '',
    intro: typeof book.intro === 'string' ? book.intro : '',
    cover: typeof book.cover === 'string' ? book.cover : undefined,
    category: typeof book.category === 'string' ? book.category : undefined,
    wordCount: Number(book.wordCount) || undefined,
    chapters: Array.isArray(book.chapters) ? book.chapters.map((chapter, index) => normalizeLibraryBookChapter(chapter, index)) : [],
    downloadedAt: typeof book.downloadedAt === 'string' ? book.downloadedAt : undefined,
    createdAt: typeof book.createdAt === 'string' ? book.createdAt : now,
    updatedAt: typeof book.updatedAt === 'string' ? book.updatedAt : now,
    localPath: typeof book.localPath === 'string' ? book.localPath : undefined,
    fontCss: typeof book.fontCss === 'string' ? book.fontCss : undefined,
  };
};

const normalizeRankingBook = (book: Partial<RankingBook>, index: number): RankingBook => ({
  id: typeof book.id === 'string' ? book.id : localResourceId('ranking-book'),
  title: typeof book.title === 'string' ? book.title : '未命名书籍',
  author: typeof book.author === 'string' ? book.author : '未知作者',
  intro: typeof book.intro === 'string' ? book.intro : '',
  cover: typeof book.cover === 'string' ? book.cover.replace(/^http:/iu, 'https:') : undefined,
  category: typeof book.category === 'string' ? book.category : undefined,
  rank: Number(book.rank) || index + 1,
  rankType: book.rankType === 'new' || book.rankType === 'hot' || book.rankType === 'completed' || book.rankType === 'collect' ? book.rankType : 'read',
  gender: book.gender === 'male' || book.gender === 'female' ? book.gender : 'all',
  platform: book.platform === 'qidian' || book.platform === 'faloo' ? book.platform : 'fanqie',
  sourceBookId: typeof book.sourceBookId === 'string' ? book.sourceBookId : undefined,
  url: typeof book.url === 'string' ? book.url : '',
  wordCount: Number(book.wordCount) || undefined,
  readCount: Number(book.readCount) || undefined,
  fetchedAt: typeof book.fetchedAt === 'string' ? book.fetchedAt : new Date().toISOString(),
  sourceName: typeof book.sourceName === 'string' ? book.sourceName : undefined,
});

const trustedRankingCache = (book: RankingBook) => book.platform !== 'fanqie' || book.sourceName === '番茄小说网';

const normalizeWritingStyle = (style: Partial<WritingStyle>): WritingStyle => {
  const now = new Date().toISOString();
  return {
    id: typeof style.id === 'string' ? style.id : localResourceId('style'),
    name: typeof style.name === 'string' && style.name.trim() ? style.name.trim() : '未命名文风',
    description: typeof style.description === 'string' ? style.description : '',
    tags: asTextList(style.tags, 12),
    content: typeof style.content === 'string' ? style.content : '',
    sourceBookId: typeof style.sourceBookId === 'string' ? style.sourceBookId : undefined,
    createdAt: typeof style.createdAt === 'string' ? style.createdAt : now,
    updatedAt: typeof style.updatedAt === 'string' ? style.updatedAt : now,
    sourcePath: typeof style.sourcePath === 'string' ? style.sourcePath : undefined,
  };
};

const chapterOrder = (memory: ChapterMemory) => memory.sourceChapterNumber ?? memory.chapterId;
const recentMemoryIds = (memories: ChapterMemory[], limit = 1) => [...memories]
  .sort((left, right) => chapterOrder(left) - chapterOrder(right))
  .slice(-limit)
  .map(memory => memory.id);

const memoryListMarkdown = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '- 暂无';

const readableChapterPlan = (value?: string): string => {
  const text = String(value || '').trim().replace(/^```(?:json|markdown|text)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const plan = parsed.plan ?? parsed.content ?? parsed;
    if (typeof plan === 'string') return readableChapterPlan(plan);
    if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
      const labels: Record<string, string> = { opening: '开篇承接', openingAnchor: '开篇承接', handoff: '下一章交接', continuity: '承接锚点', story: '这章的故事', plot: '核心事件链', events: '核心事件链', characters: '这章的人物', characterGoals: '人物目标与动机', conflict: '冲突升级', pacing: '节奏安排', rhythm: '节奏安排', newInformation: '本章新增信息', foreshadowing: '伏笔推进', ending: '章末钩子', hook: '章末钩子', style: '写法与禁区' };
      return Object.entries(plan as Record<string, unknown>).map(([key, entry]) => {
        const label = labels[key] || key;
        const detail = Array.isArray(entry) ? entry.map(item => `- ${String(item)}`).join('\n') : typeof entry === 'object' && entry ? Object.entries(entry as Record<string, unknown>).map(([subKey, subValue]) => `- ${subKey}：${String(subValue)}`).join('\n') : String(entry ?? '');
        return detail ? `## ${label}\n${detail}` : '';
      }).filter(Boolean).join('\n\n');
    }
  } catch { /* Plain Markdown plans are already suitable for display. */ }
  return text;
};

const snapshotMarkdown = (memory: ChapterMemory) => `# ${memory.chapterTitle} 记忆快照

## 章节摘要
${memory.summary || '暂无摘要'}

## 关键词
${memory.keywords.length ? memory.keywords.map(item => `- ${item}`).join('\n') : '- 暂无'}

## 人物状态变化
${memoryListMarkdown(memory.characterStateChanges)}

## 角色认知变化
${memoryListMarkdown(memory.knowledgeChanges)}

## 伏笔变化
${memoryListMarkdown(memory.foreshadowingChanges)}

## 时间线事件
${memoryListMarkdown(memory.timelineEvents)}

## 设定事实
${memoryListMarkdown(memory.canonFacts)}

## 冲突
${memoryListMarkdown(memory.conflicts)}

## 章末钩子
${memory.endingHook || '暂无'}
`;

const buildMemoryDocuments = (memories: ChapterMemory[], existingDocuments: MemoryDocument[] = [], force = false): MemoryDocument[] => {
  const ordered = [...memories].sort((left, right) => chapterOrder(left) - chapterOrder(right));
  const sections = (title: string, entries: Array<{ memory: ChapterMemory; items: string[] }>) => `# ${title}\n\n${entries.length
    ? entries.map(({ memory, items }) => `## ${memory.chapterTitle}\n${memoryListMarkdown(items)}`).join('\n\n')
    : '暂无已保存章节记忆。'}\n`;
  const documentContent: Record<MemoryDocumentKind, string> = {
    '章节快照': `# 章节快照\n\n${ordered.length ? ordered.map(memory => `## ${memory.chapterTitle}\n${memory.summary || '暂无摘要'}\n\n关键词：${memory.keywords.join('、') || '暂无'}\n\n人物状态：${memory.characterStateChanges.join('；') || '暂无'}\n认知变化：${memory.knowledgeChanges.join('；') || '暂无'}\n伏笔：${memory.foreshadowingChanges.join('；') || '暂无'}\n时间线：${memory.timelineEvents.join('；') || '暂无'}\n设定事实：${memory.canonFacts.join('；') || '暂无'}\n冲突：${memory.conflicts.join('；') || '暂无'}\n章末钩子：${memory.endingHook || '暂无'}`).join('\n\n---\n\n') : '暂无已保存章节记忆。'}\n`,
    '人物状态': sections('人物状态', ordered.map(memory => ({ memory, items: memory.characterStateChanges }))),
    '角色认知': sections('角色认知', ordered.map(memory => ({ memory, items: memory.knowledgeChanges }))),
    '伏笔追踪': sections('伏笔追踪', ordered.map(memory => ({ memory, items: memory.foreshadowingChanges }))),
    '时间线': sections('时间线', ordered.map(memory => ({ memory, items: memory.timelineEvents }))),
    '设定事实': sections('设定事实', ordered.map(memory => ({ memory, items: memory.canonFacts }))),
    '冲突': sections('冲突', ordered.map(memory => ({ memory, items: memory.conflicts }))),
  };
  const now = new Date().toISOString();
  return memoryDocumentKinds.map(kind => {
    const existing = existingDocuments.find(document => document.kind === kind);
    const preserveManual = Boolean(existing?.manuallyEdited) && !force;
    return {
      id: memoryDocumentId(kind),
      kind,
      title: kind,
      content: preserveManual ? existing?.content ?? documentContent[kind] : documentContent[kind],
      updatedAt: preserveManual ? existing?.updatedAt ?? now : now,
      manuallyEdited: preserveManual,
    };
  });
};

const hydrateMemoryDocuments = (documents: unknown, memories: ChapterMemory[]): MemoryDocument[] => {
  const generated = buildMemoryDocuments(memories);
  if (!Array.isArray(documents) || documents.length === 0) return generated;
  return generated.map(template => {
    const saved = documents.find(item => item && typeof item === 'object' && (item as MemoryDocument).kind === template.kind) as Partial<MemoryDocument> | undefined;
    if (!saved) return template;
    const content = typeof saved.content === 'string' ? saved.content : template.content;
    return {
      ...template,
      ...saved,
      id: memoryDocumentId(template.kind),
      kind: template.kind,
      title: template.kind,
      content,
      manuallyEdited: Boolean(saved.manuallyEdited) || content !== template.content,
    };
  });
};

const normalizeChapterMemory = (memory: Partial<ChapterMemory>, fallbackChapter?: Chapter): ChapterMemory => {
  const now = new Date().toISOString();
  return {
    id: typeof memory.id === 'number' ? memory.id : Date.now(),
    chapterId: typeof memory.chapterId === 'number' ? memory.chapterId : (fallbackChapter?.id ?? 0),
    chapterTitle: typeof memory.chapterTitle === 'string' ? memory.chapterTitle : (fallbackChapter?.title ?? '未命名章节'),
    summary: typeof memory.summary === 'string' ? memory.summary : '',
    keywords: asTextList(memory.keywords, 8),
    characterStateChanges: asTextList(memory.characterStateChanges),
    knowledgeChanges: asTextList(memory.knowledgeChanges),
    foreshadowingChanges: asTextList(memory.foreshadowingChanges),
    foreshadowingItems: Array.isArray(memory.foreshadowingItems) ? memory.foreshadowingItems.filter(item => item && typeof item.text === 'string').map(item => ({ ...item, status: item.status || 'active', priority: item.priority || 'normal' })) : [],
    timelineEvents: asTextList(memory.timelineEvents),
    canonFacts: asTextList(memory.canonFacts),
    conflicts: asTextList(memory.conflicts),
    endingHook: typeof memory.endingHook === 'string' ? memory.endingHook : '',
    sourceChapterNumber: typeof memory.sourceChapterNumber === 'number' ? memory.sourceChapterNumber : undefined,
    createdAt: typeof memory.createdAt === 'string' ? memory.createdAt : now,
    updatedAt: typeof memory.updatedAt === 'string' ? memory.updatedAt : (typeof memory.createdAt === 'string' ? memory.createdAt : now),
  };
};

const buildLocalChapterSummary = (content: string) => {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 220) return normalized;
  const sentences = normalized.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [];
  const summary = sentences.slice(0, 3).join('').trim();
  return summary.length > 220 ? `${summary.slice(0, 220)}...` : summary;
};

const extractLocalKeywords = (content: string) => {
  const ignored = new Set(['这一章', '故事', '小说', '主角', '他们', '自己', '已经', '没有', '一个', '什么']);
  const matches = content.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  return Array.from(new Set(matches.filter(word => !ignored.has(word)))).slice(0, 8);
};

const chapterSentences = (content: string) => content
  .replace(/\s+/gu, ' ')
  .split(/(?<=[。！？!?])/u)
  .map(sentence => sentence.trim())
  .filter(sentence => sentence.length >= 8);

// This is intentionally conservative: it gives a saved chapter a useful local
// memory immediately, while the model can later refine it. It also prevents an
// iOS network/SSE failure from replacing all structured fields with empty lists.
const buildLocalStructuredMemory = (chapter: Chapter, project: Project) => {
  const sentences = chapterSentences(chapter.content);
  const namedCharacters = Array.from(new Set([
    project.protagonist1,
    project.protagonist2,
    ...project.cards.filter(card => card.type === '角色卡').flatMap(card => {
      const aliases = card.content.match(/(?:姓名|名称|本名|别名|称号|代号)\s*[：:]\s*([^\n；;，,]+)/gu) ?? [];
      return [card.title, ...aliases.map(alias => alias.replace(/^.*?[：:]/u, '').trim())];
    }),
  ].map(name => (name || '').trim()).filter(name => name.length >= 2 && name.length <= 24)));
  const quote = (sentence: string, limit = 110) => sentence.length > limit ? `${sentence.slice(0, limit)}...` : sentence;
  const sentencesFor = (name: string) => sentences.filter(sentence => sentence.includes(name));
  const stateSignals = /(?:受伤|恢复|突破|晋升|获得|失去|决定|答应|拒绝|愤怒|紧张|恐惧|欣喜|冷静|昏迷|逃离|抵达|离开|出现|死亡|复活|怀疑|对峙|交手|战胜|失败)/u;
  const knowledgeSignals = /(?:得知|发现|意识到|明白|知晓|看出|听说|告知|透露|隐瞒|秘密|真相|怀疑|认出|记起|见到|听到|收到|面对|接触|阅读|察觉)/u;
  const characterStateChanges = namedCharacters.flatMap(name => {
    const evidence = sentencesFor(name).find(sentence => stateSignals.test(sentence)) || sentencesFor(name)[0];
    return evidence ? [`${name}：${quote(evidence)}`] : [];
  }).slice(0, 12);
  const knowledgeChanges = namedCharacters.flatMap(name => {
    const evidence = sentencesFor(name).find(sentence => knowledgeSignals.test(sentence));
    return evidence ? [`${name}：${quote(evidence)}`] : [];
  }).slice(0, 12);
  const explicitForeshadowing = sentences.filter(sentence => /(?:伏笔|秘密|异常|似乎|预感|未知|线索|暗中|背后|等待|不对劲|尚未|还没|未曾|将要|明天|计划|任务|目标|约定)/u.test(sentence)).slice(-4).map(sentence => quote(sentence));
  const timelineEvents = sentences.filter(sentence => /(?:此时|随后|当晚|次日|清晨|傍晚|终于|之后|不久|刚刚|同时)/u.test(sentence)).slice(0, 6).map(sentence => quote(sentence));
  const canonFacts = sentences.filter(sentence => /(?:规则|能力|境界|系统|必须|不能|限制|代价|身份|设定)/u.test(sentence)).slice(0, 6).map(sentence => quote(sentence));
  const endingHook = [...sentences].reverse().find(sentence => /(?:？|!|！|却|竟|突然|危机|秘密|声音|身影|下一刻|门外)/u.test(sentence)) || '';
  const foreshadowingChanges = explicitForeshadowing.length
    ? explicitForeshadowing
    : (endingHook ? [`待承接线索：${quote(endingHook)}`] : []);
  const explicitConflicts = sentences.filter(sentence => /(?:冲突|争执|嘲讽|威胁|攻击|反击|对峙|战斗|追杀|阻拦|拒绝|质问|逼迫|挑衅|敌人|杀意|不满|冷笑|喝道|争夺|谈判)/u.test(sentence)).slice(0, 6).map(sentence => quote(sentence));
  const conflicts = explicitConflicts;
  return {
    summary: buildLocalChapterSummary(chapter.content),
    keywords: extractLocalKeywords(chapter.content),
    characterStateChanges,
    knowledgeChanges,
    foreshadowingChanges,
    timelineEvents,
    canonFacts,
    conflicts,
    endingHook: quote(endingHook),
  };
};

const aiDetectionLabel = (confidence: number): AIDetectionLabel => {
  if (confidence >= 0.99) return 'AI 特征';
  if (confidence >= 0.5) return '疑似 AI';
  return '人工';
};

const splitAIDetectionSegments = (text: string, chapterScore: number): AIDetectionSegment[] => {
  // Keep paragraph separators in the segment so stored offsets remain aligned
  // with the editor content when the result is rendered as an overlay.
  const parts = text.match(/[\s\S]*?(?:\n{2,}|$)/gu) ?? [text];
  let order = 0;
  return parts.filter(part => part.length > 0).map(part => {
    const sentences = part.split(/[。！？!?\n]/u).map(item => item.trim()).filter(Boolean);
    const lengths = sentences.map(item => item.length);
    const average = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0;
    const variance = lengths.length ? lengths.reduce((sum, length) => sum + (length - average) ** 2, 0) / lengths.length : 0;
    const uniformity = lengths.length ? Math.max(0, 100 - Math.sqrt(variance) * 2) : 50;
    const logicCount = ['但是', '不过', '然而', '因此', '所以', '首先', '其次', '最后', '总之'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const colloquialCount = ['咋', '啥', '呗', '嘛', '呢', '啊', '呀', '咯', '喽', '琢磨', '寻思'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const templateCount = ['首先', '其次', '最后', '总之', '综上所述', '值得注意的是', '需要注意的是', '通过这种方式'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const normalizedLength = Math.max(1, part.replace(/\s+/gu, '').length);
    const localSignal = 0.08 + uniformity / 100 * 0.2 + Math.min(1, logicCount / Math.max(1, sentences.length)) * 0.18 + (1 - Math.min(1, colloquialCount / Math.max(1, sentences.length))) * 0.14 + chapterScore * 0.16;
    const stronglyTemplated = sentences.length >= 4 && uniformity >= 88 && (templateCount >= 3 || logicCount >= 5);
    const confidence = stronglyTemplated ? 0.99 : Math.max(0, Math.min(0.98, Number((localSignal + (normalizedLength < 30 ? 0.03 : 0)).toFixed(3))));
    return { order: ++order, text: part, confidence, label: aiDetectionLabel(confidence) };
  });
};

const analyzeAIChapter = (chapter: Chapter): AIDetectionChapter => {
  const text = chapter.content.replace(/^【第\d+章[^】]*】\s*/u, '').replace(/（本章完）\s*$/u, '').trim();
  const sentences = text.split(/[。！？\n]/u).map(item => item.trim()).filter(Boolean);
  const lengths = sentences.map(item => item.length);
  const average = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0;
  const variance = lengths.length ? lengths.reduce((sum, length) => sum + (length - average) ** 2, 0) / lengths.length : 0;
  const sentenceUniformity = lengths.length ? Math.max(0, 100 - Math.sqrt(variance) * 2) : 50;
  const logicWords = ['但是', '不过', '然而', '因此', '所以', '首先', '其次', '最后', '总之', '综上所述'];
  const colloquialWords = ['咋', '啥', '呗', '嘛', '呢', '啊', '呀', '咯', '喽', '琢磨', '寻思', '要得'];
  const psychologicalPatterns = ['心里一', '心里头', '心里有', '心里明白', '心里盘算'];
  const perHundred = (count: number) => text.length ? count / (text.length / 100) : 0;
  const logicFrequency = perHundred(logicWords.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const colloquialFrequency = perHundred(colloquialWords.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const psychologicalFrequency = perHundred(psychologicalPatterns.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const paragraphs = text.split(/\n\n/u).map(item => item.trim()).filter(Boolean);
  const paragraphLengths = paragraphs.map(item => item.length);
  const paragraphAverage = paragraphLengths.length ? paragraphLengths.reduce((sum, length) => sum + length, 0) / paragraphLengths.length : 0;
  const paragraphVariance = paragraphLengths.length ? paragraphLengths.reduce((sum, length) => sum + (length - paragraphAverage) ** 2, 0) / paragraphLengths.length : 0;
  const paragraphUniformity = paragraphs.length > 1 ? Math.max(0, 100 - Math.sqrt(paragraphVariance)) : 50;
  const logicScore = Math.min(1, logicFrequency * 10 / 100);
  const colloquialScore = Math.min(1, colloquialFrequency * 20 / 100);
  const aiRate = Math.min(100, Math.max(0, sentenceUniformity / 100 * 25 + logicScore * 25 + (1 - colloquialScore) * 25 + Math.min(1, psychologicalFrequency * 5) * 15 + paragraphUniformity / 100 * 10));
  const segments = splitAIDetectionSegments(chapter.content, aiRate / 100);
  return {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    wordCount: countNovelCharacters(chapter.content),
    sentenceUniformity: Number(sentenceUniformity.toFixed(1)),
    logicFrequency: Number(logicFrequency.toFixed(2)),
    colloquialFrequency: Number(colloquialFrequency.toFixed(2)),
    psychologicalFrequency: Number(psychologicalFrequency.toFixed(2)),
    paragraphUniformity: Number(paragraphUniformity.toFixed(1)),
    aiRate: Number(aiRate.toFixed(1)),
    humanRate: Number((100 - aiRate).toFixed(1)),
    segments,
    label: aiDetectionLabel(aiRate / 100),
  };
};

const buildAIDetectionReport = (project: Project, scope: 'chapter' | 'book', chapter?: Chapter): AIDetectionReport => {
  const chapters = (scope === 'chapter' && chapter ? [chapter] : project.chapters).filter(item => item.content.trim()).map(analyzeAIChapter);
  const averageAIRate = chapters.length ? chapters.reduce((sum, item) => sum + item.aiRate, 0) / chapters.length : 0;
  const level = averageAIRate < 30 ? '极低' : averageAIRate < 45 ? '低' : averageAIRate < 60 ? '中等' : '高';
  const suggestion = averageAIRate < 30 ? '文本具有较强的人类写作特征。' : averageAIRate < 45 ? '文本具有人类写作特征，可保持具体动作和口语表达。' : averageAIRate < 60 ? '文本存在混合特征，建议增加句式变化和个性化细节。' : '文本具有较多模板化特征，建议使用去 AI 味技能复写后再检测。';
  return { updatedAt: new Date().toISOString(), scope, chapters, averageAIRate: Number(averageAIRate.toFixed(1)), level, suggestion, provider: '本地启发式' };
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countOccurrences = (content: string, query: string) => {
  if (!query) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf(query, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + Math.max(1, query.length);
  }
  return count;
};

const findTextMatches = (content: string, query: string): number[] => {
  if (!query) return [];
  const matches: number[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf(query, cursor);
    if (index < 0) break;
    matches.push(index);
    cursor = index + Math.max(1, query.length);
  }
  return matches;
};

const searchSnippet = (content: string, position: number, query: string): string => {
  const start = Math.max(0, position - 54);
  const end = Math.min(content.length, position + query.length + 110);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return `${prefix}${content.slice(start, end).replace(/\s+/gu, ' ').trim()}${suffix}`;
};

const formatNovelChapterContent = (content: string) => content
  .replace(/^\uFEFF/u, '')
  .replace(/\r\n?/gu, '\n')
  .replace(/[\u00A0\u2007\u202F]/gu, ' ')
  .split('\n')
  .map(line => line.trim())
  .join('\n')
  .replace(/\n{3,}/gu, '\n\n')
  .trim();

type TabType = 'projects' | 'books' | 'dismantles' | 'rankings' | 'skills' | 'styles';
type TagTab = '主分类' | '主题' | '角色' | '情节';
type Channel = '男频' | '女频';

interface GenreTag {
  name: string;
  description?: string;
  icon: string;
  tone: string;
}

const compactTags = (items: Array<[string, string, string]>): GenreTag[] =>
  items.map(([name, icon, tone]) => ({ name, icon, tone }));

const simpleTags = (names: string[], icon = '✦', tone = 'gold'): GenreTag[] =>
  names.map(name => ({ name, icon, tone }));

const defaultProjectTags = (channel: Channel = '男频'): Record<TagTab, string[]> => ({
  主分类: [channel === '男频' ? '东方玄幻' : '女频悬疑'],
  主题: [],
  角色: [],
  情节: [],
});

const cloneProjectTags = (tags: Record<TagTab, string[]>): Record<TagTab, string[]> => ({
  主分类: [...tags.主分类],
  主题: [...tags.主题],
  角色: [...tags.角色],
  情节: [...tags.情节],
});

const maleTagCatalog: Record<TagTab, GenreTag[]> = {
  主分类: [
    { name: '东方玄幻', description: '偏东方世界观，包含玄法、奇术、神话传说', icon: '☯', tone: 'gold' },
    { name: '西方奇幻', description: '偏西方世界背景，包含魔法、骑士、精灵等', icon: '♜', tone: 'gold' },
    { name: '科幻末世', description: '末世、废土、星际、机甲、未来科技', icon: '◉', tone: 'blue' },
    { name: '男频衍生', description: '影视剧、动漫、网文世界的男频同人小说', icon: '✦', tone: 'gold' },
    { name: '都市高武', description: '都市架空，全民拥有修炼体系或超凡力量', icon: '⚡', tone: 'gold' },
    { name: '悬疑灵异', description: '男频探案、悬疑、恐怖、灵异和风水奇术', icon: '☠', tone: 'teal' },
    { name: '悬疑脑洞', description: '脑洞向的悬疑灵异、破案探险和未知谜团', icon: '⌕', tone: 'brown' },
    { name: '抗战谍战', description: '抗战时期的军事战争和间谍情报故事', icon: '◆', tone: 'green' },
    { name: '历史古代', description: '以种田、朝堂、智谋、争霸、科举等为主', icon: '▱', tone: 'green' },
    { name: '历史脑洞', description: '脑洞向历史，一般有金手指或特殊设定', icon: '◌', tone: 'teal' },
    { name: '都市种田', description: '重生年代文、职场商战、种田建设等题材', icon: '❋', tone: 'olive' },
    { name: '都市脑洞', description: '拥有金手指系统的男频都市脑洞奇想', icon: '▣', tone: 'navy' },
    { name: '都市日常', description: '都市情感、现实生活和轻日常故事', icon: '◆', tone: 'blue' },
    { name: '玄幻脑洞', description: '脑洞向玄幻，强调新奇设定和世界规则', icon: '♨', tone: 'orange' },
    { name: '战神赘婿', description: '都市向战神、兵王、赘婿逆袭文', icon: '⌁', tone: 'brown' },
    { name: '动漫衍生', description: '游戏、动漫专项同人或二次元衍生作品', icon: '✧', tone: 'peach' },
    { name: '游戏体育', description: '网游、竞技、体育及穿入游戏或世界', icon: '◎', tone: 'peach' },
    { name: '传统玄幻', description: '废柴逆袭、强者重生等传统玄幻题材', icon: '△', tone: 'teal' },
    { name: '都市修真', description: '以修真为力量体系的都市故事', icon: '◐', tone: 'olive' },
  ],
  主题: compactTags([
    ['衍生', '◫', 'gold'], ['仕途', '♟', 'gray'], ['综影视', '▰', 'gold'], ['天灾', '⚠', 'gold'],
    ['第一人称', 'Ⅰ', 'gold'], ['赛博朋克', '◉', 'navy'], ['第四天灾', 'Ⅳ', 'gold'], ['规则怪谈', '?', 'teal'],
    ['搞笑轻松', '☺', 'peach'], ['古代', '◒', 'gray'], ['悬疑', '●', 'red'], ['克苏鲁', '〰', 'navy'],
    ['都市异能', '⚡', 'purple'], ['末日求生', '☠', 'red'], ['灵气复苏', '✦', 'green'], ['高武世界', '拳', 'green'],
    ['异世大陆', '✣', 'blue'], ['东方玄幻', '龙', 'peach'], ['谍战', '➤', 'blue'], ['清朝', '帽', 'orange'],
    ['宋朝', '宋', 'coral'], ['断层', '山', 'brown'], ['武将', '将', 'teal'], ['国运', '鼎', 'red'],
    ['综漫', '漫', 'yellow'], ['开局', '剑', 'navy'], ['架空', '◉', 'blue'], ['奇幻仙侠', '剑', 'navy'],
    ['都市', '城', 'gold'], ['玄幻', '山', 'teal'], ['历史', '卷', 'green'], ['体育', '🏋', 'purple'], ['武侠', '鹤', 'gray'],
  ]),
  角色: compactTags([
    ['多女主', '女', 'peach'], ['赘婿', '婿', 'yellow'], ['全能', '◫', 'gold'], ['大佬', '鞋', 'purple'],
    ['大小姐', '花', 'coral'], ['特工', '人', 'teal'], ['游戏主播', '游', 'green'], ['神探', '探', 'brown'],
    ['宫廷侯爵', '宫', 'gold'], ['皇帝', '帝', 'brown'], ['单女主', '女', 'coral'], ['校花', '校', 'peach'],
    ['无女主', '无', 'teal'], ['女帝', '后', 'brown'], ['特种兵', '枪', 'teal'], ['反派', '影', 'navy'],
    ['神医', '诊', 'green'], ['奶爸', '奶', 'orange'], ['学霸', '100', 'brown'], ['天才', '脑', 'teal'],
    ['腹黑', '黑', 'purple'], ['扮猪吃虎', '猪', 'orange'],
  ]),
  情节: compactTags([
    ['都市江湖', '◫', 'gold'], ['风水秘术', '卦', 'gold'], ['斩神衍生', '◫', 'gold'], ['十日衍生', '◫', 'gold'],
    ['西游衍生', '游', 'brown'], ['公版衍生', '◫', 'gold'], ['红楼衍生', '◫', 'gold'], ['甄嬛衍生', '◫', 'gold'],
    ['如懿衍生', '◫', 'gold'], ['惊悚游戏', '惊', 'gold'], ['卡牌', '牌', 'gold'], ['山海经', '山', 'gold'],
    ['捉鬼', '鬼', 'gold'], ['剑修', '剑', 'gold'], ['废土', '土', 'gold'], ['副本', '本', 'gold'],
    ['黑科技', '科', 'gold'], ['无脑爽', '爽', 'gold'], ['魂穿', '魂', 'gold'], ['高手下山', '山', 'gold'],
    ['黑化', '黑', 'gold'], ['迪化', '迪', 'gold'], ['发家致富', '富', 'gold'], ['无后宫', '无', 'gold'],
    ['争霸', '争', 'gold'], ['1v1', '1', 'gold'], ['升级流', '↑', 'gold'], ['灵魂互换', '换', 'teal'],
    ['科举', '卷', 'gold'], ['封神', '神', 'gold'], ['四合院', '院', 'orange'], ['电竞', '竞', 'teal'],
    ['双重生', '双', 'blue'], ['乡村', '田', 'yellow'], ['同人', '同', 'yellow'], ['打脸', '掌', 'brown'],
    ['破案', '案', 'green'], ['囤物资', '箱', 'coral'], ['钓鱼', '鱼', 'olive'], ['网游', '剑', 'navy'],
    ['奥特同人', '奥', 'blue'], ['求生', '帐', 'green'], ['无敌', '拳', 'yellow'], ['九叔', '符', 'red'],
    ['穿书', '书', 'purple'], ['聊天群', '群', 'green'], ['大秦', '秦', 'red'], ['龙珠', '珠', 'green'],
    ['漫威', '盾', 'navy'], ['神奇宝贝', '球', 'blue'], ['海贼', '帽', 'blue'], ['火影', '忍', 'navy'],
    ['职场', '包', 'brown'], ['明朝', '明', 'gold'], ['家庭', '家', 'blue'], ['三国', '马', 'gold'],
    ['末世', '火', 'orange'], ['直播', '播', 'blue'], ['无限流', '∞', 'teal'], ['诸天万界', '界', 'olive'],
    ['大唐', '唐', 'brown'], ['宠物', '宠', 'brown'], ['外卖', '送', 'olive'], ['星际', '星', 'navy'],
    ['美食', '食', 'coral'], ['剑道', '刀', 'purple'], ['盗墓', '墓', 'gray'], ['灵异', '灵', 'green'],
    ['鉴宝', '镜', 'teal'], ['系统', '图', 'gold'], ['神豪', '钱', 'olive'], ['重生', '蝶', 'orange'],
    ['穿越', '穿', 'teal'], ['二次元', '笔', 'olive'], ['海岛', '岛', 'blue'], ['娱乐圈', '娱', 'gray'],
    ['空间', '空', 'coral'], ['推理', '帽', 'brown'], ['洪荒', '荒', 'orange'],
  ]),
};

const femaleTagCatalog: Record<TagTab, GenreTag[]> = {
  主分类: [
    { name: '女频悬疑', description: '以女性视角为主，讲述悬疑、探案和灵异故事', icon: '⌕', tone: 'red' },
    { name: '古风世情', description: '女频历史、权谋以及原生土著的古风故事', icon: '卷', tone: 'gold' },
    { name: '科幻末世', description: '末世、丧尸、星际、机甲与未来科技', icon: '◉', tone: 'blue' },
    { name: '女频衍生', description: '影视剧或古籍女频同人小说', icon: '✦', tone: 'gold' },
    { name: '青春甜宠', description: '校园题材，可甜可酸，青春成长', icon: '花', tone: 'coral' },
    { name: '双男主', description: '讲述两位男性主角之间的故事', icon: '双', tone: 'blue' },
    { name: '古言脑洞', description: '含金手指、系统或特殊设定的古言故事', icon: '古', tone: 'blue' },
    { name: '现言脑洞', description: '含系统、读心术等非现实元素的现言故事', icon: '今', tone: 'purple' },
    { name: '玄幻言情', description: '玄幻、修真、御兽等幻想言情故事', icon: '幻', tone: 'olive' },
    { name: '宫斗宅斗', description: '古代后宫、宅院与家族斗争', icon: '宫', tone: 'brown' },
    { name: '豪门总裁', description: '豪门、总裁、先婚后爱等都市情感故事', icon: '楼', tone: 'teal' },
    { name: '动漫衍生', description: '游戏、动漫等二次元方向的同人作品', icon: '漫', tone: 'peach' },
    { name: '星光璀璨', description: '娱乐圈、明星、综艺、恋综与直播故事', icon: '◆', tone: 'blue' },
    { name: '游戏体育', description: '网游、竞技、体育及穿入游戏世界', icon: '◎', tone: 'orange' },
    { name: '职场婚恋', description: '职场、婚姻生活与现实情感故事', icon: '职', tone: 'coral' },
    { name: '双女主', description: '讲述两位女性主角之间的故事', icon: '双', tone: 'navy' },
    { name: '年代', description: '穿越年代、重生年代与时代生活', icon: '年', tone: 'purple' },
    { name: '种田', description: '种田、空间、灵泉、逃荒与经营建设', icon: '田', tone: 'orange' },
    { name: '快穿', description: '主角穿越多个小世界完成任务', icon: '⌛', tone: 'teal' },
  ],
  主题: simpleTags([
    '古言权谋', '悬疑恋爱', '纯爱', '衍生', '仕途', '综影视', '天灾', '第一人称', '赛博朋克', '规则怪谈',
    '搞笑轻松', '古代', '悬疑', '谍战', '职场商战', '虐恋情深', '日久生情', '豪门世家', '综漫', '异世穿越',
    '独宠', '现代言情', '古代言情', '幻想言情', '武侠',
  ], '✦', 'coral'),
  角色: simpleTags([
    '位尊权重', '总裁', '忠犬', '全能', '白切黑', '双学霸', '作精', '大佬', '大小姐', '游戏主播',
    '神探', '将军', '毒医', '厨娘', '律师', '医生', '明星', '替身', '双面', '冰山', '古灵精怪',
    '天作之合', '可盐可甜', '无CP', '病娇', '反派', '萌宝', '宠妻', '学霸', '公主', '皇后', '王妃',
    '女强', '皇叔', '嫡女', '精灵', '天才', '腹黑', '扮猪吃虎', '团宠',
  ], '角', 'purple'),
  情节: simpleTags([
    '男二上位', '代嫁代娶', '攻略反派', '风水秘术', '斩神衍生', '十日衍生', '西游衍生', '公版衍生',
    '红楼衍生', '甄嬛衍生', '如懿衍生', '惊悚游戏', '追夫', '山海经', '胎穿', '捉鬼', '剑修',
    '相互救赎', '宠夫', '无脑爽', '魂穿', '黑化', '养崽', '年龄差', '真假千金', '久别重逢',
    '发家致富', '养成', '互宠', '1v1', '灵魂互换', '科举', '年下', '婚恋', '封神', '四合院', '电竞',
    '双重生', '前世今生', '双洁', '追妻火葬场', '乡村', '逃荒', '同人', '打脸', '破案', '囤物资',
    '钓鱼', 'HE', '相爱相杀', '暗恋', '逃婚', '带球跑', '强强', '一见钟情', '双向奔赴', '破镜重圆',
    '契约婚姻', '隐婚', '闪婚', '今穿古', '古穿今', '群穿', '护短', '虐渣', '情有独钟', '马甲',
    '先婚后爱', '医术', '女扮男装', '青梅竹马', '无敌', '民国', '穿书', '职场', '家庭', '末世',
    '直播', '无限流', '兽世', '清穿', '星际', '美食', '盗墓', '虐文', '甜宠', '灵异', '校园', '系统',
    '重生', '穿越', '二次元', '娱乐圈', '空间', '推理',
  ], '情', 'gold'),
};

const channelTagCatalog: Record<Channel, Record<TagTab, GenreTag[]>> = {
  男频: maleTagCatalog,
  女频: femaleTagCatalog,
};

function App() {
  const [activeTab, setActiveTab] = useState<TabType>('projects');
  const [projects, setProjects] = useState<Project[]>(() => {
    const saved = localStorage.getItem('projects');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // 兼容旧版本项目数据：补齐章节、大纲和时间字段
          return parsed.map((project: Partial<Project>) => {
            const chapters = Array.isArray(project.chapters) ? project.chapters.map((chapter: Partial<Chapter>) => ({
              id: Number(chapter.id) || Date.now(),
              title: chapter.title ?? '未命名章节',
              content: chapter.content ?? '',
              wordCount: countNovelCharacters(chapter.content ?? ''),
              createdAt: chapter.createdAt ?? new Date().toISOString(),
              updatedAt: chapter.updatedAt ?? new Date().toISOString(),
            })) : [];
            const legacyOutlines = Array.isArray(project.outlines) ? project.outlines : [];
            const legacyGoldFingerCards = legacyOutlines.filter((outline: any) => outline?.kind === '金手指' && String(outline.content || '').trim()).map((outline: any) => ({
              id: Number(outline.id) || Date.now(), type: '金手指卡' as CardType, title: outline.title || '金手指设定', content: outline.content,
              currentState: '', stateHistory: [], createdAt: outline.createdAt ?? new Date().toISOString(), updatedAt: outline.updatedAt ?? new Date().toISOString(),
            }));
            const existingCards = Array.isArray(project.cards) ? project.cards : [];
            return {
              id: Number(project.id) || Date.now(),
              title: project.title ?? '未命名小说',
              genre: project.genre ?? '玄幻',
              subgenre: project.subgenre ?? project.genre ?? '东方玄幻',
              tags: project.tags ?? {},
              cover: project.cover,
              protagonist1: project.protagonist1 ?? '',
              protagonist2: project.protagonist2 ?? '',
              synopsis: project.synopsis ?? '',
              status: project.status === 'completed' ? 'completed' : 'writing',
              wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
              chapters,
              outline: Array.isArray(project.outline) ? project.outline : [],
              outlines: legacyOutlines.filter((outline: any) => outline?.kind !== '金手指').map((outline: any) => ({ ...outline, kind: outline.kind === '细纲' ? '章纲' : outline.kind })),
              cards: [...existingCards, ...legacyGoldFingerCards.filter(card => !existingCards.some((existing: any) => existing.title === card.title && existing.content === card.content))],
              memories: Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [],
              memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : []),
              graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
              graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
              // Keep legacy publish metadata intact when saving older projects.
              // The automatic publishing feature itself is no longer available.
              publishConfig: project.publishConfig,
              publishRecords: project.publishRecords,
              chapterTargetWords: Number(project.chapterTargetWords) > 0 ? Number(project.chapterTargetWords) : 3000,
              aiDetection: project.aiDetection,
              styleProfileId: typeof project.styleProfileId === 'string' ? project.styleProfileId : undefined,
              sourceDismantleBookId: typeof project.sourceDismantleBookId === 'string' ? project.sourceDismantleBookId : undefined,
              createdAt: project.createdAt ?? project.updatedAt ?? new Date().toISOString(),
              updatedAt: project.updatedAt ?? new Date().toISOString(),
            };
          });
        }
      } catch {
        localStorage.removeItem('projects');
      }
    }
    // 没有本地项目时直接展示居中的新建入口。
    return [];
  });
  const [libraryBooks, setLibraryBooks] = useState<LibraryBook[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('writer-library-books') || '[]');
      return Array.isArray(saved) ? saved.map(book => normalizeLibraryBook(book)) : [];
    } catch { return []; }
  });
  const [rankingBooks, setRankingBooks] = useState<RankingBook[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('writer-ranking-books') || '[]');
      return Array.isArray(saved) ? saved.map((book, index) => normalizeRankingBook(book, index)).filter(trustedRankingCache) : [];
    } catch { return []; }
  });
  const [dismantleBooks, setDismantleBooks] = useState<DismantleBook[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('writer-dismantle-books') || '[]');
      return Array.isArray(saved) ? saved.map(book => normalizeDismantleBook(book)) : [];
    } catch { return []; }
  });
  const [writingStyles, setWritingStyles] = useState<WritingStyle[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('writer-writing-styles') || '[]');
      return Array.isArray(saved) ? saved.map(style => normalizeWritingStyle(style)) : [];
    } catch { return []; }
  });
  const [activeLibraryBookId, setActiveLibraryBookId] = useState<string | null>(null);
  const [activeLibraryChapterId, setActiveLibraryChapterId] = useState<string | null>(null);
  const [libraryChapterDownloadRunningId, setLibraryChapterDownloadRunningId] = useState<string | null>(null);
  const [libraryOutlineRunningId, setLibraryOutlineRunningId] = useState<string | null>(null);
  const [activeRankingBookId, setActiveRankingBookId] = useState<string | null>(null);
  const [rankingPlatform, setRankingPlatform] = useState<RankingPlatform>('fanqie');
  const [rankingType, setRankingType] = useState<RankingType>('read');
  const [fanqieSection, setFanqieSection] = useState<FanqieSection>('male-read');
  const [fanqieCategories, setFanqieCategories] = useState<Record<FanqieSection, RankingCategoryOption[]>>({ 'male-read': [], 'male-new': [], 'female-read': [], 'female-new': [] });
  const [fanqieCategoryId, setFanqieCategoryId] = useState('all');
  const [fanqieCategoriesLoading, setFanqieCategoriesLoading] = useState(false);
  const [rankingGender, setRankingGender] = useState<'male' | 'female' | 'all'>('all');
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingQuery, setRankingQuery] = useState('');
  const [rankingFontCss, setRankingFontCss] = useState('');

  const [bookSearchQuery, setBookSearchQuery] = useState('');
  const [bookSearchLoading, setBookSearchLoading] = useState(false);
  const [librarySearchResults, setLibrarySearchResults] = useState<LibraryBook[]>([]);
  const [bookDownloadRunningId, setBookDownloadRunningId] = useState<string | null>(null);
  const txtImportInputRef = useRef<HTMLInputElement | null>(null);
  const [activeDismantleBookId, setActiveDismantleBookId] = useState<string | null>(null);
  const [activeDismantleChapterId, setActiveDismantleChapterId] = useState<string | null>(null);
  const [selectedDismantleChapterIds, setSelectedDismantleChapterIds] = useState<string[]>([]);
  const [dismantleRunningIds, setDismantleRunningIds] = useState<string[]>([]);
  const [dismantleRewriteRunning, setDismantleRewriteRunning] = useState(false);
  const [dismantleRewriteInstruction, setDismantleRewriteInstruction] = useState('保留章节的冲突强度和推进节奏，重构为独立原创故事。');
  const [styleDistilling, setStyleDistilling] = useState(false);
  const [styleDraft, setStyleDraft] = useState<WritingStyle | null>(null);
  const [imitationSource, setImitationSource] = useState<{ bookId: string; chapterId?: string } | null>(null);
  const [skills, setSkills] = useState<Skill[]>(() => builtinSkills);
  const [skillCategoryFilter, setSkillCategoryFilter] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [deviceStorageReady, setDeviceStorageReady] = useState(false);
  const [resourceStorageReady, setResourceStorageReady] = useState(false);
  
  // 模态框状态
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [projectFormMode, setProjectFormMode] = useState<'create' | 'edit'>('create');
  const [projectEditingId, setProjectEditingId] = useState<number | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSupportAnnouncement, setShowSupportAnnouncement] = useState(false);
  const [announcementTab, setAnnouncementTab] = useState<'notice' | 'timeline'>('notice');
  const [announcementDontShow, setAnnouncementDontShow] = useState(false);
  const [showMobileMore, setShowMobileMore] = useState(false);
  const [showOutlineTypeModal, setShowOutlineTypeModal] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [activeTagTab, setActiveTagTab] = useState<TagTab>('主分类');
  const [tagDraft, setTagDraft] = useState<Record<TagTab, string[]>>(defaultProjectTags);
  const [projectPendingDeletion, setProjectPendingDeletion] = useState<Project | null>(null);
  const [chapterPendingDeletion, setChapterPendingDeletion] = useState<Chapter | null>(null);
  const [showNewSkillModal, setShowNewSkillModal] = useState(false);
  const [showBatchGenerationModal, setShowBatchGenerationModal] = useState(false);
  const [batchGenerationCount, setBatchGenerationCount] = useState('3');
  const [batchGenerationProjectId, setBatchGenerationProjectId] = useState<number | null>(null);
  const [batchGenerationRunning, setBatchGenerationRunning] = useState(false);
  const [batchGenerationProgress, setBatchGenerationProgress] = useState('');
  const [batchGenerationItems, setBatchGenerationItems] = useState<BatchGenerationItem[]>([]);
  const [skillEditingId, setSkillEditingId] = useState<number | string | null>(null);
  const [notice, setNotice] = useState<{ title: string; content: string } | null>(null);
  
  // 编辑器状态
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editorSidebarTab, setEditorSidebarTab] = useState<'chapters' | 'search' | 'outline' | 'knowledge-graph' | 'cards' | 'style' | 'knowledge' | 'ai-detect'>('chapters');
  const [aiDetecting, setAIDetecting] = useState(false);
  const [activeChapter, setActiveChapter] = useState<Chapter | null>(null);
  const [activeOutlineId, setActiveOutlineId] = useState<number | null>(null);
  const [activeCardId, setActiveCardId] = useState<number | null>(null);
  const [activeMemoryDocumentId, setActiveMemoryDocumentId] = useState<string>(memoryDocumentId('章节快照'));
  const [activeChapterMemoryId, setActiveChapterMemoryId] = useState<number | null>(null);
  const [activeGraphNodeId, setActiveGraphNodeId] = useState<string | null>(null);
  const [graphViewMode, setGraphViewMode] = useState<'document' | 'graph'>('document');
  const [graphDocumentGroup, setGraphDocumentGroup] = useState('');
  const [graphDocumentQuery, setGraphDocumentQuery] = useState('');
  const [graphDocumentType, setGraphDocumentType] = useState('全部类型');
  const [graphOnlyIsolated, setGraphOnlyIsolated] = useState(false);
  const [expandedGraphDocumentIds, setExpandedGraphDocumentIds] = useState<string[]>([]);
  const [selectedCardIds, setSelectedCardIds] = useState<number[]>([]);
  const [selectedOutlineCardIds, setSelectedOutlineCardIds] = useState<number[]>([]);
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<number[]>([]);
  const [selectedOutlineIds, setSelectedOutlineIds] = useState<number[]>([]);
  const [selectedAgentSkillNames, setSelectedAgentSkillNames] = useState<string[]>([]);
  const [showAgentSkillPicker, setShowAgentSkillPicker] = useState(false);
  const [showChapterOutlinePicker, setShowChapterOutlinePicker] = useState(false);
  const [showChapterCardPicker, setShowChapterCardPicker] = useState(false);
  const [cardTypeFilter, setCardTypeFilter] = useState<CardType | '全部'>('全部');
  const [cardDraft, setCardDraft] = useState<{ type: CardType; title: string; content: string }>({ type: '角色卡', title: '', content: '' });
  const getChapterOutline = (project: Project | null, chapter: Chapter | null) => {
    if (!project || !chapter) return undefined;
    return project.outlines.find(outline => outline.kind === '章纲' && String(outline.chapterId ?? '') === String(chapter.id))
      || project.outlines.find(outline => outline.kind === '章纲' && outline.title === `章纲｜${chapter.title}`);
  };
  const [cardGenerating, setCardGenerating] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig>(() => {
    const saved = localStorage.getItem('agent-config');
    try {
      return normalizeAgentConfig(saved ? JSON.parse(saved) : {});
    } catch {
      return normalizeAgentConfig({});
    }
  });

  useEffect(() => {
    if (activeTab !== 'rankings' || rankingPlatform !== 'fanqie' || Object.values(fanqieCategories).some(items => items.length)) return;
    if (!('__TAURI_INTERNALS__' in window)) return;
    setFanqieCategoriesLoading(true);
    void invoke<{ sections?: Array<{ key: FanqieSection; categories?: RankingCategoryOption[] }> }>('call_agent_rpc', { method: 'ranking.categories', params: { ...agentNetworkParams(agentConfig) } })
      .then(result => {
        const next = { 'male-read': [], 'male-new': [], 'female-read': [], 'female-new': [] } as Record<FanqieSection, RankingCategoryOption[]>;
        (result.sections || []).forEach(section => { if (section.key in next) next[section.key as FanqieSection] = Array.isArray(section.categories) ? section.categories : []; });
        setFanqieCategories(next);
        setFanqieCategoryId('all');
      })
      .catch(error => setNotice({ title: '番茄榜单分类加载失败', content: String(error) }))
      .finally(() => setFanqieCategoriesLoading(false));
  }, [activeTab, rankingPlatform, fanqieCategories, agentConfig]);

  const [agentInstruction, setAgentInstruction] = useState('根据当前章节上下文继续创作，保持人物设定和时间线一致，并在结尾留下自然的悬念。');
  const [outlineAgentInstruction, setOutlineAgentInstruction] = useState('根据上一章正文自动识别章节编号，生成下一章章纲；控制在700字以内（包括标点符号），明确承接、冲突、转折和章末钩子。');
  const [cardAgentInstruction, setCardAgentInstruction] = useState('根据作品设定、当前章节和已有卡片，补全这张知识卡的详细信息，保持设定一致。');
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [agentStage, setAgentStage] = useState<AgentStage>('idle');
  const [agentDraft, setAgentDraft] = useState<AgentDraftResult | null>(null);
  const [agentDisplayContent, setAgentDisplayContent] = useState('');
  const [outlineChatMessages, setOutlineChatMessages] = useState<AgentChatMessage[]>([]);
  const [cardChatMessages, setCardChatMessages] = useState<AgentChatMessage[]>([]);
  const [chapterSessionId, setChapterSessionId] = useState(() => `chapter-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [outlineSessionId, setOutlineSessionId] = useState(() => `outline-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [cardSessionId, setCardSessionId] = useState(() => `card-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [chapterPreviousSessionId, setChapterPreviousSessionId] = useState('');
  const [outlinePreviousSessionId, setOutlinePreviousSessionId] = useState('');
  const [cardPreviousSessionId, setCardPreviousSessionId] = useState('');
  const newAgentSessionId = (kind: string) => `${kind}-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [outlineStreamContent, setOutlineStreamContent] = useState('');
  const [outlineAgentActivity, setOutlineAgentActivity] = useState<Array<{ id: string; step: string; message: string; status: 'active' | 'complete' | 'error'; source?: string }>>([]);
  const [cardStreamContent, setCardStreamContent] = useState('');
  const outlineRunRef = useRef('');
  const cardRunRef = useRef('');
  const agentTypewriterRef = useRef<number | null>(null);
  const agentStreamRawContentRef = useRef('');
  const [agentError, setAgentError] = useState('');
  const [agentProgress, setAgentProgress] = useState<AgentProgressItem[]>([]);
  const [agentProgressPercent, setAgentProgressPercent] = useState(0);
  const [agentProgressMessage, setAgentProgressMessage] = useState('');
  const [contextTrace, setContextTrace] = useState<ContextTraceEvent[]>([]);
  const [runtimeUsage, setRuntimeUsage] = useState<RuntimeUsageSummary>(() => {
    try { return JSON.parse(localStorage.getItem('writer-runtime-usage') || '') as RuntimeUsageSummary; } catch { return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, startedAt: new Date().toISOString() }; }
  });
  const [usageDays, setUsageDays] = useState<UsageDay[]>(() => { try { const value = JSON.parse(localStorage.getItem('writer-runtime-usage-days') || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } });
  const [settingsSection, setSettingsSection] = useState<'model' | 'writing' | 'network' | 'usage' | 'sync' | 'support' | 'tutorial'>('model');
  const [cloudRemotePath, setCloudRemotePath] = useState(() => {
    const saved = localStorage.getItem('cloud-remote-path');
    return !saved || saved === 'ApiSaverWriter/projects' ? 'ApiSaverWriter/backup' : saved;
  });
  const [cloudSyncRunning, setCloudSyncRunning] = useState(false);
  const [cloudSyncMessage, setCloudSyncMessage] = useState('');
  const [cloudBackupFiles, setCloudBackupFiles] = useState<CloudBackupFile[]>([]);
  const [selectedCloudBackup, setSelectedCloudBackup] = useState<CloudBackupFile | null>(null);
  const [showCloudBackupPicker, setShowCloudBackupPicker] = useState(false);
  const [baiduAuthURL, setBaiduAuthURL] = useState('');
  const [baiduAuthCode, setBaiduAuthCode] = useState('');
  const [usageDateFilter, setUsageDateFilter] = useState('all');
  const [usageStartDate, setUsageStartDate] = useState('');
  const [usageEndDate, setUsageEndDate] = useState('');
  const [gatewayUsage, setGatewayUsage] = useState<GatewayUsageSnapshot | null>(null);
  const [gatewayUsageLoading, setGatewayUsageLoading] = useState(false);
  const [gatewayUsageError, setGatewayUsageError] = useState('');
  const activeAgentRunRef = useRef('');
  const runtimeUsageSessionRef = useRef<RuntimeUsageSummary | null>(null);
  const syncRuntimeUsage = async () => {
    try {
      const latest = await invoke<RuntimeUsageSummary>('call_agent_rpc', { method: 'usage.summary', params: {} });
      const prior = runtimeUsageSessionRef.current;
      runtimeUsageSessionRef.current = latest;
      if (!prior) return;
      const delta = {
        inputTokens: Math.max(0, latest.inputTokens - prior.inputTokens), outputTokens: Math.max(0, latest.outputTokens - prior.outputTokens),
        totalTokens: Math.max(0, latest.totalTokens - prior.totalTokens), cachedInputTokens: Math.max(0, latest.cachedInputTokens - prior.cachedInputTokens),
        cacheWriteTokens: Math.max(0, latest.cacheWriteTokens - prior.cacheWriteTokens), reasoningTokens: Math.max(0, latest.reasoningTokens - prior.reasoningTokens),
        requests: Math.max(0, latest.requests - prior.requests),
      };
      if (!delta.requests) return;
      setRuntimeUsage(current => {
        const next = { ...current, inputTokens: current.inputTokens + delta.inputTokens, outputTokens: current.outputTokens + delta.outputTokens, totalTokens: current.totalTokens + delta.totalTokens, cachedInputTokens: current.cachedInputTokens + delta.cachedInputTokens, cacheWriteTokens: current.cacheWriteTokens + delta.cacheWriteTokens, reasoningTokens: current.reasoningTokens + delta.reasoningTokens, requests: current.requests + delta.requests };
        localStorage.setItem('writer-runtime-usage', JSON.stringify(next));
        const now = new Date();
        const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        setUsageDays(days => {
          const existing = days.find(day => day.date === date);
          const updated = existing ? days.map(day => day.date === date ? { ...day, inputTokens: day.inputTokens + delta.inputTokens, outputTokens: day.outputTokens + delta.outputTokens, totalTokens: day.totalTokens + delta.totalTokens, cachedInputTokens: day.cachedInputTokens + delta.cachedInputTokens, cacheWriteTokens: day.cacheWriteTokens + delta.cacheWriteTokens, reasoningTokens: day.reasoningTokens + delta.reasoningTokens, requests: day.requests + delta.requests } : day) : [...days, { ...delta, date, startedAt: new Date().toISOString() }];
          localStorage.setItem('writer-runtime-usage-days', JSON.stringify(updated));
          return updated;
        });
        return next;
      });
    } catch { /* Runtime may not have started yet. */ }
  };
  useEffect(() => { void invoke<string>('start_agent_runtime').then(() => syncRuntimeUsage()); }, []);
  useEffect(() => {
    const key = 'apisaverwriter-support-announcement-seen';
    if (localStorage.getItem(key) !== '1') {
      const timer = window.setTimeout(() => { setAnnouncementDontShow(false); setShowSupportAnnouncement(true); }, 650);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { void syncRuntimeUsage(); }, 5000);
    return () => window.clearInterval(timer);
  }, []);
  const refreshGatewayUsage = async () => {
    const key = settingsDraft.apiKey.trim() || agentConfig.apiKey.trim();
    if (!key) {
      setGatewayUsageError('请先在 AI 模型配置中填写并保存 API Key。');
      return;
    }
    setGatewayUsageLoading(true);
    setGatewayUsageError('');
    try {
      await invoke<string>('start_agent_runtime');
      const result = await invoke<GatewayUsageSnapshot>('call_agent_rpc', {
        method: 'gateway.usage',
        params: {
          apiKey: key,
          apiKeys: settingsDraft.apiKeys,
          ...agentNetworkParams(settingsDraft),
        },
      });
      setGatewayUsage(result);
    } catch (error) {
      setGatewayUsageError(String(error));
    } finally {
      setGatewayUsageLoading(false);
    }
  };
  useEffect(() => {
    if (showSettingsModal && settingsSection === 'usage' && !gatewayUsageLoading) void refreshGatewayUsage();
  }, [showSettingsModal, settingsSection]);
  const [chapterSaving, setChapterSaving] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [searchScope, setSearchScope] = useState<'chapter' | 'book'>('chapter');
  const [searchQuery, setSearchQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [bookSearchMatchIndex, setBookSearchMatchIndex] = useState(0);
  const [showBannedWords, setShowBannedWords] = useState(false);
  const [bannedWords, setBannedWords] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('writer-banned-words') || '[]');
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
    } catch { return []; }
  });
  const [bannedWordsDraft, setBannedWordsDraft] = useState('');
  const [writingMarksEnabled, setWritingMarksEnabled] = useState(true);
  const [chapterTargetWordsDraft, setChapterTargetWordsDraft] = useState('3000');
  const [aiToolMode, setAIToolMode] = useState<'polish' | 'de-ai' | 'continue' | null>(null);
  const [aiToolInstruction, setAIToolInstruction] = useState('');
  const [aiToolRunning, setAIToolRunning] = useState(false);
  const [aiToolResult, setAIToolResult] = useState<AIToolResult | null>(null);
  const [selectionSnapshot, setSelectionSnapshot] = useState<{ start: number; end: number; source: string } | null>(null);
  const chapterEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const highlightLayerRef = useRef<HTMLDivElement | null>(null);
  const goalNoticeChapterRef = useRef<number | null>(null);
  const [settingsDraft, setSettingsDraft] = useState(agentConfig);
  const [availableModels, setAvailableModels] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('agent-models');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed.filter((model): model is string => typeof model === 'string') : fallbackModels;
    } catch {
      return fallbackModels;
    }
  });
  const [settingsModels, setSettingsModels] = useState<string[]>(availableModels);
  const [fetchedModels, setFetchedModels] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('agent-fetched-models');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed.filter((model): model is string => typeof model === 'string') : [];
    } catch {
      return [];
    }
  });
  const [customModelName, setCustomModelName] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsTesting, setModelsTesting] = useState(false);
  const [modelListMessage, setModelListMessage] = useState('');
  const [settingsServiceExpanded, setSettingsServiceExpanded] = useState(true);
  
  // 表单数据
  const [newProject, setNewProject] = useState({
    title: '',
    channel: '男频' as Channel,
    selectedTags: defaultProjectTags(),
    cover: '',
    protagonist1: '',
    protagonist2: '',
    synopsis: '',
  });
  const [projectGenerationSource, setProjectGenerationSource] = useState<'outline' | 'chapters'>('outline');
  const [projectGeneratingField, setProjectGeneratingField] = useState<'title' | 'synopsis' | null>(null);
  const [newSkill, setNewSkill] = useState({
    name: '',
    category: 'write',
    description: '',
    content: '',
    tags: '',
  });
  const [skillGenerating, setSkillGenerating] = useState(false);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentProgressEvent>('agent-progress', event => {
      const payload = event.payload;
      if (!payload) return;
      const data = payload.data ?? {};
      if (payload.runId === outlineRunRef.current) {
        if (payload.type === 'chunk' && data.text) { setOutlineStreamContent(current => current + String(data.text)); return; }
        if (payload.type === 'progress' || payload.type === 'context' || payload.type === 'complete' || payload.type === 'error') {
          const step = String(data.step || (payload.type === 'complete' ? 'complete' : payload.type === 'error' ? 'error' : 'progress'));
          const message = String(data.message || data.context?.action || data.error || '正在处理大纲任务');
          const source = data.context?.source;
          setOutlineAgentActivity(current => {
            const id = `${step}:${message}`;
            const status = payload.type === 'error' ? 'error' : payload.type === 'complete' ? 'complete' : 'active';
            const previous = current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item);
            const existing = previous.findIndex(item => item.id === id);
            if (existing >= 0) return previous.map((item, index) => index === existing ? { ...item, status, source: source || item.source } : item).slice(-12);
            return [...previous, { id, step, message, status, source }].slice(-12);
          });
          return;
        }
      }
      if (payload.type === 'chunk' && payload.runId === outlineRunRef.current && data.text) { setOutlineStreamContent(current => current + String(data.text)); return; }
      if (payload.type === 'chunk' && payload.runId === cardRunRef.current && data.text) { setCardStreamContent(current => current + String(data.text)); return; }
      if (payload.runId !== activeAgentRunRef.current) return;
      if (payload.type === 'context' && data.context) {
        const trace = {
          id: `${String(data.step || 'context')}:${String(data.context.source || data.context.action)}`,
          step: String(data.step || 'context'),
          action: data.context?.action || data.message || '更新上下文',
          source: data.context?.source,
          status: data.context?.status,
          bytes: data.context?.bytes,
          items: data.context?.items,
          timestamp: Date.now(),
        };
        setContextTrace(current => {
          const existing = current.findIndex(item => item.id === trace.id);
          if (existing < 0) return [...current, trace].slice(-40);
          return current.map((item, index) => index === existing ? { ...item, ...trace } : item);
        });
        return;
      }
      if (payload.type === 'chunk' && data.text) {
        agentStreamRawContentRef.current += String(data.text);
        setAgentDisplayContent(chapterDraftFromStream(agentStreamRawContentRef.current));
        const characters = countNovelCharacters(data.text);
        setAgentProgressMessage(characters ? `正文已返回 ${characters.toLocaleString()} 字，正在整理草稿` : '正在接收模型输出');
        setAgentProgress(items => items.map(item => item.id === 'draft'
          ? { ...item, status: 'active', progress: Math.max(item.progress, 70), message: '正在接收并整理章节草稿' }
          : item));
        setAgentProgressPercent(current => Math.max(current, 70));
        return;
      }
      if (payload.type === 'complete') {
        setAgentProgressMessage(data.message || '章节草稿和一致性审查已完成');
        setAgentProgressPercent(100);
        setAgentProgress(items => items.map(item => ({ ...item, status: 'complete', progress: Math.max(item.progress, 100) })));
        return;
      }
      if (payload.type === 'error') {
        const message = data.error || '智能体运行失败';
        setAgentProgressMessage(message);
        setAgentProgress(items => {
          const activeIndex = Math.max(0, items.findIndex(item => item.status === 'active'));
          return items.map((item, index) => index === activeIndex ? { ...item, status: 'error', message } : item);
        });
        return;
      }
      if (!isAgentWorkflowStep(data.step)) return;
      const stepIndex = agentWorkflowSteps.findIndex(step => step.id === data.step);
      const progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
      setAgentStage(data.step);
      setAgentProgressMessage(data.message || agentStageLabel[data.step]);
      setAgentProgressPercent(current => Math.max(current, progress));
      setAgentProgress(items => {
        const source = items.length ? items : createAgentProgressItems();
        return source.map((item, index) => {
          if (index < stepIndex) return { ...item, status: 'complete', progress: Math.max(item.progress, 100) };
          if (item.id === data.step) return { ...item, status: 'active', progress: Math.max(item.progress, progress), message: data.message || item.description };
          return item;
        });
      });
    }).then(handler => {
      if (disposed) handler();
      else unlisten = handler;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isMobileRuntime()) return;
    const receive = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      if (message) setCloudSyncMessage(message);
    };
    window.addEventListener('cloud-sync-progress', receive);
    return () => window.removeEventListener('cloud-sync-progress', receive);
  }, []);

  // The mobile HTTP Agent sends the same stream envelope as the desktop runtime.
  useEffect(() => {
    if (!isMobileRuntime()) return;
    const receive = (event: Event) => {
      const payload = (event as CustomEvent<AgentProgressEvent>).detail;
      if (!payload) return;
      const data = payload.data ?? {};
      if (payload.runId === outlineRunRef.current) {
        if (payload.type === 'chunk' && data.text) { setOutlineStreamContent(current => current + String(data.text)); return; }
        if (payload.type === 'progress' || payload.type === 'context' || payload.type === 'complete' || payload.type === 'error') {
          const step = String(data.step || (payload.type === 'complete' ? 'complete' : payload.type === 'error' ? 'error' : 'progress'));
          const message = String(data.message || data.context?.action || data.error || '正在处理大纲任务');
          const source = data.context?.source;
          setOutlineAgentActivity(current => {
            const id = `${step}:${message}`;
            const status = payload.type === 'error' ? 'error' : payload.type === 'complete' ? 'complete' : 'active';
            const previous = current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item);
            const existing = previous.findIndex(item => item.id === id);
            return (existing >= 0 ? previous.map((item, index) => index === existing ? { ...item, status, source: source || item.source } : item) : [...previous, { id, step, message, status, source }]).slice(-12);
          });
          return;
        }
      }
      if (payload.type === 'chunk' && payload.runId === outlineRunRef.current && data.text) { setOutlineStreamContent(current => current + String(data.text)); return; }
      if (payload.type === 'chunk' && payload.runId === cardRunRef.current && data.text) { setCardStreamContent(current => current + String(data.text)); return; }
      if (payload.runId !== activeAgentRunRef.current) return;
      if (payload.type === 'context' && data.context) {
        const trace = {
          id: `${String(data.step || 'context')}:${String(data.context.source || data.context.action)}`,
          step: String(data.step || 'context'),
          action: data.context.action || data.message || '更新上下文',
          source: data.context.source,
          status: data.context.status,
          bytes: data.context.bytes,
          items: data.context.items,
          timestamp: Date.now(),
        };
        setContextTrace(current => {
          const existing = current.findIndex(item => item.id === trace.id);
          if (existing < 0) return [...current, trace].slice(-40);
          return current.map((item, index) => index === existing ? { ...item, ...trace } : item);
        });
        return;
      }
      if (payload.type === 'chunk' && data.text) {
        agentStreamRawContentRef.current += String(data.text);
        setAgentDisplayContent(chapterDraftFromStream(agentStreamRawContentRef.current));
        setAgentProgressPercent(current => Math.max(current, 70));
        setAgentProgressMessage(`正文已返回 ${countNovelCharacters(String(data.text)).toLocaleString()} 字，正在整理草稿`);
        return;
      }
      if (payload.type === 'complete') { setAgentProgressMessage(data.message || '章节草稿和一致性审查已完成'); setAgentProgressPercent(100); return; }
      if (payload.type === 'error') { setAgentStage('error'); setAgentProgressMessage(data.error || '智能体运行失败'); return; }
      if (!isAgentWorkflowStep(data.step)) return;
      setAgentStage(data.step);
      setAgentProgressMessage(data.message || agentStageLabel[data.step]);
      setAgentProgressPercent(current => Math.max(current, Math.max(0, Math.min(100, Number(data.progress) || 0))));
    };
    window.addEventListener('agent-progress', receive);
    return () => window.removeEventListener('agent-progress', receive);
  }, []);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ message?: string }>('cloud-sync-progress', event => {
      if (!disposed && event.payload?.message) setCloudSyncMessage(event.payload.message);
    }).then(handler => {
      if (disposed) handler();
      else unlisten = handler;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 拆书和文风是跨作品复用的本地资源，独立于单本小说目录保存。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setResourceStorageReady(true);
      return;
    }
    Promise.all([
      invoke<LibraryBook[] | null>('load_library_books'),
      invoke<RankingBook[] | null>('load_ranking_books'),
      invoke<DismantleBook[] | null>('load_dismantle_books'),
      invoke<WritingStyle[] | null>('load_writing_styles'),
    ]).then(([library, rankings, books, styles]) => {
      if (Array.isArray(library)) setLibraryBooks(library.map(book => normalizeLibraryBook(book)));
      if (Array.isArray(rankings)) setRankingBooks(rankings.map((book, index) => normalizeRankingBook(book, index)).filter(trustedRankingCache));
      if (Array.isArray(books)) setDismantleBooks(books.map(book => normalizeDismantleBook(book)));
      if (Array.isArray(styles)) setWritingStyles(styles.map(style => normalizeWritingStyle(style)));
    }).catch(error => {
      setNotice({ title: '读取本地书籍资源失败', content: String(error) });
    }).finally(() => setResourceStorageReady(true));
  }, []);

  // 应用启动时预热常驻 Agent Runtime，后续智能体请求复用同一进程。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void invoke<string>('start_agent_runtime')
      .catch(error => {
        console.warn('Agent Runtime 或小说书源初始化失败，将在首次请求时重试。', error);
      });
  }, []);

  // App 启动时优先读取设备应用数据目录中的 projects.json。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setDeviceStorageReady(true);
      return;
    }

    invoke<Project[] | null>('load_projects')
      .then(savedProjects => {
        if (Array.isArray(savedProjects)) {
          setProjects(savedProjects.map(project => {
            const chapters = Array.isArray(project.chapters) ? project.chapters.map(chapter => ({
              ...chapter,
              wordCount: countNovelCharacters(chapter.content ?? ''),
              createdAt: chapter.createdAt ?? new Date().toISOString(),
              updatedAt: chapter.updatedAt ?? new Date().toISOString(),
            })) : [];
            return {
              ...project,
              status: project.status === 'completed' ? 'completed' : 'writing',
              chapters,
              outline: Array.isArray(project.outline) ? project.outline : [],
              outlines: Array.isArray(project.outlines) ? project.outlines : [],
              cards: Array.isArray(project.cards) ? project.cards : [],
              memories: Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [],
              graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
              graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
              chapterTargetWords: Number(project.chapterTargetWords) > 0 ? Number(project.chapterTargetWords) : 3000,
              aiDetection: project.aiDetection,
              styleProfileId: typeof project.styleProfileId === 'string' ? project.styleProfileId : undefined,
              sourceDismantleBookId: typeof project.sourceDismantleBookId === 'string' ? project.sourceDismantleBookId : undefined,
              memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : []),
              wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
              createdAt: project.createdAt ?? project.updatedAt ?? new Date().toISOString(),
              updatedAt: project.updatedAt ?? new Date().toISOString(),
            };
          }));
        }
      })
      .catch(error => {
        setNotice({ title: '读取本地小说失败', content: String(error) });
      })
      .finally(() => setDeviceStorageReady(true));
  }, []);

  // 编辑时做短暂防抖，随后原子写入设备本地文件；网页调试环境保留 localStorage 回退。
  useEffect(() => {
    if (!deviceStorageReady) return;
    const timer = window.setTimeout(() => {
      setAutoSaveStatus('saving');
      if ('__TAURI_INTERNALS__' in window) {
        invoke<string>('save_projects', { projects })
          .then(() => { localStorage.removeItem('projects'); setAutoSaveStatus('saved'); })
          .catch(error => { setAutoSaveStatus('error'); setNotice({ title: '保存本地小说失败', content: String(error) }); });
      } else {
        localStorage.setItem('projects', JSON.stringify(projects));
        setAutoSaveStatus('saved');
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [projects, deviceStorageReady]);

  useEffect(() => {
    if (!resourceStorageReady) return;
    const timer = window.setTimeout(() => {
      if ('__TAURI_INTERNALS__' in window) {
        Promise.all([
          invoke<string>('save_library_books', { books: libraryBooks }),
          invoke<string>('save_ranking_books', { books: rankingBooks }),
          invoke<string>('save_dismantle_books', { books: dismantleBooks }),
        ]).then(() => {
          localStorage.removeItem('writer-library-books');
          localStorage.removeItem('writer-ranking-books');
          localStorage.removeItem('writer-dismantle-books');
        }).catch(error => setNotice({ title: '保存本地书籍资源失败', content: String(error) }));
      } else {
        localStorage.setItem('writer-library-books', JSON.stringify(libraryBooks));
        localStorage.setItem('writer-ranking-books', JSON.stringify(rankingBooks));
        localStorage.setItem('writer-dismantle-books', JSON.stringify(dismantleBooks));
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [libraryBooks, rankingBooks, dismantleBooks, resourceStorageReady]);

  useEffect(() => {
    if (!resourceStorageReady) return;
    const timer = window.setTimeout(() => {
      if ('__TAURI_INTERNALS__' in window) {
        void invoke<string>('save_writing_styles', { styles: writingStyles })
          .then(() => localStorage.removeItem('writer-writing-styles'))
          .catch(error => setNotice({ title: '保存文风失败', content: String(error) }));
      } else {
        localStorage.setItem('writer-writing-styles', JSON.stringify(writingStyles));
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [writingStyles, resourceStorageReady]);

  // 番茄以私有区字符保护部分网页内容。榜单与已下载书籍均保存相应字体，正常中文仍走系统字体。
  useEffect(() => {
    const id = 'fanqie-private-font';
    const existing = document.getElementById(id) as HTMLStyleElement | null;
    const defaultFont = '@font-face{font-family:ApiSaverWriterFanqie;font-display:swap;src:url(https://lf6-awef.bytetos.com/obj/awesome-font/c/dc027189e0ba4cd.woff2) format("woff2");unicode-range:U+E000-F8FF;}';
    const fontCss = [defaultFont, rankingFontCss, ...libraryBooks.map(book => book.fontCss || '')].filter(Boolean).join('\n');
    if (!fontCss.trim()) {
      existing?.remove();
      return;
    }
    const style = existing || document.createElement('style');
    style.id = id;
    style.textContent = fontCss;
    if (!existing) document.head.appendChild(style);
  }, [rankingFontCss, libraryBooks]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!editingProject) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void persistCurrentChapter();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (editorSidebarTab === 'search') {
          setSearchScope('book');
          setShowSearchPanel(false);
        } else {
          setShowSearchPanel(true);
          setSearchScope('chapter');
        }
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingProject, activeChapter, chapterSaving, editorSidebarTab]);

  useEffect(() => {
    void loadSkills();
  }, [activeTab, editingProject?.id]);

  useEffect(() => {
    localStorage.setItem('agent-config', JSON.stringify(agentConfig));
  }, [agentConfig]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const loadSkills = async () => {
    setLoading(true);
    try {
      const saved = localStorage.getItem('writer-skills');
      const stored = saved ? JSON.parse(saved) : [];
      const records = Array.isArray(stored) ? stored.filter((skill): skill is Skill => Boolean(skill && typeof skill.name === 'string')) : [];
      const builtinOverrides = records.filter(skill => skill.builtin).map(skill => ({
        ...skill,
        builtin: true,
        content: typeof skill.content === 'string' ? skill.content : '',
        tags: Array.isArray(skill.tags) ? skill.tags : [],
        rating: Number(skill.rating) || 0,
        usageCount: Number(skill.usageCount) || 0,
      }));
      const customSkills = records.filter(skill => !skill.builtin).map(skill => ({
        ...skill,
        content: typeof skill.content === 'string' ? skill.content : '',
        tags: Array.isArray(skill.tags) ? skill.tags : [],
        rating: Number(skill.rating) || 0,
        usageCount: Number(skill.usageCount) || 0,
      }));
      const mergedBuiltins = builtinSkills.map(skill => {
        const override = builtinOverrides.find(item => String(item.id) === String(skill.id));
        // Built-in routing IDs remain stable, while the canonical Chinese
        // display name always comes from the bundled definition. This also
        // repairs older localStorage records that stored English labels.
        if (!override) return skill;
        const isLegacyWorldSetting = skill.name === 'world-setting-planner'
          && /标记已确认与待揭示内容/u.test(String(override.content || ''));
        const isLegacyChapterOutline = skill.name === '小说章纲生成器'
          && (!/#\s*番茄小说章纲生成器 Skill/u.test(String(override.content || ''))
            || /(?:800\s*[-~到至]\s*1000|章纲总字数控制)/u.test(String(override.content || '')));
        return isLegacyWorldSetting || isLegacyChapterOutline
          ? { ...skill, builtin: true }
          : { ...skill, ...override, displayName: skill.displayName, builtin: true };
      });
      setSkills([...mergedBuiltins, ...customSkills]);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProject = () => {
    if (!newProject.title.trim()) {
      alert('请输入小说标题');
      return;
    }
    
    const now = new Date().toISOString();
    const existingProject = projectEditingId === null ? undefined : projects.find(project => project.id === projectEditingId);
    if (existingProject) {
      const updatedProject: Project = {
        ...existingProject,
        title: newProject.title.trim(),
        genre: newProject.channel,
        subgenre: newProject.selectedTags.主分类[0] ?? existingProject.subgenre,
        tags: cloneProjectTags(newProject.selectedTags),
        cover: newProject.cover || undefined,
        protagonist1: newProject.protagonist1.trim(),
        protagonist2: newProject.protagonist2.trim(),
        synopsis: newProject.synopsis.trim(),
        updatedAt: now,
      };
      setProjects(current => current.map(project => project.id === updatedProject.id ? updatedProject : project));
      if (editingProject?.id === updatedProject.id) setEditingProject(updatedProject);
      resetProjectForm();
      setShowNewProjectModal(false);
      setNotice({ title: '小说信息已更新', content: `《${updatedProject.title}》的基础信息已保存。` });
      return;
    }

    const sourceChapter = imitationSource?.chapterId
      ? dismantleBooks.find(book => book.id === imitationSource.bookId)?.chapters.find(chapter => chapter.id === imitationSource.chapterId)
      : undefined;
    const sourceOutline = sourceChapter?.detailedOutline.trim()
      ? [{ id: Date.now() + 1, kind: '章纲' as OutlineKind, title: `参考章纲｜${sourceChapter.title}`, content: sourceChapter.detailedOutline, createdAt: now, updatedAt: now }]
      : [];
    const project: Project = {
      id: Date.now(),
      title: newProject.title.trim(),
      genre: newProject.channel,
      subgenre: newProject.selectedTags.主分类[0],
      tags: cloneProjectTags(newProject.selectedTags),
      cover: newProject.cover || undefined,
      protagonist1: newProject.protagonist1.trim(),
      protagonist2: newProject.protagonist2.trim(),
      synopsis: newProject.synopsis.trim(),
      status: 'writing',
      wordCount: 0,
      chapters: [],
      outline: [],
      outlines: sourceOutline,
      cards: [],
      memories: [],
      memoryDocuments: [],
      graphNodes: [],
      graphEdges: [],
      chapterTargetWords: 3000,
      sourceDismantleBookId: imitationSource?.bookId,
      createdAt: now,
      updatedAt: now,
    };
    
    setProjects(current => [...current, project]);
    if (imitationSource) {
      setDismantleBooks(current => current.map(book => book.id === imitationSource.bookId
        ? { ...book, boundProjectId: project.id, updatedAt: now }
        : book));
      setNotice({ title: '仿写项目已创建', content: sourceChapter?.detailedOutline ? '已绑定拆书资料并将当前细纲带入小说大纲。' : '已绑定拆书资料，可在拆书管理中把细纲生成到本书章节。' });
    }
    setImitationSource(null);
    resetProjectForm();
    setShowNewProjectModal(false);
  };

  const resetProjectForm = () => {
    setNewProject({
      title: '',
      channel: '男频' as Channel,
      selectedTags: defaultProjectTags(),
      cover: '',
      protagonist1: '',
      protagonist2: '',
      synopsis: '',
    });
    setProjectGenerationSource('outline');
    setProjectGeneratingField(null);
    setProjectFormMode('create');
    setProjectEditingId(null);
  };

  const openNewProjectModal = () => {
    setImitationSource(null);
    resetProjectForm();
    setShowNewProjectModal(true);
  };

  const openProjectEdit = (project: Project) => {
    const channel: Channel = project.genre === '女频' ? '女频' : '男频';
    const selectedTags: Record<TagTab, string[]> = {
      主分类: [...(project.tags?.主分类?.length ? project.tags.主分类 : [project.subgenre ?? (channel === '男频' ? '东方玄幻' : '女频悬疑')])],
      主题: [...(project.tags?.主题 ?? [])],
      角色: [...(project.tags?.角色 ?? [])],
      情节: [...(project.tags?.情节 ?? [])],
    };
    setProjectFormMode('edit');
    setProjectEditingId(project.id);
    setNewProject({
      title: project.title,
      channel,
      selectedTags,
      cover: project.cover ?? '',
      protagonist1: project.protagonist1 ?? '',
      protagonist2: project.protagonist2 ?? '',
      synopsis: project.synopsis ?? '',
    });
    setTagDraft(selectedTags);
    setActiveTagTab('主分类');
    setProjectGenerationSource(project.outlines.some(outline => outline.content.trim()) ? 'outline' : 'chapters');
    setProjectGeneratingField(null);
    setShowNewProjectModal(true);
  };

  const generateProjectField = async (field: 'title' | 'synopsis') => {
    if (projectGeneratingField) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写 API Saver Key，再生成书名或作品简介。' });
      return;
    }
    const sourceProject = projectEditingId === null ? undefined : projects.find(project => project.id === projectEditingId);
    const outlines = projectGenerationSource === 'outline'
      ? (sourceProject?.outlines ?? []).filter(outline => outline.content.trim()).map(outline => ({ kind: outline.kind, title: outline.title, content: outline.content.slice(0, 5000) }))
      : [];
    const chapters = projectGenerationSource === 'chapters'
      ? (sourceProject?.chapters ?? []).filter(chapter => chapter.content.trim()).slice(0, 3).map(chapter => ({ title: chapter.title, content: chapter.content.slice(0, 4500) }))
      : [];
    setProjectGeneratingField(field);
    try {
      await invoke<string>('start_agent_runtime');
      const result = await invoke<{ title?: string; synopsis?: string }>('call_agent_rpc', {
        method: 'project.generate',
        params: {
          field,
          source: projectGenerationSource,
          title: newProject.title.trim(),
          synopsis: newProject.synopsis.trim(),
          channel: newProject.channel,
          tags: newProject.selectedTags,
          protagonist1: newProject.protagonist1.trim(),
          protagonist2: newProject.protagonist2.trim(),
          outlines,
          chapters,
          apiKey: agentConfig.apiKey.trim(),
          apiKeys: agentConfig.apiKeys,
          baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
          model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        },
      });
      if (field === 'title') {
        const title = Array.from((result.title || '').replace(/[《》“”"'`]/gu, '').trim()).slice(0, 15).join('');
        if (!title) throw new Error('智能体没有返回可用书名');
        setNewProject(current => ({ ...current, title }));
      } else {
        const synopsis = Array.from((result.synopsis || '').trim()).slice(0, 500).join('');
        if (!synopsis) throw new Error('智能体没有返回作品简介');
        setNewProject(current => ({ ...current, synopsis }));
      }
      const sourceLabel = projectGenerationSource === 'outline' ? '作品大纲' : '前 3 章内容';
      setNotice({ title: field === 'title' ? 'AI 书名已生成' : 'AI 作品简介已生成', content: `已根据${sourceLabel}回填草稿，可继续修改后保存。` });
    } catch (error) {
      setNotice({ title: field === 'title' ? '书名生成失败' : '作品简介生成失败', content: String(error) });
    } finally {
      setProjectGeneratingField(null);
    }
  };

  const openProjectTagPicker = () => {
    setTagDraft(cloneProjectTags(newProject.selectedTags));
    setActiveTagTab('主分类');
    setShowTagPicker(true);
  };

  const handleChannelChange = (channel: Channel) => {
    setNewProject(current => ({
      ...current,
      channel,
      selectedTags: defaultProjectTags(channel),
    }));
  };

  const handleCoverChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNotice({ title: '封面格式不支持', content: '请选择 JPG、PNG 或 WebP 图片。' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setNotice({ title: '封面文件过大', content: '请选择小于 10MB 的图片。' });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxWidth = 480;
        const maxHeight = 640;
        const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        setNewProject(current => ({ ...current, cover: canvas.toDataURL('image/jpeg', 0.82) }));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const updateDismantleBook = (bookId: string, updater: (book: DismantleBook) => DismantleBook) => {
    setDismantleBooks(current => current.map(book => book.id === bookId ? updater(book) : book));
  };

  const createDismantleFromLibrary = (book: LibraryBook) => {
    const chapters = book.chapters.filter(chapter => chapter.content.trim()).map((chapter, index) => normalizeDismantleChapter({
      id: localResourceId('dismantle-chapter'), number: chapter.number || index + 1, title: chapter.title,
      sourceContent: chapter.content, status: 'pending', updatedAt: new Date().toISOString(),
    }, index));
    if (!chapters.length) {
      setNotice({ title: '还没有可拆正文', content: '请先在书籍管理下载至少一章正文。' });
      return;
    }
    const existing = dismantleBooks.find(item => item.sourceLibraryBookId === book.id);
    if (existing) {
      setActiveDismantleBookId(existing.id);
      setActiveDismantleChapterId(existing.chapters[0]?.id || null);
      setActiveTab('dismantles');
      setNotice({ title: '已打开拆书资料', content: `《${book.title}》已经在拆书管理中。` });
      return;
    }
    const now = new Date().toISOString();
    const dismantle: DismantleBook = {
      id: localResourceId('dismantle'), title: book.title, sourceFileName: `${book.title}.txt`,
      sourceLibraryBookId: book.id, chapters, createdAt: now, updatedAt: now,
    };
    setDismantleBooks(current => [...current, dismantle]);
    setActiveDismantleBookId(dismantle.id);
    setActiveDismantleChapterId(chapters[0]?.id || null);
    setSelectedDismantleChapterIds(chapters.slice(0, 1).map(chapter => chapter.id));
    setActiveTab('dismantles');
    setNotice({ title: '已加入拆书管理', content: `《${book.title}》共 ${chapters.length} 章可分析。` });
  };

  const runBookSearch = async () => {
    if (!bookSearchQuery.trim()) return;
    setBookSearchLoading(true);
    try {
      const result = await invoke<{ books?: Partial<LibraryBook>[]; fontCss?: string; searchedSourceCount?: number; responsiveSourceCount?: number }>('call_agent_rpc', {
        method: 'book.search.all',
        params: { query: bookSearchQuery.trim(), ...agentNetworkParams(agentConfig) },
      });
      setLibrarySearchResults((result.books || []).map(book => normalizeLibraryBook({ ...book, fontCss: result.fontCss || book.fontCss })));
      setNotice({ title: '书籍搜索完成', content: `已搜索 ${result.searchedSourceCount || 0} 个书源，其中 ${result.responsiveSourceCount || 0} 个响应，找到 ${(result.books || []).length} 本书。选择结果卡片即可从对应书源下载。` });
    } catch (error) {
      setNotice({ title: '书籍搜索失败', content: String(error) });
    } finally {
      setBookSearchLoading(false);
    }
  };

  const fetchRankingBooks = async () => {
    setRankingLoading(true);
    try {
      const fanqieSectionConfig = fanqieSectionOptions.find(option => option.value === fanqieSection) || fanqieSectionOptions[0];
      const effectiveRankingGender = rankingPlatform === 'fanqie' ? fanqieSectionConfig.gender : 'all';
      const effectiveRankingType = rankingPlatform === 'fanqie' ? fanqieSectionConfig.list : rankingType;
      const selectedCategory = rankingPlatform === 'fanqie' ? fanqieCategories[fanqieSection].find(category => category.id === fanqieCategoryId) : undefined;
      const result = await invoke<{ books?: Partial<RankingBook>[]; fontCss?: string; sourceName?: string }>('call_agent_rpc', {
        method: 'ranking.fetch',
        params: { platform: rankingPlatform, rankType: effectiveRankingType, gender: effectiveRankingGender, rankUrl: selectedCategory?.url || undefined, ...agentNetworkParams(agentConfig) },
      });
      const sourceName = result.sourceName || { fanqie: '番茄小说网', qidian: '起点中文网官网', faloo: '飞卢小说网官网' }[rankingPlatform];
      const fetched = (result.books || []).map((book, index) => normalizeRankingBook({ ...book, platform: rankingPlatform, rankType: effectiveRankingType, gender: effectiveRankingGender, sourceName }, index));
      setRankingBooks(fetched);
      setRankingFontCss(result.fontCss || '');
      setActiveRankingBookId(fetched[0]?.id || null);
      const platformName = { fanqie: '番茄小说网', qidian: '起点', faloo: '飞卢中文网' }[rankingPlatform];
      const sectionLabel = rankingPlatform === 'fanqie' ? fanqieSectionConfig.label : rankingTypeLabel(rankingPlatform, rankingType);
      setNotice({ title: '榜单已更新', content: `${sourceName}返回${platformName}${sectionLabel}${selectedCategory ? `·${selectedCategory.label}` : ''} ${fetched.length} 本书。` });
    } catch (error) {
      setNotice({ title: '扫榜失败', content: String(error) });
    } finally {
      setRankingLoading(false);
    }
  };

  const downloadLibraryBook = async (book: LibraryBook | RankingBook): Promise<LibraryBook | null> => {
    const id = String(book.id);
    setBookDownloadRunningId(id);
    try {
      let downloadable: LibraryBook | RankingBook = book;
      if ('platform' in book && book.platform !== 'fanqie') {
        const search = await invoke<{ books?: Partial<LibraryBook>[] }>('call_agent_rpc', {
          method: 'book.search',
          params: { query: book.title, source: 'qianyue-kuwo', ...agentNetworkParams(agentConfig) },
        });
        const candidates = (search.books || []).map(candidate => normalizeLibraryBook(candidate));
        const matched = candidates.find(candidate => candidate.title.trim() === book.title.trim()) || candidates[0];
        if (!matched) throw new Error(`小说书源中没有找到《${book.title}》，可在书籍管理中切换书源搜索。`);
        downloadable = matched;
      }
      const result = await invoke<{ chapters?: Partial<LibraryBookChapter>[]; intro?: string; cover?: string; downloadedChapterCount?: number; completedChapterCount?: number }>('call_agent_rpc', {
        method: 'book.download',
        params: {
          title: downloadable.title, author: downloadable.author, source: downloadable.sourceId || 'fanqie', sourceBookId: downloadable.sourceBookId || downloadable.id, url: downloadable.url,
          // 不设置人为上限，按书源完整目录下载全部章节。
          ...agentNetworkParams(agentConfig),
        },
      });
      const downloadedChapterCount = Number(result.completedChapterCount) || (result.chapters || []).filter(chapter => chapter.downloaded === true && typeof chapter.content === 'string' && chapter.content.trim()).length;
      if (!downloadedChapterCount) throw new Error('没有获取到完整正文，未保存空章节。可稍后重试，或导入本地 TXT。');
      const now = new Date().toISOString();
      const normalized = normalizeLibraryBook({ ...downloadable, id: libraryBooks.find(item => item.sourceBookId === (downloadable.sourceBookId || downloadable.id))?.id || localResourceId('book'), chapters: result.chapters || [], intro: result.intro || downloadable.intro, cover: result.cover || downloadable.cover, downloadedAt: now, createdAt: now, updatedAt: now });
      setLibraryBooks(current => {
        const existing = current.findIndex(item => item.sourceBookId === (downloadable.sourceBookId || downloadable.id) || item.id === normalized.id);
        if (existing >= 0) return current.map((item, index) => index === existing ? { ...item, ...normalized, id: item.id } : item);
        return [...current, normalized];
      });
      setActiveLibraryBookId(normalized.id);
      setActiveLibraryChapterId(normalized.chapters[0]?.id || null);
      setActiveTab('books');
      setNotice({ title: '小说下载完成', content: `《${normalized.title}》已保存 ${downloadedChapterCount}/${normalized.chapters.length} 章完整正文到书籍管理。` });
      return normalized;
    } catch (error) {
      setNotice({ title: '小说下载失败', content: String(error) });
      return null;
    } finally {
      setBookDownloadRunningId(null);
    }
  };

  const requestLibraryChapterDownload = async (book: LibraryBook, chapter: LibraryBookChapter): Promise<LibraryBookChapter> => {
    const sourceId = book.sourceId || (/番茄/u.test(book.source) ? 'fanqie' : '');
    if (!sourceId) throw new Error('这本书没有保存书源信息，请重新搜索并下载该书。');
    const result = await invoke<{ chapter?: Partial<LibraryBookChapter> }>('call_agent_rpc', {
      method: 'book.chapter.download',
      params: {
        source: sourceId,
        sourceBookId: book.sourceBookId || '',
        bookUrl: book.url,
        bookTitle: book.title,
        chapter,
        ...agentNetworkParams(agentConfig),
      },
    });
    if (!result.chapter) throw new Error('书源没有返回本章结果。');
    return normalizeLibraryBookChapter({ ...result.chapter, id: chapter.id, number: chapter.number, title: chapter.title, url: chapter.url }, chapter.number - 1);
  };

  const retryLibraryChapter = async (book: LibraryBook, chapter: LibraryBookChapter) => {
    setLibraryChapterDownloadRunningId(chapter.id);
    try {
      const refreshed = await requestLibraryChapterDownload(book, chapter);
      if (refreshed.downloaded) {
        setLibraryBooks(current => current.map(item => item.id === book.id ? {
          ...item,
          chapters: item.chapters.map(existing => existing.id === chapter.id ? refreshed : existing),
          updatedAt: new Date().toISOString(),
        } : item));
      }
      setActiveLibraryChapterId(chapter.id);
      setNotice(refreshed.downloaded
        ? { title: '本章下载完成', content: `《${book.title}》${refreshed.title}已保存 ${refreshed.wordCount.toLocaleString()} 字。` }
        : { title: '本章仍未完整下载', content: refreshed.unavailableReason || '书源仅返回片段，可稍后再次重试。' });
    } catch (error) {
      setNotice({ title: '本章下载失败', content: String(error) });
    } finally {
      setLibraryChapterDownloadRunningId(null);
    }
  };

  const retryUnfinishedLibraryChapters = async (book: LibraryBook) => {
    const pending = book.chapters.filter(chapter => !chapter.downloaded);
    if (!pending.length) {
      setNotice({ title: '没有未下载章节', content: '这本书的章节都已经下载完成。' });
      return;
    }
    const runningId = `book:${book.id}`;
    setLibraryChapterDownloadRunningId(runningId);
    const updates = new Map<string, LibraryBookChapter>();
    let completed = 0;
    try {
      for (const chapter of pending) {
        try {
          const refreshed = await requestLibraryChapterDownload(book, chapter);
          if (refreshed.downloaded) {
            updates.set(chapter.id, refreshed);
            completed += 1;
          }
        } catch {
          // Keep the existing preview and continue with the remaining chapters.
        }
      }
      if (updates.size) {
        setLibraryBooks(current => current.map(item => item.id === book.id ? {
          ...item,
          chapters: item.chapters.map(chapter => updates.get(chapter.id) || chapter),
          updatedAt: new Date().toISOString(),
        } : item));
      }
      setNotice({ title: '未下载章节处理完成', content: `《${book.title}》本次完成 ${completed}/${pending.length} 章；已下载章节保持不变。` });
    } finally {
      setLibraryChapterDownloadRunningId(null);
    }
  };

  const importLibraryTxt = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await readLocalTxtFile(file);
      const sourceChapters = splitTxtIntoDismantleChapters(text);
      if (!sourceChapters.length) throw new Error('TXT 文件没有可导入的正文。');
      const now = new Date().toISOString();
      const sourceBookId = `local-txt:${file.name}:${file.size}:${file.lastModified}`;
      const existing = libraryBooks.find(book => book.sourceBookId === sourceBookId);
      const title = file.name.replace(/\.txt$/iu, '').trim() || '未命名本地书籍';
      const normalized = normalizeLibraryBook({
        id: existing?.id || localResourceId('book'), title, author: '本地导入', source: '本地 TXT', sourceId: 'local-txt', sourceBookId, url: '', intro: '',
        chapters: sourceChapters.map((chapter, index) => ({ id: `local-txt:${sourceBookId}:${index + 1}`, number: index + 1, title: chapter.title, url: '', content: chapter.sourceContent, wordCount: countNovelCharacters(chapter.sourceContent), downloaded: true })),
        downloadedAt: now, createdAt: existing?.createdAt || now, updatedAt: now,
      });
      setLibraryBooks(current => {
        const index = current.findIndex(book => book.sourceBookId === sourceBookId || book.id === normalized.id);
        return index >= 0 ? current.map((book, currentIndex) => currentIndex === index ? { ...normalized, id: book.id } : book) : [...current, normalized];
      });
      setActiveLibraryBookId(normalized.id);
      setActiveLibraryChapterId(normalized.chapters[0]?.id || null);
      setNotice({ title: 'TXT 导入完成', content: `《${normalized.title}》已导入 ${normalized.chapters.length} 章，共 ${normalized.chapters.reduce((total, chapter) => total + chapter.wordCount, 0).toLocaleString()} 字。` });
    } catch (error) {
      setNotice({ title: 'TXT 导入失败', content: String(error) });
    }
  };

  const deleteLibraryBook = async (book: LibraryBook) => {
    setLibraryBooks(current => current.filter(item => item.id !== book.id));
    setLibrarySearchResults(current => current.filter(item => item.id !== book.id));
    setActiveLibraryBookId(current => current === book.id ? null : current);
    setActiveLibraryChapterId(null);
    try {
      if ('__TAURI_INTERNALS__' in window) await invoke<string>('delete_library_book', { bookId: book.id, bookTitle: book.title });
      setNotice({ title: '书籍已删除', content: `《${book.title}》的本地书籍文件已清理。` });
    } catch (error) {
      setLibraryBooks(current => current.some(item => item.id === book.id) ? current : [...current, book]);
      setNotice({ title: '删除书籍失败', content: String(error) });
    }
  };

  const deleteDismantleBook = async (book: DismantleBook) => {
    setDismantleBooks(current => current.filter(item => item.id !== book.id));
    setActiveDismantleBookId(current => current === book.id ? null : current);
    setActiveDismantleChapterId(null);
    setSelectedDismantleChapterIds([]);
    try {
      if ('__TAURI_INTERNALS__' in window) await invoke<string>('delete_dismantle_book', { bookId: book.id, bookTitle: book.title });
      setNotice({ title: '拆书资料已删除', content: `《${book.title}》的原文、章纲和改写稿已清理。` });
    } catch (error) {
      setDismantleBooks(current => current.some(item => item.id === book.id) ? current : [...current, book]);
      setNotice({ title: '删除拆书资料失败', content: String(error) });
    }
  };

  const generateLibraryChapterOutline = async (book: LibraryBook, chapter: LibraryBookChapter) => {
    if (!chapter.content.trim()) {
      setNotice({ title: '章节暂无正文', content: '该章节尚未下载正文，无法生成章纲。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥，再生成章节章纲。' });
      return;
    }
    setLibraryOutlineRunningId(chapter.id);
    try {
      const result = await invoke<{ summary?: string; detailedOutline?: string; plotBeats?: string[]; characterDynamics?: string[]; setupPayoff?: string[]; pacing?: string }>('call_agent_rpc', {
        method: 'book.dismantle',
        params: {
          bookTitle: book.title, chapterTitle: chapter.title, chapterNumber: chapter.number, sourceContent: chapter.content,
          apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys, baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
          model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        },
      });
      const outline = [
        result.summary?.trim() ? `## 剧情摘要\n${result.summary.trim()}` : '',
        result.detailedOutline?.trim() ? `## 章节细纲\n${result.detailedOutline.trim()}` : '',
        result.plotBeats?.length ? `## 情节节点\n${asTextList(result.plotBeats, 10).map(item => `- ${item}`).join('\n')}` : '',
        result.characterDynamics?.length ? `## 人物关系\n${asTextList(result.characterDynamics, 10).map(item => `- ${item}`).join('\n')}` : '',
        result.setupPayoff?.length ? `## 伏笔与回收\n${asTextList(result.setupPayoff, 10).map(item => `- ${item}`).join('\n')}` : '',
        result.pacing?.trim() ? `## 节奏判断\n${result.pacing.trim()}` : '',
      ].filter(Boolean).join('\n\n');
      if (!outline) throw new Error('智能体没有返回可用章纲');
      setLibraryBooks(current => current.map(item => item.id === book.id ? {
        ...item,
        chapters: item.chapters.map(value => value.id === chapter.id ? { ...value, outline } : value),
        updatedAt: new Date().toISOString(),
      } : item));
      setNotice({ title: '章节章纲已生成', content: `《${book.title}》${chapter.title} 的章纲已保存到本地。` });
    } catch (error) {
      setNotice({ title: '生成章节章纲失败', content: String(error) });
    } finally {
      setLibraryOutlineRunningId(null);
    }
  };

  const runDismantleAnalysis = async () => {
    const book = dismantleBooks.find(item => item.id === activeDismantleBookId);
    if (!book) return;
    const targets = book.chapters.filter(chapter => selectedDismantleChapterIds.includes(chapter.id) && chapter.sourceContent.trim());
    if (!targets.length) {
      setNotice({ title: '请选择章节', content: '勾选至少一章正文后再生成章纲。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥，再运行拆书分析。' });
      return;
    }
    setDismantleRunningIds(targets.map(chapter => chapter.id));
    let completed = 0;
    try {
      for (const chapter of targets) {
        updateDismantleBook(book.id, current => ({ ...current, chapters: current.chapters.map(item => item.id === chapter.id ? { ...item, status: 'analyzing' } : item), updatedAt: new Date().toISOString() }));
        const result = await invoke<{ summary?: string; detailedOutline?: string; plotBeats?: string[]; characterDynamics?: string[]; setupPayoff?: string[]; pacing?: string }>('call_agent_rpc', {
          method: 'book.dismantle',
          params: {
            bookTitle: book.title, chapterTitle: chapter.title, chapterNumber: chapter.number, sourceContent: chapter.sourceContent,
            apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys, baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
            model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
            contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
          },
        });
        updateDismantleBook(book.id, current => ({ ...current, chapters: current.chapters.map(item => item.id === chapter.id ? {
          ...item, summary: result.summary?.trim() || item.summary, detailedOutline: result.detailedOutline?.trim() || item.detailedOutline,
          plotBeats: asTextList(result.plotBeats, 10), characterDynamics: asTextList(result.characterDynamics, 10), setupPayoff: asTextList(result.setupPayoff, 10),
          pacing: result.pacing?.trim() || item.pacing, status: result.detailedOutline?.trim() ? 'analyzed' : item.status, updatedAt: new Date().toISOString(),
        } : item), updatedAt: new Date().toISOString() }));
        completed += 1;
      }
      setNotice({ title: '拆书章纲已生成', content: `已完成 ${completed} 章，章纲和分析结果会自动保存。` });
    } catch (error) {
      setNotice({ title: '拆书分析失败', content: String(error) });
    } finally {
      setDismantleRunningIds([]);
    }
  };

  const runDismantleRewrite = async () => {
    const book = dismantleBooks.find(item => item.id === activeDismantleBookId);
    const chapter = book?.chapters.find(item => item.id === activeDismantleChapterId);
    if (!book || !chapter?.detailedOutline.trim()) {
      setNotice({ title: '请先生成章纲', content: '确认当前章节的细纲后，再生成原创改写稿。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥，再生成原创改写稿。' });
      return;
    }
    setDismantleRewriteRunning(true);
    try {
      const result = await invoke<{ content?: string }>('call_agent_rpc', {
        method: 'book.rewrite',
        params: {
          bookTitle: book.title, chapterTitle: chapter.title, detailedOutline: chapter.detailedOutline,
          instruction: dismantleRewriteInstruction, targetWords: 2200,
          apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys, baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
          model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        },
      });
      if (!result.content?.trim()) throw new Error('智能体没有返回原创改写稿');
      updateDismantleBook(book.id, current => ({ ...current, chapters: current.chapters.map(item => item.id === chapter.id ? { ...item, rewriteContent: result.content?.trim() || '', status: 'rewritten', updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }));
      setNotice({ title: '原创改写稿已生成', content: '请在右侧编辑并确认，确认后可生成到绑定小说。' });
    } catch (error) {
      setNotice({ title: '原创改写失败', content: String(error) });
    } finally {
      setDismantleRewriteRunning(false);
    }
  };

  const distillDismantleStyle = async () => {
    const book = dismantleBooks.find(item => item.id === activeDismantleBookId);
    if (!book) return;
    const chapters = book.chapters.filter(chapter => selectedDismantleChapterIds.includes(chapter.id) && chapter.sourceContent.trim()).slice(0, 8);
    if (!chapters.length) {
      setNotice({ title: '请选择样本章节', content: '至少选择一章有正文的章节用于文风蒸馏。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥，再蒸馏文风。' });
      return;
    }
    setStyleDistilling(true);
    try {
      const result = await invoke<{ name?: string; description?: string; tags?: string[]; content?: string }>('call_agent_rpc', {
        method: 'book.style.distill',
        params: {
          bookTitle: book.title, styleName: `${book.title}文风`, samples: chapters.map(chapter => ({ title: chapter.title, content: chapter.sourceContent })),
          apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys, baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
          model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        },
      });
      if (!result.content?.trim()) throw new Error('智能体没有返回文风 Skill');
      const now = new Date().toISOString();
      const style = normalizeWritingStyle({ id: localResourceId('style'), name: result.name || `${book.title}文风`, description: result.description || '', tags: result.tags || [], content: result.content, sourceBookId: book.id, createdAt: now, updatedAt: now });
      setWritingStyles(current => [...current, style]);
      setStyleDraft(style);
      setNotice({ title: '文风蒸馏完成', content: `${style.name} 已保存到全局文风管理，可在任意小说中绑定。` });
    } catch (error) {
      setNotice({ title: '文风蒸馏失败', content: String(error) });
    } finally {
      setStyleDistilling(false);
    }
  };

  const startDismantleImitation = (book: DismantleBook, chapter?: DismantleChapter) => {
    setImitationSource({ bookId: book.id, chapterId: chapter?.id });
    setProjectFormMode('create');
    setProjectEditingId(null);
    setNewProject({ title: '', channel: '男频', selectedTags: defaultProjectTags('男频'), cover: '', protagonist1: '', protagonist2: '', synopsis: '' });
    setShowNewProjectModal(true);
    setActiveTab('projects');
    setNotice({ title: '已带入仿写创建', content: '请补充目标小说的书名、简介和分类后创建。只会带入抽象细纲，不会复制原文。' });
  };

  const bindDismantleToProject = (bookId: string, projectId?: number) => {
    updateDismantleBook(bookId, book => ({ ...book, boundProjectId: projectId, updatedAt: new Date().toISOString() }));
    setProjects(current => current.map(project => project.id === projectId ? { ...project, sourceDismantleBookId: bookId, updatedAt: new Date().toISOString() } : project));
  };

  const generateDismantleChapter = async () => {
    const book = dismantleBooks.find(item => item.id === activeDismantleBookId);
    const chapter = book?.chapters.find(item => item.id === activeDismantleChapterId);
    const target = book?.boundProjectId ? projects.find(project => project.id === book.boundProjectId) : undefined;
    if (!book || !chapter || !target) {
      setNotice({ title: '请先绑定小说', content: '在拆书详情顶部选择目标小说后，才能把原创内容生成到章节。' });
      return;
    }
    if (!chapter.rewriteContent.trim() && !chapter.detailedOutline.trim()) {
      setNotice({ title: '请先准备章节素材', content: '先生成章纲，或完成原创改写稿后再生成章节。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥。' });
      return;
    }
    try {
      const style = target.styleProfileId ? writingStyles.find(item => item.id === target.styleProfileId) : undefined;
      const result = await invoke<{ title?: string; content?: string }>('call_agent_rpc', {
        method: 'book.adapt',
        params: {
          projectTitle: target.title, projectSynopsis: target.synopsis, projectOutlines: target.outlines.map(outline => `## ${outline.kind}\n${outline.content}`).join('\n\n'),
          chapterTitle: chapter.title, detailedOutline: chapter.detailedOutline, rewriteContent: chapter.rewriteContent, styleProfile: style?.content,
          apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys, baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
          model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        },
      });
      if (!result.content?.trim()) throw new Error('智能体没有返回章节正文');
      const now = new Date().toISOString();
      const newChapter: Chapter = { id: Date.now(), title: result.title?.trim() || `第${target.chapters.length + 1}章`, content: result.content.trim(), wordCount: countNovelCharacters(result.content), createdAt: now, updatedAt: now };
      const updated = { ...target, chapters: [...target.chapters, newChapter], wordCount: target.wordCount + newChapter.wordCount, updatedAt: now };
      setProjects(current => current.map(project => project.id === updated.id ? updated : project));
      setNotice({ title: '原创章节已生成', content: `已写入《${target.title}》的第 ${updated.chapters.length} 章，可进入小说继续编辑。` });
    } catch (error) {
      setNotice({ title: '生成目标章节失败', content: String(error) });
    }
  };

  const openNewWritingStyle = () => {
    const now = new Date().toISOString();
    setStyleDraft(normalizeWritingStyle({ id: localResourceId('style'), name: '', description: '', tags: [], content: '# 文风 Skill\n\n## 写作指令\n\n', createdAt: now, updatedAt: now }));
  };

  const saveWritingStyleDraft = () => {
    if (!styleDraft?.name.trim() || !styleDraft.content.trim()) {
      setNotice({ title: '文风信息不完整', content: '请填写文风名称和 Skill 内容。' });
      return;
    }
    const updated = { ...styleDraft, name: styleDraft.name.trim(), updatedAt: new Date().toISOString() };
    setWritingStyles(current => current.some(style => style.id === updated.id) ? current.map(style => style.id === updated.id ? updated : style) : [...current, updated]);
    setStyleDraft(updated);
    setNotice({ title: '文风已保存', content: `${updated.name} 已更新，可在小说中绑定使用。` });
  };

  const deleteWritingStyle = (styleId: string) => {
    setWritingStyles(current => current.filter(style => style.id !== styleId));
    if (styleDraft?.id === styleId) setStyleDraft(null);
    setProjects(current => current.map(project => project.styleProfileId === styleId ? { ...project, styleProfileId: undefined, updatedAt: new Date().toISOString() } : project));
  };

  const bindStyleToCurrentProject = (styleId: string) => {
    if (!editingProject) return;
    updateEditorProject(project => ({ ...project, styleProfileId: styleId || undefined, updatedAt: new Date().toISOString() }));
    setNotice({ title: '文风绑定已更新', content: styleId ? '章节智能体会在相关创作中加入该文风 Skill。' : '已取消绑定文风。' });
  };

  const handleProjectTagToggle = (tag: string) => {
    const selected = tagDraft[activeTagTab];
    const next = activeTagTab === '主分类'
      ? [tag]
      : selected.includes(tag)
        ? selected.filter(item => item !== tag)
        : selected.length < 2
          ? [...selected, tag]
          : selected;
    setTagDraft({ ...tagDraft, [activeTagTab]: next });
  };

  const confirmProjectTags = () => {
    setNewProject({ ...newProject, selectedTags: cloneProjectTags(tagDraft) });
    setShowTagPicker(false);
  };

  const handleDeleteProject = () => {
    if (!projectPendingDeletion) return;
    const deletedId = projectPendingDeletion.id;
    setProjects(prev => prev.filter(project => project.id !== deletedId));
    if (editingProject?.id === deletedId) {
      setEditingProject(null);
      setActiveChapter(null);
      setEditorSidebarTab('chapters');
    }
    setProjectPendingDeletion(null);
  };

  const handleOpenProjectLocation = async (project: Project) => {
    try {
      await invoke<string>('save_projects', { projects });
      const path = await invoke<string>('open_project_location', { projectId: project.id });
      setNotice({ title: '已打开小说目录', content: path });
    } catch (error) {
      setNotice({ title: '打开小说目录失败', content: String(error) });
    }
  };

  const handleOpenChapterLocation = async (chapter: Chapter) => {
    if (!editingProject) return;
    try {
      await invoke<string>('save_projects', { projects });
      await invoke<string>('open_chapter_location', { projectId: editingProject.id, chapterTitle: chapter.title });
    } catch (error) {
      setNotice({ title: '打开章节位置失败', content: String(error) });
    }
  };

  const handleOpenOutlineLocation = async () => {
    if (!editingProject) return;
    try {
      await invoke<string>('save_projects', { projects });
      await invoke<string>('open_outline_location', { projectId: editingProject.id, outlineTitle: activeOutline?.title ?? '大纲' });
    } catch (error) {
      setNotice({ title: '打开大纲位置失败', content: String(error) });
    }
  };

  const handleOpenCardLocation = async (card: KnowledgeCard) => {
    if (!editingProject) return;
    try {
      await invoke<string>('save_projects', { projects });
      await invoke<string>('open_card_location', { projectId: editingProject.id, cardType: card.type, cardTitle: card.title });
    } catch (error) {
      setNotice({ title: '打开卡片位置失败', content: String(error) });
    }
  };

  const handleOpenGraphNodeLocation = async (node: KnowledgeGraphNode) => {
    if (!editingProject) return;
    try {
      await invoke<string>('save_projects', { projects });
      await invoke<string>('open_graph_node_location', { projectId: editingProject.id, nodeId: node.id });
    } catch (error) {
      setNotice({ title: '打开图谱档案位置失败', content: String(error) });
    }
  };

  const updateGraphNodeProfile = (nodeId: string, content: string) => {
    updateEditorProject(project => ({
      ...project,
      graphNodes: project.graphNodes.map(node => node.id === nodeId ? { ...node, content, updatedAt: new Date().toISOString() } : node),
      updatedAt: new Date().toISOString(),
    }));
  };

  const persistSkillRecords = (nextSkills: Skill[]) => {
    const records = nextSkills.filter(skill => !skill.builtin || builtinSkills.some(item => String(item.id) === String(skill.id)))
      .map(skill => ({ ...skill, ...(skill.builtin ? { builtin: true } : { builtin: false }) }));
    localStorage.setItem('writer-skills', JSON.stringify(records));
  };

  const openNewSkill = () => {
    setSkillEditingId(null);
    setNewSkill({ name: '', category: 'write', description: '', content: '', tags: '' });
    setShowNewSkillModal(true);
  };

  const openSkillEditor = (skill: Skill) => {
    setSkillEditingId(skill.id);
    setNewSkill({
      name: skill.displayName || skill.name,
      category: skill.category,
      description: skill.description,
      content: skill.content,
      tags: skill.tags.join(', '),
    });
    setShowNewSkillModal(true);
  };

  const handleCreateSkill = () => {
    if (!newSkill.name.trim() || !newSkill.content.trim()) {
      setNotice({ title: '技能信息不完整', content: '请填写技能名称和详细内容。' });
      return;
    }
    const editingSkill = skillEditingId === null ? null : skills.find(item => String(item.id) === String(skillEditingId));
    const skill: Skill = {
      id: editingSkill?.id ?? Date.now(),
      name: editingSkill?.builtin ? editingSkill.name : newSkill.name.trim(),
      displayName: editingSkill?.builtin ? newSkill.name.trim() : undefined,
      category: newSkill.category,
      description: newSkill.description.trim(),
      tags: newSkill.tags.split(',').map(t => t.trim()).filter(Boolean),
      rating: editingSkill?.rating ?? 0,
      usageCount: editingSkill?.usageCount ?? 0,
      content: newSkill.content.trim(),
      builtin: editingSkill?.builtin ?? false,
    };
    const nextSkills = editingSkill
      ? skills.map(item => String(item.id) === String(skillEditingId) ? skill : item)
      : [...skills, skill];
    persistSkillRecords(nextSkills);
    setSkills(nextSkills);
    setNewSkill({
      name: '',
      category: 'write',
      description: '',
      content: '',
      tags: '',
    });
    setSkillEditingId(null);
    setShowNewSkillModal(false);
    setNotice({ title: editingSkill ? '技能已更新' : '技能已创建', content: `${skill.displayName || skill.name} 已保存到本机技能库。` });
  };

  const generateSkillWithAI = async () => {
    if (skillGenerating) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中配置可用模型，再生成技能。' });
      return;
    }
    if (!newSkill.name.trim() && !newSkill.description.trim() && !newSkill.content.trim()) {
      setNotice({ title: '需要技能需求', content: '请先填写技能名称、用途或草稿内容。' });
      return;
    }
    setSkillGenerating(true);
    try {
      await invoke<string>('start_agent_runtime');
      const result = await invoke<{ name?: string; category?: string; description?: string; content?: string; tags?: string[] }>('call_agent_rpc', {
        method: 'skill.write',
        params: {
          name: newSkill.name.trim(),
          category: newSkill.category,
          description: newSkill.description.trim(),
          content: newSkill.content.trim(),
          tags: newSkill.tags.split(',').map(tag => tag.trim()).filter(Boolean),
          apiKey: agentConfig.apiKey.trim(),
          apiKeys: agentConfig.apiKeys,
          baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
          model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        },
      });
      setNewSkill(current => ({
        ...current,
        name: result.name?.trim() || current.name,
        category: result.category?.trim() || current.category,
        description: result.description?.trim() || current.description,
        content: result.content?.trim() || current.content,
        tags: Array.isArray(result.tags) && result.tags.length ? result.tags.join(', ') : current.tags,
      }));
      setNotice({ title: '技能草稿已生成', content: '请检查技能步骤和输出契约后保存。' });
    } catch (error) {
      setNotice({ title: '技能生成失败', content: String(error) });
    } finally {
      setSkillGenerating(false);
    }
  };

  const deleteSkill = (skill: Skill) => {
    if (skill.builtin) {
      const nextSkills = skills.filter(item => String(item.id) !== String(skill.id));
      const restored = builtinSkills.find(item => String(item.id) === String(skill.id));
      if (!restored) return;
      const next = [...nextSkills, restored].sort((left, right) => (left.builtin ? 0 : 1) - (right.builtin ? 0 : 1));
      persistSkillRecords(next.filter(item => !(item.builtin && String(item.id) === String(skill.id))));
      setSkills(next);
      setNotice({ title: '内置技能已恢复', content: `${restored.name} 已恢复为默认内容。` });
      return;
    }
    const nextSkills = skills.filter(item => String(item.id) !== String(skill.id));
    persistSkillRecords(nextSkills);
    setSkills(nextSkills);
    setNotice({ title: '技能已删除', content: `${skill.displayName || skill.name} 已从本机技能库移除。` });
  };

  const handleEditProject = (projectId: number) => {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      setChapterTargetWordsDraft(String(Number(project.chapterTargetWords) || 3000));
      setSearchQuery('');
      setReplaceQuery('');
      setSearchMatchIndex(0);
      setSelectionSnapshot(null);
      setAIToolResult(null);
      setAIToolMode(null);
      const chapters = Array.isArray(project.chapters) ? project.chapters : [];
      // 如果项目没有章节，自动创建第一章
      if (chapters.length === 0) {
        const firstChapter: Chapter = {
          id: Date.now(),
          title: '第 1 章',
          content: '',
          wordCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const updatedProject = {
          ...project,
          chapters: [firstChapter],
          outline: Array.isArray(project.outline) ? project.outline : [],
          outlines: Array.isArray(project.outlines) ? project.outlines : [],
          cards: Array.isArray(project.cards) ? project.cards : [],
          memories: Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [],
          memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : []),
          graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
          graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
        };
        setProjects(prev => prev.map(p => p.id === projectId ? updatedProject : p));
        setEditingProject(updatedProject);
        setActiveChapter(firstChapter);
        setActiveOutlineId(updatedProject.outlines[0]?.id ?? null);
        setSelectedCardIds([]);
        setActiveChapterMemoryId(updatedProject.memories[0]?.id ?? null);
        setSelectedMemoryIds(recentMemoryIds(updatedProject.memories));
      } else {
        const normalizedProject = {
          ...project,
          chapters,
          outline: Array.isArray(project.outline) ? project.outline : [],
          outlines: Array.isArray(project.outlines) ? project.outlines : [],
          cards: Array.isArray(project.cards) ? project.cards : [],
          memories: Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [],
          memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : []),
          graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
          graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
        };
        setEditingProject(normalizedProject);
        setActiveChapter(chapters[0]);
        setActiveOutlineId(normalizedProject.outlines[0]?.id ?? null);
        setSelectedCardIds([]);
        setActiveChapterMemoryId(normalizedProject.memories[0]?.id ?? null);
        setSelectedMemoryIds(recentMemoryIds(normalizedProject.memories));
      }
    }
  };

  const handleCloseEditor = () => {
    setEditingProject(null);
    setActiveChapter(null);
    setEditorSidebarTab('chapters');
    setActiveOutlineId(null);
    setActiveCardId(null);
    setSelectedCardIds([]);
    setActiveChapterMemoryId(null);
    setSelectedMemoryIds([]);
  };

  const handleAddChapter = () => {
    if (!editingProject) return;
    const newChapter: Chapter = {
      id: Date.now(),
      title: `第 ${editingProject.chapters.length + 1} 章`,
      content: '',
      wordCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = { ...editingProject, chapters: [...editingProject.chapters, newChapter] };
    setEditingProject(updated);
    setProjects(projects.map(p => p.id === updated.id ? updated : p));
    setActiveChapter(newChapter);
    setSelectedMemoryIds(recentMemoryIds(updated.memories, 1));
  };

  const handleDeleteChapter = async () => {
    if (!editingProject || !chapterPendingDeletion) return;
    const deletedId = chapterPendingDeletion.id;
    const deletedIndex = editingProject.chapters.findIndex(chapter => chapter.id === deletedId);
    if (deletedIndex < 0) {
      setChapterPendingDeletion(null);
      return;
    }
    const deletedChapterNumber = chapterNumberFromText(chapterPendingDeletion.title) || deletedIndex + 1;
    const chapters = editingProject.chapters.filter(chapter => chapter.id !== deletedId);
    // Some older projects have stale chapterId links after chapters were moved.
    // Use the title's chapter number as a second guard so deleting chapter N
    // can never remove a neighboring chapter's memory or outline.
    // Legacy projects can contain stale/duplicated chapterId links. Resolve one
    // record per document type, preferring an explicit chapter number. Never
    // delete every record sharing an old ID: unrelated chapters must survive.
    const memoryCandidates = editingProject.memories
      .map((memory, index) => ({ memory, index, number: memory.sourceChapterNumber || chapterNumberFromText(memory.chapterTitle) }))
      .filter(({ memory, number }) => (String(memory.chapterId) === String(deletedId)
        && (number === deletedChapterNumber || number === undefined)) || number === deletedChapterNumber);
    const numberedMemory = memoryCandidates.find(candidate => candidate.number === deletedChapterNumber && String(candidate.memory.chapterId) === String(deletedId))
      || memoryCandidates.find(candidate => candidate.number === deletedChapterNumber);
    const memoryToRemove = numberedMemory || (memoryCandidates.length === 1 && memoryCandidates[0].number === undefined ? memoryCandidates[0] : undefined);
    const memories = editingProject.memories.filter((_memory, index) => index !== memoryToRemove?.index);

    const outlineCandidates = editingProject.outlines
      .map((outline, index) => ({ outline, index, number: chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`) }))
      .filter(({ outline, number }) => outline.kind === '章纲' && ((String(outline.chapterId) === String(deletedId)
        && (number === deletedChapterNumber || number === undefined)) || number === deletedChapterNumber));
    const numberedOutline = outlineCandidates.find(candidate => candidate.number === deletedChapterNumber && String(candidate.outline.chapterId) === String(deletedId))
      || outlineCandidates.find(candidate => candidate.number === deletedChapterNumber);
    const outlineToRemove = numberedOutline || (outlineCandidates.length === 1 && outlineCandidates[0].number === undefined ? outlineCandidates[0] : undefined);
    const removedOutlineIds = new Set<number>(outlineToRemove ? [outlineToRemove.outline.id] : []);
    const outlines = editingProject.outlines.filter(outline => !removedOutlineIds.has(outline.id));
    const chapterNodeId = `chapter:${deletedId}`;
    const graphNodes = editingProject.graphNodes.filter(node => node.id !== chapterNodeId);
    const graphEdges = editingProject.graphEdges.filter(edge => edge.source !== chapterNodeId && edge.target !== chapterNodeId && !removedOutlineIds.has(Number(String(edge.source).replace('outline:', ''))) && !removedOutlineIds.has(Number(String(edge.target).replace('outline:', ''))));
    const aiDetection = editingProject.aiDetection
      ? (() => {
        const chapters = editingProject.aiDetection.chapters.filter(item => item.chapterId !== deletedId);
        const averageAIRate = chapters.length ? Math.round(chapters.reduce((sum, item) => sum + item.aiRate, 0) / chapters.length * 10) / 10 : 0;
        return { ...editingProject.aiDetection, chapters, averageAIRate, level: chapters.length ? editingProject.aiDetection.level : '暂无检测', suggestion: chapters.length ? editingProject.aiDetection.suggestion : '暂无章节检测记录。', updatedAt: new Date().toISOString() };
      })()
      : undefined;
    const updatedProject: Project = {
      ...editingProject,
      chapters,
      outlines,
      memories,
      memoryDocuments: buildMemoryDocuments(memories, editingProject.memoryDocuments, true),
      graphNodes,
      graphEdges,
      aiDetection,
      wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      updatedAt: new Date().toISOString(),
    };
    const nextChapter = chapters[Math.min(deletedIndex, Math.max(0, chapters.length - 1))] ?? null;
    const nextOutline = outlines.find(outline => outline.id === activeOutlineId) || outlines[0];
    const snapshot = projects.map(project => project.id === updatedProject.id ? updatedProject : project);
    setProjects(snapshot);
    setEditingProject(updatedProject);
    setActiveChapter(nextChapter);
    setActiveOutlineId(nextOutline?.id ?? null);
    setSelectedOutlineIds(current => current.filter(id => !removedOutlineIds.has(id)));
    setActiveChapterMemoryId(nextChapter ? memories.find(memory => memory.chapterId === nextChapter.id)?.id ?? null : null);
    setSelectedMemoryIds(recentMemoryIds(memories, 1));
    setChapterPendingDeletion(null);
    try {
      if ('__TAURI_INTERNALS__' in window) await invoke<string>('save_projects', { projects: snapshot });
      else localStorage.setItem('projects', JSON.stringify(snapshot));
      setNotice({ title: '章节已删除', content: `已删除《${chapterPendingDeletion.title}》，相关章纲、记忆和图谱关系也已清理。` });
    } catch (error) {
      setNotice({ title: '章节已删除但保存失败', content: String(error) });
    }
  };

  const handleUpdateChapterContent = (content: string) => {
    if (!activeChapter || !editingProject) return;
    const wordCount = countNovelCharacters(content);
    const updatedChapter = { ...activeChapter, content, wordCount, updatedAt: new Date().toISOString() };
    const updatedChapters = editingProject.chapters.map(c => c.id === activeChapter.id ? updatedChapter : c);
    const totalWords = updatedChapters.reduce((sum, c) => sum + c.wordCount, 0);
    const updated = { ...editingProject, chapters: updatedChapters, wordCount: totalWords, updatedAt: new Date().toISOString() };
    setEditingProject(updated);
    setActiveChapter(updatedChapter);
    setProjects(current => current.map(p => p.id === updated.id ? updated : p));
    setAutoSaveStatus('saving');
    const target = Number(editingProject.chapterTargetWords) || 3000;
    if (wordCount >= target && goalNoticeChapterRef.current !== activeChapter.id) {
      goalNoticeChapterRef.current = activeChapter.id;
      setNotice({ title: '已达到本章目标字数', content: `本章已写 ${wordCount} 字，建议保存并创建下一章。` });
    }
  };

  const formatActiveChapter = () => {
    if (!activeChapter) return;
    const formatted = formatNovelChapterContent(activeChapter.content);
    if (formatted === activeChapter.content) {
      setNotice({ title: '正文格式已规范', content: '没有发现需要清理的空格、换行或首尾空白。' });
      return;
    }
    handleUpdateChapterContent(formatted);
    setNotice({ title: '正文格式化完成', content: '已统一换行、清理行首尾空格并合并多余空行，内容会自动保存。' });
    window.requestAnimationFrame(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(formatted.length, formatted.length);
    });
  };

  const captureChapterSelection = () => {
    const element = chapterEditorRef.current;
    if (!element || !activeChapter) return;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    if (end > start) setSelectionSnapshot({ start, end, source: activeChapter.content.slice(start, end) });
  };

  const focusSearchMatch = (direction: 1 | -1 = 1) => {
    if (!activeChapter || !searchQuery) return;
    const matches: number[] = [];
    let cursor = 0;
    while (cursor < activeChapter.content.length) {
      const index = activeChapter.content.indexOf(searchQuery, cursor);
      if (index < 0) break;
      matches.push(index);
      cursor = index + Math.max(1, searchQuery.length);
    }
    if (!matches.length) {
      setSearchMatchIndex(0);
      setNotice({ title: '没有找到匹配内容', content: `本章没有“${searchQuery}”。` });
      return;
    }
    const element = chapterEditorRef.current;
    const selectedIndex = element
      ? matches.findIndex(start => element.selectionStart === start && element.selectionEnd === start + searchQuery.length)
      : -1;
    const baseIndex = selectedIndex >= 0 ? selectedIndex : (direction === 1 ? -1 : 0);
    const nextIndex = (baseIndex + direction + matches.length) % matches.length;
    setSearchMatchIndex(nextIndex);
    window.requestAnimationFrame(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      const start = matches[nextIndex];
      editor.focus();
      editor.setSelectionRange(start, start + searchQuery.length);
    });
  };

  const replaceCurrentMatch = () => {
    if (!activeChapter || !searchQuery) return;
    const matches: number[] = [];
    let cursor = 0;
    while (cursor < activeChapter.content.length) {
      const index = activeChapter.content.indexOf(searchQuery, cursor);
      if (index < 0) break;
      matches.push(index);
      cursor = index + Math.max(1, searchQuery.length);
    }
    if (!matches.length) {
      setNotice({ title: '没有可替换内容', content: `本章没有“${searchQuery}”。` });
      return;
    }
    const targetStart = matches[Math.min(searchMatchIndex, matches.length - 1)];
    handleUpdateChapterContent(`${activeChapter.content.slice(0, targetStart)}${replaceQuery}${activeChapter.content.slice(targetStart + searchQuery.length)}`);
    setNotice({ title: '已替换一处', content: `已将“${searchQuery}”替换为“${replaceQuery}”。` });
  };

  const replaceAllMatches = () => {
    if (!activeChapter || !searchQuery) return;
    const count = countOccurrences(activeChapter.content, searchQuery);
    if (!count) {
      setNotice({ title: '没有可替换内容', content: `本章没有“${searchQuery}”。` });
      return;
    }
    handleUpdateChapterContent(activeChapter.content.split(searchQuery).join(replaceQuery));
    setSearchMatchIndex(0);
    setNotice({ title: '替换完成', content: `本章已替换 ${count} 处。` });
  };

  const toggleSearchPanel = () => {
    setShowSearchPanel(current => !current);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const openProjectSearch = () => {
    setEditorSidebarTab('search');
    setSearchScope('book');
    setShowSearchPanel(false);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const moveDocumentSearchMatch = (content: string, label: string, direction: 1 | -1) => {
    if (!searchQuery) return;
    const count = countOccurrences(content, searchQuery);
    if (!count) {
      setSearchMatchIndex(0);
      setNotice({ title: '没有找到匹配内容', content: `${label}中没有“${searchQuery}”。` });
      return;
    }
    setSearchMatchIndex(current => (current + direction + count) % count);
  };

  const replaceDocumentCurrentMatch = (content: string, label: string, update: (next: string) => void) => {
    if (!searchQuery) return;
    const matches: number[] = [];
    let cursor = 0;
    while (cursor < content.length) {
      const index = content.indexOf(searchQuery, cursor);
      if (index < 0) break;
      matches.push(index);
      cursor = index + Math.max(1, searchQuery.length);
    }
    if (!matches.length) {
      setNotice({ title: '没有可替换内容', content: `${label}中没有“${searchQuery}”。` });
      return;
    }
    const targetStart = matches[Math.min(searchMatchIndex, matches.length - 1)];
    update(`${content.slice(0, targetStart)}${replaceQuery}${content.slice(targetStart + searchQuery.length)}`);
    setSearchMatchIndex(Math.min(searchMatchIndex, Math.max(0, matches.length - 2)));
    setNotice({ title: '已替换一处', content: `${label}已将“${searchQuery}”替换为“${replaceQuery}”。` });
  };

  const replaceDocumentAllMatches = (content: string, label: string, update: (next: string) => void) => {
    if (!searchQuery) return;
    const count = countOccurrences(content, searchQuery);
    if (!count) {
      setNotice({ title: '没有可替换内容', content: `${label}中没有“${searchQuery}”。` });
      return;
    }
    update(content.split(searchQuery).join(replaceQuery));
    setSearchMatchIndex(0);
    setNotice({ title: '替换完成', content: `${label}已替换 ${count} 处。` });
  };

  const renderDocumentSearchPanel = (label: string, content: string, update: (next: string) => void) => {
    if (!showSearchPanel) return null;
    const matchCount = searchQuery ? countOccurrences(content, searchQuery) : 0;
    return <section className="search-panel document-search-panel" aria-label={`${label}搜索与替换`}>
      <div className="search-panel-row">
        <input ref={searchInputRef} className="input" value={searchQuery} placeholder={`搜索${label}内容`} onChange={event => { setSearchQuery(event.target.value); setSearchMatchIndex(0); setBookSearchMatchIndex(0); }} />
        <button className="editor-tool-button" onClick={() => moveDocumentSearchMatch(content, label, -1)} disabled={!searchQuery}>上一个</button>
        <button className="editor-tool-button" onClick={() => moveDocumentSearchMatch(content, label, 1)} disabled={!searchQuery}>下一个</button>
        <button className="icon-delete" title="关闭搜索" onClick={() => setShowSearchPanel(false)}>×</button>
      </div>
      <div className="search-panel-row replace-row">
        <input className="input" value={replaceQuery} placeholder="替换为" onChange={event => setReplaceQuery(event.target.value)} />
        <button className="editor-tool-button" onClick={() => replaceDocumentCurrentMatch(content, label, update)} disabled={!searchQuery}>替换</button>
        <button className="editor-tool-button" onClick={() => replaceDocumentAllMatches(content, label, update)} disabled={!searchQuery}>全部替换</button>
        <small>{matchCount ? `${Math.min(searchMatchIndex + 1, matchCount)} / ${matchCount}` : '无匹配'}</small>
      </div>
    </section>;
  };

  const saveBannedWords = () => {
    const words = Array.from(new Set(bannedWordsDraft.split(/[\n,，、]+/u).map(word => word.trim()).filter(Boolean))).slice(0, 300);
    setBannedWords(words);
    localStorage.setItem('writer-banned-words', JSON.stringify(words));
    setShowBannedWords(false);
    setNotice({ title: '禁词列表已保存', content: `当前共 ${words.length} 个禁词，编辑器会实时标记。` });
  };

  const copyText = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setNotice({ title: '已复制', content: '文本已复制到剪贴板。' });
    } catch {
      setNotice({ title: '复制失败', content: '当前系统未允许访问剪贴板，请手动选择文本复制。' });
    }
  };

  const runAITool = async (mode: 'polish' | 'de-ai' | 'continue') => {
    if (!editingProject || !activeChapter || aiToolRunning) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中配置可用模型。' });
      return;
    }
    const target = Number(editingProject.chapterTargetWords) || 3000;
    const currentCount = countNovelCharacters(activeChapter.content);
    if (mode === 'continue') {
      const maxWords = Math.max(0, Math.floor(target * 1.2 - currentCount));
      if (!maxWords) {
        setNotice({ title: '已达到续写上限', content: `本章目标 ${target} 字，最多续写到 ${Math.floor(target * 1.2)} 字。` });
        return;
      }
      const chapterIndex = editingProject.chapters.findIndex(chapter => chapter.id === activeChapter.id);
      const previous = editingProject.chapters[chapterIndex - 1];
      if (!previous && currentCount < 200) {
        setNotice({ title: '正文太短', content: '第一章至少写满 200 字后才可以续写。' });
        return;
      }
      setAIToolResult(null);
      setAIToolMode('continue');
      setAIToolRunning(true);
      try {
        await invoke<string>('start_agent_runtime');
        const result = await invoke<{ content?: string }>('call_agent_rpc', {
          method: 'text.transform',
          params: {
            mode,
            instruction: aiToolInstruction.trim(),
            content: activeChapter.content,
            previousChapter: previous?.content?.slice(-6000) || '',
            maxWords,
            projectTitle: editingProject.title,
            chapterTitle: activeChapter.title,
            apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys,
            baseURL: agentConfig.baseURL.trim() || defaultBaseURL, model: agentConfig.model.trim() || fallbackModels[0],
            apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode, contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
          },
        });
        const content = result.content?.trim() || '';
        if (!content) throw new Error('模型没有返回续写内容');
        setAIToolResult({ mode, content, projectId: editingProject.id, chapterId: activeChapter.id, scope: 'chapter', maxWords });
      } catch (error) { setNotice({ title: 'AI 续写失败', content: String(error) }); }
      finally { setAIToolRunning(false); }
      return;
    }
    const element = chapterEditorRef.current;
    const liveStart = element?.selectionStart ?? 0;
    const liveEnd = element?.selectionEnd ?? 0;
    const savedSelectionValid = selectionSnapshot
      && selectionSnapshot.end > selectionSnapshot.start
      && activeChapter.content.slice(selectionSnapshot.start, selectionSnapshot.end) === selectionSnapshot.source;
    const start = liveEnd > liveStart ? liveStart : savedSelectionValid ? selectionSnapshot.start : 0;
    const end = liveEnd > liveStart ? liveEnd : savedSelectionValid ? selectionSnapshot.end : 0;
    const source = end > start ? activeChapter.content.slice(start, end) : activeChapter.content;
    if (!source.trim()) {
      setNotice({ title: '没有可润色内容', content: '请在章节中输入内容或选中一段文字。' });
      return;
    }
    setAIToolMode(mode);
    setAIToolRunning(true);
    setAIToolResult(null);
    try {
      await invoke<string>('start_agent_runtime');
      const result = await invoke<{ content?: string }>('call_agent_rpc', {
        method: 'text.transform',
        params: {
          mode, instruction: aiToolInstruction.trim(), content: source,
          projectTitle: editingProject.title, chapterTitle: activeChapter.title,
          apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys,
          baseURL: agentConfig.baseURL.trim() || defaultBaseURL, model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode, contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        },
      });
      const content = result.content?.trim() || '';
      if (!content) throw new Error(`模型没有返回${mode === 'de-ai' ? '去 AI 味' : '润色'}内容`);
      setAIToolResult({
        mode,
        content,
        projectId: editingProject.id,
        chapterId: activeChapter.id,
        scope: end > start ? 'selection' : 'chapter',
        source,
        start,
        end,
      });
    } catch (error) { setNotice({ title: mode === 'de-ai' ? '去 AI 味失败' : 'AI 润色失败', content: String(error) }); }
    finally { setAIToolRunning(false); }
  };

  const acceptAIToolResult = async () => {
    if (!aiToolResult) return;
    const targetProject = projects.find(project => project.id === aiToolResult.projectId)
      || (editingProject?.id === aiToolResult.projectId ? editingProject : null);
    const targetChapter = targetProject?.chapters.find(chapter => chapter.id === aiToolResult.chapterId);
    if (!targetProject || !targetChapter) {
      setNotice({ title: '无法写入结果', content: '原章节已不存在，未覆盖任何内容。' });
      return;
    }

    let nextContent = targetChapter.content;
    if (aiToolResult.mode === 'continue') {
      nextContent = `${targetChapter.content}${targetChapter.content.trim() ? '\n\n' : ''}${aiToolResult.content}`;
    } else if (aiToolResult.scope === 'chapter') {
      nextContent = aiToolResult.content;
    } else {
      const source = aiToolResult.source || '';
      const matchesOriginalRange = aiToolResult.start !== undefined
        && aiToolResult.end !== undefined
        && targetChapter.content.slice(aiToolResult.start, aiToolResult.end) === source;
      if (matchesOriginalRange) {
        nextContent = `${targetChapter.content.slice(0, aiToolResult.start)}${aiToolResult.content}${targetChapter.content.slice(aiToolResult.end)}`;
      } else {
        const currentIndex = source ? targetChapter.content.indexOf(source) : -1;
        if (currentIndex < 0) {
          setNotice({ title: '原段落已变更', content: '为避免覆盖你在生成期间的编辑，未替换正文。请重新选择该段后再处理。' });
          return;
        }
        nextContent = `${targetChapter.content.slice(0, currentIndex)}${aiToolResult.content}${targetChapter.content.slice(currentIndex + source.length)}`;
      }
    }

    const now = new Date().toISOString();
    const updatedChapter: Chapter = { ...targetChapter, content: nextContent, wordCount: countNovelCharacters(nextContent), updatedAt: now };
    const updatedChapters = targetProject.chapters.map(chapter => chapter.id === updatedChapter.id ? updatedChapter : chapter);
    const updatedProject: Project = {
      ...targetProject,
      chapters: updatedChapters,
      wordCount: updatedChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      updatedAt: now,
    };
    const nextProjects = projects.some(project => project.id === updatedProject.id)
      ? projects.map(project => project.id === updatedProject.id ? updatedProject : project)
      : [...projects, updatedProject];

    setProjects(nextProjects);
    if (editingProject?.id === updatedProject.id) setEditingProject(updatedProject);
    if (activeChapter?.id === updatedChapter.id) setActiveChapter(updatedChapter);
    setAutoSaveStatus('saving');
    setAIToolResult(null);
    setAIToolMode(null);
    setAIToolInstruction('');

    try {
      if ('__TAURI_INTERNALS__' in window) {
        await invoke<string>('save_projects', { projects: nextProjects });
      } else {
        localStorage.setItem('projects', JSON.stringify(nextProjects));
      }
      setAutoSaveStatus('saved');
      setNotice({ title: aiToolResult.mode === 'continue' ? '续写已插入章节' : aiToolResult.mode === 'de-ai' ? '去 AI 味已替换章节内容' : '润色已替换章节内容', content: '正文已写入并保存到本地。' });
    } catch (error) {
      setAutoSaveStatus('error');
      setNotice({ title: '正文已更新但保存失败', content: String(error) });
    }
  };

  const updateChapterTargetWords = () => {
    if (!editingProject) return;
    const target = Math.max(200, Math.min(100000, Number(chapterTargetWordsDraft) || 3000));
    updateEditorProject(project => ({ ...project, chapterTargetWords: target, updatedAt: new Date().toISOString() }));
    setChapterTargetWordsDraft(String(target));
    setNotice({ title: '章节目标已更新', content: `当前章节目标设为 ${target} 字，续写上限为 ${Math.floor(target * 1.2)} 字。` });
  };

  const cardSearchTerms = (card: KnowledgeCard) => {
    const generic = new Set([
      '角色', '角色卡', '人物', '人物卡', '物品', '物品卡', '地点', '地点卡', '势力', '势力卡',
      '金手指', '金手指卡', '手指', '身份', '性格', '目标', '能力', '天赋', '关系', '当前状态',
      '详细信息', '暂无', '设定', '限制', '代价', '升级路径', '触发条件', '核心能力',
    ]);
    const primaryTerms: string[] = [];
    const secondaryTerms = new Set<string>();
    const addPrimary = (value: string) => {
      const normalized = value.replace(/^[#*\-\s]+|[#*\-\s]+$/gu, '').replace(/[“”"']/gu, '').trim();
      if (normalized.length >= 2 && normalized.length <= 24 && !generic.has(normalized) && !primaryTerms.includes(normalized)) primaryTerms.push(normalized);
    };
    const addSecondary = (value: string) => {
      const normalized = value.replace(/^[#*\-\s]+|[#*\-\s]+$/gu, '').trim();
      if (normalized.length >= 2 && normalized.length <= 12 && !generic.has(normalized) && !primaryTerms.includes(normalized)) secondaryTerms.add(normalized);
    };
    if (!generic.has(card.title.trim())) addPrimary(card.title);
    const canonicalTitle = card.title.replace(/^(主角|角色|人物|本命|关键|核心)/u, '').trim();
    if (!generic.has(canonicalTitle)) addPrimary(canonicalTitle);
    if (!generic.has(canonicalTitle) && /^[\u3400-\u9fff]{3,}$/u.test(canonicalTitle)) {
      addPrimary(canonicalTitle.slice(-2));
      if (canonicalTitle.length > 3) addPrimary(canonicalTitle.slice(-3));
    }
    const identityPattern = /^\s*(?:[-*]\s*)?(?:姓名|名称|本名|别名|称号|代号|简称|天赋名称|能力名称)\s*[：:]\s*(.+)$/gmu;
    for (const match of card.content.matchAll(identityPattern)) {
      for (const value of match[1].split(/[、,，;；/]/u)) addPrimary(value.replace(/[（(].*$/u, '').trim());
    }
    const abilityHeadingPattern = /^\s*#{2,6}\s*(?:[^\n：:]{0,24}[：:])\s*([^\n]+)$/gmu;
    for (const match of card.content.matchAll(abilityHeadingPattern)) {
      for (const value of match[1].split(/[、,，;；/]/u)) addPrimary(value.replace(/[（(].*$/u, '').trim());
    }
    for (const segment of `${card.title}\n${card.content}`.match(/[\u3400-\u9fff]{2,10}|[A-Za-z][A-Za-z0-9_-]{1,24}/g) || []) {
      addSecondary(segment);
    }
    return [...primaryTerms, ...[...secondaryTerms].sort((left, right) => right.length - left.length)].slice(0, 40);
  };

  // Keep card retrieval deterministic: explicit selections win, then cards whose
  // stable names/aliases occur in the current task or immediate chapter context.
  // Sending only compact card headers/content keeps the upstream prompt prefix
  // stable and avoids requiring a manual picker for every chapter.
  const rankCardsForChapter = (project: Project, chapter: Chapter | null, instruction: string, outlineText: string, previousMemory?: ChapterMemory) => {
    const query = [chapter?.title || '', chapter?.content || '', instruction, outlineText, previousMemory?.summary || '', ...(previousMemory?.keywords || [])].join('\n').toLocaleLowerCase();
    return project.cards.map(card => {
      const terms = cardSearchTerms(card);
      const title = card.title.trim().toLocaleLowerCase();
      const titleHit = title.length >= 2 && query.includes(title) ? 80 : 0;
      const termHits = terms.slice(0, 12).reduce((score, term) => score + (term.length >= 3 && query.includes(term.toLocaleLowerCase()) ? (term === card.title ? 24 : 4) : 0), 0);
      const explicit = selectedCardIds.includes(card.id) ? 1000 : 0;
      const typeBoost = /角色卡|地点卡|势力卡/u.test(card.type) ? 3 : 0;
      return { card, score: explicit + titleHit + termHits + typeBoost };
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.card.id - right.card.id).slice(0, 10).map(item => item.card);
  };

  const buildEarlierMemorySummary = (project: Project, currentChapter: Chapter, count: number): MemoryDocument | undefined => {
    const currentIndex = project.chapters.findIndex(item => item.id === currentChapter.id);
    if (count <= 0 || currentIndex <= 1) return undefined;
    const previousId = project.chapters[currentIndex - 1]?.id;
    const memories = project.memories
      .filter(memory => memory.chapterId !== currentChapter.id && memory.chapterId !== previousId)
      .map(memory => ({ memory, index: project.chapters.findIndex(chapter => chapter.id === memory.chapterId) }))
      .filter(item => item.index >= 0 && item.index < currentIndex - 1)
      .sort((left, right) => right.index - left.index)
      .slice(0, count)
      .sort((left, right) => right.index - left.index);
    if (!memories.length) return undefined;
    const list = (value: unknown, limit = 3) => asTextList(value, limit).join('；');
    const content = memories.map(({ memory, index }) => {
      const number = memory.sourceChapterNumber || index + 1;
      const lines = [
        `## 第 ${number} 章《${memory.chapterTitle || '未命名'}》`,
        `摘要：${memory.summary || '暂无'}`,
        `人物状态：${list(memory.characterStateChanges) || '暂无'}`,
        `角色认知：${list(memory.knowledgeChanges) || '暂无'}`,
        `伏笔：${list(memory.foreshadowingChanges) || '暂无'}`,
        `时间线：${list(memory.timelineEvents) || '暂无'}`,
        `设定事实：${list(memory.canonFacts) || '暂无'}`,
        `冲突：${list(memory.conflicts) || '暂无'}`,
        `章末钩子：${memory.endingHook || '暂无'}`,
      ];
      return lines.join('\n');
    }).join('\n\n');
    return { id: 'memory-summary:earlier', kind: '章节快照', title: `前 ${memories.length} 章记忆摘要`, content, updatedAt: 'stable' };
  };

  const findCardRecentMentions = (project: Project, card: KnowledgeCard, limit = 3) => {
    const terms = cardSearchTerms(card);
    const mentions: Array<{ chapter: Chapter; matchedTerm: string; snippet: string; position: number }> = [];
    for (const chapter of [...project.chapters].reverse()) {
      const positions = terms.flatMap(term => {
        const found: Array<{ term: string; position: number }> = [];
        let position = chapter.content.indexOf(term);
        while (position >= 0 && found.length < 8) {
          found.push({ term, position });
          position = chapter.content.indexOf(term, position + term.length);
        }
        return found;
      }).sort((left, right) => right.position - left.position);
      for (const match of positions.slice(0, limit)) {
        const { position, term: matchedTerm } = match;
        const start = Math.max(0, position - 70);
        const end = Math.min(chapter.content.length, position + matchedTerm.length + 150);
        mentions.push({ chapter, matchedTerm, position, snippet: chapter.content.slice(start, end).replace(/\s+/gu, ' ').trim() });
      }
    }
    return mentions.slice(0, limit);
  };

  const refreshCardStatesForProject = (project: Project, cardIds?: Set<number>) => {
    const now = new Date().toISOString();
    const targetCards = cardIds ? project.cards.filter(card => cardIds.has(card.id)) : project.cards;
    if (!targetCards.length) return project;
    const graphNodes = [...project.graphNodes];
    const graphEdges = [...project.graphEdges];
    project.cards.forEach(card => {
      if (!graphNodes.some(node => node.id === `card:${card.id}`)) {
        graphNodes.push({ id: `card:${card.id}`, label: card.title, type: 'card', category: card.type });
      }
    });
    const cards = project.cards.map(card => {
      if (!targetCards.some(target => target.id === card.id)) return card;
      const recentMentions = findCardRecentMentions(project, card, 3);
      const mention = recentMentions[0] ?? null;
      const status = mention ? '最近出现' : '未在正文中定位';
      const changes = mention
        ? recentMentions.map(item => `第 ${project.chapters.findIndex(chapter => chapter.id === item.chapter.id) + 1} 章《${item.chapter.title}》出现“${item.matchedTerm}”：${item.snippet}`).join('\n')
        : '当前全文未检索到可定位的卡片名称或关键词。';
      const lastEntry = card.stateHistory?.[card.stateHistory.length - 1];
      const stateHistory = lastEntry?.changes === changes ? (card.stateHistory || []) : [
        ...(card.stateHistory || []),
        { chapterId: mention?.chapter.id ?? 0, chapterTitle: mention?.chapter.title ?? '全文检索', status, changes, updatedAt: now },
      ].slice(-30);
      for (const item of recentMentions) {
        const chapterNodeId = `chapter:${item.chapter.id}`;
        if (!graphNodes.some(node => node.id === chapterNodeId)) graphNodes.push({ id: chapterNodeId, label: item.chapter.title, type: 'chapter' });
        const edgeId = `${chapterNodeId}->card:${card.id}:状态引用`;
        upsertKnowledgeGraphEdge(graphEdges, { id: edgeId, source: chapterNodeId, target: `card:${card.id}`, label: '状态引用', weight: 0.88, updatedAt: now });
      }
      return { ...card, currentState: changes, stateHistory, updatedAt: now };
    });
    return { ...project, cards, graphNodes, graphEdges, updatedAt: now };
  };

  const updateCardStatesFromBook = async (cardId?: number) => {
    if (!editingProject) return;
    let searchProject = editingProject;
    // 章节正文以 Markdown 文件为事实来源；刷新前重新载入一次，避免只扫描启动时的元数据快照。
    if ('__TAURI_INTERNALS__' in window) {
      try {
        const loadedProjects = await invoke<Project[] | null>('load_projects');
        const loadedProject = loadedProjects?.find(project => project.id === editingProject.id);
        if (loadedProject) searchProject = { ...editingProject, chapters: loadedProject.chapters };
      } catch (error) {
        setNotice({ title: '读取本地章节失败', content: String(error) });
      }
    }
    if (activeChapter && searchProject.chapters.some(chapter => chapter.id === activeChapter.id)) {
      searchProject = { ...searchProject, chapters: searchProject.chapters.map(chapter => chapter.id === activeChapter.id ? activeChapter : chapter) };
    }
    const targetCards = cardId === undefined ? searchProject.cards : searchProject.cards.filter(card => card.id === cardId);
    if (!targetCards.length) return;
    const refreshedProject = refreshCardStatesForProject(searchProject, new Set(targetCards.map(card => card.id)));
    setEditingProject(refreshedProject);
    setProjects(current => current.map(project => project.id === refreshedProject.id ? refreshedProject : project));
    setNotice({ title: cardId === undefined ? '卡片状态已更新' : '卡片状态已更新', content: `已全文检索并更新 ${targetCards.length} 张卡片的最近出现状态。` });
  };

  const buildProjectWithChapterMemory = (project: Project, chapter: Chapter, memoryPatch: Partial<ChapterMemory>) => {
    const hasContent = chapter.content.trim().length > 0;
    const updatedChapters = project.chapters.map(item => item.id === chapter.id ? chapter : item);
    const chapterNodeId = `chapter:${chapter.id}`;
    const chapterNumber = project.chapters.findIndex(item => item.id === chapter.id) + 1;
    const mentionedCards = project.cards.filter(card => cardSearchTerms(card).some(term => chapter.content.includes(term)));
    const autoMatchedCards = rankCardsForChapter(project, chapter, '', '', project.memories.find(memory => memory.chapterId === chapter.id));
    const referencedCards = project.cards.filter(card => selectedCardIds.includes(card.id) || mentionedCards.some(item => item.id === card.id) || autoMatchedCards.some(item => item.id === card.id));
    const graphNodes = [...project.graphNodes];
    const ensureNode = (id: string, label: string, type: KnowledgeGraphNode['type'], category?: string) => {
      const index = graphNodes.findIndex(node => node.id === id);
      if (index >= 0) graphNodes[index] = { ...graphNodes[index], label, type, category: category || graphNodes[index].category };
      else graphNodes.push({ id, label, type, category, content: createGraphNodeProfile(type, category), updatedAt: new Date().toISOString() });
    };
    project.cards.forEach(card => ensureNode(`card:${card.id}`, card.title, 'card', card.type));
    project.outlines.forEach(outline => ensureNode(`outline:${outline.id}`, outline.title, 'outline', outline.kind));
    [project.protagonist1, project.protagonist2].filter((name): name is string => Boolean(name?.trim())).forEach(name => ensureNode(`entity:${name.trim()}`, name.trim(), 'entity', '人物'));
    if (hasContent) ensureNode(chapterNodeId, chapter.title, 'chapter');
    else {
      const index = graphNodes.findIndex(node => node.id === chapterNodeId);
      if (index >= 0) graphNodes.splice(index, 1);
    }
    const graphEdges = project.graphEdges.filter(edge => edge.source !== chapterNodeId && edge.target !== chapterNodeId);
    if (hasContent) {
      referencedCards.forEach(card => {
        const id = `${chapterNodeId}->card:${card.id}`;
        const label = selectedCardIds.includes(card.id) ? '本章引用' : '正文提及';
        graphEdges.push({ id, source: chapterNodeId, target: `card:${card.id}`, label, weight: defaultKnowledgeGraphWeight(label), sourceChapterId: chapter.id, updatedAt: new Date().toISOString() });
      });
      [project.protagonist1, project.protagonist2].filter((name): name is string => Boolean(name?.trim()) && chapter.content.includes(name.trim())).forEach(name => {
        const target = `entity:${name.trim()}`;
        graphEdges.push({ id: `${chapterNodeId}->${target}`, source: chapterNodeId, target, label: '章节主角', weight: 0.92, sourceChapterId: chapter.id, updatedAt: new Date().toISOString() });
      });
    }
    const cards = project.cards.map(card => {
      if (!hasContent || !referencedCards.some(item => item.id === card.id)) return card;
      const matchedTerm = cardSearchTerms(card).find(term => chapter.content.includes(term)) || card.title;
      const position = chapter.content.lastIndexOf(matchedTerm);
      const snippet = position >= 0 ? chapter.content.slice(Math.max(0, position - 70), Math.min(chapter.content.length, position + matchedTerm.length + 150)).replace(/\s+/gu, ' ').trim() : '';
      const changes = `第 ${chapterNumber} 章《${chapter.title}》出现“${matchedTerm}”：${snippet}`;
      const lastEntry = card.stateHistory?.[card.stateHistory.length - 1];
      const stateHistory = lastEntry?.changes === changes ? (card.stateHistory || []) : [...(card.stateHistory || []), { chapterId: chapter.id, chapterTitle: chapter.title, status: '本章出现', changes, updatedAt: new Date().toISOString() }].slice(-30);
      return { ...card, currentState: changes, stateHistory, updatedAt: new Date().toISOString() };
    });
    const existingMemory = project.memories.find(memory => memory.chapterId === chapter.id);
    const memories = hasContent ? [
      ...project.memories.filter(memory => memory.chapterId !== chapter.id),
      normalizeChapterMemory({
        ...existingMemory,
        ...memoryPatch,
        id: existingMemory?.id ?? Date.now(),
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        createdAt: existingMemory?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceChapterNumber: project.chapters.findIndex(item => item.id === chapter.id) + 1,
      }, chapter),
    ] : project.memories.filter(memory => memory.chapterId !== chapter.id);
    return {
      ...project,
      chapters: updatedChapters,
      cards,
      wordCount: updatedChapters.reduce((sum, item) => sum + item.wordCount, 0),
      memories,
      memoryDocuments: buildMemoryDocuments(memories, project.memoryDocuments),
      graphNodes,
      graphEdges,
      updatedAt: new Date().toISOString(),
    };
  };

  // 将章节记忆 Agent 抽取的实体和关系增量合并到本地知识图谱。
  const mergeKnowledgeGraph = (project: Project, chapter: Chapter, result: AgentMemoryResult): Project => {
    const chapterNodeId = `chapter:${chapter.id}`;
    const nodes = [...project.graphNodes];
    const edges = normalizeKnowledgeGraphEdges(project.graphEdges);
    const now = new Date().toISOString();
    let cards = project.cards;
    const cardTypeForEntity = (type?: string): CardType | undefined => {
      const value = String(type || '').toLocaleLowerCase();
      if (/人物|角色|主角|配角|character|person/u.test(value)) return '角色卡';
      if (/地点|场景|城市|区域|location|place/u.test(value)) return '地点卡';
      if (/势力|组织|宗门|家族|集团|faction|organization/u.test(value)) return '势力卡';
      if (/物品|道具|装备|artifact|item/u.test(value)) return '物品卡';
      if (/能力|技能|天赋|系统|金手指|ability|skill/u.test(value)) return '金手指卡';
      return undefined;
    };
    const normalizedCardTitle = (value: string) => value.replace(/[“”"'「」『』【】]/gu, '').replace(/\s+/gu, '').trim().slice(0, 40);
    const findCardForEntity = (label: string) => {
      const normalized = normalizedCardTitle(label);
      return cards.find(card => normalized && (normalized === normalizedCardTitle(card.title) || cardSearchTerms(card).some(term => normalized === normalizedCardTitle(term))));
    };
    const findNodeId = (label: string) => nodes.find(node => node.label === label)?.id
      || project.cards.find(card => cardSearchTerms(card).includes(label))?.id.toString().replace(/^/, 'card:');
    const ensureEntity = (label: string, category = '实体') => {
      const normalized = label.trim().slice(0, 80);
      if (!normalized) return null;
      const existingId = findNodeId(normalized);
      if (existingId) return existingId;
      const id = `entity:${normalized}`;
      nodes.push({ id, label: normalized, type: 'entity', category, content: createGraphNodeProfile('entity', category), updatedAt: new Date().toISOString() });
      return id;
    };
    const chapterNode = nodes.find(node => node.id === chapterNodeId);
    if (!chapterNode && chapter.content.trim()) nodes.push({ id: chapterNodeId, label: chapter.title, type: 'chapter', content: createGraphNodeProfile('chapter'), updatedAt: now });
    project.cards.forEach(card => {
      if (!nodes.some(node => node.id === `card:${card.id}`)) nodes.push({ id: `card:${card.id}`, label: card.title, type: 'card', category: card.type, content: createGraphNodeProfile('card', card.type), updatedAt: now });
    });
    project.outlines.forEach(outline => {
      if (!nodes.some(node => node.id === `outline:${outline.id}`)) nodes.push({ id: `outline:${outline.id}`, label: outline.title, type: 'outline', category: outline.kind, content: createGraphNodeProfile('outline', outline.kind), updatedAt: now });
    });
    for (const entity of result.entities || []) {
      const label = String(entity.name || '').trim();
      const category = String(entity.type || '实体').trim() || '实体';
      const id = ensureEntity(label, category);
      if (!id) continue;
      // New entities become lightweight, author-confirmable cards immediately.
      // This prevents later chapter prompts from hallucinating an entity that
      // was already introduced, without spending another model request.
      let card = findCardForEntity(label);
      const cardType = cardTypeForEntity(category);
      if (!card && cardType) {
        const createdAt = new Date().toISOString();
        const nextId = Math.max(0, ...cards.map(item => Number(item.id) || 0)) + 1;
        card = {
          id: nextId,
          type: cardType,
          title: normalizedCardTitle(label),
          content: `## 首次发现\n本实体在第 ${project.chapters.findIndex(item => item.id === chapter.id) + 1} 章正文中出现。\n\n## 当前线索\n由章节记忆自动创建，待作者补充确认。`,
          currentState: '待作者确认',
          stateHistory: [{ chapterId: chapter.id, chapterTitle: chapter.title, status: '待确认', changes: '由章节记忆自动创建；请作者补充设定。', updatedAt: createdAt }],
          createdAt,
          updatedAt: createdAt,
        };
        cards = [...cards, card];
        nodes.push({ id: `card:${card.id}`, label: card.title, type: 'card', category: card.type, content: card.content, status: '待确认', updatedAt: createdAt });
      }
      // Keep graph and card identity unified even when the entity already had a card.
      if (card && !nodes.some(node => node.id === `card:${card.id}`)) nodes.push({ id: `card:${card.id}`, label: card.title, type: 'card', category: card.type, content: card.content, status: card.currentState, updatedAt: card.updatedAt });
      if (card) {
        const cardId = `card:${card.id}`;
        upsertKnowledgeGraphEdge(edges, { id: `${chapterNodeId}->${cardId}:实体卡片`, source: chapterNodeId, target: cardId, label: '实体卡片', weight: 0.9, sourceChapterId: chapter.id, updatedAt: now });
      }
      const edgeId = `${chapterNodeId}->${id}`;
      upsertKnowledgeGraphEdge(edges, { id: edgeId, source: chapterNodeId, target: id, label: '章节提及', weight: 0.7, sourceChapterId: chapter.id, updatedAt: now });
    }
    for (const relation of result.relations || []) {
      const sourceLabel = String(relation.source || '').trim();
      const targetLabel = String(relation.target || '').trim();
      if (!sourceLabel || !targetLabel) continue;
      const source = findNodeId(sourceLabel) || ensureEntity(sourceLabel);
      const target = findNodeId(targetLabel) || ensureEntity(targetLabel);
      if (!source || !target || source === target) continue;
      const label = String(relation.label || '关联').trim().slice(0, 40) || '关联';
      const edgeId = `${source}->${target}:${label}`;
      upsertKnowledgeGraphEdge(edges, { id: edgeId, source, target, label, weight: normalizeKnowledgeGraphWeight(relation.weight, label), sourceChapterId: chapter.id, updatedAt: now });
    }
    for (const update of result.cardUpdates || []) {
      const card = cards.find(item => (update.cardId !== undefined && String(item.id) === String(update.cardId)) || (update.cardTitle && item.title === update.cardTitle));
      const changes = String(update.changes || '').trim();
      if (!card || !changes) continue;
      const status = String(update.status || 'updated').trim();
      const lastEntry = card.stateHistory?.[card.stateHistory.length - 1];
      const stateHistory = lastEntry?.changes === changes ? (card.stateHistory || []) : [...(card.stateHistory || []), { chapterId: chapter.id, chapterTitle: chapter.title, status, changes, updatedAt: now }].slice(-30);
      cards = cards.map(item => item.id === card.id ? { ...item, currentState: changes, stateHistory, updatedAt: now } : item);
      const cardNodeId = `card:${card.id}`;
      const edgeId = `${chapterNodeId}->${cardNodeId}:状态更新`;
      upsertKnowledgeGraphEdge(edges, { id: edgeId, source: chapterNodeId, target: cardNodeId, label: '状态更新', weight: 0.95, sourceChapterId: chapter.id, updatedAt: now });
    }
    return { ...project, cards, graphNodes: nodes, graphEdges: edges, updatedAt: now };
  };

  const persistCurrentChapter = async () => {
    if (!editingProject || !activeChapter || chapterSaving) return;
    setChapterSaving(true);
    const now = new Date().toISOString();
    const chapter: Chapter = {
      ...activeChapter,
      content: activeChapter.content,
      wordCount: countNovelCharacters(activeChapter.content),
      updatedAt: now,
    };
    const currentMemory = editingProject.memories.find(memory => memory.chapterId === chapter.id);
    const localStructuredMemory = buildLocalStructuredMemory(chapter, editingProject);
    const autoMatchedCards = rankCardsForChapter(editingProject, chapter, '', getChapterOutline(editingProject, chapter)?.content || '', currentMemory);
    const selectedKeywords = editingProject.cards.filter(card => selectedCardIds.includes(card.id) || autoMatchedCards.some(item => item.id === card.id)).map(card => card.title);
    const keywords = selectedKeywords.length ? selectedKeywords : (currentMemory?.keywords?.length ? currentMemory.keywords : localStructuredMemory.keywords);
    const localProjectWithMemory = buildProjectWithChapterMemory(editingProject, chapter, {
      ...localStructuredMemory,
      keywords,
    });
    const cardsToRefresh = new Set(localProjectWithMemory.cards
      .filter(card => selectedCardIds.includes(card.id) || autoMatchedCards.some(item => item.id === card.id) || cardSearchTerms(card).some(term => chapter.content.includes(term)))
      .map(card => card.id));
    const localProject = refreshCardStatesForProject(localProjectWithMemory, cardsToRefresh);
    const saveProject = async (project: Project) => {
      const snapshot = projects.map(item => item.id === project.id ? project : item);
      setProjects(snapshot);
      setEditingProject(project);
      setActiveChapter(chapter);
      if ('__TAURI_INTERNALS__' in window) {
        await invoke<string>('save_projects', { projects: snapshot });
      } else {
        localStorage.setItem('projects', JSON.stringify(snapshot));
      }
    };

    try {
      await saveProject(localProject);
    } catch (error) {
      setNotice({ title: '章节保存失败', content: String(error) });
      setChapterSaving(false);
      return;
    }

    if (!chapter.content.trim() || !agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '章节已保存', content: chapter.content.trim() ? '章节和本地章节记忆已更新。' : '空章节已保存，并移除了本章记忆。' });
      setChapterSaving(false);
      return;
    }

    if (Date.now() < memoryQuotaRetryAt) {
      const remainingMinutes = Math.max(1, Math.ceil((memoryQuotaRetryAt - Date.now()) / 60_000));
      setNotice({ title: '章节已保存', content: `正文和本地章节记忆已更新；API 中转额度暂不可用，本章智能摘要将在 ${remainingMinutes} 分钟后可再次更新。` });
      setChapterSaving(false);
      return;
    }

    // 本地章节已经保存，AI 记忆只处理当前章节，并在后台增量更新。
    // 这样网络中转变慢或返回 502 时不会阻塞编辑器的保存按钮。
    setChapterSaving(false);
    setNotice({ title: '章节已保存', content: '章节已写入本地，正在后台更新本章记忆。' });
    void (async () => {
      try {
        await invoke<string>('start_agent_runtime');
        const result = await invoke<AgentMemoryResult>('call_agent_rpc', {
          method: 'memory.write',
          params: {
            projectTitle: localProject.title,
            chapterTitle: chapter.title,
            content: chapter.content,
            cards: localProject.cards.filter(card => selectedCardIds.includes(card.id) || autoMatchedCards.some(item => item.id === card.id) || (card.title.trim() && chapter.content.includes(card.title))).sort((left, right) => left.id - right.id).slice(0, 10),
            apiKey: agentConfig.apiKey.trim(),
            apiKeys: agentConfig.apiKeys,
            baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
            model: agentConfig.model.trim() || fallbackModels[0],
            apiMode: agentConfig.apiMode,
            reasoningMode: agentConfig.reasoningMode,
            contextWindow: agentConfig.contextWindow,
            knowledgeGraph: { nodes: localProject.graphNodes, edges: localProject.graphEdges },
            ...agentNetworkParams(agentConfig),
          },
        });
        const summary = result.summary?.trim() || localStructuredMemory.summary;
        const aiKeywords = Array.isArray(result.keywords) && result.keywords.length ? asTextList(result.keywords, 8) : keywords;
        const aiStructuredFieldCount = [
          result.characterStateChanges,
          result.knowledgeChanges,
          result.foreshadowingChanges,
          result.timelineEvents,
          result.canonFacts,
          result.conflicts,
        ].filter(value => asTextList(value).length > 0).length + (result.endingHook?.trim() ? 1 : 0);
        // A complete model response is used as one coherent classification.
        // Mixing individual local heuristic fields into it made iOS memories
        // noticeably less precise than desktop memories.
        const useCoherentAIResult = aiStructuredFieldCount >= 3;
        const preferAIList = (value: unknown, fallback: string[], existing: string[] | undefined) => {
          const extracted = asTextList(value);
          if (useCoherentAIResult) return extracted;
          return extracted.length ? extracted : (fallback.length ? fallback : (existing || []));
        };
        const memoryPatch = {
          summary,
          keywords: aiKeywords,
          characterStateChanges: preferAIList(result.characterStateChanges, localStructuredMemory.characterStateChanges, currentMemory?.characterStateChanges),
          knowledgeChanges: preferAIList(result.knowledgeChanges, localStructuredMemory.knowledgeChanges, currentMemory?.knowledgeChanges),
          foreshadowingChanges: preferAIList(result.foreshadowingChanges, localStructuredMemory.foreshadowingChanges, currentMemory?.foreshadowingChanges),
          foreshadowingItems: Array.isArray(result.foreshadowingItems) ? result.foreshadowingItems : [],
          timelineEvents: preferAIList(result.timelineEvents, localStructuredMemory.timelineEvents, currentMemory?.timelineEvents),
          canonFacts: preferAIList(result.canonFacts, localStructuredMemory.canonFacts, currentMemory?.canonFacts),
          conflicts: preferAIList(result.conflicts, localStructuredMemory.conflicts, currentMemory?.conflicts),
          endingHook: typeof result.endingHook === 'string' && result.endingHook.trim() ? result.endingHook.trim() : (localStructuredMemory.endingHook || currentMemory?.endingHook || ''),
        };
        // 如果用户在等待期间又编辑了本章，丢弃过期摘要，避免覆盖新正文。
        setProjects(currentProjects => {
          const latestProject = currentProjects.find(project => project.id === localProject.id);
          const latestChapter = latestProject?.chapters.find(item => item.id === chapter.id);
          if (!latestProject || !latestChapter || latestChapter.updatedAt !== chapter.updatedAt) return currentProjects;
          const memoryProject = buildProjectWithChapterMemory(latestProject, latestChapter, memoryPatch);
          const refreshedMemoryProject = refreshCardStatesForProject(memoryProject, new Set(memoryProject.cards
            .filter(card => selectedCardIds.includes(card.id) || autoMatchedCards.some(item => item.id === card.id) || cardSearchTerms(card).some(term => latestChapter.content.includes(term)))
            .map(card => card.id)));
          const mergedBase = mergeKnowledgeGraph(refreshedMemoryProject, latestChapter, result);
          const resultCardIds = (result.cardUpdates || [])
            .map(update => mergedBase.cards.find(card => (update.cardId !== undefined && String(card.id) === String(update.cardId)) || (update.cardTitle && card.title === update.cardTitle))?.id)
            .filter((id): id is number => id !== undefined);
          const merged = {
            ...refreshCardStatesForProject(mergedBase, new Set([...resultCardIds, ...selectedCardIds])),
            authorPreferences: Array.from(new Set([...(latestProject.authorPreferences || []), ...asTextList(result.authorPreferences, 8)])).slice(-20),
          };
          setEditingProject(current => current?.id === merged.id ? merged : current);
          setActiveChapter(current => current?.id === latestChapter.id ? latestChapter : current);
          const nextProjects = currentProjects.map(project => project.id === merged.id ? merged : project);
          if ('__TAURI_INTERNALS__' in window) {
            void invoke<string>('save_projects', { projects: nextProjects });
          } else {
            localStorage.setItem('projects', JSON.stringify(nextProjects));
          }
          return nextProjects;
        });
        setNotice({ title: '章节记忆更新完成', content: '本章结构化摘要已写入本地；若期间再次编辑，旧摘要会被自动丢弃。' });
      } catch (error) {
        if (isQuotaExceededError(error)) {
          memoryQuotaRetryAt = Date.now() + memoryQuotaCooldownMs;
          setNotice({ title: '章节已保存', content: '正文和本地章节记忆已更新；API 中转额度已用尽，本章智能摘要会在额度恢复后再更新。' });
          return;
        }
        setNotice({ title: '章节已保存', content: `本章记忆暂未更新：${String(error)}。正文和本地快照不受影响。` });
      }
    })();
  };

  const updateEditorProject = (updater: (project: Project) => Project) => {
    if (!editingProject) return;
    const updated = updater(editingProject);
    setEditingProject(updated);
    setProjects(current => current.map(project => project.id === updated.id ? updated : project));
  };

  const parseChineseChapterNumber = (value: string): number | undefined => {
    const normalized = value.replace(/\s+/gu, '');
    if (/^\d+$/u.test(normalized)) return Number(normalized);
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0;
    let pendingDigit = 0;
    let hasDigit = false;
    for (const char of normalized) {
      if (digits[char] !== undefined) {
        pendingDigit = digits[char];
        hasDigit = true;
        continue;
      }
      const unit = char === '十' ? 10 : char === '百' ? 100 : char === '千' ? 1000 : 0;
      if (!unit) return undefined;
      total += (pendingDigit || 1) * unit;
      pendingDigit = 0;
    }
    return hasDigit || total ? total + pendingDigit : undefined;
  };

  const chapterNumberFromText = (value: string) => {
    const match = value.match(/第\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章/u);
    return match ? parseChineseChapterNumber(match[1]) : undefined;
  };

  /** Old chapter outlines may not have a chapterId. Recover it from their title
   * before an agent run, rather than letting the model infer a chapter from
   * unrelated outline history. */
  const chapterBoundToOutline = (project: Project, outline: OutlineDocument): Chapter | undefined => {
    const byId = typeof outline.chapterId === 'number'
      ? project.chapters.find(chapter => chapter.id === outline.chapterId)
      : undefined;
    if (byId) return byId;
    const chapterNumber = chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`);
    if (!chapterNumber) return undefined;
    return project.chapters.find(chapter => chapterNumberFromText(chapter.title) === chapterNumber)
      || project.chapters[chapterNumber - 1];
  };

  const chapterByNumber = (project: Project, number: number | undefined): Chapter | undefined => {
    if (!number || number < 1) return undefined;
    return project.chapters.find(chapter => chapterNumberFromText(chapter.title) === number)
      || project.chapters[number - 1];
  };

  const outlineByChapterNumber = (project: Project, number: number | undefined): OutlineDocument | undefined => {
    if (!number || number < 1) return undefined;
    return project.outlines.find(outline => outline.kind === '章纲'
      && chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`) === number)
      || project.outlines.find(outline => outline.kind === '章纲'
        && String(outline.chapterId ?? '') === String(project.chapters[number - 1]?.id ?? ''));
  };

  const instructionChapterNumber = (instruction: string, pattern: RegExp): number | undefined => {
    const matched = instruction.match(pattern)?.slice(1).find(Boolean);
    return matched ? parseChineseChapterNumber(matched) : undefined;
  };

  const resolveOutlineGenerationIntent = (project: Project, activeOutline: OutlineDocument, instruction: string) => {
    const sourcePattern = /(?:根据|基于|参考|按|以)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:正文|内容)|第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:正文|内容)\s*(?:生成|编写|补全|整理|反推|制作)/u;
    const sourceMatched = instruction.match(sourcePattern);
    const explicitSourceNumber = sourceMatched
      ? parseChineseChapterNumber(sourceMatched[1] || sourceMatched[2])
      : undefined;
    const targetNumber = chapterNumberFromText(`${activeOutline.title}\n${activeOutline.content.slice(0, 500)}`);
    const explicitTargetNumber = instructionChapterNumber(instruction, /(?:生成|编写|补全|制作|整理|反推)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:章纲|大纲)|(?:为|给)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:章纲|大纲)/u)
      || instructionChapterNumber(instruction, /第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:章纲|大纲)\s*(?:生成|编写|补全|制作|整理|反推)/u);
    const redirectedOutline = explicitTargetNumber && explicitTargetNumber !== targetNumber
      ? project.outlines.find(outline => outline.kind === '章纲' && chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`) === explicitTargetNumber)
      : undefined;
    const targetOutline = redirectedOutline || activeOutline;
    const targetChapter = chapterBoundToOutline(project, targetOutline);
    const targetIndex = targetChapter ? project.chapters.findIndex(chapter => chapter.id === targetChapter.id) : -1;
    const explicitFormatNumber = instructionChapterNumber(instruction, /(?:参考|按照|依照|沿用|模仿)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:章纲|大纲)(?:格式|结构|模板)/u);
    const formatOutline = explicitFormatNumber
      ? outlineByChapterNumber(project, explicitFormatNumber)
      : targetIndex > 0 ? outlineByChapterNumber(project, targetIndex) : undefined;
    const formatMode = explicitFormatNumber
      ? (formatOutline ? `作者指定参考第 ${explicitFormatNumber} 章章纲格式` : `未找到第 ${explicitFormatNumber} 章章纲格式`)
      : formatOutline ? '默认参考上一章章纲格式' : '无可用格式参考';
    const useCurrent = /(?:本章|当前章)(?:的)?(?:正文|内容)/u.test(instruction);
    const usePrevious = /(?:上一章|前一章)(?:的)?(?:正文|内容)/u.test(instruction);
    const sourceChapter = explicitSourceNumber ? chapterByNumber(project, explicitSourceNumber)
      : useCurrent ? targetChapter
        : (usePrevious || targetIndex > 0) ? project.chapters[targetIndex - 1]
          : undefined;
    const isFirstChapter = !explicitSourceNumber && !useCurrent && !usePrevious
      && (targetNumber === 1 || targetIndex === 0);
    const sourceMode = explicitSourceNumber
      ? `作者指定第 ${explicitSourceNumber} 章正文`
      : useCurrent ? '作者指定本章正文'
        : sourceChapter ? '默认上一章正文'
          : isFirstChapter ? '首章：根据世界观、作品简介与作者指令生成'
          : '未找到可用正文';
    return { targetOutline, targetChapter, sourceChapter, sourceMode, isFirstChapter, formatOutline, formatMode, explicitTargetNumber, targetRedirectFound: Boolean(redirectedOutline) };
  };

  const handleCreateOutline = (kind: OutlineKind) => {
    if (!editingProject) return;
    const now = new Date().toISOString();
    // 章纲按项目内已有章节/章纲的最大序号递增，避免新建时重复落在当前选中章节。
    const chapterNumber = (value: string) => chapterNumberFromText(value) || 0;
    const nextChapterNumber = kind === '章纲'
      ? Math.max(
        0,
        ...editingProject.chapters.map(chapter => chapterNumber(chapter.title)),
        ...editingProject.outlines.filter(outline => outline.kind === '章纲').map(outline => chapterNumber(`${outline.title}\n${outline.content}`)),
      ) + 1
      : 0;
    const nextChapter = kind === '章纲'
      ? editingProject.chapters.find(chapter => chapterNumber(chapter.title) === nextChapterNumber)
      : undefined;
    const chapterId = nextChapter?.id;
    const chapterTitle = kind === '章纲' ? (nextChapter?.title || `第 ${nextChapterNumber} 章`) : undefined;
    const outlineTitle = kind === '章纲' ? `章纲｜${chapterTitle}` : kind;
    const outline: OutlineDocument = {
      id: Date.now(),
      kind,
      chapterId,
      title: outlineTitle,
      content: `# ${kind}${chapterTitle ? `｜${chapterTitle}` : ''}\n\n`,
      createdAt: now,
      updatedAt: now,
    };
    updateEditorProject(project => ({
      ...project,
      outlines: [...project.outlines, outline],
      graphNodes: [...project.graphNodes, { id: `outline:${outline.id}`, label: outline.kind, type: 'outline' }],
      updatedAt: now,
    }));
    setActiveOutlineId(outline.id);
  };

  const updateActiveOutline = (patch: Partial<OutlineDocument>) => {
    if (!editingProject || activeOutlineId === null) return;
    const now = new Date().toISOString();
    updateEditorProject(project => ({
      ...project,
      outlines: project.outlines.map(outline => outline.id === activeOutlineId ? { ...outline, ...patch, updatedAt: now } : outline),
      updatedAt: now,
    }));
  };

  const handleDeleteOutline = (id: number) => {
    if (!editingProject) return;
    updateEditorProject(project => ({
      ...project,
      outlines: project.outlines.filter(outline => outline.id !== id),
      graphNodes: project.graphNodes.filter(node => node.id !== `outline:${id}`),
      graphEdges: project.graphEdges.filter(edge => edge.source !== `outline:${id}` && edge.target !== `outline:${id}`),
      updatedAt: new Date().toISOString(),
    }));
    if (activeOutlineId === id) setActiveOutlineId(editingProject.outlines.find(outline => outline.id !== id)?.id ?? null);
  };

  const generateOutline = async () => {
    if (!editingProject || activeOutlineId === null || outlineGenerating) return;
    const outline = editingProject.outlines.find(item => item.id === activeOutlineId);
    if (!outline) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写 API Saver Key，再生成大纲。' });
      return;
    }
    setAgentError('');
    setOutlineGenerating(true);
    const runId = `outline-${Date.now()}`; outlineRunRef.current = runId; setOutlineStreamContent('');
    setOutlineAgentActivity([{ id: 'starting', step: 'starting', message: '正在启动大纲智能体', status: 'active' }]);
    setOutlineChatMessages(current => [...current, { role: 'user', content: outlineAgentInstruction.trim(), createdAt: new Date().toISOString() }]);
    try {
      await invoke<string>('start_agent_runtime');
      const activeStyle = editingProject.styleProfileId ? writingStyles.find(style => style.id === editingProject.styleProfileId) : undefined;
      const intent = outline.kind === '章纲' ? resolveOutlineGenerationIntent(editingProject, outline, outlineAgentInstruction) : undefined;
      const targetOutline = intent?.targetOutline || outline;
      const targetChapter = intent?.targetChapter;
      const sourceChapter = intent?.sourceChapter;
      const formatOutline = intent?.formatOutline;
      if (outline.kind === '章纲' && intent?.explicitTargetNumber && !intent.targetRedirectFound && intent.explicitTargetNumber !== chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`)) {
        throw new Error(`没有找到第 ${intent.explicitTargetNumber} 章的章纲文档，请先新建或选择该章纲。`);
      }
      if (outline.kind === '章纲' && !sourceChapter && !intent?.isFirstChapter) {
        throw new Error('未找到上一章正文。请先保存上一章正文，或在指令中明确写“根据本章正文”或“根据第 N 章正文”。');
      }
      if (outline.kind === '章纲' && targetChapter && targetOutline.chapterId !== targetChapter.id) {
        updateEditorProject(project => ({
          ...project,
          outlines: project.outlines.map(item => item.id === targetOutline.id ? { ...item, chapterId: targetChapter.id, updatedAt: new Date().toISOString() } : item),
        }));
      }
      const result = await invoke<{ content?: string; title?: string }>('call_agent_rpc', {
        method: 'outline.write',
        params: {
          runId,
          sessionId: outlineSessionId,
          previousSessionId: outlinePreviousSessionId,
          outlineId: targetOutline.id,
          projectId: String(editingProject.id),
          projectTitle: editingProject.title,
          kind: outline.kind,
          existingContent: targetOutline.content,
          targetChapter: targetChapter ? {
            id: targetChapter.id,
            number: chapterNumberFromText(targetChapter.title) || editingProject.chapters.findIndex(chapter => chapter.id === targetChapter.id) + 1,
            title: targetChapter.title,
          } : undefined,
          sourceChapter: sourceChapter ? {
            id: sourceChapter.id,
            number: chapterNumberFromText(sourceChapter.title) || editingProject.chapters.findIndex(chapter => chapter.id === sourceChapter.id) + 1,
            title: sourceChapter.title,
            content: sourceChapter.content,
            mode: intent?.sourceMode,
          } : undefined,
          formatOutline: formatOutline ? {
            id: formatOutline.id,
            title: formatOutline.title,
            content: formatOutline.content,
            mode: intent?.formatMode,
          } : undefined,
          instruction: activeStyle ? `${outlineAgentInstruction.trim()}\n采用绑定文风 Skill「${activeStyle.name}」，只遵循抽象写作约束。` : outlineAgentInstruction.trim(),
          synopsis: editingProject.synopsis,
          cards: editingProject.cards.filter(card => selectedOutlineCardIds.includes(card.id)),
          knowledgeGraph: { nodes: editingProject.graphNodes, edges: editingProject.graphEdges },
          worldSetting: editingProject.outlines
            .filter(item => item.kind === '世界观与作品设定' && item.content.trim())
            .map(item => ({ id: item.id, title: item.title, content: item.content })),
          authorPreferences: editingProject.authorPreferences || [],
          writingStyle: activeStyle ? { name: activeStyle.name, content: activeStyle.content } : undefined,
          skills: [...skills, ...(activeStyle ? [{ name: `style-${activeStyle.id}`, displayName: activeStyle.name, category: 'write', description: activeStyle.description, tags: [...activeStyle.tags, '文风'], content: activeStyle.content }] : [])].map(skill => ({ name: skill.name, displayName: skill.displayName, category: skill.category, description: skill.description, tags: skill.tags, content: skill.content })),
          preferredSkillNames: selectedAgentSkillNames,
          apiKey: agentConfig.apiKey.trim(),
          apiKeys: agentConfig.apiKeys,
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || 'gpt-4o-mini',
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        },
      });
      const generatedContent = result.content || targetOutline.content;
      updateEditorProject(project => ({
        ...project,
        outlines: project.outlines.map(item => item.id === targetOutline.id ? { ...item, content: generatedContent, updatedAt: new Date().toISOString() } : item),
        updatedAt: new Date().toISOString(),
      }));
      setActiveOutlineId(targetOutline.id);
      setOutlineChatMessages(current => [...current, { role: 'assistant', content: generatedContent, createdAt: new Date().toISOString() }]);
      setNotice({ title: '大纲已生成', content: `${targetOutline.title} 已依据${sourceChapter ? `第 ${chapterNumberFromText(sourceChapter.title) || editingProject.chapters.findIndex(chapter => chapter.id === sourceChapter.id) + 1} 章正文` : '作品资料'}生成。` });
    } catch (error) {
      setAgentError(String(error));
      setOutlineAgentActivity(current => [...current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item), { id: `error-${Date.now()}`, step: 'error', message: String(error), status: 'error' }].slice(-12));
      setNotice({ title: '大纲生成失败', content: String(error) });
    } finally {
      setOutlineGenerating(false);
    }
  };

  const generateBatchChapters = async (project: Project, requestedCount: number) => {
    if (batchGenerationRunning) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写可用 API Key，再批量生成章节。' });
      return;
    }
    const count = Math.max(1, Math.min(20, Math.floor(requestedCount)));
    setBatchGenerationRunning(true);
    setBatchGenerationProgress(`准备生成 ${count} 章`);
    setBatchGenerationItems(Array.from({ length: count }, (_, index) => ({
      chapterNumber: project.chapters.length + index + 1,
      title: `第 ${project.chapters.length + index + 1} 章`,
      status: 'pending' as const,
    })));
    let working = project;
    let projectSnapshot = projects;
    const activeStyle = working.styleProfileId ? writingStyles.find(style => style.id === working.styleProfileId) : undefined;
    const skillPayload = skills.map(skill => ({ name: skill.name, displayName: skill.displayName, category: skill.category, description: skill.description, tags: skill.tags, content: skill.content }));
    try {
      await invoke<string>('start_agent_runtime');
      for (let offset = 0; offset < count; offset += 1) {
        const previous = working.chapters[working.chapters.length - 1];
        const chapterNumber = working.chapters.length + 1;
        const now = new Date().toISOString();
        const chapterId = Date.now() + offset * 3;
        const outlineId = chapterId + 1;
        const chapter: Chapter = { id: chapterId, title: `第 ${chapterNumber} 章`, content: '', wordCount: 0, createdAt: now, updatedAt: now };
        const updateBatchItem = (patch: Partial<BatchGenerationItem>) => setBatchGenerationItems(current => current.map(item => item.chapterNumber === chapterNumber ? { ...item, ...patch } : item));
        updateBatchItem({ status: 'outline' });
        setBatchGenerationProgress(`第 ${chapterNumber} 章：根据第 ${Math.max(1, chapterNumber - 1)} 章正文生成章纲`);
        const outlineResult = await invoke<{ title?: string; content?: string }>('call_agent_rpc', {
          method: 'outline.write',
          params: {
            runId: `batch-outline-${chapterId}`,
            sessionId: `batch-${working.id}`,
            projectId: String(working.id), projectTitle: working.title, kind: '章纲', outlineId,
            existingContent: '',
            instruction: `根据第${chapterNumber - 1}章正文生成第${chapterNumber}章章纲，自动识别并严格承接上一章结尾；最多700字，字数包括标点符号。`,
            targetChapter: { id: chapter.id, number: chapterNumber, title: chapter.title },
            sourceChapter: previous ? { id: previous.id, number: chapterNumber - 1, title: previous.title, content: previous.content, mode: '批量生成默认上一章正文' } : undefined,
            synopsis: working.synopsis,
            cards: working.cards.slice(0, 10),
            knowledgeGraph: { nodes: working.graphNodes, edges: working.graphEdges },
            worldSetting: working.outlines.filter(item => item.kind === '世界观与作品设定').map(item => ({ id: item.id, title: item.title, content: item.content })),
            writingStyle: activeStyle ? { name: activeStyle.name, content: activeStyle.content } : undefined,
            skills: skillPayload, preferredSkillNames: [],
            apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys, baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
            model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode, contextWindow: agentConfig.contextWindow,
            ...agentNetworkParams(agentConfig),
          },
        });
        const outlineContent = String(outlineResult.content || '').trim();
        if (!outlineContent) throw new Error(`第 ${chapterNumber} 章章纲生成为空`);
        const chapterTitle = batchChapterTitleFromOutline(outlineContent, chapterNumber, outlineResult.title);
        const titledChapter = { ...chapter, title: chapterTitle };
        const outline: OutlineDocument = { id: outlineId, kind: '章纲', chapterId: chapter.id, title: `章纲｜${chapterTitle}`, content: outlineContent, createdAt: now, updatedAt: now };
        updateBatchItem({ title: chapterTitle, outline: outlineContent, status: 'writing' });
        const autoCards = rankCardsForChapter(working, titledChapter, '', outlineContent, previous ? working.memories.find(memory => memory.chapterId === previous.id) : undefined);
        setBatchGenerationProgress(`第 ${chapterNumber} 章：章纲完成，正在生成正文`);
        const chapterResult = await invoke<{ draftContent?: string; content?: string }>('call_agent_rpc', {
          method: 'chapter.write',
          params: {
            runId: `batch-chapter-${chapterId}`, sessionId: `batch-${working.id}`,
            projectId: String(working.id), projectTitle: working.title, chapterId: String(titledChapter.id),
            instruction: '严格按照本章章纲生成正文，正文最多 2200 字（包含标点符号、空格和换行），自然承接上一章结尾。只输出正文，不要输出 JSON、计划、标题或解释。',
            outline: outlineContent, outlines: [
              ...working.outlines.filter(item => item.kind === '世界观与作品设定').map(item => ({ id: item.id, kind: item.kind, title: item.title, content: item.content })),
              { id: outline.id, kind: outline.kind, title: outline.title, chapterId: outline.chapterId, content: outline.content },
            ], activeOutlineId: outline.id,
            cards: [...autoCards, ...working.cards.filter(card => !autoCards.some(item => item.id === card.id))].slice(0, 10),
            knowledgeGraph: { nodes: working.graphNodes, edges: working.graphEdges },
            previousChapters: previous ? [{ id: previous.id, title: previous.title, content: previous.content }] : [],
            memories: previous ? working.memories.filter(memory => memory.chapterId === previous.id).map(memory => ({ id: memory.id, title: memory.chapterTitle, summary: memory.summary, keywords: memory.keywords, characterStateChanges: memory.characterStateChanges, knowledgeChanges: memory.knowledgeChanges, foreshadowingChanges: memory.foreshadowingChanges, timelineEvents: memory.timelineEvents, canonFacts: memory.canonFacts, conflicts: memory.conflicts, endingHook: memory.endingHook })) : [],
            memoryDocuments: [], writingStyle: activeStyle ? { name: activeStyle.name, content: activeStyle.content } : undefined,
            skills: skillPayload, preferredSkillNames: [], authorPreferences: working.authorPreferences || [],
            apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys, baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
            model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode, contextWindow: agentConfig.contextWindow,
            ...agentNetworkParams(agentConfig),
          },
        });
        const content = clampChapterContent(chapterDraftFromStream(String(chapterResult.draftContent || chapterResult.content || '')), 2200);
        if (!content) throw new Error(`第 ${chapterNumber} 章正文生成为空`);
        const completedChapter = { ...titledChapter, content, wordCount: countNovelCharacters(content), updatedAt: new Date().toISOString() };
        updateBatchItem({ content, status: 'memory' });
        setBatchGenerationProgress(`第 ${chapterNumber} 章：正文完成（${completedChapter.wordCount} 字），正在更新记忆`);
        const localMemory = buildLocalStructuredMemory(completedChapter, working);
        let memoryPatch: Partial<ChapterMemory> = localMemory;
        try {
          const memoryResult = await invoke<AgentMemoryResult>('call_agent_rpc', {
            method: 'memory.write',
            params: {
              projectTitle: working.title,
              chapterTitle: completedChapter.title,
              content: completedChapter.content,
              cards: [...autoCards, ...working.cards.filter(card => !autoCards.some(item => item.id === card.id))].slice(0, 10),
              apiKey: agentConfig.apiKey.trim(), apiKeys: agentConfig.apiKeys,
              baseURL: agentConfig.baseURL.trim() || defaultBaseURL,
              model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode,
              reasoningMode: agentConfig.reasoningMode, contextWindow: agentConfig.contextWindow,
              knowledgeGraph: { nodes: working.graphNodes, edges: working.graphEdges },
              ...agentNetworkParams(agentConfig),
            },
          });
          const listOrFallback = (value: unknown, fallback: string[], limit = 30) => {
            const values = asTextList(value, limit);
            return values.length ? values : fallback;
          };
          memoryPatch = {
            ...localMemory,
            summary: typeof memoryResult.summary === 'string' && memoryResult.summary.trim() ? memoryResult.summary.trim() : localMemory.summary,
            keywords: listOrFallback(memoryResult.keywords, localMemory.keywords, 8),
            characterStateChanges: listOrFallback(memoryResult.characterStateChanges, localMemory.characterStateChanges),
            knowledgeChanges: listOrFallback(memoryResult.knowledgeChanges, localMemory.knowledgeChanges),
            foreshadowingChanges: listOrFallback(memoryResult.foreshadowingChanges, localMemory.foreshadowingChanges),
            foreshadowingItems: Array.isArray(memoryResult.foreshadowingItems) ? memoryResult.foreshadowingItems : [],
            timelineEvents: listOrFallback(memoryResult.timelineEvents, localMemory.timelineEvents),
            canonFacts: listOrFallback(memoryResult.canonFacts, localMemory.canonFacts),
            conflicts: listOrFallback(memoryResult.conflicts, localMemory.conflicts),
            endingHook: typeof memoryResult.endingHook === 'string' && memoryResult.endingHook.trim() ? memoryResult.endingHook.trim() : localMemory.endingHook,
          };
        } catch {
          // Local extraction still persists a usable memory when the memory request is slow or unavailable.
        }
        const chapterAdded: Project = { ...working, chapters: [...working.chapters, completedChapter], outlines: [...working.outlines, outline], wordCount: working.wordCount + completedChapter.wordCount, updatedAt: new Date().toISOString() };
        const next = buildProjectWithChapterMemory(chapterAdded, completedChapter, memoryPatch);
        updateBatchItem({ status: 'complete', memory: memoryPatch.summary || localMemory.summary });
        working = next;
        projectSnapshot = projectSnapshot.map(item => item.id === next.id ? next : item);
        setProjects(projectSnapshot);
        if (editingProject?.id === next.id) setEditingProject(next);
        if ('__TAURI_INTERNALS__' in window) await invoke<string>('save_projects', { projects: projectSnapshot });
        else localStorage.setItem('projects', JSON.stringify(projectSnapshot));
      }
      setNotice({ title: '批量生成完成', content: `已连续生成 ${count} 章章纲和正文。` });
    } catch (error) {
      setBatchGenerationItems(current => current.map(item => item.status === 'outline' || item.status === 'writing' || item.status === 'memory' ? { ...item, status: 'error' } : item));
      setNotice({ title: '批量生成中断', content: `${String(error)}；已保留此前完成的章节。` });
    } finally {
      setBatchGenerationRunning(false);
      setBatchGenerationProgress('');
    }
  };

  const startNewCard = () => {
    setActiveCardId(null);
    setCardDraft({ type: '角色卡', title: '', content: '' });
  };

  const editCard = (card: KnowledgeCard) => {
    setActiveCardId(card.id);
    setCardDraft({ type: card.type, title: card.title, content: card.content });
  };

  const generateCardWithAI = async () => {
    if (!editingProject || cardGenerating) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写 API Key，再生成知识卡片。' });
      return;
    }
    setCardGenerating(true);
    const runId = `card-${Date.now()}`; cardRunRef.current = runId; setCardStreamContent('');
    setCardChatMessages(current => [...current, { role: 'user', content: cardAgentInstruction.trim(), createdAt: new Date().toISOString() }]);
    try {
      await invoke<string>('start_agent_runtime');
      const result = await invoke<{ title?: string; content?: string }>('call_agent_rpc', {
        method: 'card.write',
        params: {
          runId,
          sessionId: cardSessionId,
          previousSessionId: cardPreviousSessionId,
          projectTitle: editingProject.title,
          synopsis: editingProject.synopsis,
          cardType: cardDraft.type,
          cardTitle: cardDraft.title.trim(),
          existingContent: cardDraft.content,
          instruction: cardAgentInstruction.trim(),
          chapterTitle: activeChapter?.title,
          chapterContent: activeChapter?.content?.slice(-6000),
          outlines: editingProject.outlines.slice(-4).map(outline => ({ kind: outline.kind, content: outline.content })),
          cards: editingProject.cards.filter(card => card.id !== activeCardId).slice(-8),
          apiKey: agentConfig.apiKey.trim(),
          apiKeys: agentConfig.apiKeys,
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        },
      });
      if (!result.content?.trim()) throw new Error('智能体没有返回卡片内容');
      setCardDraft(current => ({
        ...current,
        title: result.title?.trim() || current.title || `${current.type}设定`,
        content: result.content.trim(),
      }));
      setCardChatMessages(current => [...current, { role: 'assistant', content: result.content?.trim() || '', createdAt: new Date().toISOString() }]);
      setNotice({ title: '卡片草稿已生成', content: '内容已填入左侧编辑器，请检查后点击“保存卡片”。' });
    } catch (error) {
      setNotice({ title: '卡片生成失败', content: String(error) });
    } finally {
      setCardGenerating(false);
    }
  };

  const saveCard = () => {
    if (!editingProject || !cardDraft.title.trim() || !cardDraft.content.trim()) {
      setNotice({ title: '卡片信息不完整', content: '请填写卡片名称和详细知识内容。' });
      return;
    }
    const now = new Date().toISOString();
    const card: KnowledgeCard = {
      id: activeCardId ?? Date.now(),
      type: cardDraft.type,
      title: cardDraft.title.trim(),
      content: cardDraft.content.trim(),
      currentState: activeCardId ? editingProject.cards.find(item => item.id === activeCardId)?.currentState : undefined,
      stateHistory: activeCardId ? editingProject.cards.find(item => item.id === activeCardId)?.stateHistory : undefined,
      createdAt: activeCardId ? (editingProject.cards.find(item => item.id === activeCardId)?.createdAt ?? now) : now,
      updatedAt: now,
    };
    updateEditorProject(project => ({
      ...project,
      cards: activeCardId ? project.cards.map(item => item.id === activeCardId ? card : item) : [...project.cards, card],
      graphNodes: project.graphNodes.some(node => node.id === `card:${card.id}`)
        ? project.graphNodes.map(node => node.id === `card:${card.id}` ? { ...node, label: card.title } : node)
        : [...project.graphNodes, { id: `card:${card.id}`, label: card.title, type: 'card' }],
      updatedAt: now,
    }));
    setActiveCardId(card.id);
    setNotice({ title: '卡片已保存', content: `${card.title} 已写入本地知识库。` });
  };

  const deleteCard = (id: number) => {
    if (!editingProject) return;
    updateEditorProject(project => ({
      ...project,
      cards: project.cards.filter(card => card.id !== id),
      graphNodes: project.graphNodes.filter(node => node.id !== `card:${id}`),
      graphEdges: project.graphEdges.filter(edge => edge.source !== `card:${id}` && edge.target !== `card:${id}`),
      updatedAt: new Date().toISOString(),
    }));
    setSelectedCardIds(current => current.filter(cardId => cardId !== id));
    if (activeCardId === id) startNewCard();
  };

  const toggleCardForChapter = (id: number) => {
    setSelectedCardIds(current => current.includes(id) ? current.filter(cardId => cardId !== id) : [...current, id]);
  };

  const runAIDetection = (scope: 'chapter' | 'book') => {
    if (!editingProject) return;
    if (scope === 'chapter' && !activeChapter) {
      setNotice({ title: '请选择章节', content: '选择章节后再运行当前章节 AI 检测。' });
      return;
    }
    setAIDetecting(true);
    const report = buildAIDetectionReport(editingProject, scope, activeChapter || undefined);
    updateEditorProject(project => ({ ...project, aiDetection: report, updatedAt: report.updatedAt }));
    setAIDetecting(false);
    setNotice({ title: 'AI 检测完成', content: `已分析 ${report.chapters.length} 个章节，预估 AI 率 ${report.averageAIRate}%。` });
  };

  const runChapterAgent = async () => {
    if (!editingProject || !activeChapter || agentRunning(agentStage)) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setAgentError('请先填写 API Saver Key');
      setAgentStage('error');
      return;
    }
    const runId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeAgentRunRef.current = runId;
    setAgentError('');
    setAgentDraft(null);
    setAgentDisplayContent('');
    agentStreamRawContentRef.current = '';
    setAgentStage('starting');
    setContextTrace([]);
    setAgentProgress(createAgentProgressItems().map((item, index) => index === 0
      ? { ...item, status: 'active', progress: 1, message: '正在启动 Agent Runtime' }
      : item));
    setAgentProgressPercent(1);
    setAgentProgressMessage('正在启动 Agent Runtime');
    let agentSkills = skills;
    if (!agentSkills.length) {
      try {
        const saved = JSON.parse(localStorage.getItem('writer-skills') || '[]');
        const customSkills = Array.isArray(saved) ? saved.filter((skill): skill is Skill => Boolean(skill && typeof skill.name === 'string' && !skill.builtin)) : [];
        agentSkills = [...builtinSkills, ...customSkills];
      } catch {
        agentSkills = builtinSkills;
      }
    }
    const prioritizedSkillNames = selectedAgentSkillNames.filter(name => agentSkills.some(skill => skill.name === name));
    const activeChapterIndex = editingProject.chapters.findIndex(chapter => chapter.id === activeChapter.id);
    const continuityChapter = activeChapterIndex > 0 ? editingProject.chapters[activeChapterIndex - 1] : null;
    const activeStyle = editingProject.styleProfileId ? writingStyles.find(style => style.id === editingProject.styleProfileId) : undefined;
    // 世界观与作品设定 is fixed canon and always available. 总纲 is never
    // exposed to the chapter writer, preventing future-plot leakage.
    const selectedChapterOutlines = editingProject.outlines.filter(outline => outline.kind === '章纲' && selectedOutlineIds.includes(outline.id));
    const currentChapterOutline = selectedChapterOutlines.find(outline => String(outline.chapterId ?? '') === String(activeChapter.id)) || selectedChapterOutlines[0];
    const selectedOutlines = editingProject.outlines.filter(outline => outline.kind === '世界观与作品设定' || selectedOutlineIds.includes(outline.id));
    const previousMemory = continuityChapter ? editingProject.memories.find(memory => memory.chapterId === continuityChapter.id) : undefined;
    const autoMatchedCards = rankCardsForChapter(editingProject, activeChapter, agentInstruction, selectedChapterOutlines.map(outline => outline.content).join('\n'), previousMemory);
    const resolvedCardIds = Array.from(new Set([...selectedCardIds, ...autoMatchedCards.map(card => card.id)]));
    const earlierMemorySummary = buildEarlierMemorySummary(editingProject, activeChapter, agentConfig.memorySummaryChapterCount);
    // Reflect automatic matches in the picker without making them mandatory.
    if (resolvedCardIds.some(id => !selectedCardIds.includes(id))) setSelectedCardIds(resolvedCardIds);
    try {
      await invoke<string>('start_agent_runtime');
      setAgentProgress(items => items.map(item => item.id === 'starting'
        ? { ...item, status: 'active', progress: Math.max(item.progress, 2), message: '运行环境已就绪，正在发送创作任务' }
        : item));
      setAgentProgressPercent(current => Math.max(current, 2));
      setAgentProgressMessage('运行环境已就绪，正在发送创作任务');
      const result = await invoke<AgentDraftResult>('call_agent_rpc', {
        method: 'chapter.write',
        params: {
          runId,
          sessionId: chapterSessionId,
          previousSessionId: chapterPreviousSessionId,
          projectId: String(editingProject.id),
          projectTitle: editingProject.title,
          chapterId: String(activeChapter.id),
          instruction: activeStyle ? `${agentInstruction}\n采用绑定文风 Skill「${activeStyle.name}」，只遵循抽象写作约束。` : agentInstruction,
          outlines: selectedOutlines.map(outline => ({ id: outline.id, kind: outline.kind, title: outline.title, chapterId: outline.chapterId, content: outline.content })),
          activeOutlineId: currentChapterOutline?.id,
          outline: selectedOutlineIds.includes(currentChapterOutline?.id ?? -1) ? currentChapterOutline?.content || '' : '',
          cards: editingProject.cards.filter(card => resolvedCardIds.includes(card.id)).sort((left, right) => left.id - right.id).slice(0, 10),
          knowledgeGraph: { nodes: editingProject.graphNodes, edges: editingProject.graphEdges },
          skills: [...agentSkills, ...(activeStyle ? [{ name: `style-${activeStyle.id}`, category: 'write', description: activeStyle.description, tags: [...activeStyle.tags, '文风'], content: activeStyle.content }] : [])]
            .map(skill => ({ name: skill.name, displayName: skill.displayName, category: skill.category, description: skill.description, tags: skill.tags, content: skill.content })),
          preferredSkillNames: prioritizedSkillNames,
          // 章节承接只传入紧邻上一章正文；更早章节合并成一个稳定摘要，避免正文膨胀。
          previousChapters: continuityChapter ? [{ id: continuityChapter.id, title: continuityChapter.title, content: continuityChapter.content }] : [],
          memories: (previousMemory ? [previousMemory] : []).map(memory => ({
            id: memory.id,
            title: memory.chapterTitle,
            summary: memory.summary,
            keywords: memory.keywords,
            characterStateChanges: memory.characterStateChanges,
            knowledgeChanges: memory.knowledgeChanges,
            foreshadowingChanges: memory.foreshadowingChanges,
            timelineEvents: memory.timelineEvents,
            canonFacts: memory.canonFacts,
            conflicts: memory.conflicts,
            endingHook: memory.endingHook,
          })),
          memoryDocuments: earlierMemorySummary ? [earlierMemorySummary] : [],
          apiKey: agentConfig.apiKey.trim(),
          apiKeys: agentConfig.apiKeys,
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || 'gpt-4o-mini',
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        },
      });
      // The completed RPC result is the source of truth. It must replace the
      // streaming buffer because JSON envelopes can be split across SSE frames.
      const draftContent = chapterDraftFromStream(result.draftContent || '');
      const normalizedResult = { ...result, draftContent };
      setAgentDraft(normalizedResult);
      setAgentDisplayContent(draftContent);
      agentStreamRawContentRef.current = '';
      // SSE chunks are already rendered by the shared stream listener. The
      // completed result is authoritative when the provider falls back to a
      // non-streaming response.
      if (agentTypewriterRef.current) {
        window.clearInterval(agentTypewriterRef.current);
        agentTypewriterRef.current = null;
      }
      await syncRuntimeUsage();
      setAgentStage('done');
      setAgentProgressPercent(100);
      setAgentProgressMessage('章节草稿和一致性审查已完成');
      setAgentProgress(items => items.map(item => ({ ...item, status: 'complete', progress: Math.max(item.progress, 100) })));
    } catch (error) {
      const message = String(error);
      setAgentError(message);
      setAgentStage('error');
      setAgentProgressMessage(message);
      setAgentProgress(items => {
        const activeIndex = Math.max(0, items.findIndex(item => item.status === 'active'));
        return items.map((item, index) => index === activeIndex ? { ...item, status: 'error', message } : item);
      });
    }
  };

  const acceptAgentDraft = () => {
    if (!agentDraft?.draftContent) return;
    if (editingProject && activeChapter) {
      const now = new Date().toISOString();
      const updatedChapter: Chapter = {
        ...activeChapter,
        content: agentDraft.draftContent,
        wordCount: countNovelCharacters(agentDraft.draftContent),
        updatedAt: now,
      };
      const selectedCards = editingProject.cards.filter(card => selectedCardIds.includes(card.id));
      const updatedWithMemory = buildProjectWithChapterMemory(editingProject, updatedChapter, {
        summary: agentDraft.summary || buildLocalChapterSummary(agentDraft.draftContent),
        keywords: selectedCards.map(card => card.title),
      });
      const updated = refreshCardStatesForProject(updatedWithMemory, new Set(updatedWithMemory.cards
        .filter(card => selectedCardIds.includes(card.id) || cardSearchTerms(card).some(term => updatedChapter.content.includes(term)))
        .map(card => card.id)));
      setEditingProject(updated);
      setActiveChapter(updatedChapter);
      setProjects(current => current.map(project => project.id === updated.id ? updated : project));
      window.setTimeout(() => chapterEditorRef.current?.focus(), 0);
    }
    setAgentDraft(null);
    setAgentDisplayContent('');
    setAgentStage('idle');
    setAgentProgress([]);
    setAgentProgressPercent(0);
    setAgentProgressMessage('');
    activeAgentRunRef.current = '';
  };

  const openSettings = () => {
    setSettingsDraft(agentConfig);
    setSettingsModels(availableModels);
    setCustomModelName('');
    setCustomApiKey('');
    setModelListMessage('');
    setSettingsServiceExpanded(true);
    setShowSettingsModal(true);
    setSettingsSection('model');
  };

  const openSupportLink = async (url: string, label: string, fallbackText: string) => {
    try {
      await invoke('open_external_url', { url });
    } catch {
      // Web preview and mobile builds do not expose the desktop opener.
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) window.location.href = url;
    }
    setNotice({ title: `正在打开${label}`, content: `${fallbackText} 已复制，正在跳转 QQ 官方页面。` });
  };

  const openQQGroup = async () => {
    const groupNumber = '1019592334';
    try { await navigator.clipboard.writeText(groupNumber); } catch { /* Clipboard permission is optional. */ }
    await openSupportLink('https://qm.qq.com/q/Oc3ZAaU08K', 'QQ 群', `QQ群号 ${groupNumber}`);
  };

  const openCustomerQQ = async () => {
    const customerQQ = '2805099052';
    try { await navigator.clipboard.writeText(customerQQ); } catch { /* Clipboard permission is optional. */ }
    await openSupportLink('https://qm.qq.com/q/BJKvbHWSK4', '客服 QQ', `客服 QQ ${customerQQ}`);
  };

  const openTutorial = async () => {
    const url = 'https://my.feishu.cn/wiki/UMTkwQAuEiIm3UkTNqrcAN3lnWb?from=from_copylink';
    try {
      await invoke('open_external_url', { url });
    } catch {
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) window.location.href = url;
    }
    setNotice({ title: '正在打开使用教程', content: '已在浏览器打开飞书使用教程。' });
  };

  const dismissSupportAnnouncement = (permanent = false) => {
    if (permanent) localStorage.setItem('apisaverwriter-support-announcement-seen', '1');
    setShowSupportAnnouncement(false);
  };

  const checkCloudSyncStatus = async () => {
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在检查百度网盘登录状态...');
    try {
      const result = await invoke<{ raw?: string; authenticated?: boolean; is_login?: boolean; logged_in?: boolean; username?: string }>('cloud_sync_status');
      const loggedIn = result.authenticated === true || result.is_login === true || result.logged_in === true || /已登录|logged.?in|success/iu.test(result.raw || '');
      setCloudSyncMessage(loggedIn
        ? `百度网盘已登录${result.username ? `：${result.username}` : ''}`
        : isDirectBaiduRuntime() ? '百度网盘当前未登录，请点击“登录百度网盘”完成授权。' : '百度网盘工具已安装，但当前未登录，请先完成百度网盘授权。');
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const beginBaiduLogin = async () => {
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在获取百度网盘授权链接...');
    try {
      const url = await invoke<string>('baidu_login_url');
      if (!/^https?:\/\//iu.test(url.trim())) throw new Error('百度网盘没有返回有效授权链接');
      setBaiduAuthURL(url.trim());
      setCloudSyncMessage(isDirectBaiduRuntime()
        ? '请复制链接到浏览器完成授权，再粘贴地址栏中的完整授权结果或 access_token。'
        : '请在浏览器完成授权，然后将页面显示的 32 位授权码粘贴到下方。');
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const confirmBaiduLogin = async () => {
    if (!baiduAuthCode.trim()) { setCloudSyncMessage(isDirectBaiduRuntime() ? '请先粘贴授权结果。' : '请先粘贴授权码。'); return; }
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在验证百度网盘授权...');
    try {
      await invoke('complete_baidu_login', { code: baiduAuthCode.trim() });
      setBaiduAuthCode('');
      setBaiduAuthURL('');
      setCloudSyncMessage('百度网盘登录成功，可以开始备份与恢复。');
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const backupToCloud = async () => {
    const remotePath = cloudRemotePath.trim();
    if (!remotePath) { setCloudSyncMessage('请填写云端备份目录。'); return; }
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在保存并核对全部本机数据...');
    try {
      const snapshot = editingProject ? projects.map(project => project.id === editingProject.id ? editingProject : project) : projects;
      await Promise.all([
        invoke<string>('save_projects', { projects: snapshot }),
        invoke<string>('save_library_books', { books: libraryBooks }),
        invoke<string>('save_ranking_books', { books: rankingBooks }),
        invoke<string>('save_dismantle_books', { books: dismantleBooks }),
        invoke<string>('save_writing_styles', { styles: writingStyles }),
      ]);
      const backupManifest = {
        schemaVersion: 2,
        createdAt: new Date().toISOString(),
        counts: {
          projects: snapshot.length,
          libraryBooks: libraryBooks.length,
          rankingBooks: rankingBooks.length,
          dismantleBooks: dismantleBooks.length,
          writingStyles: writingStyles.length,
          skills: skills.length,
          models: availableModels.length,
        },
        apiConfigured: Boolean(agentConfig.apiKey.trim() || agentConfig.apiKeys.some(key => key.trim())),
      };
      const clientState = Object.fromEntries([
        'agent-config', 'agent-models', 'agent-fetched-models', 'writer-skills', 'writer-runtime-usage',
        'writer-runtime-usage-days', 'writer-banned-words', 'cloud-remote-path',
      ].map(key => [key, localStorage.getItem(key)]));
      clientState['agent-config'] = JSON.stringify(agentConfig);
      clientState['agent-models'] = JSON.stringify(availableModels);
      clientState['writer-skills'] = JSON.stringify(skills);
      clientState.projects = JSON.stringify(snapshot);
      clientState['writer-library-books'] = JSON.stringify(libraryBooks);
      clientState['writer-ranking-books'] = JSON.stringify(rankingBooks);
      clientState['writer-dismantle-books'] = JSON.stringify(dismantleBooks);
      clientState['writer-writing-styles'] = JSON.stringify(writingStyles);
      clientState['cloud-remote-path'] = remotePath;
      clientState['backup-manifest'] = JSON.stringify(backupManifest);
      await invoke<{ message?: string; remotePath?: string }>('backup_projects_to_baidu', { remotePath, clientState });
      localStorage.setItem('cloud-remote-path', remotePath);
      setCloudSyncMessage(`完整备份完成：小说 ${snapshot.length}、书籍 ${libraryBooks.length}、拆书 ${dismantleBooks.length}、榜单 ${rankingBooks.length}、文风 ${writingStyles.length}。`);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const loadCloudBackups = async () => {
    const remotePath = cloudRemotePath.trim();
    if (!remotePath) { setCloudSyncMessage('请填写云端备份目录。'); return; }
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在读取百度网盘备份列表...');
    try {
      const result = await invoke<{ files?: CloudBackupFile[] }>('list_baidu_backups', { remotePath });
      const files = Array.isArray(result.files) ? result.files.filter(file => file && typeof file.path === 'string') : [];
      if (!files.length) {
        setCloudBackupFiles([]);
        setSelectedCloudBackup(null);
        setCloudSyncMessage('当前云端目录没有找到 .aswbackup 完整备份包。');
        return;
      }
      setCloudBackupFiles(files);
      setSelectedCloudBackup(null);
      setShowCloudBackupPicker(true);
      setCloudSyncMessage(`找到 ${files.length} 个完整备份包，请选择要恢复的版本。`);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const restoreFromCloud = async (selectedBackup?: CloudBackupFile) => {
    const remotePath = cloudRemotePath.trim();
    if (!remotePath) { setCloudSyncMessage('请填写云端备份目录。'); return; }
    if (!selectedBackup) { setCloudSyncMessage('请先选择要恢复的云端备份文件。'); return; }
    setShowCloudBackupPicker(false);
    setCloudSyncRunning(true);
    setCloudSyncMessage(`正在恢复备份：${selectedBackup.name}...`);
    try {
      const result = await invoke<{ clientState?: Record<string, string | null> }>('restore_projects_from_baidu', {
        remotePath,
        backupPath: selectedBackup.path,
        backupFsId: selectedBackup.fsId,
      });
      const restoredState = result.clientState || {};
      const parseState = (key: string): unknown => {
        try {
          const value = restoredState[key];
          return typeof value === 'string' ? JSON.parse(value) : null;
        } catch {
          return null;
        }
      };
      const restoreArray = async <T,>(key: string, command: string): Promise<T[] | null> => {
        const value = parseState(key);
        if (Array.isArray(value)) return value as T[];
        const stored = await invoke<T[] | null>(command);
        return Array.isArray(stored) ? stored : null;
      };
      const [restoredProjects, restoredLibrary, restoredRanking, restoredDismantle, restoredStyles] = await Promise.all([
        restoreArray<Project>('projects', 'load_projects'),
        restoreArray<LibraryBook>('writer-library-books', 'load_library_books'),
        restoreArray<RankingBook>('writer-ranking-books', 'load_ranking_books'),
        restoreArray<DismantleBook>('writer-dismantle-books', 'load_dismantle_books'),
        restoreArray<WritingStyle>('writer-writing-styles', 'load_writing_styles'),
      ]);
      const restoredConfigValue = parseState('agent-config');
      const restoredModelsValue = parseState('agent-models');
      const restoredSkillsValue = parseState('writer-skills');
      const restoredManifest = parseState('backup-manifest') as { counts?: Record<string, unknown> } | null;
      const restoredRankings = Array.isArray(restoredRanking) ? restoredRanking.map((book, index) => normalizeRankingBook({
        ...book,
        sourceName: book.sourceName || (book.platform === 'qidian' ? '起点中文网官网' : book.platform === 'faloo' ? '飞卢小说网官网' : '番茄小说网'),
      }, index)) : null;
      const actualCounts: Record<string, number> = {
        projects: restoredProjects?.length || 0,
        libraryBooks: restoredLibrary?.length || 0,
        rankingBooks: restoredRankings?.length || 0,
        dismantleBooks: restoredDismantle?.length || 0,
        writingStyles: restoredStyles?.length || 0,
      };
      if (restoredManifest?.counts) {
        for (const [key, count] of Object.entries(restoredManifest.counts)) {
          if (key in actualCounts && Number(count) > actualCounts[key]) {
            throw new Error(`备份完整性校验失败：${key} 应有 ${Number(count)} 条，实际只读取到 ${actualCounts[key]} 条。`);
          }
        }
      }
      const restoreTasks: Array<{ label: string; run: () => Promise<string> }> = [];
      if (Array.isArray(restoredProjects)) restoreTasks.push({ label: '小说、章节、大纲与记忆', run: () => invoke<string>('save_projects', { projects: restoredProjects }) });
      if (Array.isArray(restoredLibrary)) restoreTasks.push({ label: '书籍管理', run: () => invoke<string>('save_library_books', { books: restoredLibrary }) });
      if (Array.isArray(restoredRankings)) restoreTasks.push({ label: '扫榜数据', run: () => invoke<string>('save_ranking_books', { books: restoredRankings }) });
      if (Array.isArray(restoredDismantle)) restoreTasks.push({ label: '拆书数据', run: () => invoke<string>('save_dismantle_books', { books: restoredDismantle }) });
      if (Array.isArray(restoredStyles)) restoreTasks.push({ label: '文风数据', run: () => invoke<string>('save_writing_styles', { styles: restoredStyles }) });
      if (!restoreTasks.length) throw new Error('备份包中没有可恢复的小说、书籍、拆书、榜单或文风数据。');
      let restoredCount = 0;
      setCloudSyncMessage(`备份包已解析，正在并行恢复 ${restoreTasks.length} 类本机数据...`);
      await Promise.all(restoreTasks.map(async task => {
        await task.run();
        restoredCount += 1;
        setCloudSyncMessage(`已恢复 ${task.label}（${restoredCount}/${restoreTasks.length}），正在继续写入...`);
      }));
      // The data above now lives in the native app directory. Remove legacy
      // browser copies before persisting lightweight settings so iOS storage
      // quota cannot affect the next chapter save or model request.
      if ('__TAURI_INTERNALS__' in window) {
        deviceBackedStateKeys.forEach(key => localStorage.removeItem(key));
      } else {
        Object.entries(restoredState).forEach(([key, value]) => {
          if (deviceBackedStateKeys.has(key) || typeof value !== 'string') return;
          localStorage.setItem(key, value);
        });
      }
      const lightweightState = ['agent-config', 'agent-models', 'agent-fetched-models', 'writer-skills', 'writer-runtime-usage', 'writer-runtime-usage-days', 'writer-banned-words', 'cloud-remote-path'];
      lightweightState.forEach(key => {
        const value = restoredState[key];
        if (typeof value !== 'string') return;
        try { localStorage.setItem(key, value); } catch { /* Native project files remain intact if WebView settings quota is full. */ }
      });
      if (Array.isArray(restoredLibrary)) setLibraryBooks(restoredLibrary.map(book => normalizeLibraryBook(book)));
      if (Array.isArray(restoredRankings)) setRankingBooks(restoredRankings);
      if (Array.isArray(restoredDismantle)) setDismantleBooks(restoredDismantle.map(book => normalizeDismantleBook(book)));
      if (Array.isArray(restoredStyles)) setWritingStyles(restoredStyles.map(style => normalizeWritingStyle(style)));
      if (restoredConfigValue && typeof restoredConfigValue === 'object') {
        const restoredConfig = normalizeAgentConfig(restoredConfigValue);
        setAgentConfig(restoredConfig);
        setSettingsDraft(restoredConfig);
      }
      if (Array.isArray(restoredModelsValue)) {
        const restoredModels = restoredModelsValue.filter((model): model is string => typeof model === 'string' && Boolean(model.trim()));
        if (restoredModels.length) {
          setAvailableModels(restoredModels);
          setSettingsModels(restoredModels);
        }
      }
      if (Array.isArray(restoredSkillsValue)) {
        const restoredSkills = restoredSkillsValue.filter((skill): skill is Skill => Boolean(skill && typeof skill === 'object' && typeof (skill as Skill).name === 'string'));
        if (restoredSkills.length) setSkills(restoredSkills);
      }
      setCloudSyncMessage('本机数据写入完成，正在重新载入小说项目...');
      const restored = Array.isArray(restoredProjects)
        ? restoredProjects as Project[]
        : await invoke<Project[] | null>('load_projects');
      if (restored) {
        setProjects(restored);
        if (editingProject) setEditingProject(restored.find(project => project.id === editingProject.id) || null);
      }
      localStorage.setItem('cloud-remote-path', remotePath);
      setCloudSyncMessage(`完整恢复完成：小说 ${actualCounts.projects}、书籍 ${actualCounts.libraryBooks}、拆书 ${actualCounts.dismantleBooks}、榜单 ${actualCounts.rankingBooks}、文风 ${actualCounts.writingStyles}。正在重新载入...`);
      window.setTimeout(() => window.location.reload(), 1000);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const pullModels = async () => {
    const keys = Array.from(new Set([...(settingsDraft.apiKeys || []), settingsDraft.apiKey].map(key => key.trim()).filter(Boolean)));
    if (!keys.length) {
      setNotice({ title: '需要 API Key', content: '请先填写 API Key，再拉取模型列表。' });
      return;
    }
    setModelsLoading(true);
    try {
      await invoke<string>('start_agent_runtime');
      const responses = await Promise.allSettled(keys.map(async (apiKey) => ({ apiKey, result: await invoke<{ models?: string[] }>('call_agent_rpc', {
        method: 'models.list',
        params: { baseURL: defaultBaseURL, apiKey, apiKeys: [apiKey], apiMode: settingsDraft.apiMode, ...agentNetworkParams(settingsDraft) },
      }) })));
      const successful = responses.filter((response): response is PromiseFulfilledResult<{ apiKey: string; result: { models?: string[] } }> => response.status === 'fulfilled');
      const modelKeyMap = successful.reduce<Record<string, string[]>>((map, response) => {
        (Array.isArray(response.value.result.models) ? response.value.result.models : []).forEach(model => {
          if (typeof model !== 'string' || !model.trim()) return;
          map[model] = Array.from(new Set([...(map[model] || []), response.value.apiKey]));
        });
        return map;
      }, {});
      const models = Object.keys(modelKeyMap);
      if (models.length === 0) throw new Error('接口没有返回可用模型');
      setFetchedModels(models);
      localStorage.setItem('agent-fetched-models', JSON.stringify(models));
      setSettingsDraft(current => applyModelKeyRouting({ ...current, modelKeyMap: { ...current.modelKeyMap, ...modelKeyMap } }, current.model));
      const failed = responses.length - successful.length;
      setModelListMessage(`已从 ${successful.length}/${keys.length} 个 Key 获取 ${models.length} 个模型${failed ? `，${failed} 个 Key 请求失败` : ''}${settingsDraft.proxyEnabled ? `，请求已通过代理 ${settingsDraft.proxyURL}` : ''}，勾选模型即可启用。`);
    } catch (error) {
      setModelListMessage(`拉取模型失败：${String(error)}`);
    } finally {
      setModelsLoading(false);
    }
  };

  const testSelectedModel = async () => {
    if (!settingsDraft.apiKey.trim()) {
      setModelListMessage('请先填写 API 密钥，再测试模型。');
      return;
    }
    setModelsTesting(true);
    setModelListMessage('正在测试当前模型...');
    try {
      const selectedModel = settingsDraft.model.trim() || fallbackModels[0];
      const orderedKeys = orderApiKeysForModel(settingsDraft, selectedModel);
      await invoke<string>('start_agent_runtime');
      await invoke('call_agent_rpc', {
        method: 'models.test',
        params: {
          apiKey: orderedKeys[0] || settingsDraft.apiKey.trim(),
          apiKeys: orderedKeys,
          baseURL: defaultBaseURL,
          apiMode: settingsDraft.apiMode,
          model: selectedModel,
          reasoningMode: settingsDraft.reasoningMode,
          contextWindow: settingsDraft.contextWindow,
          ...agentNetworkParams(settingsDraft),
        },
      });
      setModelListMessage(`模型 ${settingsDraft.model || fallbackModels[0]} 测试成功${settingsDraft.proxyEnabled ? `，已通过代理 ${settingsDraft.proxyURL}` : ''}。`);
    } catch (error) {
      setModelListMessage(`模型测试失败：${String(error)}`);
    } finally {
      setModelsTesting(false);
    }
  };

  const useSystemProxy = async () => {
    try {
      const detected = await invoke<string | null>('detect_system_proxy');
      if (!detected) {
        setModelListMessage('没有检测到系统 HTTP/HTTPS 代理，请手动填写代理地址。');
        return;
      }
      setSettingsDraft(current => ({ ...current, proxyEnabled: true, proxyURL: detected }));
      setModelListMessage(`已读取系统代理 ${detected}，保存设置后生效。`);
    } catch (error) {
      setModelListMessage(`读取系统代理失败：${String(error)}`);
    }
  };

  const toggleSettingsModel = (model: string) => {
    setSettingsModels(current => {
      if (current.includes(model)) {
        if (current.length === 1) return current;
        const next = current.filter(item => item !== model);
        setSettingsDraft(draft => draft.model === model ? { ...draft, model: next[0] } : draft);
        return next;
      }
      return [...current, model];
    });
  };

  const setCurrentSettingsModel = (model: string) => {
    const normalized = model.trim();
    if (!normalized) return;
    setSettingsModels(current => current.includes(normalized) ? current : [...current, normalized]);
    setSettingsDraft(current => applyModelKeyRouting(current, normalized));
  };

  const addCustomModel = () => {
    const model = customModelName.trim();
    if (!model) return;
    setSettingsModels(current => Array.from(new Set([...current, model])));
    setSettingsDraft(current => ({ ...current, model: current.model || model }));
    setCustomModelName('');
  };

  const addSettingsModel = (model: string) => {
    const normalized = model.trim();
    if (!normalized) return;
    setSettingsModels(current => Array.from(new Set([...current, normalized])));
    setSettingsDraft(current => ({ ...current, model: current.model || normalized }));
  };

  const updatePrimaryApiKey = (apiKey: string) => {
    setSettingsDraft(current => {
      const keys = Array.from(new Set([
        apiKey.trim(),
        ...(current.apiKeys || []).slice(1).map(key => key.trim()),
      ].filter(Boolean)));
      return { ...current, apiKey: keys[0] || '', apiKeys: keys };
    });
  };

  const addApiKey = () => {
    const key = customApiKey.trim();
    if (!key) return;
    setSettingsDraft(current => {
      const keys = Array.from(new Set([...(current.apiKeys || []), key]));
      return { ...current, apiKey: current.apiKey.trim() || keys[0], apiKeys: keys };
    });
    setCustomApiKey('');
  };

  const removeApiKey = (index: number) => {
    setSettingsDraft(current => {
      const keys = Array.from(new Set((current.apiKeys || []).filter((_, itemIndex) => itemIndex !== index).map(key => key.trim()).filter(Boolean)));
      return { ...current, apiKey: keys[0] || '', apiKeys: keys };
    });
  };

  const saveSettings = () => {
    if (settingsDraft.proxyEnabled) {
      try {
        const proxyURL = new URL(settingsDraft.proxyURL.trim());
        if (!['http:', 'https:'].includes(proxyURL.protocol)) throw new Error('仅支持 HTTP/HTTPS 代理');
      } catch (error) {
        setModelListMessage(`代理地址无效：${error instanceof Error ? error.message : '请填写完整的 http:// 或 https:// 地址'}`);
        return;
      }
    }
    const enabledModels = Array.from(new Set((settingsModels.length ? settingsModels : [settingsDraft.model || fallbackModels[0]]).map(model => model.trim()).filter(Boolean)));
    const selectedModel = enabledModels.includes(settingsDraft.model) ? settingsDraft.model : enabledModels[0];
    const apiKeys = Array.from(new Set([settingsDraft.apiKey, ...(settingsDraft.apiKeys || [])].map(key => key.trim()).filter(Boolean)));
    setAvailableModels(enabledModels);
    localStorage.setItem('agent-models', JSON.stringify(enabledModels));
    setAgentConfig(applyModelKeyRouting({
      ...settingsDraft,
      serviceName: settingsDraft.serviceName.trim() || 'ApiSaver（省API）',
      apiMode: 'openai',
      baseURL: defaultBaseURL,
      apiKey: apiKeys[0] || '',
      apiKeys,
      model: selectedModel,
      contextWindow: Math.max(16, Number(settingsDraft.contextWindow) || 128),
    }, selectedModel));
    setAgentError('');
    setAgentStage('idle');
    setShowSettingsModal(false);
    setNotice({ title: '设置已保存', content: 'API 地址、模型和 Key 已保存到本机。' });
  };

  const chooseOutlineType = (kind: OutlineKind) => {
    handleCreateOutline(kind);
    setShowOutlineTypeModal(false);
  };

  const updateMemoryDocument = (id: string, content: string) => {
    updateEditorProject(project => ({
      ...project,
      memoryDocuments: project.memoryDocuments.map(document => document.id === id
        ? { ...document, content, manuallyEdited: true, updatedAt: new Date().toISOString() }
        : document),
      updatedAt: new Date().toISOString(),
    }));
  };

  const updateChapterMemory = (patch: Partial<ChapterMemory>) => {
    if (!editingProject || activeChapterMemoryId === null) return;
    const memories = editingProject.memories.map(memory => memory.id === activeChapterMemoryId
      ? normalizeChapterMemory({ ...memory, ...patch, updatedAt: new Date().toISOString() })
      : memory);
    updateEditorProject(project => ({
      ...project,
      memories,
      memoryDocuments: buildMemoryDocuments(memories, project.memoryDocuments),
      updatedAt: new Date().toISOString(),
    }));
  };

  const saveActiveChapterMemory = async () => {
    if (!editingProject || activeChapterMemoryId === null) return;
    const memories = editingProject.memories.map(memory => memory.id === activeChapterMemoryId
      ? { ...memory, updatedAt: new Date().toISOString() }
      : memory);
    const updatedProject = {
      ...editingProject,
      memories,
      memoryDocuments: buildMemoryDocuments(memories, editingProject.memoryDocuments),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = projects.map(item => item.id === updatedProject.id ? updatedProject : item);
    setEditingProject(updatedProject);
    setProjects(snapshot);
    try {
      if ('__TAURI_INTERNALS__' in window) {
        await invoke<string>('save_projects', { projects: snapshot });
      } else {
        localStorage.setItem('projects', JSON.stringify(snapshot));
      }
      setNotice({ title: '本章记忆已保存', content: '结构化章节快照和聚合记忆已写入本地。' });
    } catch (error) {
      setNotice({ title: '本章记忆保存失败', content: String(error) });
    }
  };

  const saveActiveMemoryDocument = async () => {
    if (!editingProject) return;
    const document = editingProject.memoryDocuments.find(item => item.id === activeMemoryDocumentId);
    if (!document) return;
    const updatedProject = {
      ...editingProject,
      memoryDocuments: editingProject.memoryDocuments.map(item => item.id === document.id
        ? { ...item, updatedAt: new Date().toISOString() }
        : item),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = projects.map(item => item.id === updatedProject.id ? updatedProject : item);
    setEditingProject(updatedProject);
    setProjects(snapshot);
    try {
      if ('__TAURI_INTERNALS__' in window) {
        await invoke<string>('save_projects', { projects: snapshot });
      } else {
        localStorage.setItem('projects', JSON.stringify(snapshot));
      }
      setNotice({ title: '记忆已保存', content: `《${document.title}》已写入本地记忆目录。` });
    } catch (error) {
      setNotice({ title: '记忆保存失败', content: String(error) });
    }
  };

  const rebuildMemoryDocuments = () => {
    if (!editingProject) return;
    const now = new Date().toISOString();
    const memories = editingProject.memories.map(memory => {
      const chapter = editingProject.chapters.find(item => item.id === memory.chapterId);
      if (!chapter?.content.trim()) return memory;
      const local = buildLocalStructuredMemory(chapter, editingProject);
      return normalizeChapterMemory({
        ...memory,
        characterStateChanges: memory.characterStateChanges.length ? memory.characterStateChanges : local.characterStateChanges,
        knowledgeChanges: memory.knowledgeChanges.length ? memory.knowledgeChanges : local.knowledgeChanges,
        foreshadowingChanges: memory.foreshadowingChanges.length ? memory.foreshadowingChanges : local.foreshadowingChanges,
        timelineEvents: memory.timelineEvents.length ? memory.timelineEvents : local.timelineEvents,
        canonFacts: memory.canonFacts.length ? memory.canonFacts : local.canonFacts,
        conflicts: memory.conflicts.length ? memory.conflicts : local.conflicts,
        endingHook: memory.endingHook || local.endingHook,
        updatedAt: now,
      }, chapter);
    });
    const updated = {
      ...editingProject,
      memories,
      memoryDocuments: buildMemoryDocuments(memories, editingProject.memoryDocuments, true)
        .map(document => ({ ...document, updatedAt: now })),
      updatedAt: now,
    };
    setEditingProject(updated);
    setProjects(current => current.map(project => project.id === updated.id ? updated : project));
    setNotice({ title: '记忆已重新整理', content: '已按正文回填空的认知、伏笔和冲突，并重建全部记忆文档。' });
  };

  const activeOutline = editingProject?.outlines.find(outline => outline.id === activeOutlineId) ?? null;
  const outlineIntentPreview = editingProject && activeOutline?.kind === '章纲'
    ? resolveOutlineGenerationIntent(editingProject, activeOutline, outlineAgentInstruction)
    : null;
  const activeCard = editingProject?.cards.find(card => card.id === activeCardId) ?? null;
  const activeWritingStyle = editingProject?.styleProfileId ? writingStyles.find(style => style.id === editingProject.styleProfileId) ?? null : null;
  const activeMemoryDocument = editingProject?.memoryDocuments.find(document => document.id === activeMemoryDocumentId) ?? null;
  const activeChapterMemory = editingProject?.memories.find(memory => memory.id === activeChapterMemoryId) ?? null;
  const activeGraphNode = editingProject?.graphNodes.find(node => node.id === activeGraphNodeId) ?? null;
  const focusedGraphRelationIds = new Set(editingProject && activeGraphNodeId
    ? editingProject.graphEdges
      .filter(edge => edge.source === activeGraphNodeId || edge.target === activeGraphNodeId)
      .map(edge => edge.id)
    : []);
  const focusedGraphNodeIds = new Set(editingProject && activeGraphNodeId
    ? [
      activeGraphNodeId,
      ...editingProject.graphEdges
        .filter(edge => edge.source === activeGraphNodeId || edge.target === activeGraphNodeId)
        .map(edge => edge.source === activeGraphNodeId ? edge.target : edge.source),
    ]
    : []);
  const graphDocumentGroups = editingProject ? Array.from(new Set(editingProject.graphNodes.map(graphNodeGroup))) : [];
  const activeGraphDocumentGroup = graphDocumentGroups.includes(graphDocumentGroup) ? graphDocumentGroup : (graphDocumentGroups[0] || '');
  const graphDocumentTypeOptions = editingProject ? Array.from(new Set(editingProject.graphNodes.map(graphNodeTypeLabel))).sort((left, right) => left.localeCompare(right, 'zh-CN')) : [];
  const graphDocumentNodes = editingProject ? editingProject.graphNodes.filter(node => {
    const matchesGroup = !activeGraphDocumentGroup || graphNodeGroup(node) === activeGraphDocumentGroup;
    const matchesType = graphDocumentType === '全部类型' || graphNodeTypeLabel(node) === graphDocumentType;
    const searchText = `${node.label}\n${graphNodeRelativePath(node)}\n${graphNodeProfile(node)}`.toLowerCase();
    const matchesQuery = !graphDocumentQuery.trim() || searchText.includes(graphDocumentQuery.trim().toLowerCase());
    const relationCount = editingProject.graphEdges.filter(edge => edge.source === node.id || edge.target === node.id).length;
    return matchesGroup && matchesType && matchesQuery && (!graphOnlyIsolated || relationCount === 0);
  }).sort((left, right) => {
    const relationStrength = (node: KnowledgeGraphNode) => editingProject.graphEdges
      .filter(edge => edge.source === node.id || edge.target === node.id)
      .reduce((sum, edge) => sum + normalizeKnowledgeGraphWeight(edge.weight, edge.label), 0);
    const relationDifference = relationStrength(right) - relationStrength(left);
    return relationDifference || left.label.localeCompare(right.label, 'zh-CN');
  }) : [];
  const visibleCards = editingProject?.cards.filter(card => cardTypeFilter === '全部' || card.type === cardTypeFilter) ?? [];
  const characterNames = editingProject ? Array.from(new Set([
    ...(editingProject.protagonist1 || '').split(/[、,，/\s]+/u),
    ...(editingProject.protagonist2 || '').split(/[、,，/\s]+/u),
    ...editingProject.cards.filter(card => card.type === '角色卡').map(card => card.title),
  ].map(item => item.trim()).filter(item => item.length > 1))) : [];
  const markTerms = Array.from(new Set([...characterNames, ...bannedWords].filter(Boolean))).sort((left, right) => right.length - left.length);
  const activeAIDetection = editingProject?.aiDetection?.chapters.find(item => item.chapterId === activeChapter?.id);
  const renderMarkedContent = (content: string) => {
    if (!content) return '\u200b';
    const hasDetectionSegments = Boolean(activeAIDetection?.segments?.length);
    const detectionSegments = hasDetectionSegments ? activeAIDetection!.segments : [{ order: 1, text: content, confidence: 0, label: '人工' as AIDetectionLabel }];
    return detectionSegments.map((segment, segmentIndex) => {
      const detectionClass = hasDetectionSegments ? `ai-detection-mark ${segment.label === '人工' ? 'human' : segment.label === '疑似 AI' ? 'suspected' : 'ai'}` : '';
      if (!writingMarksEnabled || !markTerms.length) return <span key={`detection-${segmentIndex}`} className={detectionClass}>{segment.text}</span>;
      const pattern = new RegExp(`(${markTerms.map(escapeRegExp).join('|')})`, 'gu');
      return <span key={`detection-${segmentIndex}`} className={detectionClass}>{segment.text.split(pattern).map((part, partIndex) => {
        if (!part) return null;
        const isBanned = bannedWords.includes(part);
        const isCharacter = characterNames.includes(part);
        const classes = [isBanned ? 'banned-word-mark' : '', !isBanned && isCharacter ? 'character-mark' : '', segment.label === 'AI 特征' ? 'ai-detection-emphasis' : ''].filter(Boolean).join(' ');
        return classes ? <mark key={`${part}-${partIndex}`} className={classes}>{part}</mark> : <span key={`${part}-${partIndex}`}>{part}</span>;
      })}</span>;
    });
  };
  const currentSearchMatches = activeChapter && searchQuery ? countOccurrences(activeChapter.content, searchQuery) : 0;
  const bookSearchResults = editingProject && searchScope === 'book' && searchQuery.trim()
    ? editingProject.chapters.flatMap(chapter => {
      const matches = findTextMatches(chapter.content, searchQuery);
      const titleMatches = countOccurrences(chapter.title, searchQuery);
      if (!matches.length && !titleMatches) return [];
      return [{ chapter, count: matches.length + titleMatches, matches, snippets: matches.slice(0, 3).map(position => ({ position, text: searchSnippet(chapter.content, position, searchQuery) })) }];
    })
    : [];
  const bookSearchMatches = bookSearchResults.flatMap(result => result.matches.map(position => ({ chapter: result.chapter, position })));
  const focusBookSearchMatch = (index: number) => {
    const target = bookSearchMatches[(index + bookSearchMatches.length) % bookSearchMatches.length];
    if (!target) return;
    const targetIndex = bookSearchMatches.indexOf(target);
    setBookSearchMatchIndex(targetIndex);
    setEditorSidebarTab('chapters');
    setActiveChapter(target.chapter);
    setSearchMatchIndex(findTextMatches(target.chapter.content, searchQuery).indexOf(target.position));
    window.setTimeout(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(target.position, target.position + searchQuery.length);
    }, 0);
  };

  const openBookSearchChapter = (chapter: Chapter, position?: number) => {
    setEditorSidebarTab('chapters');
    setActiveChapter(chapter);
    if (position === undefined) return;
    setSearchMatchIndex(findTextMatches(chapter.content, searchQuery).indexOf(position));
    window.setTimeout(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(position, position + searchQuery.length);
    }, 0);
  };
  const graphLayout = (() => {
    const nodes = editingProject?.graphNodes ?? [];
    const edges = editingProject?.graphEdges ?? [];
    if (!nodes.length) return [];
    const positions = nodes.map((node, index) => {
      const angle = index * 2.399963229728653;
      const radius = 0.18 + 0.27 * Math.sqrt(index / Math.max(nodes.length - 1, 1));
      return { id: node.id, x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius };
    });
    const byId = new Map(positions.map(position => [position.id, position]));
    for (let iteration = 0; iteration < 65; iteration += 1) {
      for (let left = 0; left < positions.length; left += 1) {
        for (let right = left + 1; right < positions.length; right += 1) {
          const first = positions[left]; const second = positions[right];
          const dx = first.x - second.x; const dy = first.y - second.y;
          const distance = Math.max(0.025, Math.hypot(dx, dy));
          const force = Math.min(0.018, 0.0019 / (distance * distance));
          first.x += dx / distance * force; first.y += dy / distance * force;
          second.x -= dx / distance * force; second.y -= dy / distance * force;
        }
      }
      for (const edge of edges) {
        const source = byId.get(edge.source); const target = byId.get(edge.target);
        if (!source || !target) continue;
        const dx = target.x - source.x; const dy = target.y - source.y;
        const distance = Math.max(0.025, Math.hypot(dx, dy));
        const weight = normalizeKnowledgeGraphWeight(edge.weight, edge.label);
        const preferredDistance = 0.27 - weight * 0.11;
        const force = (distance - preferredDistance) * (0.018 + weight * 0.035);
        source.x += dx / distance * force; source.y += dy / distance * force;
        target.x -= dx / distance * force; target.y -= dy / distance * force;
      }
      positions.forEach(position => {
        position.x = Math.max(0.05, Math.min(0.95, position.x + (0.5 - position.x) * 0.004));
        position.y = Math.max(0.07, Math.min(0.93, position.y + (0.5 - position.y) * 0.004));
      });
    }
    return positions.map(position => ({
      ...position,
      x: 5 + position.x * 90,
      y: 6 + position.y * 88,
      degree: edges.filter(edge => edge.source === position.id || edge.target === position.id).length,
    }));
  })();
  const visibleSkills = skills.filter(skill => {
    const matchesCategory = !skillCategoryFilter || skill.category === skillCategoryFilter;
    const query = skillSearch.trim().toLowerCase();
    return matchesCategory && (!query || `${skill.displayName || ''} ${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase().includes(query));
  });
  const activeDismantleBook = dismantleBooks.find(book => book.id === activeDismantleBookId) || null;
  const activeDismantleChapter = activeDismantleBook?.chapters.find(chapter => chapter.id === activeDismantleChapterId) || null;
  const activeLibraryBook = libraryBooks.find(book => book.id === activeLibraryBookId) || null;
  const activeLibraryChapter = activeLibraryBook?.chapters.find(chapter => chapter.id === activeLibraryChapterId) || activeLibraryBook?.chapters[0] || null;
  const visibleRankingBooks = rankingQuery.trim()
    ? rankingBooks.filter(book => `${book.title} ${book.author} ${book.intro} ${book.category || ''}`.toLowerCase().includes(rankingQuery.trim().toLowerCase()))
    : rankingBooks;
  const rankingSourceName = rankingBooks[0]?.sourceName || '';
  const outlineMode = editingProject !== null && editorSidebarTab === 'outline';
  const cardMode = editingProject !== null && editorSidebarTab === 'cards';
  const styleMode = editingProject !== null && editorSidebarTab === 'style';
  const localToday = (() => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; })();
  const usageRows = usageDays.filter(day => {
    if (usageStartDate || usageEndDate) return (!usageStartDate || day.date >= usageStartDate) && (!usageEndDate || day.date <= usageEndDate);
    if (usageDateFilter === 'all') return true;
    if (usageDateFilter === 'today') return day.date === localToday;
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - Number(usageDateFilter) + 1);
    return new Date(`${day.date}T00:00:00`).getTime() >= from.getTime();
  });
  const emptyUsage: RuntimeUsageSummary = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, startedAt: '' };
  const usageView = (usageStartDate || usageEndDate || usageDateFilter !== 'all') ? usageRows.reduce((total, day) => ({ ...total, inputTokens: total.inputTokens + day.inputTokens, outputTokens: total.outputTokens + day.outputTokens, totalTokens: total.totalTokens + day.totalTokens, cachedInputTokens: total.cachedInputTokens + day.cachedInputTokens, cacheWriteTokens: total.cacheWriteTokens + day.cacheWriteTokens, reasoningTokens: total.reasoningTokens + day.reasoningTokens, requests: total.requests + day.requests }), emptyUsage) : runtimeUsage;
  const gatewayLogTime = (log: Record<string, unknown>) => {
    const value = Number(log.created_at || 0);
    return value > 10_000_000_000 ? value : value * 1000;
  };
  const gatewayLogs = (gatewayUsage?.accounts || []).flatMap(account => account.logs.map(log => ({ ...log, __keyHint: account.keyHint, __keyIndex: account.keyIndex }))).filter(log => {
    const timestamp = gatewayLogTime(log);
    if (!timestamp) return true;
    const date = new Date(timestamp);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (usageStartDate || usageEndDate) return (!usageStartDate || key >= usageStartDate) && (!usageEndDate || key <= usageEndDate);
    if (usageDateFilter === 'all') return true;
    if (usageDateFilter === 'today') return key === localToday;
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - Number(usageDateFilter) + 1);
    return timestamp >= from.getTime();
  }).sort((left, right) => gatewayLogTime(right) - gatewayLogTime(left));
  const enabledGatewayModels = new Set([settingsDraft.model, ...settingsModels].filter(Boolean));
  const gatewayPricing = (gatewayUsage?.accounts || []).flatMap(account => (account.pricing || [])
    .filter(item => enabledGatewayModels.size === 0 || enabledGatewayModels.has(String(item.model_name || '')))
    .flatMap(item => {
      const configuredRatio = account.group && account.groupRatios?.[account.group];
      if (Number.isFinite(Number(configuredRatio))) {
        return [{ ...item, __account: account, __group: account.group, __groupRatio: Number(configuredRatio), __groupKnown: true } as GatewayPricingEntry];
      }
      // New API's read-only usage endpoint does not expose Token.Group. Do not
      // silently price an unknown key at 1x: show each usable group instead.
      const enabledGroups = Array.isArray(item.enable_groups) ? item.enable_groups.map(String) : [];
      const groups = enabledGroups.filter(group => !account.usableGroups || Object.prototype.hasOwnProperty.call(account.usableGroups, group));
      return groups.map(group => ({ ...item, __account: account, __group: group, __groupRatio: Number(account.groupRatios?.[group]), __groupKnown: false } as GatewayPricingEntry))
        .filter(entry => Number.isFinite(entry.__groupRatio));
    }));
  const gatewayQuotaPerUnit = Number(gatewayUsage?.status?.quota_per_unit || 500000);
  const gatewayCurrency = String(gatewayUsage?.status?.quota_display_type || 'CNY');
  const gatewayExchangeRate = Number(gatewayUsage?.status?.usd_exchange_rate || 1);
  const gatewayCurrencySymbol = gatewayCurrency === 'CNY' ? '¥' : gatewayCurrency === 'USD' ? '$' : String(gatewayUsage?.status?.custom_currency_symbol || gatewayCurrency);
  const formatGatewayCurrency = (usd: number, suffix = '') => `${gatewayCurrencySymbol}${Number((usd * (gatewayCurrency === 'USD' ? 1 : gatewayExchangeRate)).toFixed(6)).toLocaleString('zh-CN', { maximumFractionDigits: 6 })}${suffix}`;
  const formatGatewayPrice = (usd: number) => `${formatGatewayCurrency(usd)} / 1M tokens`;
  const parseDynamicTiers = (expression: string) => Array.from(expression.matchAll(/tier\(\s*["']([^"']+)["']\s*,\s*([^)]*)\)/gu)).map(match => ({ label: match[1], formula: match[2] }));
  const dynamicTierPrice = (formula: string, name: string, groupRatio: number) => {
    const variable = name === '输入' ? 'p' : name === '输出' ? 'c' : name === '缓存读取' ? 'cr' : 'cw';
    const pattern = new RegExp(`(?:^|[+\\s])${variable}\\s*\\*\\s*([\\d.]+)`, 'u');
    const multiplier = Number(formula.match(pattern)?.[1] || 0);
    return multiplier > 0 ? formatGatewayPrice(multiplier * groupRatio) : '-';
  };
  const staticGatewayPrice = (item: Record<string, unknown>, type: 'input' | 'output' | 'cache' | 'write', groupRatio: number) => {
    if (Number(item.quota_type) === 1) return type === 'input' ? `${formatGatewayCurrency(Number(item.model_price || 0) * groupRatio)} / 次` : '-';
    // This is New API's published model-square formula for non-tiered
    // token models. Dynamic expressions and pay-per-request models bypass it.
    const input = Number(item.model_ratio || 0) * 2 * groupRatio;
    const multiplier = type === 'output' ? Number(item.completion_ratio || 1) : type === 'cache' ? Number(item.cache_ratio ?? 1) : type === 'write' ? Number(item.create_cache_ratio ?? 1) : 1;
    return Number.isFinite(input) && input > 0 ? formatGatewayPrice(input * multiplier) : '-';
  };
  const gatewayInputPrice = (item: GatewayPricingEntry) => {
    const groupRatio = Number(item.__groupRatio);
    if (String(item.billing_mode || '') === 'tiered_expr') {
      const tier = parseDynamicTiers(String(item.billing_expr || ''))[0];
      return Number(tier?.formula.match(/(?:^|[+\s])p\s*\*\s*([\d.]+)/u)?.[1] || Number.POSITIVE_INFINITY) * groupRatio;
    }
    return Number(item.quota_type) === 1 ? Number(item.model_price || Number.POSITIVE_INFINITY) * groupRatio : Number(item.model_ratio || Number.POSITIVE_INFINITY) * 2 * groupRatio;
  };
  gatewayPricing.sort((left, right) => gatewayInputPrice(left) - gatewayInputPrice(right));

  return (
    <div className="app">
      {editingProject ? (
        <div className="editor-view">
          <header className="editor-header">
            <button className="btn-back" onClick={handleCloseEditor}>← 返回</button>
            <h2>{editingProject.title}</h2>
            {!outlineMode && !cardMode && !styleMode && editorSidebarTab !== 'search' && <>
              <button className="editor-tool-button" title="搜索当前章节" onClick={() => { setShowSearchPanel(true); setSearchScope('chapter'); window.setTimeout(() => searchInputRef.current?.focus(), 0); }}>搜索</button>
              <button className={`editor-tool-button ${writingMarksEnabled ? 'active' : ''}`} title="人物名称与禁词标记" onClick={() => setWritingMarksEnabled(current => !current)}>标记</button>
              <button className="editor-tool-button" title="编辑禁词列表" onClick={() => { setBannedWordsDraft(bannedWords.join('\n')); setShowBannedWords(true); }}>禁词</button>
              <button className="btn-primary editor-save-button" disabled={!activeChapter || chapterSaving} onClick={persistCurrentChapter}>{chapterSaving ? '保存中...' : '保存章节'}</button>
              <div className="editor-stats">
                <span>{autoSaveStatus === 'saving' ? '自动保存中' : autoSaveStatus === 'saved' ? '已自动保存' : autoSaveStatus === 'error' ? '保存失败' : '本地写作'}</span>
                <span>{editingProject.chapters.length} 章</span>
              </div>
            </>}
            {outlineMode && <span className="editor-mode-label">大纲编辑</span>}
            {cardMode && <span className="editor-mode-label">卡片编辑</span>}
            {styleMode && <span className="editor-mode-label">作品文风</span>}
          </header>

          {notice && (
            <div className="editor-notice" role="status" aria-live="polite">
              <div className="editor-notice-copy">
                <strong>{notice.title}</strong>
                <span>{notice.content}</span>
              </div>
              <button className="editor-notice-close" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
            </div>
          )}

          {showBannedWords && (
            <div className="editor-popover" role="dialog" aria-modal="true" aria-label="自定义禁词列表">
              <div className="editor-popover-header"><strong>禁词提示</strong><button className="icon-delete" title="关闭" onClick={() => setShowBannedWords(false)}>×</button></div>
              <p>每行一个，或用逗号分隔。写作时会以红色波浪线标记。</p>
              <textarea value={bannedWordsDraft} onChange={event => setBannedWordsDraft(event.target.value)} placeholder="输入需要提示的禁词" />
              <div><button className="btn-secondary" onClick={() => setShowBannedWords(false)}>取消</button><button className="btn-primary" onClick={saveBannedWords}>保存列表</button></div>
            </div>
          )}

          <div className="editor-body">
            <aside className="editor-sidebar">
              <div className="editor-sidebar-tabs">
                <button
                  className={editorSidebarTab === 'chapters' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('chapters')}
                >
                  章节
                </button>
                <button
                  className={editorSidebarTab === 'search' ? 'active' : ''}
                  onClick={openProjectSearch}
                >
                  剧情搜索
                </button>
                <button
                  className={editorSidebarTab === 'outline' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('outline')}
                >
                  大纲
                </button>
                <button
                  className={editorSidebarTab === 'knowledge-graph' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('knowledge-graph')}
                >
                  知识图谱 <small>{editingProject.graphEdges.length}</small>
                </button>
                <button
                  className={editorSidebarTab === 'cards' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('cards')}
                >
                  卡片
                </button>
                <button
                  className={editorSidebarTab === 'style' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('style')}
                >
                  文风
                </button>
                <button
                  className={editorSidebarTab === 'knowledge' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('knowledge')}
                >
                  记忆中心
                </button>
                <button
                  className={editorSidebarTab === 'ai-detect' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('ai-detect')}
                >
                  AI 检测
                </button>
              </div>
              <div className="batch-generation-sidebar-entry">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    setBatchGenerationCount('3');
                    setBatchGenerationProjectId(editingProject.id);
                    setShowBatchGenerationModal(true);
                  }}
                >
                  一键生成章节
                </button>
              </div>

              {editorSidebarTab === 'ai-detect' && (() => {
                const report = editingProject.aiDetection;
                const currentDetection = report?.chapters.find(item => item.chapterId === activeChapter?.id);
                const segmentCounts = (currentDetection?.segments || []).reduce<Record<AIDetectionLabel, number>>((counts, segment) => ({ ...counts, [segment.label]: counts[segment.label] + 1 }), { '人工': 0, '疑似 AI': 0, 'AI 特征': 0 });
                return <div className="ai-detection-panel">
                  <div className="panel-section-title">AI 内容检测 <span>{report?.provider || '本地初筛'}</span></div>
                  <p className="ai-detection-hint">检测会把正文分段标为人工、疑似 AI、AI 特征，并同步显示在编辑器中。结果用于本地写作自检，建议结合人物口吻、具体细节和情节逻辑进行判断。</p>
                  <div className="ai-detection-actions"><button className="btn-secondary" disabled={aiDetecting || !activeChapter} onClick={() => runAIDetection('chapter')}>{aiDetecting ? '检测中...' : '检测当前章'}</button><button className="btn-primary" disabled={aiDetecting} onClick={() => runAIDetection('book')}>检测全书</button></div>
                  {report ? <>
                    <div className="ai-detection-summary"><strong>{report.averageAIRate}%</strong><span>预估 AI 率 · {report.level}</span><small>{report.suggestion}</small></div>
                    <div className="ai-detection-metrics"><span>句子均匀度 {report.chapters.length === 1 ? `${report.chapters[0].sentenceUniformity}%` : '按章节查看'}</span><span>口语化 {report.chapters.length === 1 ? `${report.chapters[0].colloquialFrequency}/百字` : '按章节查看'}</span><span>逻辑词 {report.chapters.length === 1 ? `${report.chapters[0].logicFrequency}/百字` : '按章节查看'}</span></div>
                    {currentDetection && <section className="ai-detection-segments"><div className="ai-detection-legend"><span className="human">人工 {segmentCounts['人工']}</span><span className="suspected">疑似 AI {segmentCounts['疑似 AI']}</span><span className="ai">AI 特征 {segmentCounts['AI 特征']}</span></div><div className="ai-detection-segment-list">{currentDetection.segments?.length ? currentDetection.segments.map(segment => <div className={`ai-detection-segment ${segment.label === '人工' ? 'human' : segment.label === '疑似 AI' ? 'suspected' : 'ai'}`} key={segment.order}><div><strong>{segment.label}</strong><small>第 {segment.order} 段 · 置信度 {(segment.confidence * 100).toFixed(1)}%</small></div><p>{segment.text.trim()}</p></div>) : <p className="empty-hint compact">旧检测记录没有分段结果，请重新检测当前章节。</p>}</div></section>}
                    <div className="ai-detection-list">{report.chapters.map(item => <button type="button" className="ai-detection-item" key={item.chapterId} onClick={() => { const target = editingProject.chapters.find(chapter => chapter.id === item.chapterId); if (target) setActiveChapter(target); }}><div><strong>{item.chapterTitle}</strong><small>{item.wordCount} 字 · {item.label || '待重新检测'} · 句子均匀度 {item.sentenceUniformity}%</small></div><b className={item.aiRate >= 60 ? 'high' : item.aiRate >= 45 ? 'medium' : 'low'}>{item.aiRate}%</b></button>)}</div>
                    <small className="ai-detection-updated">更新于 {new Date(report.updatedAt).toLocaleString()}</small>
                  </> : <p className="empty-hint compact">尚未检测，选择当前章或全书开始分析。</p>}
                </div>;
              })()}

              {editorSidebarTab === 'chapters' && (
                <div className="chapters-panel">
                  <div className="project-writing-stats">
                    <strong>{editingProject.wordCount.toLocaleString()} <small>总字数</small></strong>
                    <span>{editingProject.chapters.length} 章</span>
                  </div>
                  <div className="chapter-target-row">
                    <label htmlFor="chapter-target-words">本章目标</label>
                    <input id="chapter-target-words" className="input" type="number" min="200" step="100" value={chapterTargetWordsDraft} onChange={event => setChapterTargetWordsDraft(event.target.value)} onBlur={updateChapterTargetWords} />
                    <span>字</span>
                  </div>
                  <button className="btn-add-chapter" onClick={handleAddChapter}>+ 新建章节</button>
                  <div className="chapters-list">
                    {editingProject.chapters.map(chapter => (
                      <div
                        key={chapter.id}
                        className={`chapter-item ${activeChapter?.id === chapter.id ? 'active' : ''}`}
                        onClick={() => { setActiveChapter(chapter); setSelectionSnapshot(null); setSearchMatchIndex(0); goalNoticeChapterRef.current = null; }}
                      >
                        <div className="chapter-copy">
                          <div className="chapter-title">{chapter.title}</div>
                          <div className="chapter-meta">{chapter.wordCount} 字</div>
                        </div>
                        <button
                          className="chapter-location-button"
                          title="打开章节文件所在位置"
                          aria-label={`打开${chapter.title}文件所在位置`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleOpenChapterLocation(chapter);
                          }}
                        >打开位置</button>
                        <button
                          className="chapter-delete-button"
                          title={`删除${chapter.title}`}
                          aria-label={`删除${chapter.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setChapterPendingDeletion(chapter);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {editorSidebarTab === 'outline' && (
                <div className="outline-panel">
                  <div className="panel-toolbar outline-toolbar">
                    <button className="btn-add-chapter" onClick={() => setShowOutlineTypeModal(true)}>+ 新建大纲</button>
                    <button className="outline-location-button" onClick={handleOpenOutlineLocation}>打开位置</button>
                  </div>
                  <div className="outline-document-list">
                    {editingProject.outlines.map(outline => (
                      <div key={outline.id} className={`outline-document-item ${activeOutlineId === outline.id ? 'active' : ''}`} onClick={() => setActiveOutlineId(outline.id)}>
                        <div><strong>{outline.kind}</strong><small>{outline.title}{outline.kind === '章纲' && outline.chapterId ? ` · ${editingProject.chapters.find(chapter => chapter.id === outline.chapterId)?.title || '未关联章节'}` : ''}</small></div>
                        <button className="icon-delete" title="删除大纲" onClick={(event) => { event.stopPropagation(); handleDeleteOutline(outline.id); }}>×</button>
                      </div>
                    ))}
                  </div>
                  {activeOutline ? (
                    <p className="outline-editor-hint">选择大纲后，在中央编辑器顶部修改标题和正文。</p>
                  ) : <p className="empty-hint">点击“新建大纲”，再选择总纲、章纲或设定文档</p>}
                </div>
              )}

              {editorSidebarTab === 'cards' && (
                <div className="cards-panel">
                  <div className="panel-toolbar">
                    <select className="select" value={cardTypeFilter} onChange={(event) => setCardTypeFilter(event.target.value as CardType | '全部')}>
                      <option value="全部">全部卡片</option>
                      <option value="角色卡">角色卡</option>
                      <option value="物品卡">物品卡</option>
                      <option value="地点卡">地点卡</option>
                      <option value="势力卡">势力卡</option>
                      <option value="金手指卡">金手指卡</option>
                    </select>
                    <button className="btn-add-chapter" onClick={startNewCard}>+ 新建</button>
                    <button className="btn-secondary" onClick={() => updateCardStatesFromBook()}>一键更新状态</button>
                  </div>
                  <div className="card-list">
                    {visibleCards.map(card => (
                      <div key={card.id} className={`knowledge-card-item ${activeCardId === card.id ? 'active' : ''}`} onClick={() => editCard(card)}>
                        <div><strong>{card.title}</strong><small>{card.type} · {card.currentState ? card.currentState.slice(0, 80) : '状态未更新'}</small></div>
                        <button className="chapter-location-button" title="打开卡片文件所在位置" aria-label={`打开${card.title}文件所在位置`} onClick={(event) => { event.stopPropagation(); handleOpenCardLocation(card); }}>打开位置</button>
                        <button className="link-button" title="全文检索并更新卡片状态" onClick={(event) => { event.stopPropagation(); editCard(card); void updateCardStatesFromBook(card.id); }}>更新状态</button>
                        <button className="icon-delete" title="删除卡片" onClick={(event) => { event.stopPropagation(); deleteCard(card.id); }}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {editorSidebarTab === 'style' && (
                <div className="project-style-panel">
                  <div className="panel-section-title">作品绑定文风 <span>{activeWritingStyle ? '已绑定' : '未绑定'}</span></div>
                  <p className="project-style-hint">绑定后，章节智能体和大纲智能体都会自动带入这份文风 Skill。</p>
                  <label className="project-style-select" htmlFor="project-style-profile">
                    <span>当前文风</span>
                    <select id="project-style-profile" className="select" value={editingProject.styleProfileId || ''} onChange={event => bindStyleToCurrentProject(event.target.value)}>
                      <option value="">默认文风</option>
                      {writingStyles.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
                    </select>
                  </label>
                  {activeWritingStyle ? <div className="project-style-summary"><strong>{activeWritingStyle.name}</strong><small>{activeWritingStyle.sourceBookId ? '拆书蒸馏' : '自定义'} · {activeWritingStyle.tags.slice(0, 4).join('、') || '未分类'}</small><p>{activeWritingStyle.description || '暂无说明'}</p></div> : <p className="empty-hint compact">选择一份全局文风后，后续生成章节和大纲都会遵循它。</p>}
                  <button className="btn-secondary project-style-manage-button" onClick={() => { setActiveTab('styles'); setStyleDraft(activeWritingStyle || writingStyles[0] || null); setEditingProject(null); }}>管理全局文风</button>
                </div>
              )}

              {editorSidebarTab === 'knowledge' && (
                <div className="knowledge-panel">
                  <div className="knowledge-toolbar">
                    <button className="knowledge-rebuild-button" onClick={rebuildMemoryDocuments}>重新整理记忆</button>
                  </div>
                  <div className="memory-kind-list">
                    {memoryDocumentKinds.map(kind => {
                      const document = editingProject.memoryDocuments.find(item => item.kind === kind);
                      return <button
                        key={kind}
                        className={`memory-kind-button ${activeMemoryDocumentId === document?.id ? 'active' : ''}`}
                        onClick={() => setActiveMemoryDocumentId(document?.id ?? memoryDocumentId(kind))}
                      >{kind}{kind === '章节快照' && <small>{editingProject.memories.length}</small>}</button>;
                    })}
                  </div>

                  {activeMemoryDocumentId === memoryDocumentId('章节快照') && (
                    <section className="snapshot-section">
                      <div className="panel-section-title">章节记忆 <span>{editingProject.memories.length} 章</span></div>
                      {editingProject.memories.length === 0 ? <p className="empty-hint">保存有正文的章节后，会在这里形成逐章记忆快照。</p> : [...editingProject.memories].sort((left, right) => chapterOrder(left) - chapterOrder(right)).map(memory => (
                        <button
                          type="button"
                          className={`memory-item memory-item-button ${activeChapterMemoryId === memory.id ? 'active' : ''}`}
                          key={memory.id}
                          onClick={() => setActiveChapterMemoryId(memory.id)}
                        >
                          <strong>{memory.sourceChapterNumber ? `第 ${memory.sourceChapterNumber} 章` : memory.chapterTitle}</strong>
                          <span className="memory-item-title">{memory.chapterTitle}</span>
                          <p>{memory.summary || '暂无摘要'}</p>
                          <small>{memory.keywords.join(' · ') || '暂无关键词'}</small>
                          <div className="memory-details">
                            <span>{memory.characterStateChanges.length} 条人物变化 · {memory.foreshadowingChanges.length} 条伏笔 · {memory.timelineEvents.length} 条时间线</span>
                            {memory.endingHook && <span>章末钩子：{memory.endingHook}</span>}
                          </div>
                        </button>
                      ))}
                    </section>
                  )}

                </div>
              )}
              <div className="editor-sidebar-footer">
                <button className="settings-button" onClick={openSettings}>⚙ 设置</button>
              </div>
            </aside>

            <main className="editor-main">
              {editorSidebarTab === 'search' ? (
                <section className="project-search-workspace" aria-label="剧情搜索">
                  <header className="project-search-header">
                    <div>
                      <span>作品资料检索</span>
                      <h3>剧情搜索</h3>
                      <p>搜索人物、事件、线索和伏笔，结果按章节归集。</p>
                    </div>
                    <small>{editingProject.chapters.length} 章 · {editingProject.wordCount.toLocaleString()} 字</small>
                  </header>
                  <div className="project-search-input-row">
                    <span aria-hidden="true">⌕</span>
                    <input
                      ref={searchInputRef}
                      className="input"
                      value={searchQuery}
                      placeholder="搜索人物、事件、伏笔..."
                      onChange={event => { setSearchQuery(event.target.value); setBookSearchMatchIndex(0); }}
                      onKeyDown={event => { if (event.key === 'Enter' && bookSearchMatches.length) focusBookSearchMatch(bookSearchMatchIndex); }}
                    />
                    {searchQuery && <button className="project-search-clear" title="清除搜索" aria-label="清除搜索" onClick={() => setSearchQuery('')}>×</button>}
                  </div>
                  <div className="project-search-tabs" role="tablist" aria-label="检索方式">
                    <button className="active" type="button">关键词</button>
                    <span>覆盖章节标题与正文</span>
                  </div>
                  {!searchQuery.trim() ? <div className="project-search-empty"><b>⌕</b><strong>输入关键词后按回车搜索</strong><span>可检索人物、事件、地点、线索与伏笔。</span></div>
                    : bookSearchResults.length ? <div className="project-search-results">
                      <div className="project-search-summary"><strong>找到 {bookSearchMatches.length} 处匹配</strong><span>分布在 {bookSearchResults.length} 个章节</span><div><button className="editor-tool-button" onClick={() => focusBookSearchMatch(bookSearchMatchIndex - 1)} disabled={!bookSearchMatches.length}>上一个</button><button className="editor-tool-button" onClick={() => focusBookSearchMatch(bookSearchMatchIndex + 1)} disabled={!bookSearchMatches.length}>下一个</button></div></div>
                      {bookSearchResults.map(({ chapter, count, snippets }) => <article className="project-search-result" key={chapter.id}>
                        <button className="project-search-result-heading" onClick={() => openBookSearchChapter(chapter, snippets[0]?.position)}><div><strong>{chapter.title}</strong><small>{count} 处匹配 · {chapter.wordCount.toLocaleString()} 字</small></div><span>打开章节 ›</span></button>
                        {snippets.map(snippet => <button className="project-search-snippet" key={`${chapter.id}-${snippet.position}`} onClick={() => openBookSearchChapter(chapter, snippet.position)}>{snippet.text}</button>)}
                      </article>)}
                    </div> : <div className="project-search-empty"><b>⌕</b><strong>没有找到“{searchQuery}”</strong><span>试试人物全名、事件关键词或地点名称。</span></div>}
                </section>
              ) : editorSidebarTab === 'outline' ? (
                <section className="outline-workspace">
                  {activeOutline ? <>
                    <div className="outline-workspace-header"><div><span>{activeOutline.kind}</span><input className="outline-title-input" value={activeOutline.title} onChange={event => updateActiveOutline({ title: event.target.value })} placeholder="大纲标题" /><small>Markdown 大纲文档 · 内容会自动保存</small></div><button className={`editor-tool-button ${showSearchPanel ? 'active' : ''}`} onClick={toggleSearchPanel}>搜索 / 替换</button></div>
                    {renderDocumentSearchPanel('大纲', activeOutline.content, content => updateActiveOutline({ content }))}
                    <textarea className="outline-main-editor" value={activeOutline.content} onChange={event => updateActiveOutline({ content: event.target.value })} placeholder={`编辑${activeOutline.kind}内容...`} />
                  </> : <div className="empty-state"><p>从左侧选择一个大纲开始编辑。</p></div>}
                </section>
              ) : editorSidebarTab === 'cards' ? (
                <section className="card-workspace">
                  <>
                    <div className="card-workspace-header"><span>{cardDraft.type}</span><input className="card-main-title-input" value={cardDraft.title} onChange={event => setCardDraft(current => ({ ...current, title: event.target.value }))} placeholder="卡片名称" /><small>知识卡 Markdown · 内容会自动保存</small></div>
                    <div className="card-workspace-controls"><select className="select" value={cardDraft.type} onChange={event => setCardDraft(current => ({ ...current, type: event.target.value as CardType }))}><option value="角色卡">角色卡</option><option value="物品卡">物品卡</option><option value="地点卡">地点卡</option><option value="势力卡">势力卡</option><option value="金手指卡">金手指卡</option></select><button className={`editor-tool-button ${showSearchPanel ? 'active' : ''}`} onClick={toggleSearchPanel}>搜索 / 替换</button><button className="btn-secondary" disabled={cardGenerating} onClick={generateCardWithAI}>{cardGenerating ? '生成中...' : 'AI 生成卡片'}</button>{activeCard && <button className="btn-secondary" onClick={() => void updateCardStatesFromBook(activeCard.id)}>更新状态</button>}</div>
                    <div className="card-workspace-meta"><span>当前状态：{activeCard?.currentState || '尚未更新'}</span>{activeCard && <button className="link-button" onClick={() => void updateCardStatesFromBook(activeCard.id)}>全文检索并更新状态</button>}</div>
                    {renderDocumentSearchPanel('卡片', cardDraft.content, content => setCardDraft(current => ({ ...current, content })))}
                    <textarea className="card-main-editor" value={cardDraft.content} onChange={event => setCardDraft(current => ({ ...current, content: event.target.value }))} placeholder="编辑卡片详细信息..." />
                    <div className="card-workspace-footer"><span>{countNovelCharacters(cardDraft.content)} 字</span><button className="btn-primary" onClick={saveCard}>{activeCard ? '保存卡片' : '创建卡片'}</button></div>
                  </>
                </section>
              ) : editorSidebarTab === 'style' ? (
                <section className="project-style-workspace">
                  {activeWritingStyle ? <>
                    <div className="project-style-workspace-header"><span>已绑定至本作品</span><h3>{activeWritingStyle.name}</h3><small>章节生成与大纲生成均自动引用此文风</small></div>
                    <div className="project-style-coverage"><span>章节智能体</span><b>自动带入</b><span>大纲智能体</span><b>自动带入</b></div>
                    <div className="project-style-description">{activeWritingStyle.description || '这份文风没有补充说明。'}</div>
                    <pre className="project-style-content">{activeWritingStyle.content}</pre>
                  </> : <div className="empty-state"><p>从左侧选择一份文风，后续章节和大纲生成都会自动带入。</p></div>}
                </section>
              ) : editorSidebarTab === 'knowledge-graph' ? (
                <section className="knowledge-graph-workspace">
                  <div className="knowledge-graph-header"><div><span>{graphViewMode === 'document' ? '图谱文档' : '关系视图'}</span><h3>知识图谱</h3></div><small>{editingProject.graphNodes.length} 个节点 · {editingProject.graphEdges.length} 条关系</small></div>
                  {editingProject.graphNodes.length === 0 ? <div className="empty-state"><p>保存章节并勾选知识卡后，这里会显示章节、设定和卡片的引用关系。</p></div> : <>
                    <div className="knowledge-graph-view-switch" role="tablist" aria-label="图谱显示模式">
                      <button className={graphViewMode === 'document' ? 'active' : ''} onClick={() => setGraphViewMode('document')}>文档</button>
                      <button className={graphViewMode === 'graph' ? 'active' : ''} onClick={() => setGraphViewMode('graph')}>关系图</button>
                    </div>
                    {graphViewMode === 'document' ? <div className="graph-document-view">
                      <div className="graph-document-toolbar">
                        <div className="graph-document-groups">{graphDocumentGroups.map(group => <button key={group} className={group === activeGraphDocumentGroup ? 'active' : ''} onClick={() => setGraphDocumentGroup(group)}>{group} <small>{editingProject.graphNodes.filter(node => graphNodeGroup(node) === group).length}</small></button>)}</div>
                        <div className="graph-document-controls">
                          <select className="select" value={graphDocumentType} onChange={event => setGraphDocumentType(event.target.value)}><option>全部类型</option>{graphDocumentTypeOptions.map(type => <option key={type}>{type}</option>)}</select>
                          <input className="input" type="search" value={graphDocumentQuery} placeholder="搜索节点标题或来源路径" onChange={event => setGraphDocumentQuery(event.target.value)} />
                          <label className="graph-document-isolated"><input type="checkbox" checked={graphOnlyIsolated} onChange={event => setGraphOnlyIsolated(event.target.checked)} /> 只看孤立节点</label>
                        </div>
                        <div className="graph-document-summary"><span>当前显示 {graphDocumentNodes.length} / {editingProject.graphNodes.filter(node => !activeGraphDocumentGroup || graphNodeGroup(node) === activeGraphDocumentGroup).length} 个节点</span><span>孤立节点 {editingProject.graphNodes.filter(node => !editingProject.graphEdges.some(edge => edge.source === node.id || edge.target === node.id)).length} 个</span><button className="link-button" onClick={() => setExpandedGraphDocumentIds(graphDocumentNodes.map(node => node.id))}>全部展开</button><button className="link-button" onClick={() => setExpandedGraphDocumentIds([])}>全部收起</button></div>
                      </div>
                      {graphDocumentNodes.length === 0 ? <div className="empty-state"><p>当前筛选下暂无图谱节点。</p></div> : <div className="graph-document-list">{graphDocumentNodes.map((node, index) => {
                        const relations = editingProject.graphEdges.filter(edge => edge.source === node.id || edge.target === node.id)
                          .sort((left, right) => normalizeKnowledgeGraphWeight(right.weight, right.label) - normalizeKnowledgeGraphWeight(left.weight, left.label));
                        const relatedChapterNodes = relations.map(edge => editingProject.graphNodes.find(item => item.id === (edge.source === node.id ? edge.target : edge.source))).filter((item): item is KnowledgeGraphNode => Boolean(item && item.type === 'chapter'));
                        const expanded = expandedGraphDocumentIds.includes(node.id);
                        return <article className="graph-document-node" key={node.id}>
                          <div className="graph-document-node-heading"><div><h4>{index + 1}. {node.label}</h4><span>{graphNodeTypeLabel(node)} · {relations.length} 条关联</span></div><button className="link-button" onClick={() => setExpandedGraphDocumentIds(current => current.includes(node.id) ? current.filter(id => id !== node.id) : [...current, node.id])}>{expanded ? '收起' : '展开'}</button></div>
                          {expanded && <div className="graph-document-node-body">
                            <div className="graph-document-node-actions"><button className="link-button" onClick={() => void handleOpenGraphNodeLocation(node)}>打开位置</button><span>来源路径：{graphNodeRelativePath(node)}</span></div>
                            <div className="graph-document-profile"><strong>档案</strong><textarea value={graphNodeProfile(node)} onChange={event => updateGraphNodeProfile(node.id, event.target.value)} /></div>
                            <div className="graph-document-relations"><strong>关系网络</strong>{relations.length === 0 ? <p>暂无关联关系。</p> : <table><thead><tr><th>关联对象</th><th>关系</th><th>方向</th><th>权重</th></tr></thead><tbody>{relations.map(edge => { const isSource = edge.source === node.id; const other = editingProject.graphNodes.find(item => item.id === (isSource ? edge.target : edge.source)); return <tr key={edge.id}><td><button className="link-button" onClick={() => { setActiveGraphNodeId(other?.id || null); setGraphViewMode('graph'); }}>{other?.label || '未知节点'}</button></td><td>{edge.label}</td><td>{isSource ? '指向对方' : '来自对方'}</td><td>{normalizeKnowledgeGraphWeight(edge.weight, edge.label).toFixed(2)}</td></tr>; })}</tbody></table>}</div>
                            <div className="graph-document-events"><strong>相关事件</strong>{relatedChapterNodes.length ? relatedChapterNodes.map(chapter => <span key={chapter.id}>{chapter.label}</span>) : <p>暂无直接关联事件。</p>}</div>
                          </div>}
                        </article>;
                      })}</div>}
                    </div> : <>
                      <div className={`knowledge-graph-canvas ${activeGraphNodeId ? 'is-focused' : ''}`} onClick={() => setActiveGraphNodeId(null)}>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{editingProject.graphEdges.map(edge => {
                          const source = graphLayout.find(item => item.id === edge.source);
                          const target = graphLayout.find(item => item.id === edge.target);
                          const weight = normalizeKnowledgeGraphWeight(edge.weight, edge.label);
                          const edgeFocusClass = !activeGraphNodeId ? '' : focusedGraphRelationIds.has(edge.id) ? 'related' : 'muted';
                          return source && target ? <line key={edge.id} className={edgeFocusClass} x1={source.x} y1={source.y} x2={target.x} y2={target.y} style={{ strokeWidth: `${0.3 + weight * 1.05}px` }} /> : null;
                        })}</svg>
                        {editingProject.graphNodes.map(node => {
                          const position = graphLayout.find(item => item.id === node.id) ?? { x: 50, y: 50 };
                          const nodeFocusClass = !activeGraphNodeId ? '' : activeGraphNodeId === node.id ? 'active' : focusedGraphNodeIds.has(node.id) ? 'related' : 'muted';
                          return <button key={node.id} className={`knowledge-graph-vertex ${node.type} ${nodeFocusClass}`} style={{ left: `${position.x}%`, top: `${position.y}%` }} onClick={event => { event.stopPropagation(); setActiveGraphNodeId(node.id); }}>{node.label}</button>;
                        })}
                      </div>
                      <div className="knowledge-graph-details">
                        <div><strong>{activeGraphNode?.label || '选择一个节点'}</strong><span>{activeGraphNode ? graphNodeTypeLabel(activeGraphNode) : '查看节点关联'}</span></div>
                        <div className="knowledge-graph-relations">{!activeGraphNode ? '点击图中的节点查看关联。' : editingProject.graphEdges.filter(edge => edge.source === activeGraphNode.id || edge.target === activeGraphNode.id).sort((left, right) => normalizeKnowledgeGraphWeight(right.weight, right.label) - normalizeKnowledgeGraphWeight(left.weight, left.label)).map(edge => {
                          const otherId = edge.source === activeGraphNode.id ? edge.target : edge.source;
                          const other = editingProject.graphNodes.find(node => node.id === otherId);
                          return <button key={edge.id} onClick={() => setActiveGraphNodeId(otherId)}>{edge.source === activeGraphNode.id ? '关联到' : '被引用于'} {other?.label || otherId}<small>{edge.label} · {normalizeKnowledgeGraphWeight(edge.weight, edge.label).toFixed(2)}</small></button>;
                        })}</div>
                      </div>
                    </>}
                  </>}
                </section>
              ) : editorSidebarTab === 'knowledge' && activeMemoryDocumentId === memoryDocumentId('章节快照') && activeChapterMemory ? (
                <section className="memory-snapshot-editor">
                  <div className="memory-document-header">
                    <div><span>逐章记忆快照</span><h3>{activeChapterMemory.chapterTitle}</h3></div>
                    <button className="btn-primary" onClick={saveActiveChapterMemory}>保存本章记忆</button>
                  </div>
                  <div className="memory-snapshot-form">
                    <label>章节摘要<textarea value={activeChapterMemory.summary} onChange={(event) => updateChapterMemory({ summary: event.target.value })} /></label>
                    <label>关键词 <small>每行一个，也可用顿号分隔</small><textarea value={activeChapterMemory.keywords.join('\n')} onChange={(event) => updateChapterMemory({ keywords: memoryTextList(event.target.value).slice(0, 8) })} /></label>
                    <div className="memory-snapshot-grid">
                      <label>人物状态变化<textarea value={activeChapterMemory.characterStateChanges.join('\n')} onChange={(event) => updateChapterMemory({ characterStateChanges: memoryTextList(event.target.value) })} /></label>
                      <label>角色认知变化<textarea value={activeChapterMemory.knowledgeChanges.join('\n')} onChange={(event) => updateChapterMemory({ knowledgeChanges: memoryTextList(event.target.value) })} /></label>
                      <label>伏笔追踪<textarea value={activeChapterMemory.foreshadowingChanges.join('\n')} onChange={(event) => updateChapterMemory({ foreshadowingChanges: memoryTextList(event.target.value) })} /></label>
                      <label>时间线事件<textarea value={activeChapterMemory.timelineEvents.join('\n')} onChange={(event) => updateChapterMemory({ timelineEvents: memoryTextList(event.target.value) })} /></label>
                      <label>设定事实<textarea value={activeChapterMemory.canonFacts.join('\n')} onChange={(event) => updateChapterMemory({ canonFacts: memoryTextList(event.target.value) })} /></label>
                      <label>冲突<textarea value={activeChapterMemory.conflicts.join('\n')} onChange={(event) => updateChapterMemory({ conflicts: memoryTextList(event.target.value) })} /></label>
                    </div>
                    <label>章末钩子<textarea value={activeChapterMemory.endingHook} onChange={(event) => updateChapterMemory({ endingHook: event.target.value })} /></label>
                  </div>
                  <p className="memory-document-meta">本章快照与聚合记忆会同步写入小说目录的“记忆”文件夹，并可被章节智能体按勾选项检索。</p>
                </section>
              ) : editorSidebarTab === 'knowledge' && activeMemoryDocument ? (
                <section className="memory-document-editor">
                  <div className="memory-document-header">
                    <div><span>本地记忆文档</span><h3>{activeMemoryDocument.title}</h3></div>
                    <button className="btn-primary" onClick={saveActiveMemoryDocument}>保存记忆</button>
                  </div>
                  <textarea
                    className="memory-document-content"
                    value={activeMemoryDocument.content}
                    onChange={(event) => updateMemoryDocument(activeMemoryDocument.id, event.target.value)}
                    placeholder="在此编辑记忆 Markdown..."
                  />
                  <p className="memory-document-meta">保存后写入小说目录的“{'记忆/'}{activeMemoryDocument.title}.md”，章节智能体会把该类记忆加入上下文检索。</p>
                </section>
              ) : activeChapter ? (
                <>
                  <div className="chapter-editor-toolbar">
                    <div className="chapter-toolbar-search">
                      <button className={`editor-tool-button ${showSearchPanel ? 'active' : ''}`} onClick={toggleSearchPanel}>搜索 / 替换</button>
                      <span className="search-shortcut">⌘/Ctrl F</span>
                    </div>
                    <button className="editor-tool-button" title="统一换行、清理多余空格和空行" onClick={formatActiveChapter} disabled={!activeChapter.content.trim()}>格式化正文</button>
                    <span className="chapter-goal-status">目标 {Number(editingProject.chapterTargetWords) || 3000} 字 · 上限 {Math.floor((Number(editingProject.chapterTargetWords) || 3000) * 1.2)} 字</span>
                  </div>
                  {showSearchPanel && (
                    <section className="search-panel" aria-label="搜索与替换">
                      <div className="search-panel-row">
                        <input ref={searchInputRef} className="input" value={searchQuery} placeholder="搜索本章内容" onChange={event => { setSearchQuery(event.target.value); setSearchMatchIndex(0); }} />
                        <button className="editor-tool-button" onClick={() => focusSearchMatch(-1)} disabled={!searchQuery}>上一个</button><button className="editor-tool-button" onClick={() => focusSearchMatch(1)} disabled={!searchQuery}>下一个</button>
                        <button className="icon-delete" title="关闭搜索" onClick={() => setShowSearchPanel(false)}>×</button>
                      </div>
                      <div className="search-panel-row replace-row"><input className="input" value={replaceQuery} placeholder="替换为" onChange={event => setReplaceQuery(event.target.value)} /><button className="editor-tool-button" onClick={replaceCurrentMatch} disabled={!searchQuery}>替换</button><button className="editor-tool-button" onClick={replaceAllMatches} disabled={!searchQuery}>全部替换</button><small>{currentSearchMatches ? `${Math.min(searchMatchIndex + 1, currentSearchMatches)} / ${currentSearchMatches}` : '无匹配'}</small></div>
                    </section>
                  )}
                  <input
                    type="text"
                    className="chapter-title-input"
                    value={activeChapter.title}
                    onChange={(e) => {
                      const updatedChapter = { ...activeChapter, title: e.target.value, updatedAt: new Date().toISOString() };
                      const updatedChapters = editingProject.chapters.map(c => c.id === activeChapter.id ? updatedChapter : c);
                      const updated = { ...editingProject, chapters: updatedChapters, updatedAt: new Date().toISOString() };
                      setEditingProject(updated);
                      setActiveChapter(updatedChapter);
                      setProjects(current => current.map(p => p.id === updated.id ? updated : p));
                    }}
                  />
                  <div className="chapter-editor-wrap">
                    <div ref={highlightLayerRef} className="chapter-highlight-layer" aria-hidden="true">{renderMarkedContent(activeChapter.content)}</div>
                    <textarea
                      ref={chapterEditorRef}
                      className="chapter-content-editor"
                      value={activeChapter.content}
                      onChange={(e) => handleUpdateChapterContent(e.target.value)}
                      onSelect={captureChapterSelection}
                      onScroll={(event) => { if (highlightLayerRef.current) highlightLayerRef.current.scrollTop = event.currentTarget.scrollTop; }}
                      placeholder="开始写作..."
                      spellCheck={false}
                    />
                  </div>
                  <div className="chapter-live-footer">
                    <span>本章实时字数 <strong>{activeChapter.wordCount.toLocaleString()}</strong></span>
                    <span>{currentSearchMatches ? `搜索到 ${currentSearchMatches} 处` : writingMarksEnabled ? `人物 ${characterNames.length} 个 · 禁词 ${bannedWords.length} 个` : '标记已关闭'}</span>
                    {activeChapter.wordCount >= (Number(editingProject.chapterTargetWords) || 3000) && <button className="link-button" onClick={handleAddChapter}>创建下一章</button>}
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <p>从左侧选择或新建章节开始写作</p>
                </div>
              )}
            </main>

          <aside className="agent-panel">
              <div className="agent-panel-header">
                <span>{outlineMode ? '大纲智能体' : cardMode ? '卡片创建智能体' : styleMode ? '文风说明' : 'AI 智能体'}</span>
                <select
                  className="agent-model-select"
                  value={agentConfig.model}
                  onChange={(event) => setAgentConfig(current => applyModelKeyRouting(current, event.target.value))}
                  aria-label="选择写作模型"
                >
                  {Array.from(new Set([agentConfig.model, ...availableModels])).filter(Boolean).map(model => <option key={model} value={model}>{model}</option>)}
                </select>
              </div>

              {outlineMode ? (
                <div className="agent-panel-scroll outline-agent-panel">
                  <section className="agent-task-section">
                    <div className="agent-instruction-heading"><label>大纲创作指令</label><button type="button" className="link-button" onClick={() => { setOutlinePreviousSessionId(outlineSessionId); setOutlineSessionId(newAgentSessionId('outline')); setOutlineChatMessages([]); setOutlineStreamContent(''); }}>新建会话</button><button type="button" className={`agent-skill-button ${showAgentSkillPicker ? 'active' : ''}`} onClick={() => setShowAgentSkillPicker(current => !current)}>技能{selectedAgentSkillNames.length ? ` ${selectedAgentSkillNames.length}` : ''}</button></div>
                    <textarea value={outlineAgentInstruction} onChange={event => setOutlineAgentInstruction(event.target.value)} placeholder="描述要补全的结构、节奏、冲突和章节安排" />
                    {outlineIntentPreview && <div className={`outline-intent-preview ${outlineIntentPreview.sourceChapter || outlineIntentPreview.isFirstChapter ? '' : 'warning'}`}>
                      <strong>意图识别</strong>
                      <span>目标：{outlineIntentPreview.targetOutline.title || '未命名章纲'}</span>
                      <span>依据：{outlineIntentPreview.sourceChapter ? `第 ${chapterNumberFromText(outlineIntentPreview.sourceChapter.title) || editingProject.chapters.findIndex(chapter => chapter.id === outlineIntentPreview.sourceChapter?.id) + 1} 章正文` : outlineIntentPreview.isFirstChapter ? '世界观与作品简介（首章无需上一章正文）' : '未找到正文'}</span>
                      <small>{outlineIntentPreview.sourceMode} · 格式：{outlineIntentPreview.formatMode}</small>
                    </div>}
                    {showAgentSkillPicker && <section className="agent-skill-picker" aria-label="选择大纲技能"><div className="agent-card-picker-title"><span>本次优先技能</span><button type="button" className="link-button" onClick={() => setSelectedAgentSkillNames([])}>自动选择</button></div><p>不选时由智能体按大纲创作意图自动选择技能。</p><div className="agent-skill-options">{skills.map(skill => <label key={skill.id} className="agent-skill-option"><input type="checkbox" checked={selectedAgentSkillNames.includes(skill.name)} onChange={() => setSelectedAgentSkillNames(current => current.includes(skill.name) ? current.filter(name => name !== skill.name) : [...current, skill.name].slice(0, 6))} /><span><strong>{skill.displayName || skill.name}</strong><small>{skill.description || skill.category}</small></span></label>)}</div></section>}
                    <div className="agent-card-picker"><div className="agent-card-picker-title">大纲带入卡片 <small>{selectedOutlineCardIds.length} 张</small></div>{editingProject.cards.length === 0 ? <p className="empty-hint compact">没有可带入的知识卡</p> : editingProject.cards.map(card => <label key={card.id} className="agent-card-option"><input type="checkbox" checked={selectedOutlineCardIds.includes(card.id)} onChange={() => setSelectedOutlineCardIds(current => current.includes(card.id) ? current.filter(id => id !== card.id) : [...current, card.id])} /><span><strong>{card.title}</strong><small>{card.type}</small></span></label>)}</div>
                    {(outlineGenerating || outlineAgentActivity.length > 0) && <section className="outline-agent-activity" aria-live="polite"><div className="outline-activity-heading"><strong>大纲智能体执行过程</strong><small>{outlineGenerating ? '运行中' : '已完成'}</small></div>{outlineAgentActivity.map(item => <div key={item.id} className={`outline-activity-row ${item.status}`}><span className="outline-activity-dot" /><div><strong>{item.step === 'intent' ? '意图识别' : item.step === 'retrieve' ? '上下文装载' : item.step === 'plan' ? '事件规划' : item.step === 'draft' ? '生成章纲' : item.step === 'review' ? '承接校验' : item.step === 'complete' ? '任务完成' : item.step === 'error' ? '运行失败' : '准备运行'}</strong><span>{item.message}</span>{item.source && <small>{item.source}</small>}</div></div>)}</section>}
                    {outlineChatMessages.length > 0 && <div className="agent-chat-history">{outlineChatMessages.map((message, index) => <article key={`${message.createdAt}-${index}`} className={`agent-chat-bubble ${message.role}`}><small>{message.role === 'user' ? '你' : '大纲智能体'}</small><p>{message.content}</p></article>)}</div>}
                    {outlineGenerating && <article className="agent-chat-bubble assistant"><small>大纲智能体正在回复</small><p>{outlineStreamContent || '正在连接模型...'}</p></article>}
                    <div className="outline-agent-actions"><button className="btn-primary" disabled={outlineGenerating || !activeOutline} onClick={() => void generateOutline()}>{outlineGenerating ? '生成大纲中...' : '生成当前大纲'}</button></div>
                    {outlineGenerating && <div className="outline-agent-progress"><span className="agent-progress-dot active" /><span>{outlineAgentActivity.at(-1)?.message || '正在分析作品设定、卡片和知识图谱...'}</span></div>}
                    {agentError && <div className="agent-error">{agentError}</div>}
                  </section>
                  <p className="outline-agent-hint">大纲智能体会读取作品简介、卡片、知识图谱和当前大纲内容，生成结果会直接回填左侧文本编辑区。</p>
                </div>
              ) : cardMode ? (
                <div className="agent-panel-scroll card-agent-panel">
                  <section className="agent-task-section">
                    <div className="agent-instruction-heading"><label>卡片创建指令</label><button type="button" className="link-button" onClick={() => { setCardPreviousSessionId(cardSessionId); setCardSessionId(newAgentSessionId('card')); setCardChatMessages([]); setCardStreamContent(''); }}>新建会话</button><button type="button" className="agent-skill-button" onClick={() => setShowAgentSkillPicker(current => !current)}>技能{selectedAgentSkillNames.length ? ` ${selectedAgentSkillNames.length}` : ''}</button></div>
                    <textarea value={cardAgentInstruction} onChange={event => setCardAgentInstruction(event.target.value)} placeholder="描述要补充的身份、能力、关系、限制或状态变化" />
                    {showAgentSkillPicker && <section className="agent-skill-picker" aria-label="选择卡片技能"><div className="agent-card-picker-title"><span>本次优先技能</span><button type="button" className="link-button" onClick={() => setSelectedAgentSkillNames([])}>自动选择</button></div><div className="agent-skill-options">{skills.map(skill => <label key={skill.id} className="agent-skill-option"><input type="checkbox" checked={selectedAgentSkillNames.includes(skill.name)} onChange={() => setSelectedAgentSkillNames(current => current.includes(skill.name) ? current.filter(name => name !== skill.name) : [...current, skill.name].slice(0, 6))} /><span><strong>{skill.displayName || skill.name}</strong><small>{skill.description || skill.category}</small></span></label>)}</div></section>}
                    <div className="card-agent-context"><span>当前卡片</span><strong>{activeCard?.title || cardDraft.title || '新建卡片'}</strong><small>{cardDraft.type} · {countNovelCharacters(cardDraft.content)} 字</small></div>
                    {cardChatMessages.length > 0 && <div className="agent-chat-history">{cardChatMessages.map((message, index) => <article key={`${message.createdAt}-${index}`} className={`agent-chat-bubble ${message.role}`}><small>{message.role === 'user' ? '你' : '卡片智能体'}</small><p>{message.content}</p></article>)}</div>}
                    {cardGenerating && <article className="agent-chat-bubble assistant"><small>卡片智能体正在回复</small><p>{cardStreamContent || '正在连接模型...'}</p></article>}
                    <button className="agent-run-button" disabled={!cardDraft.title.trim() && !cardDraft.content.trim() || cardGenerating} onClick={() => void generateCardWithAI()}>{cardGenerating ? '卡片生成中...' : '运行卡片创建智能体'}</button>
                    {cardGenerating && <div className="outline-agent-progress"><span className="agent-progress-dot active" /><span>正在分析作品设定、章节和已有卡片...</span></div>}
                    <p className="outline-agent-hint">卡片智能体会读取作品简介、大纲、当前章节和已有知识卡，生成结果会直接回填中间卡片编辑区。</p>
                  </section>
                </div>
              ) : styleMode ? (
                <div className="agent-panel-scroll style-agent-panel">
                  <section className="agent-task-section">
                    <div className="agent-instruction-heading"><label>文风应用范围</label></div>
                    {activeWritingStyle ? <>
                      <div className="card-agent-context"><span>当前绑定</span><strong>{activeWritingStyle.name}</strong><small>{activeWritingStyle.tags.join('、') || '无标签'}</small></div>
                    <div className="style-agent-coverage"><div><strong>章节智能体</strong><span>生成正文时作为专用文风 Skill 带入。</span></div><div><strong>大纲智能体</strong><span>生成总纲、章纲和设定时同样带入，保证创作方向一致。</span></div></div>
                    </> : <p className="empty-hint compact">尚未绑定文风。请在左侧选择一份全局文风。</p>}
                  </section>
                </div>
              ) : (
              <div className="agent-panel-scroll">
                <section className="agent-task-section">
                  <div className="agent-instruction-heading"><label>创作指令</label><button type="button" className="link-button" onClick={() => { setChapterPreviousSessionId(chapterSessionId); setChapterSessionId(newAgentSessionId('chapter')); setAgentDraft(null); setAgentDisplayContent(''); setAgentProgress([]); }}>新建会话</button><button type="button" className={`agent-skill-button ${showAgentSkillPicker ? 'active' : ''}`} onClick={() => setShowAgentSkillPicker(current => !current)}>技能{selectedAgentSkillNames.length ? ` ${selectedAgentSkillNames.length}` : ''}</button></div>
                  <textarea value={agentInstruction} onChange={(event) => setAgentInstruction(event.target.value)} />
                  {showAgentSkillPicker && <section className="agent-skill-picker" aria-label="选择本次写作技能">
                    <div className="agent-card-picker-title"><span>本次优先技能</span><button type="button" className="link-button" onClick={() => setSelectedAgentSkillNames([])}>自动选择</button></div>
                    <p>不选时由智能体按创作意图自动调用；勾选后会优先带入，章节承接和下一章计划仍会自动保留。</p>
                    <div className="agent-skill-options">{skills.map(skill => <label key={skill.id} className="agent-skill-option"><input type="checkbox" checked={selectedAgentSkillNames.includes(skill.name)} onChange={() => setSelectedAgentSkillNames(current => current.includes(skill.name) ? current.filter(name => name !== skill.name) : [...current, skill.name].slice(0, 6))} /><span><strong>{skill.displayName || skill.name}</strong><small>{skill.description || skill.category}</small></span></label>)}</div>
                  </section>}
                  <div className="ai-writing-tools">
                    <div className="agent-card-picker-title">润色 / 续写要求 <small>可选</small></div>
                    <textarea value={aiToolInstruction} onChange={event => setAIToolInstruction(event.target.value)} placeholder="例如：加强紧张感，保留冷峻文风；或让主角先观察再行动" />
                    <div className="ai-writing-tool-actions">
                      <button className="btn-secondary" disabled={aiToolRunning || !activeChapter} onClick={() => runAITool('polish')}>{aiToolRunning && aiToolMode === 'polish' ? '润色中...' : '润色选中内容 / 整章'}</button>
                      <button className="btn-secondary" disabled={aiToolRunning || !activeChapter} onClick={() => runAITool('de-ai')}>{aiToolRunning && aiToolMode === 'de-ai' ? '处理中...' : '去 AI 味'}</button>
                      <button className="btn-primary" disabled={aiToolRunning || !activeChapter} onClick={() => runAITool('continue')}>{aiToolRunning && aiToolMode === 'continue' ? '续写中...' : '生成续写'}</button>
                    </div>
                    {aiToolResult && <div className="ai-tool-result">
                      <div><strong>{aiToolResult.mode === 'continue' ? '续写草稿' : aiToolResult.mode === 'de-ai' ? '去 AI 味草稿' : '润色草稿'}</strong><span>{countNovelCharacters(aiToolResult.content)} 字{aiToolResult.maxWords ? ` / 最多 ${aiToolResult.maxWords} 字` : ''}</span></div>
                      <textarea value={aiToolResult.content} onChange={event => setAIToolResult(current => current ? { ...current, content: event.target.value } : current)} />
                      <div className="ai-writing-tool-actions"><button className="btn-secondary" onClick={() => copyText(aiToolResult.content)}>复制</button><button className="btn-primary" onClick={acceptAIToolResult}>{aiToolResult.mode === 'continue' ? '确认插入章节' : '确认替换'}</button></div>
                    </div>}
                  </div>
                  <div className="agent-card-picker">
                    <div className="agent-card-picker-title"><span>本次带入章纲</span><small>{selectedOutlineIds.filter(id => editingProject.outlines.some(outline => outline.id === id && outline.kind === '章纲')).length} 份</small></div>
                    <button type="button" className={`agent-context-select ${showChapterOutlinePicker ? 'active' : ''}`} onClick={() => setShowChapterOutlinePicker(current => !current)}>选择章纲</button>
                    {showChapterOutlinePicker && <div className="agent-context-dropdown">{editingProject.outlines.filter(outline => outline.kind === '章纲').length === 0 ? <p className="empty-hint compact">先在大纲页创建章纲</p> : editingProject.outlines.filter(outline => outline.kind === '章纲').map(outline => <label key={outline.id} className="agent-card-option"><input type="checkbox" checked={selectedOutlineIds.includes(outline.id)} onChange={() => setSelectedOutlineIds(current => current.includes(outline.id) ? current.filter(id => id !== outline.id) : [...current, outline.id])} /><span><strong>{outline.title || '未命名章纲'}</strong><small>{String(outline.chapterId ?? '') === String(activeChapter?.id ?? '') ? '当前章节' : '其他章节'}</small></span></label>)}</div>}
                    <p className="empty-hint compact">世界观与作品设定固定自动带入；总纲不会传入章节智能体。</p>
                  </div>
                  <div className="agent-card-picker">
                    <div className="agent-card-picker-title">本章自动带入卡片 <small>{selectedCardIds.length} 张，可手动追加</small></div>
                    <button type="button" className={`agent-context-select ${showChapterCardPicker ? 'active' : ''}`} onClick={() => setShowChapterCardPicker(current => !current)}>查看 / 追加卡片</button>
                    {showChapterCardPicker && <div className="agent-context-dropdown">{editingProject.cards.length === 0 ? <p className="empty-hint compact">先在卡片页创建知识卡</p> : editingProject.cards.map(card => <label key={card.id} className="agent-card-option"><input type="checkbox" checked={selectedCardIds.includes(card.id)} onChange={() => toggleCardForChapter(card.id)} /><span><strong>{card.title}</strong><small>{card.type}</small></span></label>)}</div>}
                  </div>
                  <div className="agent-memory-picker">
                    <div className="agent-card-picker-title">上一章记忆 <small>自动加载</small></div>
                    {(() => { const previous = activeChapter ? editingProject.chapters[editingProject.chapters.findIndex(chapter => chapter.id === activeChapter.id) - 1] : undefined; const memory = previous ? editingProject.memories.find(item => item.chapterId === previous.id) : undefined; return memory ? <div className="agent-context-fixed-item"><strong>{memory.sourceChapterNumber ? `第 ${memory.sourceChapterNumber} 章` : memory.chapterTitle}</strong><small>{memory.summary || '已自动加载上一章结构化记忆'}</small></div> : <p className="empty-hint compact">上一章暂无结构化记忆。</p>; })()}
                  </div>
                  <button className={`agent-run-button ${agentRunning(agentStage) ? 'running' : ''}`} aria-busy={agentRunning(agentStage)} onClick={runChapterAgent}>
                    {agentRunning(agentStage) ? `智能体执行中 · ${agentProgressPercent}%` : '运行章节智能体'}
                  </button>
                </section>

                {agentProgress.length > 0 && (
                  <section className={`agent-progress-panel ${agentStage === 'error' ? 'error' : agentStage === 'done' ? 'done' : ''}`} aria-live="polite">
                    <div className="agent-progress-heading">
                      <div><strong>智能体执行过程</strong><small>{agentProgressMessage || agentStageLabel[agentStage]}</small></div>
                      <span>{agentProgressPercent}%</span>
                    </div>
                    <div className="agent-progress-bar" aria-label={`智能体进度 ${agentProgressPercent}%`}><i style={{ width: `${agentProgressPercent}%` }} /></div>
                    <ol className="agent-progress-steps">
                      {agentProgress.map(item => (
                        <li key={item.id} className={item.status}>
                          <span className="agent-progress-dot" aria-hidden="true" />
                          <div><strong>{item.label}</strong><small>{item.message || item.description}</small></div>
                          <b>{item.status === 'complete' ? '完成' : item.status === 'active' ? '进行中' : item.status === 'error' ? '失败' : '等待'}</b>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}

                {contextTrace.length > 0 && (
                  <details className="context-trace-panel" open>
                    <summary><strong>上下文追逐</strong><span>{contextTrace.length} 个步骤 · 实时追踪资料如何被检索与装载</span></summary>
                    <ol className="context-trace-list">
                      {contextTrace.map(item => (
                        <li key={item.id} className={`context-trace-item ${item.status || ''}`}>
                          <span className="context-trace-marker" />
                          <div><strong>{item.action}</strong><small>{item.source || item.step}{item.items !== undefined ? ` · ${item.items} 项` : ''}{item.bytes ? ` · ${(item.bytes / 1024).toFixed(1)} KB` : ''}</small></div>
                          <b>{item.status === 'cached' ? '命中缓存' : item.status === 'pruned' ? '已裁剪' : item.status === 'searching' ? '检索中' : item.status === 'selected' ? '已选择' : '已装载'}</b>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}

                {agentError && <div className="agent-error">{agentError}</div>}

                {agentDraft?.draftContent && (
                  <section className="agent-result-section">
                    <div className="agent-result-title"><strong>章节草稿</strong><span>{countNovelCharacters(agentDraft.draftContent)} 字</span></div>
                    {(agentDraft.recognizedIntent || agentDraft.selectedSkills?.length) && <div className="agent-intent-result"><span>识别意图：{agentDraft.recognizedIntent || '章节创作与续写'}</span>{agentDraft.selectedSkills?.map(skill => <b key={skill}>{skills.find(item => item.name === skill)?.displayName || skill}</b>)}</div>}
                    {agentDraft.prewriteCheck && <div className={`agent-prewrite-check ${agentDraft.prewriteCheck.blockers.length ? 'warning' : 'passed'}`}><strong>{agentDraft.prewriteCheck.summary}</strong>{agentDraft.prewriteCheck.blockers.map(item => <span key={`block-${item}`}>阻断：{item}</span>)}{agentDraft.prewriteCheck.warnings.map(item => <span key={`warn-${item}`}>提醒：{item}</span>)}</div>}
                    {agentDraft.chapterPlan && <details className="agent-chapter-plan" open>
                      <summary>下一章执行计划</summary>
                      <div className="agent-plan-meta">已交给正文节点执行，接受草稿前可先核对承接与钩子。</div>
                      <div className="agent-plan-content">{readableChapterPlan(agentDraft.chapterPlan).split(/\n{2,}/u).map((section, index) => <p key={`${index}-${section.slice(0, 24)}`}>{section}</p>)}</div>
                    </details>}
                    {agentDraft.contextReport && <div className="agent-context-report">
                      <span>本地上下文包{agentDraft.contextReport.cache === 'hit' ? '缓存命中' : '缓存未命中'}</span>
                      {agentDraft.contextReport.contextProfile && <span>动态档案：{agentDraft.contextReport.contextProfile}</span>}
                      <span>发送上下文 {((agentDraft.contextReport.draftInputBytes || agentDraft.contextReport.packedBytes || 0) / 1024).toFixed(1)} KB</span>
                      {agentDraft.contextReport.prunedBytes ? <span>已裁剪 {(agentDraft.contextReport.prunedBytes / 1024).toFixed(1)} KB</span> : null}
                      {agentDraft.contextReport.estimatedInputTokens ? <span>估算输入 {agentDraft.contextReport.estimatedInputTokens.toLocaleString()} tokens</span> : null}
                      {agentDraft.contextReport.upstreamUsage?.requests ? <><span>中转输入 {agentDraft.contextReport.upstreamUsage.inputTokens.toLocaleString()} tokens</span><span>中转输出 {agentDraft.contextReport.upstreamUsage.outputTokens.toLocaleString()} tokens</span><span>中转总计 {agentDraft.contextReport.upstreamUsage.totalTokens.toLocaleString()} tokens</span><span>上游缓存命中 {agentDraft.contextReport.upstreamUsage.cachedInputTokens.toLocaleString()} tokens</span><span>上游缓存命中率 {agentDraft.contextReport.upstreamUsage.inputTokens ? `${((agentDraft.contextReport.upstreamUsage.cachedInputTokens / agentDraft.contextReport.upstreamUsage.inputTokens) * 100).toFixed(1)}%` : '未返回输入用量'}</span></> : <span>中转站未返回用量与缓存字段</span>}
                    </div>}
                    <textarea className="agent-draft-preview" value={agentDisplayContent || agentDraft.draftContent} onChange={(event) => { setAgentDisplayContent(event.target.value); setAgentDraft({ ...agentDraft, draftContent: event.target.value }); }} />
                    {agentDraft.summary && <p className="agent-summary">{agentDraft.summary}</p>}
                    {agentDraft.reviewResult && (
                      <div className={`agent-review ${agentDraft.reviewResult.consistent ? 'passed' : 'warning'}`}>
                        <strong>{agentDraft.reviewResult.consistent ? '一致性审查通过' : '发现一致性问题'}</strong>
                        {agentDraft.reviewResult.issues.map(issue => <p key={issue}>{issue}</p>)}
                        {agentDraft.reviewResult.suggestions.map(suggestion => <p key={suggestion}>建议：{suggestion}</p>)}
                      </div>
                    )}
                    <div className="agent-result-actions">
                      <button className="btn-secondary" onClick={() => setAgentDraft(null)}>放弃</button>
                      <button className="btn-primary" onClick={acceptAgentDraft}>接受并写入</button>
                    </div>
                  </section>
                )}
              </div>
              )}
            </aside>
          </div>
        </div>
      ) : (
        <>
      <aside className="sidebar">
        <div className="logo">
          <h1>ApiSaverWriter</h1>
          <p>AI 小说写作助手</p>
        </div>

        <nav className="nav">
          <button aria-label="小说管理" className={activeTab === 'projects' ? 'active' : ''} onClick={() => setActiveTab('projects')}>
            <span className="nav-icon" aria-hidden="true">▣</span><span className="nav-label">小说</span>
          </button>
          <button className={activeTab === 'books' ? 'active' : ''} onClick={() => setActiveTab('books')}>
            <span className="nav-icon" aria-hidden="true">▤</span><span className="nav-label">书籍</span><small>{libraryBooks.length}</small>
          </button>
          <button
            className={activeTab === 'dismantles' ? 'active' : ''}
            onClick={() => { setActiveTab('dismantles'); if (!activeDismantleBookId && dismantleBooks[0]) { setActiveDismantleBookId(dismantleBooks[0].id); setActiveDismantleChapterId(dismantleBooks[0].chapters[0]?.id || null); } }}
          >
            <span className="nav-icon" aria-hidden="true">⌘</span><span className="nav-label">拆书</span><small>{dismantleBooks.length}</small>
          </button>
          <button className={activeTab === 'rankings' ? 'active' : ''} onClick={() => setActiveTab('rankings')}>
            <span className="nav-icon" aria-hidden="true">↗</span><span className="nav-label">扫榜</span><small>{rankingBooks.length}</small>
          </button>
          <button className={activeTab === 'skills' ? 'active' : ''} onClick={() => setActiveTab('skills')}>
            <span className="nav-icon" aria-hidden="true">✦</span><span className="nav-label">技能</span><small>{skills.length}</small>
          </button>
          <button className={activeTab === 'styles' ? 'active' : ''} onClick={() => { setActiveTab('styles'); setStyleDraft(current => current || writingStyles[0] || null); }}>
            <span className="nav-icon" aria-hidden="true">◈</span><span className="nav-label">文风</span><small>{writingStyles.length}</small>
          </button>
          <button className="mobile-more-button" aria-expanded={showMobileMore} onClick={() => setShowMobileMore(current => !current)}>
            <span className="nav-icon" aria-hidden="true">•••</span><span className="nav-label">更多</span>
          </button>
        </nav>
        <div className={`mobile-more-menu ${showMobileMore ? 'open' : ''}`}>
          <button className={activeTab === 'skills' ? 'active' : ''} onClick={() => { setActiveTab('skills'); setShowMobileMore(false); }}>✦ 技能管理 <small>{skills.length}</small></button>
          <button className={activeTab === 'styles' ? 'active' : ''} onClick={() => { setActiveTab('styles'); setStyleDraft(current => current || writingStyles[0] || null); setShowMobileMore(false); }}>◈ 文风管理 <small>{writingStyles.length}</small></button>
        </div>
        <div className="sidebar-footer">
          <button className="settings-button" onClick={openSettings}><span aria-hidden="true">⚙</span><b>设置</b></button>
        </div>
      </aside>

      <main className="main">
        {activeTab === 'projects' && (
          <div className="projects">
            {projects.length === 0 ? (
              <div className="empty-project-home">
                <div className="empty-project-mark">文</div>
                <span className="empty-project-eyebrow">AI 小说写作空间</span>
                <h2>开始你的第一部小说</h2>
                <p>创建一个本地写作项目，章节、大纲、卡片和记忆都会保存在你的设备上。</p>
                <button className="btn-primary empty-project-cta" onClick={openNewProjectModal}>+ 新建小说</button>
              </div>
            ) : (
              <>
                <header className="page-header">
                  <h2>小说管理</h2>
                  <button className="btn-primary" onClick={openNewProjectModal}>+ 新建小说</button>
                </header>
                <div className="project-grid">
                  {projects.map((project) => (
                    <div key={project.id} className="project-card">
                      <h3>{project.title}</h3>
                      <div className="project-meta">
                        <span className="genre">{project.subgenre ?? project.genre}</span>
                        {project.tags?.主题?.slice(0, 2).map(tag => <span key={tag} className="genre">{tag}</span>)}
                        <span className="status">{project.status === 'completed' ? '已完结' : '连载中'}</span>
                      </div>
                      <div className="project-stats">
                        <span>{project.wordCount.toLocaleString()} 字</span>
                        <span>更新于 {new Date(project.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="project-actions">
                        <button className="btn-secondary" onClick={() => handleEditProject(project.id)}>进入</button>
                        <button className="btn-secondary" onClick={() => openProjectEdit(project)}>编辑</button>
                        <button className="btn-secondary" onClick={() => handleOpenProjectLocation(project)}>打开位置</button>
                        <button className="btn-danger" onClick={() => setProjectPendingDeletion(project)}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {activeTab === 'skills' && (
          <section className="global-management-page skills-management-page">
            <header className="page-header"><div><span className="page-eyebrow">全局写作资源</span><h2>技能管理</h2><p>管理内置与自定义写作技能。小说智能体可从这里选择并调用合适的技能。</p></div><button className="btn-primary" onClick={openNewSkill}>+ 新建技能</button></header>
            <div className="global-management-toolbar">
              <select className="select" value={skillCategoryFilter} onChange={(event) => setSkillCategoryFilter(event.target.value)}>
                <option value="">全部分类</option><option value="setup">项目设置</option><option value="write">写作</option><option value="review">审查</option><option value="polish">润色</option><option value="import">导入</option><option value="analyze">分析</option><option value="tool">工具</option><option value="creator">创建器</option>
              </select>
              <input type="search" className="input" placeholder="搜索技能名称、描述或标签" value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} />
              <button className="btn-secondary" onClick={() => { void loadSkills(); setNotice({ title: '技能已刷新', content: '已重新读取内置技能和本机自定义技能。' }); }}>刷新技能</button>
            </div>
            <div className="global-skill-grid">
              {visibleSkills.map(skill => <article className="global-skill-card" key={skill.id}>
                <div className="global-skill-card-header"><div><strong>{skill.displayName || skill.name}</strong><small>{skill.builtin ? '内置' : '自定义'} · {skillCategoryLabels[skill.category] || '未分类'}</small></div><span>{skill.tags.slice(0, 3).join(' · ') || '未分类'}</span></div>
                <p>{skill.description || '暂无描述'}</p>
                <details><summary>查看技能内容</summary><pre>{skill.content}</pre></details>
                <div className="global-card-actions"><button className="btn-secondary" onClick={() => openSkillEditor(skill)}>查看 / 编辑</button><button className="link-button danger-link" onClick={() => deleteSkill(skill)}>{skill.builtin ? '恢复默认' : '删除'}</button></div>
              </article>)}
              {!visibleSkills.length && <div className="empty-state"><p>没有匹配的技能。</p></div>}
            </div>
          </section>
        )}
        {activeTab === 'styles' && (
          <section className="global-management-page styles-management-page">
            <header className="page-header"><div><span className="page-eyebrow">全局写作资源</span><h2>文风管理</h2><p>新建或编辑文风 Skill。保存后可在每部小说的章节侧栏绑定使用。</p></div><button className="btn-primary" onClick={openNewWritingStyle}>+ 新建文风</button></header>
            <div className="global-style-workspace">
              <aside className="global-style-list"><div className="panel-section-title">全部文风 <span>{writingStyles.length}</span></div>{writingStyles.map(style => <button type="button" key={style.id} className={`writing-style-item ${styleDraft?.id === style.id ? 'active' : ''}`} onClick={() => setStyleDraft(style)}><strong>{style.name}</strong><small>{style.sourceBookId ? '拆书蒸馏' : '自定义'} · {style.tags.slice(0, 3).join('、') || '未分类'}</small></button>)}{!writingStyles.length && <p className="empty-hint">暂无文风，点击“新建文风”开始。</p>}</aside>
              <section className="global-style-editor">{styleDraft ? <div className="writing-style-editor"><div className="style-editor-heading"><div><span>Skill 文档</span><h3>{styleDraft.name || '未命名文风'}</h3></div><button className={`editor-tool-button ${showSearchPanel ? 'active' : ''}`} onClick={toggleSearchPanel}>搜索 / 替换</button></div><label>文风名称<input className="input" value={styleDraft.name} onChange={event => setStyleDraft({ ...styleDraft, name: event.target.value })} /></label><label>简短说明<input className="input" value={styleDraft.description} onChange={event => setStyleDraft({ ...styleDraft, description: event.target.value })} /></label>{renderDocumentSearchPanel('文风', styleDraft.content, content => setStyleDraft({ ...styleDraft, content }))}<label>Skill 内容<textarea className="style-content-editor" value={styleDraft.content} onChange={event => setStyleDraft({ ...styleDraft, content: event.target.value })} /></label><div className="style-editor-actions"><button className="btn-primary" onClick={saveWritingStyleDraft}>保存文风</button>{writingStyles.some(style => style.id === styleDraft.id) && <button className="link-button danger-link" onClick={() => deleteWritingStyle(styleDraft.id)}>删除</button>}</div></div> : <div className="empty-state"><p>选择一个文风，或新建文风开始编辑。</p></div>}</section>
            </div>
          </section>
        )}
        {activeTab === 'books' && (
          <div className="library-page">
            <header className="page-header library-page-header"><div><span className="page-eyebrow">本地资料库</span><h2>书籍管理</h2><p>搜索书名或作者后，系统会同时查询全部书源；从结果中选择要下载的来源。</p></div><div className="library-search"><input className="input" value={bookSearchQuery} onChange={event => setBookSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runBookSearch(); }} placeholder="搜索书名或作者" /><button className="btn-primary" onClick={() => void runBookSearch()} disabled={bookSearchLoading}>{bookSearchLoading ? '全书源搜索中...' : '搜索全部书源'}</button><button className="btn-secondary" onClick={() => txtImportInputRef.current?.click()}>导入 TXT</button><input ref={txtImportInputRef} type="file" accept=".txt,text/plain" hidden onChange={event => void importLibraryTxt(event)} /></div></header>
            {librarySearchResults.length > 0 && <section className="library-search-results"><div className="panel-section-title">全部书源结果 <span>{librarySearchResults.length}</span></div><div className="library-result-grid">{librarySearchResults.map(book => <article className="library-result-card" key={book.id}><strong>{book.title}</strong><span>{book.author} · 来源：{book.source}</span><p>{book.intro || '暂无简介'}</p><button className="btn-secondary" disabled={bookDownloadRunningId === book.id} onClick={() => void downloadLibraryBook(book)}>{bookDownloadRunningId === book.id ? '下载中...' : `从${book.source}下载`}</button></article>)}</div></section>}
            <div className="library-workspace">
              <aside className="library-list"><div className="panel-section-title">已下载书籍 <span>{libraryBooks.length}</span></div>{libraryBooks.length === 0 ? <p className="empty-hint">还没有下载书籍。可先搜索，或从扫榜管理下载。</p> : libraryBooks.map(book => <button type="button" key={book.id} className={`library-book-item ${book.id === activeLibraryBookId ? 'active' : ''}`} onClick={() => { setActiveLibraryBookId(book.id); setActiveLibraryChapterId(book.chapters[0]?.id || null); }}><strong>{book.title}</strong><small>{book.author} · {book.chapters.length} 章</small></button>)}</aside>
              {activeLibraryBook ? <section className="library-detail"><header className="library-detail-header"><div><span>{activeLibraryBook.source}</span><h3>{activeLibraryBook.title}</h3><small>{activeLibraryBook.author} · {activeLibraryBook.chapters.length} 章 · {activeLibraryBook.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0).toLocaleString()} 字</small></div><div className="library-detail-actions"><button className="link-button" onClick={() => void invoke<string>('open_library_book_location', { bookId: activeLibraryBook.id, bookTitle: activeLibraryBook.title }).catch(error => setNotice({ title: '打开书籍位置失败', content: String(error) }))}>打开位置</button>{activeLibraryBook.chapters.some(chapter => !chapter.downloaded) && <button className="link-button" disabled={libraryChapterDownloadRunningId === `book:${activeLibraryBook.id}`} onClick={() => void retryUnfinishedLibraryChapters(activeLibraryBook)}>{libraryChapterDownloadRunningId === `book:${activeLibraryBook.id}` ? '重新下载中...' : '重新下载未完成'}</button>}<button className="btn-primary library-dismantle-button" onClick={() => createDismantleFromLibrary(activeLibraryBook)}><span>拆</span>一键拆书</button><button className="link-button danger-link" onClick={() => void deleteLibraryBook(activeLibraryBook)}>删除</button></div></header><p className="library-intro">{activeLibraryBook.intro || '暂无简介'}</p><div className="library-reading-workspace"><div className="library-chapter-pane"><div className="library-chapter-pane-heading"><strong>章节目录</strong><span>{activeLibraryBook.chapters.length} 章</span></div><div className="library-chapter-list">{activeLibraryBook.chapters.map(chapter => <div className={`library-chapter-row ${chapter.id === activeLibraryChapter?.id ? 'active' : ''}`} key={chapter.id}><button type="button" className="library-chapter-select" onClick={() => setActiveLibraryChapterId(chapter.id)}><span>第 {chapter.number} 章</span><strong>{chapter.title}</strong><small>{chapter.wordCount.toLocaleString()} 字 · {chapter.downloaded ? '已下载' : '未下载'}</small></button>{!chapter.downloaded && <button type="button" className="library-chapter-retry" disabled={libraryChapterDownloadRunningId === chapter.id || libraryChapterDownloadRunningId === `book:${activeLibraryBook.id}`} onClick={() => void retryLibraryChapter(activeLibraryBook, chapter)}>{libraryChapterDownloadRunningId === chapter.id ? '下载中...' : '重新下载'}</button>}</div>)}</div></div><article className="library-reader">{activeLibraryChapter ? <><header className="library-reader-header"><div><span>第 {activeLibraryChapter.number} 章</span><h4>{activeLibraryChapter.title}</h4><small>{activeLibraryChapter.wordCount.toLocaleString()} 字</small></div><button className="btn-secondary" disabled={libraryOutlineRunningId === activeLibraryChapter.id || !activeLibraryChapter.content.trim()} onClick={() => void generateLibraryChapterOutline(activeLibraryBook, activeLibraryChapter)}>{libraryOutlineRunningId === activeLibraryChapter.id ? '生成章纲中...' : '生成章纲'}</button></header>{activeLibraryChapter.unavailableReason && <div className="library-chapter-warning">{activeLibraryChapter.unavailableReason}</div>}{activeLibraryChapter.content.trim() ? <pre className="library-reader-content">{activeLibraryChapter.content}</pre> : <div className="library-reader-empty">该章节没有可阅读的本地正文。</div>}{activeLibraryChapter.outline && <details className="library-reader-outline" open><summary>本章章纲</summary><pre>{activeLibraryChapter.outline}</pre></details>}</> : <div className="library-reader-empty">选择章节开始阅读。</div>}</article></div></section> : <div className="empty-state"><p>选择一本已下载书籍查看章节。</p></div>}
            </div>
          </div>
        )}
        {activeTab === 'books' && activeLibraryBook && activeLibraryChapter && !activeLibraryChapter.downloaded && (
          <button className="library-retry-chapter-button" disabled={libraryChapterDownloadRunningId === activeLibraryChapter.id} onClick={() => void retryLibraryChapter(activeLibraryBook, activeLibraryChapter)}>
            {libraryChapterDownloadRunningId === activeLibraryChapter.id ? '重新下载中...' : '重新下载本章'}
          </button>
        )}
        {activeTab === 'rankings' && (
          <div className="ranking-page">
            <header className="page-header"><div><span className="page-eyebrow">市场观察</span><h2>扫榜管理</h2><p>聚合番茄小说网、起点和飞卢榜单，选书后可下载或进入拆书流程。</p></div><div className="ranking-header-actions"><button className="btn-primary" onClick={() => void fetchRankingBooks()} disabled={rankingLoading}>{rankingLoading ? '拉取中...' : '刷新榜单'}</button></div></header>
            <div className="ranking-toolbar"><select className="select" aria-label="榜单平台" value={rankingPlatform} onChange={event => { const nextPlatform = event.target.value as RankingPlatform; setRankingPlatform(nextPlatform); setRankingBooks([]); if (nextPlatform === 'fanqie') { setFanqieSection('male-read'); setFanqieCategoryId('all'); setRankingType('read'); } else { setRankingType(rankingTypeOptions(nextPlatform)[0].value); } }}><option value="fanqie">番茄小说网</option><option value="qidian">起点中文网</option><option value="faloo">飞卢中文网</option></select>{rankingPlatform === 'fanqie' ? <><select className="select" aria-label="番茄榜单分类" value={fanqieSection} onChange={event => { setFanqieSection(event.target.value as FanqieSection); setFanqieCategoryId('all'); }} >{fanqieSectionOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><select className="select" aria-label="番茄题材分类" value={fanqieCategoryId} onChange={event => setFanqieCategoryId(event.target.value)} disabled={fanqieCategoriesLoading}><option value="all">{fanqieCategoriesLoading ? '分类加载中...' : '总榜'}</option>{(fanqieCategories[fanqieSection] || []).filter(category => category.id !== 'all').map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select></> : <select className="select" value={rankingType} onChange={event => setRankingType(event.target.value as RankingType)}>{rankingTypeOptions(rankingPlatform).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}<input className="input" value={rankingQuery} onChange={event => setRankingQuery(event.target.value)} placeholder="筛选书名、作者、分类" />{rankingSourceName && <span className="ranking-source-label">数据来源：{rankingSourceName}</span>}</div>
            {visibleRankingBooks.length === 0 ? <div className="empty-state"><p>选择平台后点击“刷新榜单”。</p></div> : <div className="ranking-grid">{visibleRankingBooks.map(book => <article className="ranking-book-card" key={book.id}><div className="ranking-book-rank">{book.rank}</div><div className={`ranking-book-cover ${book.cover ? 'has-image' : ''}`}><span>{book.title.trim().slice(0, 1) || '书'}</span>{book.cover && <img src={book.cover} alt={`${book.title}封面`} loading="lazy" onError={event => event.currentTarget.parentElement?.classList.remove('has-image')} />}</div><div className="ranking-book-copy"><h3>{book.title}</h3><span>{book.author} · {book.category || '未分类'}</span><p>{book.intro || '暂无简介'}</p><small>{book.wordCount ? `${book.wordCount.toLocaleString()} 字` : '字数未知'}{book.readCount ? ` · ${book.readCount.toLocaleString()} 热度` : ''}</small><div className="ranking-book-actions"><button className="btn-secondary" disabled={bookDownloadRunningId === book.id} onClick={() => void downloadLibraryBook(book)}>{bookDownloadRunningId === book.id ? '下载中...' : '一键下载 TXT'}</button><button className="link-button" onClick={async () => { const downloaded = libraryBooks.find(item => item.title === book.title); const ready = downloaded || await downloadLibraryBook(book); if (ready) createDismantleFromLibrary(ready); }}>{bookDownloadRunningId === book.id ? '处理中...' : '一键拆书'}</button></div></div></article>)}</div>}
          </div>
        )}
        {activeTab === 'dismantles' && (
          <div className="dismantle-page">
            <header className="page-header dismantle-page-header">
              <div><span className="page-eyebrow">本地资料库</span><h2>拆书管理</h2><p>从书籍管理选择已下载小说，逐章提炼剧情结构，再生成独立原创章节。</p></div>
              <button className="btn-secondary" onClick={() => setActiveTab('books')}>去书籍管理下载</button>
            </header>
            {dismantleBooks.length === 0 ? <div className="dismantle-empty"><div className="dismantle-empty-mark">拆</div><h3>还没有拆书资料</h3><p>请先在书籍管理下载小说，再选择“加入拆书管理”。</p><button className="btn-primary" onClick={() => setActiveTab('books')}>选择本地书籍</button></div> : <div className="dismantle-workspace">
              <aside className="dismantle-library">
                <div className="dismantle-library-heading"><div><strong>拆书书库</strong><small>{dismantleBooks.length} 部作品</small></div><button className="link-button" onClick={() => setActiveTab('books')}>选择书籍</button></div>
                <div className="dismantle-book-list">{dismantleBooks.map(book => <button type="button" key={book.id} className={`dismantle-book-item ${book.id === activeDismantleBookId ? 'active' : ''}`} onClick={() => { setActiveDismantleBookId(book.id); setActiveDismantleChapterId(book.chapters[0]?.id || null); setSelectedDismantleChapterIds(book.chapters.slice(0, 1).map(chapter => chapter.id)); }}><div><strong>{book.title}</strong><small>{book.chapters.length} 章 · {book.chapters.filter(chapter => chapter.status === 'analyzed' || chapter.status === 'rewritten').length} 章已分析</small>{book.boundProjectId && <em>已绑定小说</em>}</div></button>)}</div>
              </aside>
              {activeDismantleBook && <section className="dismantle-detail">
                <header className="dismantle-detail-header"><div><span>拆书资料</span><h3>{activeDismantleBook.title}</h3><small>{activeDismantleBook.chapters.length} 章 · {activeDismantleBook.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0).toLocaleString()} 字</small></div><div className="dismantle-detail-actions"><button className="link-button" onClick={() => void invoke<string>('open_dismantle_location', { bookTitle: activeDismantleBook.title }).catch(error => setNotice({ title: '打开拆书位置失败', content: String(error) }))}>打开位置</button><button className="link-button danger-link" onClick={() => void deleteDismantleBook(activeDismantleBook)}>删除</button></div></header>
                <div className="dismantle-detail-toolbar"><label>绑定目标小说<select className="select" value={activeDismantleBook.boundProjectId?.toString() || ''} onChange={event => bindDismantleToProject(activeDismantleBook.id, event.target.value ? Number(event.target.value) : undefined)}><option value="">暂不绑定</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><button className="btn-secondary" onClick={() => startDismantleImitation(activeDismantleBook)}>一键仿写此书</button><button className="btn-secondary" disabled={styleDistilling} onClick={() => void distillDismantleStyle()}>{styleDistilling ? '蒸馏中...' : '蒸馏文风 Skill'}</button><button className="btn-primary" disabled={Boolean(dismantleRunningIds.length)} onClick={() => void runDismantleAnalysis()}>{dismantleRunningIds.length ? `分析中 ${dismantleRunningIds.length} 章` : `生成选中章纲（${selectedDismantleChapterIds.length}）`}</button></div>
                <div className="dismantle-detail-body">
                  <div className="dismantle-chapter-list"><div className="dismantle-list-heading"><strong>章节选择</strong><button className="link-button" onClick={() => setSelectedDismantleChapterIds(activeDismantleBook.chapters.map(chapter => chapter.id))}>全选</button><button className="link-button" onClick={() => setSelectedDismantleChapterIds([])}>清空</button></div>{activeDismantleBook.chapters.map(chapter => <label key={chapter.id} className={`dismantle-chapter-row ${chapter.id === activeDismantleChapterId ? 'active' : ''}`}><input type="checkbox" checked={selectedDismantleChapterIds.includes(chapter.id)} onChange={() => setSelectedDismantleChapterIds(current => current.includes(chapter.id) ? current.filter(id => id !== chapter.id) : [...current, chapter.id])} /><button type="button" onClick={() => setActiveDismantleChapterId(chapter.id)}><strong>第 {chapter.number} 章</strong><span>{chapter.title}</span><small>{chapter.wordCount.toLocaleString()} 字 · {chapter.status === 'rewritten' ? '已改写' : chapter.status === 'analyzed' ? '已分析' : chapter.status === 'analyzing' ? '分析中' : '待分析'}</small></button></label>)}</div>
                  {activeDismantleChapter && <article className="dismantle-chapter-editor"><div className="dismantle-chapter-heading"><div><span>第 {activeDismantleChapter.number} 章</span><h4>{activeDismantleChapter.title}</h4></div><button className="btn-secondary" onClick={() => void runDismantleRewrite()} disabled={dismantleRewriteRunning || !activeDismantleChapter.detailedOutline.trim()}>{dismantleRewriteRunning ? '原创生成中...' : '根据章纲生成原创稿'}</button></div><div className="dismantle-analysis-grid"><div><strong>剧情摘要</strong><textarea value={activeDismantleChapter.summary} onChange={event => updateDismantleBook(activeDismantleBook.id, book => ({ ...book, chapters: book.chapters.map(item => item.id === activeDismantleChapter.id ? { ...item, summary: event.target.value, updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }))} placeholder="分析后显示剧情摘要" /></div><div><strong>节奏判断</strong><textarea value={activeDismantleChapter.pacing} onChange={event => updateDismantleBook(activeDismantleBook.id, book => ({ ...book, chapters: book.chapters.map(item => item.id === activeDismantleChapter.id ? { ...item, pacing: event.target.value, updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }))} placeholder="开场、发展、转折、收束" /></div></div><label className="dismantle-outline-field"><strong>章节细纲（可人工修改）</strong><textarea value={activeDismantleChapter.detailedOutline} onChange={event => updateDismantleBook(activeDismantleBook.id, book => ({ ...book, chapters: book.chapters.map(item => item.id === activeDismantleChapter.id ? { ...item, detailedOutline: event.target.value, status: event.target.value.trim() ? 'analyzed' : 'pending', updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }))} placeholder="选择章节后点击生成章纲" /></label><details className="dismantle-source-details"><summary>查看原文（只读）</summary><pre>{activeDismantleChapter.sourceContent}</pre></details><label className="dismantle-outline-field"><strong>原创改写稿（确认前可编辑）</strong><textarea value={activeDismantleChapter.rewriteContent} onChange={event => updateDismantleBook(activeDismantleBook.id, book => ({ ...book, chapters: book.chapters.map(item => item.id === activeDismantleChapter.id ? { ...item, rewriteContent: event.target.value, status: event.target.value.trim() ? 'rewritten' : item.detailedOutline.trim() ? 'analyzed' : 'pending', updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }))} placeholder="AI 生成后可人工修改，确认后生成到目标小说" /></label><div className="dismantle-rewrite-footer"><input className="input" value={dismantleRewriteInstruction} onChange={event => setDismantleRewriteInstruction(event.target.value)} placeholder="原创改写要求（可选）" />{activeDismantleBook.boundProjectId && <button className="btn-primary" onClick={() => void generateDismantleChapter()}>确认并生成目标章节</button>}</div></article>}
                </div>
              </section>}
            </div>}
          </div>
        )}

      </main>

      {!editingProject && notice && (
        <div className="app-notice" role="status" aria-live="polite">
          <div className="app-notice-copy">
            <strong>{notice.title}</strong>
            <span>{notice.content}</span>
          </div>
          <button className="app-notice-close" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      {showNewSkillModal && (
        <div className="modal-overlay" onClick={() => setShowNewSkillModal(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="skill-modal-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="skill-modal-title">{skillEditingId === null ? '新建技能' : '编辑技能'}</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowNewSkillModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-group"><label>技能名称 *</label><input type="text" className="input" placeholder="例如：场景切换" value={newSkill.name} onChange={(event) => setNewSkill({ ...newSkill, name: event.target.value })} /></div>
              <div className="form-group"><label>分类</label><select className="select" value={newSkill.category} onChange={(event) => setNewSkill({ ...newSkill, category: event.target.value })}><option value="setup">项目设置</option><option value="write">写作</option><option value="review">审查</option><option value="polish">润色</option><option value="import">导入</option><option value="analyze">分析</option><option value="tool">工具</option><option value="creator">创建器</option></select></div>
              <div className="form-group"><label>简短描述</label><input type="text" className="input" placeholder="一句话描述这个技能" value={newSkill.description} onChange={(event) => setNewSkill({ ...newSkill, description: event.target.value })} /></div>
              <div className="form-group"><label>详细内容 *</label><textarea className="textarea" rows={6} placeholder="详细说明如何使用这个技能..." value={newSkill.content} onChange={(event) => setNewSkill({ ...newSkill, content: event.target.value })} /></div>
              <div className="form-group"><label>标签（逗号分隔）</label><input type="text" className="input" placeholder="场景,过渡,技巧" value={newSkill.tags} onChange={(event) => setNewSkill({ ...newSkill, tags: event.target.value })} /></div>
              <div className="skill-creator-actions"><button className="btn-secondary" onClick={generateSkillWithAI} disabled={skillGenerating}>{skillGenerating ? '生成中...' : 'AI 生成技能草稿'}</button><span>可先填写一句需求，再由 skill-creator 补全步骤和输出格式。</span></div>
            </div>
            <div className="modal-footer"><button className="btn-secondary" onClick={() => setShowNewSkillModal(false)}>取消</button><button className="btn-primary" onClick={handleCreateSkill}>{skillEditingId === null ? '创建' : '保存修改'}</button></div>
          </div>
        </div>
      )}
      </>
      )}

      {showSettingsModal && (
        <div className="modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="settings-title">设置</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowSettingsModal(false)}>×</button>
            </div>
            <div className="settings-layout">
              <nav className="settings-sidebar" aria-label="设置分类">
                <button className={settingsSection === 'model' ? 'active' : ''} onClick={() => setSettingsSection('model')}><strong>AI 模型配置</strong><small>服务、接口、密钥与模型参数</small></button>
                <button className={settingsSection === 'writing' ? 'active' : ''} onClick={() => setSettingsSection('writing')}><strong>写作设置</strong><small>章节记忆与自动检索范围</small></button>
                <button className={settingsSection === 'network' ? 'active' : ''} onClick={() => setSettingsSection('network')}><strong>网络设置</strong><small>代理连接与本地地址规则</small></button>
                <button className={settingsSection === 'usage' ? 'active' : ''} onClick={() => setSettingsSection('usage')}><strong>API 用量</strong><small>余额、模型价格与个人日志</small></button>
                <button className={settingsSection === 'sync' ? 'active' : ''} onClick={() => setSettingsSection('sync')}><strong>备份与同步</strong><small>百度网盘云端备份与恢复</small></button>
                <button className={settingsSection === 'support' ? 'active' : ''} onClick={() => setSettingsSection('support')}><strong>联系与支持</strong><small>加入 QQ 群，获取帮助与公告</small></button>
                <button className={settingsSection === 'tutorial' ? 'active' : ''} onClick={() => setSettingsSection('tutorial')}><strong>使用教程</strong><small>快速了解核心工作流</small></button>
              </nav>
            <div className="modal-body settings-content">
              {settingsSection === 'model' && <>
              <section className="settings-service-card">
                <div className="settings-service-header">
                  <button className="settings-collapse-button" aria-label={settingsServiceExpanded ? '收起服务配置' : '展开服务配置'} onClick={() => setSettingsServiceExpanded(current => !current)}>{settingsServiceExpanded ? '⌄' : '›'}</button>
                  <div className="settings-service-title">
                    <strong>AI 模型配置</strong>
                    <span>服务、接口、密钥与模型参数</span>
                  </div>
                  <label className="settings-toggle" title="启用此服务">
                    <input type="checkbox" checked={settingsDraft.enabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, enabled: event.target.checked })} />
                    <span />
                  </label>
                </div>
                {settingsServiceExpanded && <div className="settings-service-content">
                  <div className="form-group">
                    <label>服务名称</label>
                    <input className="input" value={settingsDraft.serviceName} onChange={(event) => setSettingsDraft({ ...settingsDraft, serviceName: event.target.value })} placeholder="服务名称" />
                  </div>
                  <div className="form-group">
                    <label>API 模式</label>
                    <div className="settings-segmented-control">
                      <span className="settings-fixed-mode">OpenAI 兼容接口（所有模型统一使用）</span>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>接口地址 <small>固定官方服务</small></label>
                    <input className="input settings-fixed-address" value={defaultBaseURL} readOnly aria-readonly="true" />
                  </div>
                  <div className="form-group">
                    <label>API 密钥 <small>{(settingsDraft.apiKeys || []).filter(Boolean).length} 个</small></label>
                    <input className="input" type="password" value={settingsDraft.apiKey} placeholder="请输入主 API Key" onChange={(event) => updatePrimaryApiKey(event.target.value)} />
                    {(settingsDraft.apiKeys || []).length > 1 && <div className="settings-key-tags">{settingsDraft.apiKeys.map((key, index) => <span key={`${key}-${index}`} className={index === 0 ? 'active' : ''}>Key {index + 1} · {key.slice(0, 4)}••••{key.slice(-4)}<button aria-label={`移除 Key ${index + 1}`} onClick={() => removeApiKey(index)}>×</button></span>)}</div>}
                    <div className="model-add-row"><input className="input" type="password" value={customApiKey} placeholder="添加备用供应商 Key" onChange={(event) => setCustomApiKey(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addApiKey(); } }} /><button className="btn-secondary" onClick={addApiKey}>添加 Key</button></div>
                  </div>
                  <div className="form-group model-management">
                    <label>模型标签 <small>可多选 · 当前模型：{settingsDraft.model || '未选择'}</small></label>
                    <div className="settings-model-tags">
                      {settingsModels.map(model => <button key={model} className={`settings-model-tag ${settingsDraft.model === model ? 'active' : ''}`} onClick={() => setCurrentSettingsModel(model)} title="点击设为当前模型"><span>{model}</span><b aria-label={`移除 ${model}`} onClick={(event) => { event.stopPropagation(); toggleSettingsModel(model); }}>×</b></button>)}
                      {!settingsModels.length && <span className="settings-model-empty">暂无启用模型</span>}
                    </div>
                    <div className="settings-model-selection" aria-label="启用模型列表">
                      <span>启用模型</span>
                      {Array.from(new Set([...settingsModels, ...fetchedModels])).map(model => <label key={`select-${model}`}><input type="checkbox" checked={settingsModels.includes(model)} onChange={() => toggleSettingsModel(model)} /><span>{model}</span><button type="button" onClick={() => setCurrentSettingsModel(model)}>设为当前</button></label>)}
                    </div>
                    <div className="model-add-row">
                      <input className="input" value={customModelName} placeholder="输入模型 ID，回车添加" onChange={(event) => setCustomModelName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomModel(); } }} />
                      <button className="btn-secondary" onClick={addCustomModel}>添加</button>
                    </div>
                    {fetchedModels.length > 0 && <div className="settings-fetched-models"><span>接口返回模型</span><div>{fetchedModels.map(model => <button key={model} className={settingsModels.includes(model) ? 'added' : ''} disabled={settingsModels.includes(model)} onClick={() => addSettingsModel(model)}>{settingsModels.includes(model) ? '✓ ' : '+ '}{model}</button>)}</div></div>}
                    <div className="settings-model-actions">
                      <button className="btn-secondary" onClick={pullModels} disabled={modelsLoading}>{modelsLoading ? '拉取中...' : '拉取模型'}</button>
                      <button className="btn-secondary" onClick={testSelectedModel} disabled={modelsTesting || !settingsDraft.model.trim()}>{modelsTesting ? '测试中...' : '测试模型'}</button>
                    </div>
                    {modelListMessage && <p className={`model-list-message ${modelListMessage.includes('失败') || modelListMessage.includes('错误') ? 'error' : ''}`}>{modelListMessage}</p>}
                  </div>
                  <div className="settings-grid-two">
                    <div className="form-group"><label>上下文窗口 <strong>{Number(settingsDraft.contextWindow).toLocaleString()} KB</strong></label><input className="settings-range" type="range" min="16" max="512" step="16" value={settingsDraft.contextWindow} onChange={(event) => setSettingsDraft({ ...settingsDraft, contextWindow: Number(event.target.value) })} /></div>
                    <div className="form-group"><label>推理模式</label><select className="select" value={settingsDraft.reasoningMode} onChange={(event) => setSettingsDraft({ ...settingsDraft, reasoningMode: event.target.value as ReasoningMode })}><option value="auto">自动</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="max">最大</option><option value="custom">自定义</option></select></div>
                  </div>
                </div>}
              </section>
              </>}
              {settingsSection === 'writing' && <section className="settings-network-card settings-network-panel">
                <div className="settings-network-header"><div><strong>章节写作上下文</strong><small>上一章始终自动带入，更早章节压缩为一份摘要</small></div><span className="settings-sync-badge">省 Token</span></div>
                <div className="form-group">
                  <label>前章记忆摘要数量 <strong>{settingsDraft.memorySummaryChapterCount} 章</strong></label>
                  <input className="settings-range" type="range" min="0" max="20" step="1" value={settingsDraft.memorySummaryChapterCount} onChange={event => setSettingsDraft({ ...settingsDraft, memorySummaryChapterCount: Number(event.target.value) })} />
                  <small className="settings-network-note">读取上一章之前的最近 N 章结构化记忆并合并为一个稳定摘要。设为 0 表示关闭；不会加载更早章节正文。</small>
                </div>
                <div className="settings-context-preview"><span>固定上下文顺序</span><strong>世界观与作品设定 → 文风与技能 → 上一章正文/记忆 → 前章摘要 → 当前章纲与指令</strong></div>
              </section>}
              {settingsSection === 'network' && <section className="settings-network-card settings-network-panel">
                <div className="settings-network-header"><div><strong>网络设置</strong><small>为模型请求配置代理连接</small></div><label className="settings-toggle" title="启用网络代理"><input type="checkbox" checked={settingsDraft.proxyEnabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, proxyEnabled: event.target.checked })} /><span /></label></div>
                <div className="settings-network-address"><input className="input" value={settingsDraft.proxyURL} disabled={!settingsDraft.proxyEnabled} placeholder="http://127.0.0.1:7897" onChange={(event) => setSettingsDraft({ ...settingsDraft, proxyURL: event.target.value })} /><button className="btn-secondary" onClick={useSystemProxy}>读取系统代理</button></div>
                <label className="settings-network-check"><input type="checkbox" checked={settingsDraft.proxyBypassLocal} onChange={(event) => setSettingsDraft({ ...settingsDraft, proxyBypassLocal: event.target.checked })} /> 本地地址不走代理（推荐）</label>
                <small className="settings-network-note">支持 HTTP/HTTPS 代理，例如 Clash、Surge、V2Ray 的本地 HTTP 端口。</small>
              </section>}
              {settingsSection === 'usage' && <section className="usage-dashboard">
                <div className="usage-filter-bar"><div className="usage-range-checks">{[['all', '全部时间'], ['today', '今天'], ['1', '近 1 天'], ['7', '近 7 天'], ['14', '近 14 天'], ['30', '近 30 天']].map(([value, label]) => <button type="button" key={value} className={!usageStartDate && !usageEndDate && usageDateFilter === value ? 'active' : ''} onClick={() => { setUsageStartDate(''); setUsageEndDate(''); setUsageDateFilter(value); }}>{label}</button>)}</div><div className="usage-date-controls"><label>开始<input type="date" value={usageStartDate} onChange={event => { setUsageStartDate(event.target.value); setUsageDateFilter('custom'); }} /></label><span>至</span><label>结束<input type="date" value={usageEndDate} onChange={event => { setUsageEndDate(event.target.value); setUsageDateFilter('custom'); }} /></label><button className="link-button" onClick={() => { setUsageStartDate(''); setUsageEndDate(''); setUsageDateFilter('all'); }}>重置</button></div></div>
                <div className="gateway-usage-heading"><div><strong>ApiSaver 中转站用量</strong><small>余额、模型广场定价与日志均直接来自中转站；仅使用当前配置的 API Key 查询。</small></div><button className="btn-secondary" disabled={gatewayUsageLoading} onClick={() => void refreshGatewayUsage()}>{gatewayUsageLoading ? '刷新中...' : '刷新中转站数据'}</button></div>
                {gatewayUsageError && <p className="model-list-message error">{gatewayUsageError}</p>}
                {gatewayUsage?.errors.length ? <p className="model-list-message error">{gatewayUsage.errors.join('；')}</p> : null}
                {gatewayUsage && <>
                  <div className="gateway-balance-grid">{gatewayUsage.accounts.map(account => {
                    const available = Number(account.usage?.total_available ?? 0);
                    const used = Number(account.usage?.total_used ?? 0);
                    const unlimited = account.usage?.unlimited_quota === true;
                    const amount = (quota: number) => gatewayCurrency === 'TOKENS' ? quota.toLocaleString() : formatGatewayCurrency(quota / gatewayQuotaPerUnit);
                    return <article key={`${account.keyHint}-${account.keyIndex}`} className="gateway-balance-card"><header><strong>Key {account.keyIndex + 1}</strong><span>{account.keyHint}</span></header>{account.error ? <small className="gateway-card-error">{account.error}</small> : <><b>{unlimited ? '不限额' : amount(available)}</b><small>可用余额 · 已用 {amount(used)}</small><small>{String(account.usage?.name || '当前 API Key')}</small></>}</article>;
                  })}</div>
                  <section className="gateway-pricing"><div className="gateway-section-heading"><h4>当前启用模型价格</h4><small>直接按中转站的模型定价与分组倍率计算 · 已按输入价从低到高排序</small></div>{gatewayPricing.length ? <div className="gateway-price-table"><div className="gateway-price-row gateway-price-head"><span>模型 / Key</span><span>分组</span><span>计费类型</span><span>输入</span><span>输出</span><span>缓存读取</span><span>缓存写入</span></div>{gatewayPricing.map(item => {
                    const account = item.__account;
                    const group = item.__group || '未返回';
                    const groupRatio = Number(item.__groupRatio);
                    const dynamicTiers = String(item.billing_mode || '') === 'tiered_expr' ? parseDynamicTiers(String(item.billing_expr || '')) : [];
                    const dynamic = dynamicTiers.length > 0;
                    const primaryTier = dynamicTiers[0];
                    const price = (kind: 'input' | 'output' | 'cache' | 'write', dynamicName: string) => dynamic ? dynamicTierPrice(primaryTier.formula, dynamicName, groupRatio) : staticGatewayPrice(item, kind, groupRatio);
                    return <div key={`${String(item.model_name)}-${String(account.keyIndex)}-${group}`} className="gateway-price-row"><strong>{String(item.model_name || '-')}<small>{account.keyHint || ''}</small></strong><span title={item.__groupKnown ? '中转站返回的 Key 分组' : '中转站的只读 API 未返回该 Key 固定分组，列出该模型可用分组价格'}>{group} · {groupRatio}x{item.__groupKnown ? '' : '（可用）'}</span><span>{dynamic ? `动态分档${dynamicTiers.length > 1 ? `（${primaryTier.label}）` : ''}` : Number(item.quota_type) === 1 ? '按次' : '按 Token'}</span><span>{price('input', '输入')}</span><span>{price('output', '输出')}</span><span>{price('cache', '缓存读取')}</span><span>{price('write', '缓存写入')}</span>{dynamic && <small className="gateway-dynamic-formula" title={String(item.billing_expr || '')}>{dynamicTiers.map(tier => `${tier.label}: ${tier.formula}`).join(' | ')}</small>}</div>;
                  })}</div> : <p className="empty-hint compact">中转站暂未返回已启用模型的定价。请先刷新模型列表或检查 Key 权限。</p>}<small className="gateway-fetched-at">说明：中转站公开的 API Key 用量接口未公开 Token 固定分组时，以上会列出该模型的可用分组价格，不会错误按 1x 伪造为实际价格。</small></section>
                  <section className="gateway-logs"><div className="gateway-section-heading"><h4>中转站使用日志</h4><small>只显示当前 API Key 的日志 · {gatewayLogs.length} 条</small></div>{gatewayLogs.length ? <div className="gateway-log-table"><div className="gateway-log-row gateway-log-head"><span>时间</span><span>令牌</span><span>模型</span><span>流</span><span>Tokens</span><span>费用</span><span>耗时</span><span>详情</span></div>{gatewayLogs.map((log, index) => <div key={`${String(log.__keyIndex)}-${String(log.id || index)}-${String(log.created_at || '')}`} className="gateway-log-row"><span>{gatewayLogTime(log) ? new Date(gatewayLogTime(log)).toLocaleString('zh-CN', { hour12: false }) : '-'}</span><span>{String(log.token_name || log.__keyHint || '-')}</span><strong>{String(log.model_name || '-')}</strong><span>{log.is_stream === true ? '流' : '非流'}</span><span>{Number(log.prompt_tokens || 0).toLocaleString()} / {Number(log.completion_tokens || 0).toLocaleString()}</span><span>{gatewayCurrency === 'TOKENS' ? Number(log.quota || 0).toLocaleString() : formatGatewayCurrency(Number(log.quota || 0) / gatewayQuotaPerUnit)}</span><span>{Number(log.use_time || 0).toFixed(1)}s</span><span title={String(log.other || log.content || '')}>{String(log.content || log.group || '-')}</span></div>)}</div> : <p className="empty-hint compact">筛选时间内没有中转站使用日志，或该 Key 未开放日志查询。</p>}</section>
                  <small className="gateway-fetched-at">中转站数据更新于 {new Date(gatewayUsage.fetchedAt).toLocaleString('zh-CN', { hour12: false })}；本机统计仅作为离线回退，不参与上方账单。</small>
                </>}
                <details className="local-usage-details"><summary>本机应用统计（离线回退）</summary><div className="usage-total"><span>{usageDateFilter === 'all' ? '全部时间本机处理 Tokens' : '筛选时间本机处理 Tokens'}</span><strong>{usageView.totalTokens.toLocaleString()}</strong><small>请求 {usageView.requests} 次</small></div><div className="usage-metrics"><div><span>输入</span><b>{usageView.inputTokens.toLocaleString()}</b></div><div><span>输出</span><b>{usageView.outputTokens.toLocaleString()}</b></div><div><span>缓存命中</span><b>{usageView.cachedInputTokens.toLocaleString()}</b></div><div><span>缓存命中率</span><b>{usageView.inputTokens ? `${((usageView.cachedInputTokens / usageView.inputTokens) * 100).toFixed(1)}%` : '--'}</b></div></div><div className="usage-day-list"><h4>按天统计</h4>{usageRows.sort((a, b) => b.date.localeCompare(a.date)).map(day => <div className="usage-day-row" key={day.date}><strong>{day.date}</strong><span>{day.totalTokens.toLocaleString()} tokens</span><span>缓存 {day.cachedInputTokens.toLocaleString()}</span><b>{day.inputTokens ? `${((day.cachedInputTokens / day.inputTokens) * 100).toFixed(1)}%` : '--'}</b></div>)}</div></details>
              </section>}
              {settingsSection === 'sync' && <section className="settings-sync-card">
                <div className="settings-network-header"><div><strong>百度网盘完整备份与同步</strong><small>备份所有写作资料与本机配置，安装新应用后可直接恢复</small></div><span className="settings-sync-badge">完整快照</span></div>
                <label className="form-group settings-sync-path"><span>云端备份目录</span><input className="input" value={cloudRemotePath} onChange={event => setCloudRemotePath(event.target.value)} placeholder="ApiSaverWriter/backup" /><small>使用相对路径，不要填写 /apps/bdpan 前缀。</small></label>
                <div className="settings-sync-actions"><button className="btn-secondary" disabled={cloudSyncRunning} onClick={() => void checkCloudSyncStatus()}>{cloudSyncRunning ? '处理中...' : '检查登录状态'}</button><button className="btn-secondary" disabled={cloudSyncRunning} onClick={() => void beginBaiduLogin()}>登录百度网盘</button><button className="btn-primary" disabled={cloudSyncRunning} onClick={() => void backupToCloud()}>备份到百度网盘</button><button className="btn-secondary" disabled={cloudSyncRunning} onClick={() => void loadCloudBackups()}>选择备份恢复</button></div>
                {baiduAuthURL && <div className="settings-baidu-auth"><strong>完成授权</strong><small>{isDirectBaiduRuntime() ? '复制以下链接到浏览器完成授权，再粘贴浏览器地址栏中的完整授权结果或 access_token。' : '复制以下链接到浏览器完成授权，再粘贴页面显示的 32 位授权码。'}</small><div className="settings-baidu-url"><input className="input" value={baiduAuthURL} readOnly aria-label="百度网盘授权链接" /><button className="btn-secondary" onClick={() => void copyText(baiduAuthURL)}>复制链接</button></div><div><input className="input" type="password" value={baiduAuthCode} onChange={event => setBaiduAuthCode(event.target.value)} placeholder={isDirectBaiduRuntime() ? '粘贴完整授权结果或 access_token' : '粘贴 32 位授权码'} autoComplete="off" /><button className="btn-primary" disabled={cloudSyncRunning} onClick={() => void confirmBaiduLogin()}>确认登录</button></div></div>}
                {cloudSyncMessage && <p className={`model-list-message ${/失败|错误|未找到|未登录/iu.test(cloudSyncMessage) ? 'error' : ''}`}>{cloudSyncMessage}</p>}
                <p className="settings-network-note">备份范围：小说及章节/大纲/记忆/卡片/知识图谱、书籍管理、拆书、扫榜缓存、文风、技能、API 与网络配置、用量统计和禁词。同步只操作应用自己的 /apps/bdpan/ 目录；恢复会替换对应本地数据并重新载入。</p>
              </section>}
              {settingsSection === 'support' && <section className="settings-support-card">
                <div className="settings-support-hero"><div className="settings-support-icon" aria-hidden="true">群</div><div><strong>联系与支持</strong><small>加入官方 QQ 群，获取版本更新、使用帮助和问题反馈支持。</small></div></div>
                <div className="settings-support-group"><div><span>官方 QQ 交流群</span><strong>1019592334</strong><small>点击后打开官方 QQ 群页面，并自动复制群号。</small></div><button className="btn-primary" onClick={() => void openQQGroup()}>加入 QQ 群</button></div>
                <div className="settings-support-group settings-customer-group"><div><span>唯一客服 QQ</span><strong>2805099052</strong><small>充值或账号问题请联系唯一客服，谨防冒充。</small></div><button className="btn-secondary" onClick={() => void openCustomerQQ()}>联系客服</button></div>
                <div className="settings-support-notice"><strong>系统公告</strong><p>请在反馈问题时附上应用版本、运行平台和可复现步骤。我们会在群公告同步版本变更与维护通知。若网站无法充值，请联系客服充值。</p></div>
              </section>}
              {settingsSection === 'tutorial' && <section className="settings-tutorial-card">
                <div className="settings-tutorial-heading"><strong>使用教程</strong><small>官方飞书文档会持续更新最新功能说明与操作步骤。</small></div>
                <div className="settings-support-group settings-tutorial-link"><div><span>ApiSaverWriter 使用教程</span><strong>飞书文档</strong><small>点击后在浏览器打开完整教程。</small></div><button className="btn-primary" onClick={() => void openTutorial()}>打开教程</button></div>
              </section>}
              <p className="settings-hint">保存后，编辑器中的 AI 智能体会使用模型与网络配置。密钥仅保存到本机。</p>
            </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowSettingsModal(false)}>取消</button>
              <button className="btn-primary" onClick={saveSettings}>保存设置</button>
            </div>
          </div>
        </div>
      )}

      {showSupportAnnouncement && (
        <div className="modal-overlay support-announcement-overlay" onClick={() => dismissSupportAnnouncement()}>
          <div className="modal support-announcement-modal" role="dialog" aria-modal="true" aria-labelledby="support-announcement-title" onClick={(event) => event.stopPropagation()}>
            <div className="support-announcement-brand"><span className="support-announcement-mark" aria-hidden="true">ASW</span><div><strong>ApiSaverWriter</strong><small>系统公告</small></div><button className="modal-close" aria-label="关闭" onClick={() => dismissSupportAnnouncement()}>×</button></div>
            <div className="support-announcement-tabs" role="tablist" aria-label="公告栏目"><button role="tab" aria-selected={announcementTab === 'notice'} className={announcementTab === 'notice' ? 'active' : ''} onClick={() => setAnnouncementTab('notice')}>公告</button><button role="tab" aria-selected={announcementTab === 'timeline'} className={announcementTab === 'timeline' ? 'active' : ''} onClick={() => setAnnouncementTab('timeline')}>更新记录</button></div>
            <div className="support-announcement-body">
              {announcementTab === 'notice' ? <><span className="support-announcement-kicker">欢迎使用 ApiSaverWriter</span><h3 id="support-announcement-title">写作资料、智能体与备份，都在一个工作台完成</h3><p>建议首次使用先在设置中完成模型配置，再创建作品并生成世界观。遇到模型、同步或数据恢复问题，可加入官方 QQ 群获得支持。</p><div className="support-announcement-callout"><strong>官方支持群</strong><span>1019592334</span><button className="btn-primary" onClick={() => void openQQGroup()}>加入 QQ 群</button></div><div className="support-announcement-contact"><span>唯一客服 QQ：<strong>2805099052</strong></span><button className="btn-secondary" onClick={() => void openCustomerQQ()}>联系客服</button></div></> : <><span className="support-announcement-kicker">最近更新</span><div className="support-announcement-timeline"><div><b>设置中心</b><span>新增联系与支持、使用教程入口。</span></div><div><b>数据安全</b><span>百度网盘支持完整应用备份与手动选择恢复版本。</span></div><div><b>智能写作</b><span>章节、大纲和卡片支持连续会话与流式生成。</span></div></div></>}
            </div>
            <div className="support-announcement-footer"><label><input type="checkbox" checked={announcementDontShow} onChange={(event) => setAnnouncementDontShow(event.target.checked)} /> 下次不再自动显示</label><button className="btn-secondary" onClick={() => dismissSupportAnnouncement(announcementDontShow)}>稍后查看</button><button className="btn-primary" onClick={() => { dismissSupportAnnouncement(true); setShowSettingsModal(true); setSettingsSection('support'); }}>打开联系与支持</button></div>
          </div>
        </div>
      )}

      {showCloudBackupPicker && (
        <div className="modal-overlay cloud-backup-picker-overlay" onClick={() => setShowCloudBackupPicker(false)}>
          <div className="modal cloud-backup-picker" role="dialog" aria-modal="true" aria-labelledby="cloud-backup-picker-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div><h3 id="cloud-backup-picker-title">选择云端备份</h3><small className="cloud-backup-picker-subtitle">从百度网盘备份目录中选择一个版本恢复</small></div>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowCloudBackupPicker(false)}>×</button>
            </div>
            <div className="modal-body cloud-backup-picker-body">
              <div className="cloud-backup-breadcrumb"><span>百度网盘</span><b>/</b><span>{cloudRemotePath.trim()}</span></div>
              <div className="cloud-backup-toolbar"><strong>完整备份文件</strong><span>{cloudBackupFiles.length} 个项目</span><button type="button" className="link-button" onClick={() => void loadCloudBackups()} disabled={cloudSyncRunning}>刷新列表</button></div>
              <div className="cloud-backup-list" role="radiogroup" aria-label="云端备份文件">
                {cloudBackupFiles.map(file => {
                  const selected = selectedCloudBackup?.path === file.path && selectedCloudBackup?.fsId === file.fsId;
                  const date = file.modifiedAt ? new Date(file.modifiedAt) : null;
                  const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '时间未知';
                  const sizeText = file.size > 0 ? `${(file.size / 1_048_576).toFixed(file.size >= 1_048_576 ? 1 : 2)} MB` : '大小未知';
                  return <label key={`${file.path}-${file.fsId || ''}`} className={`cloud-backup-option${selected ? ' active' : ''}`}>
                    <input type="radio" name="cloud-backup" checked={selected} onChange={() => setSelectedCloudBackup(file)} />
                    <span className="cloud-backup-file-icon" aria-hidden="true">ASW</span>
                    <span className="cloud-backup-option-main"><strong>{file.name}</strong><small>{file.isBundle ? '完整应用备份' : '备份文件'}</small><em className="cloud-backup-mobile-meta">{dateText} · {sizeText}</em></span>
                    <span className="cloud-backup-option-date">{dateText}</span>
                    <span className="cloud-backup-option-size">{sizeText}</span>
                  </label>;
                })}
              </div>
              <p className="cloud-backup-picker-note">恢复会覆盖本机对应的小说、书籍、拆书、扫榜、文风、技能、记忆和设置。</p>
            </div>
            <div className="modal-footer">
              <span className="cloud-backup-selection-status">{selectedCloudBackup ? `已选择：${selectedCloudBackup.name}` : '请选择一个备份文件'}</span>
              <div className="cloud-backup-picker-actions"><button className="btn-secondary" onClick={() => setShowCloudBackupPicker(false)}>取消</button>
              <button className="btn-primary" disabled={!selectedCloudBackup || cloudSyncRunning} onClick={() => selectedCloudBackup && void restoreFromCloud(selectedCloudBackup)}>恢复所选备份</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showOutlineTypeModal && editingProject && (
        <div className="modal-overlay" onClick={() => setShowOutlineTypeModal(false)}>
          <div className="modal outline-type-modal" role="dialog" aria-modal="true" aria-labelledby="outline-type-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="outline-type-title">新建大纲</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowOutlineTypeModal(false)}>×</button>
            </div>
            <div className="modal-body outline-type-options">
              <p>请选择要创建的大纲类型</p>
              {outlineKinds.map(kind => <button key={kind} className="outline-type-option" onClick={() => chooseOutlineType(kind)}><strong>{kind}</strong><span>创建 Markdown 文档</span></button>)}
            </div>
          </div>
        </div>
      )}

      {/* 新建小说模态框 */}
      {showNewProjectModal && (
        <div className="modal-overlay" onClick={() => setShowNewProjectModal(false)}>
          <div className="modal new-project-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{projectFormMode === 'edit' ? '编辑小说' : '新建小说'}</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowNewProjectModal(false)}>×</button>
            </div>
            <div className="modal-body create-project-body">
              <aside className="cover-column">
                <div className={`cover-preview ${newProject.cover ? 'has-image' : ''}`}>
                  {newProject.cover ? (
                    <img src={newProject.cover} alt="小说封面预览" />
                  ) : (
                    <>
                      <span className="cover-book-name">{newProject.title || '书本名称'}</span>
                      <span className="cover-decoration">文</span>
                      <small>ApiSaverWriter</small>
                    </>
                  )}
                </div>
                <label className="cover-upload-button">
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleCoverChange} />
                  选择封面
                </label>
                <p>支持 JPG、PNG、WebP，自动压缩保存</p>
              </aside>

              <div className="create-project-form">
                <div className="create-form-row">
                  <label htmlFor="project-title"><span className="required-mark">*</span>书本名称</label>
                  <div className="project-field-stack">
                    <div className="counted-field">
                      <input
                        id="project-title"
                        type="text"
                        className="input"
                        placeholder="请输入作品名称"
                        maxLength={15}
                        value={newProject.title}
                        onChange={(e) => setNewProject({ ...newProject, title: e.target.value })}
                      />
                      <span>{newProject.title.length}/15</span>
                    </div>
                    <div className="project-ai-actions">
                      <span>AI 参考</span>
                      <select className="select" value={projectGenerationSource} onChange={(event) => setProjectGenerationSource(event.target.value as 'outline' | 'chapters')}>
                        <option value="outline">作品大纲</option>
                        <option value="chapters">前 3 章内容</option>
                      </select>
                      <button className="btn-secondary" type="button" disabled={projectGeneratingField !== null} onClick={() => generateProjectField('title')}>{projectGeneratingField === 'title' ? '生成中...' : 'AI 生成书名'}</button>
                    </div>
                  </div>
                </div>

                <div className="create-form-row">
                  <label>目标读者</label>
                  <div className="channel-switcher" role="radiogroup" aria-label="目标读者">
                    {(['男频', '女频'] as Channel[]).map(channel => (
                      <button
                        key={channel}
                        type="button"
                        role="radio"
                        aria-checked={newProject.channel === channel}
                        className={newProject.channel === channel ? 'active' : ''}
                        onClick={() => handleChannelChange(channel)}
                      >
                        <span className="radio-dot" />{channel}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="create-form-row">
                  <label>作品标签</label>
                  <div className="tag-field-wrap">
                    <button type="button" className="tag-picker-trigger" onClick={openProjectTagPicker}>
                      <span>{newProject.selectedTags.主分类.length ? '修改作品标签' : '请选择作品标签'}</span><span>›</span>
                    </button>
                    <div className="selected-tag-summary">
                      {Object.entries(newProject.selectedTags).flatMap(([tab, tags]) => tags.map(tag => <span key={`${tab}-${tag}`}>{tag}</span>))}
                    </div>
                  </div>
                </div>

                <div className="create-form-row">
                  <label>主角名</label>
                  <div className="protagonist-fields">
                    <div className="counted-field">
                      <input type="text" className="input" placeholder="请输入主角名1" maxLength={5} value={newProject.protagonist1} onChange={(e) => setNewProject({ ...newProject, protagonist1: e.target.value })} />
                      <span>{newProject.protagonist1.length}/5</span>
                    </div>
                    <div className="counted-field">
                      <input type="text" className="input" placeholder="请输入主角名2" maxLength={5} value={newProject.protagonist2} onChange={(e) => setNewProject({ ...newProject, protagonist2: e.target.value })} />
                      <span>{newProject.protagonist2.length}/5</span>
                    </div>
                  </div>
                </div>

                <div className="create-form-row synopsis-row">
                  <label htmlFor="project-synopsis">作品简介</label>
                  <div className="project-field-stack">
                    <div className="counted-field counted-textarea">
                      <textarea id="project-synopsis" className="textarea" placeholder="请输入作品简介" maxLength={500} value={newProject.synopsis} onChange={(e) => setNewProject({ ...newProject, synopsis: e.target.value })} />
                      <span>{newProject.synopsis.length}/500</span>
                    </div>
                    <div className="project-ai-actions synopsis-ai-actions">
                      <small>生成番茄风格的卖点简介，可根据当前选择的参考内容直接回填。</small>
                      <button className="btn-secondary" type="button" disabled={projectGeneratingField !== null} onClick={() => generateProjectField('synopsis')}>{projectGeneratingField === 'synopsis' ? '生成中...' : 'AI 生成作品简介'}</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowNewProjectModal(false)}>
                取消
              </button>
              <button className="btn-primary" onClick={handleCreateProject}>
                {projectFormMode === 'edit' ? '保存修改' : '立即创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {batchGenerationRunning && !showBatchGenerationModal && (
        <button type="button" className="batch-background-progress" onClick={() => setShowBatchGenerationModal(true)}>
          <span><strong>连续生成章节</strong><small>{batchGenerationProgress || '正在后台生成...'}</small></span>
          <b>查看进度</b>
        </button>
      )}

      {showBatchGenerationModal && batchGenerationProjectId !== null && (() => {
        const target = projects.find(item => item.id === batchGenerationProjectId);
        if (!target) return null;
        return <div className="modal-overlay" onClick={() => setShowBatchGenerationModal(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="batch-generation-title" onClick={event => event.stopPropagation()}>
            <div className="modal-header"><h3 id="batch-generation-title">一键生成章节</h3><button className="modal-close" aria-label={batchGenerationRunning ? '转入后台运行' : '关闭'} onClick={() => setShowBatchGenerationModal(false)}>×</button></div>
            <div className="modal-body">
              <p>《{target.title}》将从第 {target.chapters.length + 1} 章开始，逐章生成章纲和正文。每章自动读取上一章正文，章纲默认不超过 700 字（含标点）。</p>
              <label className="form-group"><span>生成章数</span><input className="input" type="number" min="1" max="20" step="1" value={batchGenerationCount} disabled={batchGenerationRunning} onChange={event => setBatchGenerationCount(event.target.value)} /></label>
              {batchGenerationRunning && <p className="settings-network-note">{batchGenerationProgress || '正在生成...'}</p>}
              {batchGenerationItems.length > 0 && <div className="batch-generation-items" aria-live="polite">{batchGenerationItems.map(item => <article key={item.chapterNumber} className={`batch-generation-item ${item.status}`}><div className="batch-generation-item-heading"><strong>{item.title}</strong><span>{item.status === 'pending' ? '等待' : item.status === 'outline' ? '生成章纲' : item.status === 'writing' ? '生成正文' : item.status === 'memory' ? '更新记忆' : item.status === 'complete' ? '已完成' : '失败'}</span></div>{item.outline && <details><summary>查看章纲</summary><pre>{item.outline}</pre></details>}{item.content && <details open={item.status === 'complete'}><summary>查看正文 · {countNovelCharacters(item.content)} 字</summary><pre>{item.content}</pre></details>}{item.memory && <small className="batch-generation-memory">记忆：{item.memory}</small>}</article>)}</div>}
            </div>
            <div className="modal-footer"><button className="btn-secondary" onClick={() => setShowBatchGenerationModal(false)}>{batchGenerationRunning ? '后台运行' : '关闭'}</button><button className="btn-primary" disabled={batchGenerationRunning} onClick={() => void generateBatchChapters(target, Number(batchGenerationCount) || 1)}>{batchGenerationRunning ? '生成中...' : batchGenerationItems.length ? '重新生成' : '开始生成'}</button></div>
          </div>
        </div>;
      })()}

      {showTagPicker && (
        <div className="modal-overlay tag-picker-overlay" onClick={() => setShowTagPicker(false)}>
          <div className="modal work-tags-modal" role="dialog" aria-modal="true" aria-labelledby="work-tags-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="work-tags-title">作品标签</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowTagPicker(false)}>×</button>
            </div>
            <div className="work-tags-body">
              <nav className="tag-tabs work-tag-tabs">
                {(Object.keys(channelTagCatalog[newProject.channel]) as TagTab[]).map(tab => (
                  <button key={tab} className={activeTagTab === tab ? 'active' : ''} onClick={() => setActiveTagTab(tab)}>
                    {tab === '主分类' && <span className="required-mark">*</span>}{tab}
                    {tagDraft[tab].length > 0 && <span className="tag-tab-count">{tagDraft[tab].length}</span>}
                  </button>
                ))}
              </nav>
              <div className="tag-grid work-tag-grid">
                {channelTagCatalog[newProject.channel][activeTagTab].map(tag => {
                  const selected = tagDraft[activeTagTab].includes(tag.name);
                  return (
                    <button key={tag.name} className={`tag-option ${selected ? 'selected' : ''}`} onClick={() => handleProjectTagToggle(tag.name)}>
                      <span className={`tag-option-icon ${tag.tone}`}>{tag.icon}</span>
                      <span className="tag-option-copy"><strong>{tag.name}</strong>{tag.description && <small>{tag.description}</small>}</span>
                      <span className="tag-check">{selected ? '✓' : ''}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="work-tags-footer">
              <p>主分类必选且只能选一个，主题、角色、情节最多可选两个</p>
              <div><button className="btn-secondary" onClick={() => setShowTagPicker(false)}>取消</button><button className="btn-primary" onClick={confirmProjectTags}>确认</button></div>
            </div>
          </div>
        </div>
      )}

      {projectPendingDeletion && (
        <div className="modal-overlay" onClick={() => setProjectPendingDeletion(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="delete-project-title">删除小说</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setProjectPendingDeletion(null)}>×</button>
            </div>
            <div className="modal-body">
              <p>确定删除《{projectPendingDeletion.title}》吗？</p>
              <p className="delete-warning">小说中的章节、大纲和本地保存内容都会被移除，此操作不可撤销。</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setProjectPendingDeletion(null)}>取消</button>
              <button className="btn-danger" onClick={handleDeleteProject}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {chapterPendingDeletion && (
        <div className="modal-overlay" onClick={() => setChapterPendingDeletion(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-chapter-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="delete-chapter-title">删除章节</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setChapterPendingDeletion(null)}>×</button>
            </div>
            <div className="modal-body">
              <p>确定删除《{chapterPendingDeletion.title}》吗？</p>
              <p className="delete-warning">本章正文、绑定章纲、章节记忆、图谱关系和 AI 检测记录都会被移除，此操作不可撤销。</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setChapterPendingDeletion(null)}>取消</button>
              <button className="btn-danger" onClick={() => void handleDeleteChapter()}>确认删除</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
