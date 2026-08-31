#!/usr/bin/env node
import { createChapterGraph, selectSkillsByIntent, type SkillDefinition } from "./graphs/chapter-write.graph.js";
import { StoryStore } from "./storage/story-store.js";
import { ApiSaverClient, getRuntimeUsageSummary } from "./models/api-saver.js";
import { StreamEmitter } from "./streaming/stream-handler.js";
import { byteLength, compactKnowledgeGraph, compactText, contextBudgetBytes, LruCache, prepareChapterInput, stableHash, type ContextReport, type PreparedChapterInput } from "./context/context-optimizer.js";
import { readPersistentContext, readPersistentDocument, writePersistentContext, writePersistentDocument } from "./context/persistent-context-cache.js";
import { ProxyAgent } from "undici";
import { load as loadHtml } from "cheerio";
import iconv from "iconv-lite";
import { createDecipheriv } from "node:crypto";
import qianyueSourceData from "./data/qianyue-novel-sources.json" with { type: "json" };
import fanqiePuaMaps from "./data/fanqie-pua-map.json" with { type: "json" };

interface RPCRequest {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface RPCResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// The desktop process keeps this runtime alive. These caches therefore survive
// normal editor actions without persisting any novel material outside memory.
const chapterPreparationCache = new LruCache<PreparedChapterInput>(48);
const chapterMemoryCache = new LruCache<Record<string, unknown>>(96);
type AgentSessionTurn = {
  instruction: string;
  conclusion: string;
  createdAt: string;
};

type AgentSessionState = {
  version: 1;
  summary: string;
  recentTurns: AgentSessionTurn[];
  compressedAt?: string;
};

const novelSessionCache = new LruCache<AgentSessionState>(128);
const outlineSessionCache = new LruCache<AgentSessionState>(96);
const cardSessionCache = new LruCache<AgentSessionState>(96);

const SESSION_KEEP_TURNS = 2;

// Local saves refresh timestamps on chapters, cards and graph edges. Those
// timestamps are not prompt facts, so omit them from the preparation key or a
// save-without-content-change would defeat the persistent context cache.
function cacheStableContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cacheStableContext);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "updatedAt" && key !== "createdAt")
      .map(([key, child]) => [key, cacheStableContext(child)]));
  }
  return value;
}

function normalizeAgentSession(value: unknown): AgentSessionState {
  if (typeof value === "string") {
    return { version: 1, summary: compactText(value, 5000), recentTurns: [] };
  }
  if (!value || typeof value !== "object") return { version: 1, summary: "", recentTurns: [] };
  const source = value as Record<string, unknown>;
  return {
    version: 1,
    summary: compactText(source.summary || "", 7000),
    recentTurns: Array.isArray(source.recentTurns)
      ? source.recentTurns.slice(-6).flatMap(turn => {
        if (!turn || typeof turn !== "object") return [];
        const item = turn as Record<string, unknown>;
        const instruction = compactText(item.instruction || "", 2200);
        const conclusion = compactText(item.conclusion || "", 6000);
        return instruction || conclusion ? [{ instruction, conclusion, createdAt: String(item.createdAt || "") }] : [];
      })
      : [],
    compressedAt: typeof source.compressedAt === "string" ? source.compressedAt : undefined,
  };
}

function renderAgentSession(state: AgentSessionState): string {
  const parts = [
    state.summary ? `## 已压缩的会话摘要\n${state.summary}` : "",
    state.recentTurns.length ? `## 最近会话轮次\n${state.recentTurns.map((turn, index) => `### 轮次 ${index + 1}\n作者请求：${turn.instruction || "延续上一轮"}\n已确认结论：${turn.conclusion || "暂无"}`).join("\n\n")}` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

function renderSessionSummary(state: AgentSessionState): string {
  return state.summary ? `## 历史会话摘要\n${state.summary}` : "";
}

function renderRecentTurns(state: AgentSessionState): string {
  return state.recentTurns.length
    ? `## 最近两轮请求与结论\n${state.recentTurns.map((turn, index) => `### 轮次 ${index + 1}\n作者请求：${turn.instruction || "延续上一轮"}\n已确认结论：${turn.conclusion || "暂无"}`).join("\n\n")}`
    : "";
}

function compactAgentSession(state: AgentSessionState, contextWindowKB: unknown, baseBytes: number): { state: AgentSessionState; compressed: boolean } {
  const threshold = Math.floor(Math.max(16, Number(contextWindowKB) || 128) * 1024 * 0.8);
  const rendered = renderAgentSession(state);
  if (baseBytes + byteLength(rendered) < threshold) return { state, compressed: false };

  const historicTurns = state.recentTurns.slice(0, -SESSION_KEEP_TURNS);
  const historicDigest = historicTurns.map(turn => `请求：${compactText(turn.instruction, 500)}\n结论：${compactText(turn.conclusion, 1200)}`).join("\n\n");
  const availableBytes = Math.max(4096, threshold - baseBytes);
  const recentTurnBudget = Math.max(1000, Math.floor(availableBytes * 0.32));
  const recentTurns = state.recentTurns.slice(-SESSION_KEEP_TURNS).map(turn => ({
    instruction: compactText(turn.instruction, Math.max(300, Math.floor(recentTurnBudget * 0.25))),
    conclusion: compactText(turn.conclusion, Math.max(700, Math.floor(recentTurnBudget * 0.75))),
    createdAt: turn.createdAt,
  }));
  // The response itself already contains a model-produced plan/conclusion. Keep
  // that semantic material while collapsing older turns into one durable handoff.
  const summary = compactText([state.summary, historicDigest].filter(Boolean).join("\n\n"), Math.max(1200, Math.floor(availableBytes * 0.3)));
  return {
    compressed: true,
    state: {
      version: 1,
      summary: summary || "此前会话已压缩；后续以最近已确认结论继续。",
      recentTurns,
      compressedAt: new Date().toISOString(),
    },
  };
}

function appendAgentSession(state: AgentSessionState, instruction: string, conclusion: string, contextWindowKB: unknown, baseBytes: number): { state: AgentSessionState; compressed: boolean } {
  const next: AgentSessionState = {
    version: 1,
    summary: state.summary,
    recentTurns: [...state.recentTurns, {
      instruction: compactText(instruction, 2200),
      conclusion: compactText(conclusion, 6500),
      createdAt: new Date().toISOString(),
    }],
    compressedAt: state.compressedAt,
  };
  return compactAgentSession(next, contextWindowKB, baseBytes);
}

// Byte-stable prompt for compatible upstream prefix caches. Dynamic chapter
// instructions and the editable outline are deliberately sent afterwards.
const outlineWriterSystemPrompt = `你是长篇网络小说总策划与章节规划 Agent。根据作品资料编写可直接执行的 Markdown 大纲。
世界观与作品设定是作者确认的只读固定规则，只能引用，不得自动改写、补全或推断变化；保持人物、时间线、设定和知识图谱一致。不要输出解释性前言。未知信息标记为待揭示，不能编造为既定事实。`;

// Chapter outlines have one canonical contract. A user-provided outline may
// supply facts or writing density, but it cannot replace these fields.
const chapterOutlineOutputProtocol = `## 番茄小说章纲生成器输出协议（必须严格遵守）
仅当类型为“章纲”时使用。参考章纲只能借鉴叙事密度，不能替换以下栏目或字段。

# 章纲｜第X章 标题

## 核心爽点类型
主：从打脸、升级、得宝、揭秘、装逼、复仇、收女、差异感、低调装逼、异性倾慕中选择。
副：从上述类型中选择。

## 情绪曲线
压抑：____（20%）
爆发：____（50%）
余韵：____（20%，必须明确本章释放点）
新危机：____（10%）

## 场景划分
场景一：
- 地点：
- 人物：
- 目标：
- 冲突：
- 转折：

场景二（如需要）：
- 地点：
- 人物：
- 目标：
- 冲突：
- 转折：

场景三（如需要）：
- 地点：
- 人物：
- 目标：
- 冲突：
- 转折：

## 人物功能
逐人说明行动、独立作用和状态变化，禁止工具人。

## 信息揭示与伏笔
新信息：至少1条。
伏笔：至少1条，必须明确标注“待揭示”，并写出可回收方向。

## 爽点拆解
至少填写其中两项：
- 差异感：
- 低调装逼：
- 异性倾慕：
- 因果铺陈：

## 章末钩子
必须落在具体动作、对话或画面上，形成追读钩子；不得写“欲知后事如何”。

硬性限制：默认控制在 700 字以内，字数统计包括汉字、数字、空格、换行和所有标点符号；先保证承接事实、核心冲突、转折、释放点和章末钩子，再压缩非关键修饰。只有作者明确要求更长时才放宽，不得半途截断。只输出 Markdown 章纲正文，不输出技能名、知识图谱、实体关系、JSON、分析过程、前言或后记。未知信息写“待揭示”，不得虚构。`;

function unwrapOutlineEnvelope(value: string): { title?: string; content: string } {
  let content = String(value || "").trim()
    .replace(/^```(?:json|markdown|md|text)?\s*/iu, "")
    .replace(/```$/u, "")
    .trim();
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const nested = typeof parsed.content === "string" ? parsed.content : typeof parsed.body === "string" ? parsed.body : "";
    if (nested.trim()) {
      return {
        title: typeof parsed.title === "string" ? parsed.title.trim() : undefined,
        content: nested.trim(),
      };
    }
  } catch {
    // Markdown output is the normal path; JSON envelopes are accepted for provider compatibility.
  }
  return { content };
}

function outlineTitleFromOutput(value: string, chapterNumber: number): string {
  const envelope = unwrapOutlineEnvelope(value);
  const lines = envelope.content.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const labeledTitles = lines.flatMap((line, index) => {
    if (!/^(?:#{1,6}\s*)?(?:章纲\s*[|｜:：-]\s*)?(?:章节标题|标题)\s*[：:]?/u.test(line)) return [];
    const inline = line.replace(/^(?:#{1,6}\s*)?(?:章纲\s*[|｜:：-]\s*)?(?:章节标题|标题)\s*[：:]\s*/u, "").trim();
    return [inline || lines[index + 1] || ""];
  });
  const candidates = [envelope.title || "", ...labeledTitles, ...lines.filter(line => /^#{1,2}\s*.*第\s*(?:\d+|[零〇一二三四五六七八九十百千]+)\s*章/u.test(line))];
  for (const raw of candidates) {
    const candidate = raw.replace(/^#{1,6}\s*/u, "").trim()
      .replace(/^章纲\s*[|｜:：-]\s*/u, "")
      .replace(/^(?:章节标题|标题)\s*[：:]?/u, "")
      .replace(/^第\s*(?:\d+|[零〇一二三四五六七八九十百千]+)\s*章\s*[：:、-]?\s*/u, "")
      .replace(/^《(.+?)》$/u, "$1")
      .trim();
    if (candidate && !/^(?:正文|内容|未命名|未命名章节|章节)$/u.test(candidate)) return `第 ${chapterNumber} 章 ${candidate}`;
  }
  // Providers occasionally omit the title line but still return a useful
  // chapter objective. Use that objective as a deterministic local title so
  // batch generation never saves a bare "第 N 章" when a summary exists.
  const summaryIndex = lines.findIndex(line => /^(?:#{1,6}\s*)?(?:核心主线与目标|本章目标|章节定位|核心事件)(?:\s*[：:].*)?$/u.test(line));
  const summary = summaryIndex >= 0
    ? (lines[summaryIndex].match(/[：:]\s*(.+)$/u)?.[1] || lines[summaryIndex + 1] || "")
    : "";
  const compactSummary = summary.replace(/^[-*]\s*/u, "").replace(/[。！？.!?].*$/u, "").trim();
  if (compactSummary && !/^(?:暂无|无|待定|待揭示)$/u.test(compactSummary)) {
    return `第 ${chapterNumber} 章 ${compactText(compactSummary, 24)}`;
  }
  return `第 ${chapterNumber} 章`;
}

function normalizeChapterOutlineOutput(value: string): string {
  let content = unwrapOutlineEnvelope(value).content;
  const graphTail = content.search(/^##\s*(?:实体与关系更新|知识图谱更新)\s*$/imu);
  if (graphTail >= 0) content = content.slice(0, graphTail).trim();
  const lines = content.split(/\r?\n/u);
  const seenHeadings = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/u)?.[1]?.trim();
    if (heading) {
      const key = heading.replace(/[：:｜|]/gu, "").replace(/\s+/gu, "");
      if (seenHeadings.has(key)) break;
      seenHeadings.add(key);
    }
    kept.push(line);
  }
  content = kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return content;
}

// Kept byte-stable and paired with a separately sent project packet so card
// requests for the same novel can reuse compatible upstream prompt caches.
      const cardWriterSystemPrompt = `你是长篇小说的知识设定编辑。只根据提供的作品资料生成可长期检索的知识卡，不把推测写成既定事实。
输出必须是严格 JSON 对象，不要代码围栏或额外说明：{"title":"卡片名称","content":"详细 Markdown 内容"}。`;

const memoryEditorSystemPrompt = `你是长篇小说的记忆编辑。只从章节正文与给定的相关资料抽取明确事实，不补写未发生的剧情。

输出必须是严格 JSON 对象，不要代码围栏或解释。摘要应简短、可检索、包含事件推进、人物状态和未解决线索。实体与关系必须有正文依据；卡片只在状态确有变化且正文能证明时更新。`;

const chapterReviewSystemPrompt = `你是长篇小说审查中心编辑。只依据给定的章节正文、章纲、人物卡和设定资料审查，不补写剧情，不把风格偏好伪装成事实错误。
重点检查：章节与章纲是否一致、人物状态和认知是否前后一致、时间线与地点是否矛盾、设定和力量规则是否冲突、伏笔与冲突是否断裂、标题和结尾钩子是否有效、明显重复段落和病句。
输出严格 JSON 对象，不要代码围栏或额外文字：{"score":0,"summary":"","issues":[{"severity":"high|medium|low","category":"","evidence":"原文短引","suggestion":"可执行修改建议"}],"suggestions":["..."]}。score 为 0-100；没有问题时 issues 为空。`;

const stringList = (value: unknown, limit = 20): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, limit)
  : [];

const memoryStringList = (value: unknown, limit = 40): string[] => Array.isArray(value)
  ? value.map(item => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return "";
      const entry = item as Record<string, unknown>;
      return compactText(entry.text || entry.content || entry.change || entry.changes || entry.description || entry.name || "", 600).trim();
    }).filter(Boolean).slice(0, limit)
  : typeof value === "string"
    ? value.split(/\r?\n|[；;、]/u).map(item => item.trim()).filter(Boolean).slice(0, limit)
  : [];

const memoryField = (result: Record<string, unknown>, ...names: string[]): unknown => {
  for (const name of names) {
    const value = result[name];
    if ((Array.isArray(value) && value.length) || (typeof value === "string" && value.trim())) return value;
  }
  return [];
};

const networkProxyConfig = (params?: Record<string, unknown>) => ({
  proxyEnabled: Boolean(params?.proxyEnabled),
  proxyURL: typeof params?.proxyURL === "string" ? params.proxyURL : "",
  proxyBypassLocal: params?.proxyBypassLocal === true,
});

const memoryTypeForDocument = (kind: string): "event" | "character_state" | "canon_fact" | "foreshadowing" | "timeline" => {
  if (kind === "人物状态" || kind === "角色认知") return "character_state";
  if (kind === "伏笔追踪") return "foreshadowing";
  if (kind === "时间线") return "timeline";
  if (kind === "设定事实" || kind === "冲突") return "canon_fact";
  return "event";
};

const normalizeRelationWeight = (value: unknown, fallback = 0.7): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  const weight = Number.isFinite(parsed) ? parsed : fallback;
  return Math.round(Math.max(0.1, Math.min(1, weight)) * 100) / 100;
};

const normalizeMemoryResult = (content: string): Record<string, unknown> => {
  try {
    const cleanedResponse = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/u, "").trim();
    const parsed = JSON.parse(cleanedResponse) as Record<string, unknown>;
    const result = typeof parsed.content === "string" && parsed.content.trim().startsWith("{")
      ? (JSON.parse(parsed.content) as Record<string, unknown>)
      : parsed;
    return {
      summary: typeof (result.summary || result.摘要 || result.chapterSummary || result.chapter_summary) === "string" ? String(result.summary || result.摘要 || result.chapterSummary || result.chapter_summary) : content,
      keywords: memoryStringList(memoryField(result, "keywords", "关键词", "key_words"), 8),
      characterStateChanges: memoryStringList(memoryField(result, "characterStateChanges", "character_state_changes", "characterChanges", "character_changes", "人物状态变化", "人物状态", "角色状态变化")),
      knowledgeChanges: memoryStringList(memoryField(result, "knowledgeChanges", "knowledge_changes", "characterKnowledgeChanges", "roleKnowledgeChanges", "角色认知变化", "角色认知", "认知变化", "知识变化")),
      foreshadowingChanges: memoryStringList(memoryField(result, "foreshadowingChanges", "foreshadowing_changes", "伏笔变化", "伏笔进展")),
      foreshadowingItems: Array.isArray(result.foreshadowingItems) ? result.foreshadowingItems.filter(item => item && typeof item === "object").slice(0, 20).map(item => {
        const entry = item as Record<string, unknown>;
        return {
          text: compactText(entry.text || entry.content || entry.name || "", 260),
          status: String(entry.status || "active").trim(),
          priority: String(entry.priority || "normal").trim(),
          plantedChapter: Number.isFinite(Number(entry.plantedChapter)) ? Number(entry.plantedChapter) : undefined,
          targetChapter: Number.isFinite(Number(entry.targetChapter)) ? Number(entry.targetChapter) : undefined,
        };
      }).filter(item => item.text) : [],
      timelineEvents: memoryStringList(memoryField(result, "timelineEvents", "timeline_events", "时间线事件", "时间线")),
      canonFacts: memoryStringList(memoryField(result, "canonFacts", "canon_facts", "设定事实", "世界观事实")),
      conflicts: memoryStringList(memoryField(result, "conflicts", "冲突", "冲突变化")),
      endingHook: typeof (result.endingHook || result.ending_hook || result.章末钩子 || result.结尾钩子) === "string" ? String(result.endingHook || result.ending_hook || result.章末钩子 || result.结尾钩子).trim() : "",
      entities: Array.isArray(result.entities) ? (result.entities as unknown[]).filter(item => item && typeof item === "object").slice(0, 30).map((item: unknown) => {
        const entity = item as Record<string, unknown>;
        return { name: String(entity.name || "").trim(), type: String(entity.type || "实体").trim() };
      }).filter(item => item.name) : [],
      relations: Array.isArray(result.relations) ? (result.relations as unknown[]).filter(item => item && typeof item === "object").slice(0, 60).map((item: unknown) => {
        const relation = item as Record<string, unknown>;
        return {
          source: String(relation.source || "").trim(),
          target: String(relation.target || "").trim(),
          label: String(relation.label || "关联").trim(),
          weight: normalizeRelationWeight(relation.weight),
        };
      }).filter(item => item.source && item.target) : [],
      cardUpdates: Array.isArray(result.cardUpdates) ? (result.cardUpdates as unknown[]).filter(item => item && typeof item === "object").slice(0, 30).map((item: unknown) => {
        const update = item as Record<string, unknown>;
        return { cardId: typeof update.cardId === "number" || typeof update.cardId === "string" ? update.cardId : undefined, cardTitle: String(update.cardTitle || "").trim(), status: String(update.status || "updated").trim(), changes: String(update.changes || "").trim() };
      }).filter(item => item.cardTitle || item.cardId !== undefined) : [],
    };
  } catch {
    return {
      summary: content.slice(0, 220), keywords: [], characterStateChanges: [], knowledgeChanges: [],
      foreshadowingChanges: [], foreshadowingItems: [], timelineEvents: [], canonFacts: [], conflicts: [], endingHook: "", entities: [], relations: [], cardUpdates: [],
    };
  }
};

const webProxyAgents = new Map<string, ProxyAgent>();
type WebFetchOptions = {
  headers?: Record<string, string>;
  retries?: number;
};

const fetchWebText = async (url: string, params?: Record<string, unknown>, options: WebFetchOptions = {}): Promise<string> => {
  const proxyEnabled = params?.proxyEnabled === true;
  const proxyURL = typeof params?.proxyURL === "string" ? params.proxyURL.trim() : "";
  let dispatcher: ProxyAgent | undefined;
  if (proxyEnabled && proxyURL) {
    dispatcher = webProxyAgents.get(proxyURL);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxyURL);
      webProxyAgents.set(proxyURL, dispatcher);
    }
  }
  let lastError: unknown;
  const retries = Math.max(1, Math.min(4, options.retries ?? 3));
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          Referer: "https://fanqienovel.com/",
          ...options.headers,
        },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      if (!response.ok) throw new Error(`书籍服务返回 HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const decodeWebText = (value: string): string => value
  .replace(/<br\s*\/?>/giu, "\n")
  .replace(/<[^>]+>/gu, "")
  .replace(/&nbsp;/giu, " ")
  .replace(/&amp;/giu, "&")
  .replace(/&quot;/giu, '"')
  .replace(/&#39;/giu, "'")
  .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/\n{3,}/gu, "\n\n")
  .trim();

// Normal reader pages also load the CAPTCHA script. Only the dedicated challenge
// page title identifies a completed redirect to verification.
const isFanqieVerificationPage = (html: string): boolean => /<title>\s*验证码中间页\s*<\/title>/iu.test(html);

const fanqiePuaStarts = [58344, 58345] as const;
const decodeFanqiePuaText = (content: string, mode = 0): string => {
  const table = fanqiePuaMaps[mode] || fanqiePuaMaps[0];
  const start = fanqiePuaStarts[mode] ?? fanqiePuaStarts[0];
  return Array.from(content, character => {
    const index = character.codePointAt(0)! - start;
    const decoded = index >= 0 && index < table.length ? table[index] : undefined;
    return decoded && decoded !== "?" ? decoded : character;
  }).join("");
};

const fanqiePrivateUseCount = (content: string): number => Array.from(content).filter(character => {
  const codePoint = character.codePointAt(0)!;
  return codePoint >= 58344 && codePoint <= 58715;
}).length;

const decodeFanqieContent = (content: string): string => {
  const primary = decodeFanqiePuaText(content);
  if (fanqiePrivateUseCount(primary) === 0 || fanqiePrivateUseCount(content) === 0) return primary;
  const fallback = decodeFanqiePuaText(content, 1);
  return fanqiePrivateUseCount(fallback) < fanqiePrivateUseCount(primary) ? fallback : primary;
};

const extractFanqieReaderContent = (html: string): string => {
  const $ = loadHtml(html);
  const paragraphs = $('.muye-reader-content p').toArray().map(element => $(element).text().trim()).filter(Boolean).join("\n");
  if (paragraphs) return decodeFanqieContent(paragraphs);
  const jsonContentMatch = html.match(/["']content["']\s*:\s*"((?:\\.|[^"\\])*)"/u);
  if (jsonContentMatch) {
    try {
      const decoded = JSON.parse(`"${jsonContentMatch[1]}"`) as string;
      const content = decodeFanqieContent(decodeWebText(decoded));
      if (content) return content;
    } catch { /* Fall through to the rendered chapter body. */ }
  }
  return decodeFanqieContent(decodeWebText($('.muye-reader-content').first().html() || ''));
};

const fanqieBookFromHtml = (html: string, query: string): Array<Record<string, unknown>> => {
  const results: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const pattern = /<a[^>]+href=["'](?:https?:\/\/fanqienovel\.com)?\/page\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(pattern)) {
    const sourceBookId = match[1];
    if (seen.has(sourceBookId)) continue;
    seen.add(sourceBookId);
    const title = decodeWebText(match[2]).slice(0, 100);
    // 搜索页同时覆盖书名和作者；不要在这里只按标题二次过滤，保证作者关键词也能保留结果。
    if (!title) continue;
    results.push({ id: `fanqie:${sourceBookId}`, sourceBookId, title, author: "未知作者", source: "番茄小说", url: `https://fanqienovel.com/page/${sourceBookId}`, intro: "" });
    if (results.length >= 30) break;
  }
  return results;
};

const fanqiePrivateFontCss = (html: string): string => Array.from(html.matchAll(/@font-face\{[^}]+\}/gu))
  .map(match => match[0]
    .replace(/font-family:[^;]+;/u, "font-family:ApiSaverWriterFanqie;")
    .replace(/}$/, "unicode-range:U+E000-F8FF;}"))
  .join("\n");

const fanqieBooksFromSearchPayload = (payload: unknown): Array<Record<string, unknown>> => {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : root;
  const books = Array.isArray(data.search_book_data_list) ? data.search_book_data_list : [];
  const seen = new Set<string>();
  return books.flatMap(item => {
    const book = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const sourceBookId = String(book.book_id || book.bookId || book.id || "").trim();
    const title = String(book.book_name || book.bookName || book.title || "").trim();
    if (!sourceBookId || !title || seen.has(sourceBookId)) return [];
    seen.add(sourceBookId);
    return [{
      id: `fanqie:${sourceBookId}`,
      sourceBookId,
      title,
      author: String(book.author || book.author_name || "未知作者"),
      source: "番茄小说",
      url: `https://fanqienovel.com/page/${sourceBookId}`,
      intro: String(book.abstract || book.introduction || book.description || "").replace(/\\n/gu, "\n").slice(0, 320),
      cover: String(book.thumb_url || book.thumbUri || book.cover || "") || undefined,
      category: String(book.category || book.category_v2 || "") || undefined,
      wordCount: Number(book.word_count || book.wordCount) || undefined,
    }];
  });
};

// The public search endpoint sometimes returns an empty body after an anti-bot
// challenge. Search-engine results provide a read-only discovery fallback while
// preserving the canonical Fanqie page URL used by the rest of the workflow.
const fanqieBooksFromBing = (html: string): Array<Record<string, unknown>> => {
  const results: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const pattern = /<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']https?:\/\/fanqienovel\.com\/page\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/giu;
  for (const match of html.matchAll(pattern)) {
    const sourceBookId = match[1];
    if (seen.has(sourceBookId)) continue;
    seen.add(sourceBookId);
    const title = decodeWebText(match[2]).replace(/[？?].*$/u, "").trim().slice(0, 100);
    if (!title) continue;
    results.push({
      id: `fanqie:${sourceBookId}`,
      sourceBookId,
      title,
      author: "未知作者",
      source: "番茄小说",
      url: `https://fanqienovel.com/page/${sourceBookId}`,
      intro: decodeWebText(match[3] || "").slice(0, 320),
    });
    if (results.length >= 20) break;
  }
  return results;
};

const searchFanqieSource = async (query: string, params?: Record<string, unknown>): Promise<{ books: Array<Record<string, unknown>>; fontCss: string }> => {
  const pageUrl = `https://fanqienovel.com/search/${encodeURIComponent(query)}`;
  const pageHtml = await fetchWebText(pageUrl, params);
  const fontCss = fanqiePrivateFontCss(pageHtml);
  let books: Array<Record<string, unknown>> = [];
  try {
    const endpoint = `https://fanqienovel.com/api/author/search/search_book/v1?filter=127%2C127%2C127%2C127&page_count=10&page_index=0&query_type=0&query_word=${encodeURIComponent(query)}`;
    const response = await fetchWebText(endpoint, params);
    if (response.trim()) books = fanqieBooksFromSearchPayload(JSON.parse(response) as unknown);
  } catch { /* The source may issue a challenge; use the discovery fallbacks below. */ }
  if (!books.length) books = fanqieBookFromHtml(pageHtml, query);
  if (!books.length) {
    try {
      const bingQuery = encodeURIComponent(`site:fanqienovel.com/page/ ${query}`);
      books = fanqieBooksFromBing(await fetchWebText(`https://www.bing.com/search?q=${bingQuery}&setlang=zh-Hans`, params));
    } catch { /* Keep the successful Fanqie response as an empty result. */ }
  }
  return { books, fontCss };
};

type FanqieChapterLink = {
  id: string;
  title: string;
  url: string;
  locked: boolean;
};

const fanqieSessionCookies = new Map<string, string>();
const fanqieSessionKey = (params?: Record<string, unknown>): string => `${params?.proxyEnabled === true ? "proxy" : "direct"}:${typeof params?.proxyURL === "string" ? params.proxyURL.trim() : ""}`;
const createFanqieSessionCookie = (): string => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0")}`.slice(-18);
  return `novel_web_id=7${suffix}`;
};
const getFanqieSessionCookie = (params?: Record<string, unknown>): string => {
  const key = fanqieSessionKey(params);
  const existing = fanqieSessionCookies.get(key);
  if (existing) return existing;
  const created = createFanqieSessionCookie();
  fanqieSessionCookies.set(key, created);
  return created;
};
const replaceFanqieSessionCookie = (params?: Record<string, unknown>): string => {
  const created = createFanqieSessionCookie();
  fanqieSessionCookies.set(fanqieSessionKey(params), created);
  return created;
};

const isFanqieBlockedReaderPage = (html: string): boolean => {
  if (isFanqieVerificationPage(html)) return true;
  const title = html.match(/<title>\s*([^<]*)<\/title>/iu)?.[1] || "";
  return /小说,番茄小说网/u.test(title) && !/muye-reader-title/u.test(html);
};

const fetchFanqieReaderHtml = async (chapter: FanqieChapterLink, bookId: string, params?: Record<string, unknown>): Promise<string> => {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cookie = attempt === 0 ? getFanqieSessionCookie(params) : replaceFanqieSessionCookie(params);
    try {
      const html = await fetchWebText(chapter.url, params, {
        retries: 1,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          Referer: `https://fanqienovel.com/page/${bookId}`,
          Cookie: cookie,
        },
      });
      if (!isFanqieBlockedReaderPage(html)) return html;
      lastError = new Error("番茄返回了验证码页面");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("番茄章节未返回有效页面");
};

const fanqieChapterLinksFromPage = (html: string, maxChapters: number): FanqieChapterLink[] => {
  const $ = loadHtml(html);
  const chapterLinks: FanqieChapterLink[] = [];
  const seen = new Set<string>();
  $('.chapter-item').each((_index, element) => {
    if (chapterLinks.length >= maxChapters) return;
    const anchor = $(element).find('a[href*="/reader/"]').first();
    const href = anchor.attr('href') || "";
    const id = href.match(/\/reader\/(\d+)/u)?.[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    chapterLinks.push({
      id,
      title: anchor.text().trim().slice(0, 120) || `第${chapterLinks.length + 1}章`,
      url: `https://fanqienovel.com/reader/${id}`,
      locked: $(element).find('.chapter-item-lock').length > 0,
    });
  });
  return chapterLinks;
};

const fanqieExpectedWordCount = (html: string): number => {
  const $ = loadHtml(html);
  const match = $('.muye-reader-subtitle').text().replace(/\s/gu, "").match(/本章字数：(\d+)/u);
  return match ? Number(match[1]) : 0;
};

const concurrentMap = async <T, Result>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<Result>): Promise<Result[]> => {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
  return results;
};

const downloadFanqieChapter = async (chapter: FanqieChapterLink, number: number, bookId: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const html = await fetchFanqieReaderHtml(chapter, bookId, params);
  const content = extractFanqieReaderContent(html);
  const expectedWords = fanqieExpectedWordCount(html);
  const complete = content.length > 0 && (expectedWords === 0 || content.length >= Math.min(expectedWords * 0.65, 500));
  return {
    id: `fanqie-chapter:${chapter.id}`,
    number,
    title: chapter.title,
    url: chapter.url,
    content,
    wordCount: content.length,
    expectedWords,
    downloaded: complete,
    ...(complete ? {} : { unavailableReason: chapter.locked ? "该章节仅返回可读片段" : "该章节未返回完整正文" }),
  };
};

const downloadFanqieBook = async (bookUrl: string, sourceBookId: string, params?: Record<string, unknown>, maxChapters = Number.MAX_SAFE_INTEGER): Promise<Array<Record<string, unknown>>> => {
  const bookId = sourceBookId || bookUrl.match(/\/page\/(\d+)/u)?.[1] || "";
  if (!bookId) throw new Error("无法识别番茄书籍 ID");
  const pageHtml = await fetchWebText(bookUrl, params);
  const chapterLinks = fanqieChapterLinksFromPage(pageHtml, Math.max(1, Math.floor(maxChapters)));
  if (!chapterLinks.length) throw new Error("未找到章节目录，书籍页面可能已变更");
  return concurrentMap(chapterLinks, 4, async (chapter, index) => {
    try {
      return await downloadFanqieChapter(chapter, index + 1, bookId, params);
    } catch (error) {
      return {
        id: `fanqie-chapter:${chapter.id}`,
        number: index + 1,
        title: chapter.title,
        url: chapter.url,
        content: "",
        wordCount: 0,
        downloaded: false,
        unavailableReason: error instanceof Error ? error.message : "章节下载失败",
      };
    }
  });
};

type BookSourceDefinition = {
  id: string;
  name: string;
  encoding?: string;
  search: { method: "GET" | "POST"; url: string; bodyTemplate?: string; contentType?: string };
  searchItemSelector: string;
  searchTitleSelector: string;
  searchAuthorSelector: string;
  directorySelector: string;
  contentSelector: string;
  directoryUrlTemplate?: string;
  filterPatterns?: string[];
};

// A compact, configuration-driven source adapter modeled after so-novel. Each
// source describes only request and DOM shape; search, catalog, and chapter
// extraction below use the same shared flow.
const webBookSources: BookSourceDefinition[] = [
  {
    id: "shuhaige", name: "书海阁", encoding: "utf-8",
    search: { method: "POST", url: "https://www.shuhaige.net/search.html", bodyTemplate: "searchkey=%q&searchtype=all", contentType: "application/x-www-form-urlencoded; charset=utf-8" },
    searchItemSelector: "#sitembox > dl", searchTitleSelector: "dd > h3 > a", searchAuthorSelector: "dd:nth-child(3) > span:first-child",
    directorySelector: "dl > dt:nth-of-type(2) ~ dd > a", contentSelector: "#content",
    filterPatterns: ["本小章还未完，请点击下一页继续阅读后面精彩内容！", "小主，这个章节后面还有哦，请点击下一页继续阅读，后面更精彩！", "这章没有结束，请点击下一页继续阅读！", "\\(本章完\\)"],
  },
  {
    id: "biquge365", name: "笔趣阁 365", encoding: "utf-8",
    search: { method: "POST", url: "https://www.biquge365.net/s.php", bodyTemplate: '{"type":"articlename","s":"%s"}', contentType: "application/json; charset=utf-8" },
    searchItemSelector: "body > div.menu > div > ul > li", searchTitleSelector: "span.name > a", searchAuthorSelector: "span.zuo > a",
    directorySelector: "body > div.menu > div.border > ul > li > a", contentSelector: "#txt",
    directoryUrlTemplate: "https://www.biquge365.net/newbook/%s/",
    filterPatterns: ["\\(本章完\\)"],
  },
  {
    id: "xbiquge", name: "新笔趣阁", encoding: "utf-8",
    search: { method: "GET", url: "https://www.xbiquge.la/search.php?q=%s" },
    searchItemSelector: "table tbody tr", searchTitleSelector: "td a", searchAuthorSelector: "td:nth-child(3)",
    directorySelector: "#list dd a", contentSelector: "#content",
    filterPatterns: ["\\(本章完\\)"],
  },
];

type QianyueRules = Record<string, unknown>;
type QianyueSource = {
  id: string;
  name: string;
  baseUrl: string;
  searchUrl: string;
  header?: string;
  encoding?: string;
  ruleSearch: QianyueRules;
  ruleBookInfo: QianyueRules;
  ruleToc: QianyueRules;
  ruleContent: QianyueRules;
};

const qianyueSources: QianyueSource[] = (qianyueSourceData as Array<Record<string, unknown>>).map((source, index) => ({
  id: source.bookSourceName === "酷我小说[api]" ? "qianyue-kuwo" : `qianyue-${index}`,
  name: String(source.bookSourceName || `千阅书源 ${index + 1}`),
  baseUrl: String(source.bookSourceUrl || "").split("##")[0].trim(),
  searchUrl: String(source.searchUrl || ""),
  header: typeof source.header === "string" ? source.header : undefined,
  encoding: typeof source.header === "string" && /gbk/iu.test(source.header) ? "gbk" : "utf-8",
  ruleSearch: source.ruleSearch && typeof source.ruleSearch === "object" ? source.ruleSearch as QianyueRules : {},
  ruleBookInfo: source.ruleBookInfo && typeof source.ruleBookInfo === "object" ? source.ruleBookInfo as QianyueRules : {},
  ruleToc: source.ruleToc && typeof source.ruleToc === "object" ? source.ruleToc as QianyueRules : {},
  ruleContent: source.ruleContent && typeof source.ruleContent === "object" ? source.ruleContent as QianyueRules : {},
}));

const parseQianyueHeaders = (raw?: string): Record<string, string> => {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw.replace(/'/gu, '"')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    const headers: Record<string, string> = {};
    for (const match of raw.matchAll(/["']?([^"'{}:,]+)["']?\s*:\s*["']([^"']*)["']/gu)) headers[match[1].trim()] = match[2];
    return headers;
  }
};

const qianyuePathValues = (input: unknown, rawRule: unknown): unknown[] => {
  let rule = String(rawRule || "").trim().replace(/^@JSON:/iu, "").replace(/^@JSon:/iu, "");
  if (!rule || rule === "null") return [];
  rule = rule.split("##")[0].split("@js:")[0].trim();
  const alternatives = rule.split(/\|\||&&/u).map(value => value.trim()).filter(Boolean);
  for (const alternative of alternatives) {
    const normalized = alternative.replace(/^\$\.?/u, "").replace(/^\.\./u, "").replace(/\[\*\]/gu, ".*");
    if (!normalized) return [input];
    let values: unknown[] = [input];
    for (const segment of normalized.split(".").filter(Boolean)) {
      if (segment === "*") {
        values = values.flatMap(value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value as Record<string, unknown>) : []);
        continue;
      }
      const key = segment.replace(/\[.*$/u, "");
      values = values.flatMap(value => {
        if (Array.isArray(value)) return value.flatMap(item => item && typeof item === "object" ? [(item as Record<string, unknown>)[key]] : []);
        return value && typeof value === "object" ? [(value as Record<string, unknown>)[key]] : [];
      }).filter(value => value !== undefined && value !== null);
    }
    if (values.length) return values.flatMap(value => Array.isArray(value) ? value : [value]);
  }
  return [];
};

const applyQianyueReplacement = (value: unknown, rawRule: unknown): string => {
  let text = String(value ?? "").trim();
  const parts = String(rawRule || "").split("##");
  if (parts.length > 1 && parts[1]) {
    try { text = text.replace(new RegExp(parts[1], "gu"), parts[2] || ""); } catch { /* Keep the extracted value when a source regex is invalid. */ }
  }
  return text.trim();
};

const qianyueValue = (input: unknown, rule: unknown): string => applyQianyueReplacement(qianyuePathValues(input, rule)[0], rule);

const qianyueInterpolate = (template: string, item: unknown, variables: Record<string, string>): string => {
  let output = template
    .replace(/\{\{key\}\}/gu, encodeURIComponent(variables.key || ""))
    .replace(/\{\{page(?:-1)?\}\}/gu, match => match.includes("-1") ? "0" : variables.page || "1")
    .replace(/\{\{baseUrl\.replace\(['"]([^'"]*)['"],['"]([^'"]*)['"]\)\}\}/gu, (_match, from: string, to: string) => (variables.baseUrl || "").replace(from, to))
    .replace(/\{\{baseUrl\}\}/gu, variables.baseUrl || "");
  output = output.replace(/\{\{?\$\.([^}]+)\}\}?/gu, (_match, path: string) => qianyueValue(item, path));
  return output.trim();
};

const parseQianyueRequest = (raw: string, source: QianyueSource, item: unknown, variables: Record<string, string>): { url: string; method: "GET" | "POST"; body?: string; encoding: string; headers: Record<string, string> } => {
  const interpolated = qianyueInterpolate(raw, item, variables).replace(/^\{\{cookie[^}]+\}\}\s*/u, "").trim();
  if (/^(?:@js:|<js>)/iu.test(interpolated)) throw new Error("该书源使用脚本规则，当前版本暂不支持");
  const descriptorIndex = interpolated.search(/,\s*\{/u);
  const urlPart = descriptorIndex >= 0 ? interpolated.slice(0, descriptorIndex) : interpolated;
  const descriptorText = descriptorIndex >= 0 ? interpolated.slice(descriptorIndex + 1) : "";
  let descriptor: Record<string, unknown> = {};
  if (descriptorText) {
    try { descriptor = JSON.parse(descriptorText.replace(/'/gu, '"')) as Record<string, unknown>; } catch { descriptor = {}; }
  }
  const baseHeaders = parseQianyueHeaders(source.header);
  const extraHeaders = descriptor.headers && typeof descriptor.headers === "object" ? descriptor.headers as Record<string, string> : {};
  const charset = String(descriptor.charset || source.encoding || "utf-8");
  const body = typeof descriptor.body === "string" ? qianyueInterpolate(descriptor.body, item, variables) : undefined;
  const url = resolveBookUrl(source.baseUrl, urlPart.replace(/\n/gu, "").trim());
  if (!url) throw new Error("书源地址规则无效");
  return { url, method: String(descriptor.method || (body ? "POST" : "GET")).toUpperCase() === "POST" ? "POST" : "GET", body, encoding: charset, headers: { ...baseHeaders, ...extraHeaders } };
};

const isExpiredBearerToken = (value: string): boolean => {
  const token = value.replace(/^Bearer\s+/iu, "").trim();
  const parts = token.split(".");
  if (parts.length < 2) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0 && exp <= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
};

const withoutExpiredAuthorization = (headers: Record<string, string>): Record<string, string> => Object.fromEntries(
  Object.entries(headers).filter(([key, value]) => key.toLowerCase() !== "authorization" || !isExpiredBearerToken(String(value))),
);

const fetchQianyueResource = async (request: ReturnType<typeof parseQianyueRequest>, params?: Record<string, unknown>): Promise<string> => {
  const proxyEnabled = params?.proxyEnabled === true;
  const proxyURL = typeof params?.proxyURL === "string" ? params.proxyURL.trim() : "";
  let dispatcher: ProxyAgent | undefined;
  if (proxyEnabled && proxyURL) {
    dispatcher = webProxyAgents.get(proxyURL) || new ProxyAgent(proxyURL);
    webProxyAgents.set(proxyURL, dispatcher);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const requestHeaders = withoutExpiredAuthorization(request.headers);
    const execute = async (headers: Record<string, string>) => fetch(request.url, {
      method: request.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        ...(request.body ? { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" } : {}),
        ...headers,
      },
      ...(request.body ? { body: request.body } : {}),
      ...(dispatcher ? { dispatcher } : {}),
      signal: controller.signal,
    } as RequestInit);
    let response = await execute(requestHeaders);
    if (response.status === 401 || response.status === 403) {
      const hasAuthorization = Object.keys(requestHeaders).some(key => key.toLowerCase() === "authorization");
      if (hasAuthorization) {
        response = await execute(Object.fromEntries(Object.entries(requestHeaders).filter(([key]) => key.toLowerCase() !== "authorization")));
      }
    }
    if (!response.ok) throw new Error(`书源返回 HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return request.encoding.toLowerCase().includes("gb") ? iconv.decode(bytes, "gbk") : bytes.toString("utf-8");
  } finally {
    clearTimeout(timeout);
  }
};

const qianyueHtmlSelector = (rule: string): { selector: string; attribute: string } => {
  const normalized = rule.split("##")[0].replace(/^@css:/iu, "");
  const segments = normalized.split("@");
  const attribute = ["text", "html", "href", "src", "content", "textNodes"].includes(segments.at(-1) || "") ? segments.pop() || "text" : "text";
  const selector = segments.join(" ")
    .replace(/\bclass\.([\w-]+(?:\s+[\w-]+)*)/gu, (_match, names: string) => `.${names.trim().replace(/\s+/gu, ".")}`)
    .replace(/\bid\.([\w-]+)/gu, "#$1")
    .replace(/\btag\./gu, "")
    .replace(/\.(-?\d+)\b/gu, (_match, index: string) => Number(index) >= 0 ? `:eq(${index})` : "")
    .replace(/!.*$/u, "")
    .trim();
  return { selector, attribute };
};

const qianyueHtmlValues = (html: string, rule: unknown, context?: ReturnType<typeof loadHtml>): string[] => {
  const $ = context || loadHtml(html);
  for (const alternative of String(rule || "").split("||")) {
    if (/^(?:@js:|<js>)/iu.test(alternative.trim())) continue;
    const { selector, attribute } = qianyueHtmlSelector(alternative.trim());
    if (!selector) continue;
    const values = $(selector).toArray().map(element => {
      const node = $(element);
      const value = attribute === "html" ? node.html() || "" : attribute === "text" || attribute === "textNodes" ? node.text() : node.attr(attribute) || "";
      return applyQianyueReplacement(value, alternative);
    }).filter(Boolean);
    if (values.length) return values;
  }
  return [];
};

const parseMaybeJson = (text: string): unknown | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try { return JSON.parse(trimmed) as unknown; } catch { return null; }
};

const qianyueRuleValues = (payload: string, rule: unknown): unknown[] => {
  const json = parseMaybeJson(payload);
  if (json !== null && !String(rule || "").includes("@html") && !String(rule || "").includes("@href")) return qianyuePathValues(json, rule);
  return qianyueHtmlValues(payload, rule);
};

const qianyueScalar = (payload: string, item: unknown, rule: unknown): string => {
  const json = parseMaybeJson(payload);
  return json !== null ? qianyueValue(item, rule) : qianyueHtmlValues(payload, rule, loadHtml(typeof item === "string" ? item : payload))[0] || "";
};

const qianyueChapterUrl = (rule: string, item: unknown, tocUrl: string): string => {
  if (rule.includes("aesBase64DecodeToString")) {
    const pathRule = rule.split("@js:")[0];
    const encoded = qianyueValue(item, pathRule) || (item && typeof item === "object" ? String((item as Record<string, unknown>).path || "") : "");
    const args = rule.match(/aesBase64DecodeToString\(result,\s*["']([^"']+)["']\s*,\s*["'][^"']+["']\s*,\s*["']([^"']+)["']\s*\)/u);
    if (!encoded || !args) return "";
    try {
      const decipher = createDecipheriv("aes-128-cbc", Buffer.from(args[1], "utf8"), Buffer.from(args[2], "utf8"));
      return Buffer.concat([decipher.update(Buffer.from(encoded, "base64")), decipher.final()]).toString("utf8").trim();
    } catch {
      return "";
    }
  }
  return resolveBookUrl(tocUrl, qianyueInterpolate(rule, item, { baseUrl: tocUrl, key: "", page: "1" }));
};

const searchQianyueSource = async (source: QianyueSource, query: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const request = parseQianyueRequest(source.searchUrl, source, {}, { key: query, page: "1", baseUrl: source.baseUrl });
  const payload = await fetchQianyueResource(request, params);
  const items = qianyueRuleValues(payload, source.ruleSearch.bookList);
  const json = parseMaybeJson(payload);
  const $ = json === null ? loadHtml(payload) : null;
  return items.slice(0, 30).map((item, index) => {
    const localPayload = typeof item === "string" && json === null ? item : payload;
    const value = (rule: unknown) => json !== null ? qianyueValue(item, rule) : qianyueHtmlValues(localPayload, rule, $ || undefined)[index] || "";
    const title = value(source.ruleSearch.name);
    const rawUrl = qianyueInterpolate(String(source.ruleSearch.bookUrl || ""), item, { key: query, page: "1", baseUrl: request.url });
    const url = resolveBookUrl(request.url, rawUrl || value(source.ruleSearch.bookUrl));
    return {
      id: `${source.id}:${Buffer.from(url || `${title}-${index}`).toString("base64url")}`,
      sourceId: source.id,
      sourceBookId: url,
      source: source.name,
      title,
      author: value(source.ruleSearch.author) || "未知作者",
      intro: value(source.ruleSearch.intro).slice(0, 500),
      cover: resolveBookUrl(request.url, value(source.ruleSearch.coverUrl)) || undefined,
      category: value(source.ruleSearch.kind) || undefined,
      wordCount: Number(value(source.ruleSearch.wordCount).replace(/[^0-9]/gu, "")) || undefined,
      url,
    };
  }).filter(book => book.title && book.url);
};

type QianyueChapterLink = {
  number: number;
  title: string;
  url: string;
};

const qianyueChapterLinks = async (source: QianyueSource, bookUrl: string, params?: Record<string, unknown>, maxChapters = Number.MAX_SAFE_INTEGER): Promise<QianyueChapterLink[]> => {
  const infoRequest = parseQianyueRequest(bookUrl, source, {}, { key: "", page: "1", baseUrl: bookUrl });
  const infoPayload = await fetchQianyueResource(infoRequest, params);
  const infoJson = parseMaybeJson(infoPayload);
  const info = infoJson !== null && source.ruleBookInfo.init ? qianyuePathValues(infoJson, source.ruleBookInfo.init)[0] || infoJson : infoJson;
  const tocRule = String(source.ruleBookInfo.tocUrl || bookUrl);
  const tocRequest = parseQianyueRequest(tocRule, source, info, { key: "", page: "1", baseUrl: bookUrl });
  const tocPayload = await fetchQianyueResource(tocRequest, params);
  const tocItems = qianyueRuleValues(tocPayload, source.ruleToc.chapterList).slice(0, Math.max(1, Math.floor(maxChapters)));
  if (!tocItems.length) throw new Error("书源没有返回章节目录");
  const chapterRule = String(source.ruleToc.chapterUrl || "");
  const titleRule = source.ruleToc.chapterName;
  return tocItems.map((item, index) => ({
    number: index + 1,
    title: qianyueValue(item, titleRule) || `第 ${index + 1} 章`,
    url: qianyueChapterUrl(chapterRule, item, tocRequest.url),
  }));
};

const downloadQianyueSource = async (source: QianyueSource, bookUrl: string, params?: Record<string, unknown>, maxChapters = Number.MAX_SAFE_INTEGER): Promise<Array<Record<string, unknown>>> => {
  const links = await qianyueChapterLinks(source, bookUrl, params, maxChapters);
  return concurrentMap(links, 4, async (chapter, index) => {
    if (!chapter.url) return { id: `${source.id}:chapter:${index}`, number: chapter.number, title: chapter.title, url: "", content: "", wordCount: 0, downloaded: false };
    try {
      const chapterRequest = parseQianyueRequest(chapter.url, source, {}, { key: "", page: "1", baseUrl: chapter.url });
      const chapterPayload = await fetchQianyueResource(chapterRequest, params);
      const contentJson = parseMaybeJson(chapterPayload);
      const rawContent = contentJson !== null ? qianyueValue(contentJson, source.ruleContent.content) : qianyueHtmlValues(chapterPayload, source.ruleContent.content)[0] || "";
      const content = cleanBookSourceContent(rawContent, []);
      return { id: `${source.id}:chapter:${Buffer.from(chapter.url).toString("base64url")}`, number: chapter.number, title: chapter.title, url: chapter.url, content, wordCount: content.replace(/\s/gu, "").length, downloaded: Boolean(content) };
    } catch {
      return { id: `${source.id}:chapter:${Buffer.from(chapter.url).toString("base64url")}`, number: chapter.number, title: chapter.title, url: chapter.url, content: "", wordCount: 0, downloaded: false };
    }
  });
};

const resolveBookUrl = (baseUrl: string, value: string): string => {
  try { return new URL(value.trim(), baseUrl).toString(); } catch { return ""; }
};

const sourceSearchBody = (template: string, query: string): string => template
  .replace(/%q/gu, encodeURIComponent(query))
  .replace(/%s/gu, () => JSON.stringify(query).slice(1, -1));

const fetchBookSourceHtml = async (url: string, params: Record<string, unknown> | undefined, options: { method?: "GET" | "POST"; body?: string; contentType?: string; encoding?: string } = {}): Promise<string> => {
  const proxyEnabled = params?.proxyEnabled === true;
  const proxyURL = typeof params?.proxyURL === "string" ? params.proxyURL.trim() : "";
  let dispatcher: ProxyAgent | undefined;
  if (proxyEnabled && proxyURL) {
    dispatcher = webProxyAgents.get(proxyURL);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxyURL);
      webProxyAgents.set(proxyURL, dispatcher);
    }
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(options.body ? { "Content-Type": options.contentType || "application/json; charset=utf-8" } : {}),
    },
    ...(options.body ? { body: options.body } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
  if (!response.ok) throw new Error(`书源返回 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return options.encoding && options.encoding.toLowerCase() !== "utf-8" ? iconv.decode(bytes, options.encoding) : bytes.toString("utf-8");
};

const cleanBookSourceContent = (content: string, patterns: string[] = []): string => {
  let cleaned = decodeWebText(content);
  for (const pattern of patterns) {
    try { cleaned = cleaned.replace(new RegExp(pattern, "gu"), ""); } catch { /* Ignore an invalid source rule. */ }
  }
  return cleaned.replace(/\n{3,}/gu, "\n\n").trim();
};

const searchConfiguredBookSource = async (source: BookSourceDefinition, query: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const searchUrl = source.search.url.replace(/%s/gu, encodeURIComponent(query));
  const html = await fetchBookSourceHtml(searchUrl, params, source.search.method === "POST" ? {
    method: "POST", body: sourceSearchBody(source.search.bodyTemplate || "{}", query), contentType: source.search.contentType, encoding: source.encoding,
  } : { encoding: source.encoding });
  const $ = loadHtml(html);
  const results: Array<Record<string, unknown>> = [];
  $(source.searchItemSelector).each((_index, element) => {
    const item = $(element);
    const titleNode = item.find(source.searchTitleSelector).first();
    const title = titleNode.text().trim();
    const url = resolveBookUrl(searchUrl, titleNode.attr("href") || "");
    if (!title || !url) return;
    results.push({
      id: `${source.id}:${Buffer.from(url).toString("base64url")}`,
      sourceId: source.id,
      sourceBookId: url,
      source: source.name,
      title,
      author: item.find(source.searchAuthorSelector).first().text().trim() || "未知作者",
      url,
      intro: "",
    });
  });
  return results.slice(0, 30);
};

type BookSearchTask = {
  sourceId: string;
  sourceName: string;
  run: () => Promise<{ books: Array<Record<string, unknown>>; fontCss?: string }>;
};

const isSearchableQianyueSource = (source: QianyueSource): boolean => {
  const searchUrl = source.searchUrl.trim();
  return Boolean(searchUrl) && !/^(?:@js:|<js>)/iu.test(searchUrl);
};

const searchResultScore = (query: string, book: Record<string, unknown>): number => {
  const normalize = (value: unknown): string => String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const needle = normalize(query);
  const title = normalize(book.title);
  const author = normalize(book.author);
  if (title === needle) return 1_000;
  if (title.includes(needle)) return 800 - Math.min(240, title.length - needle.length);
  if (needle.includes(title)) return 620 - Math.min(240, needle.length - title.length);
  if (author.includes(needle)) return 560;
  return 0;
};

const searchAllBookSources = async (query: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const tasks: BookSearchTask[] = [
    {
      sourceId: "fanqie",
      sourceName: "番茄小说",
      run: async () => searchFanqieSource(query, params),
    },
    ...qianyueSources.filter(isSearchableQianyueSource).map(source => ({
      sourceId: source.id,
      sourceName: source.name,
      run: async () => ({ books: await searchQianyueSource(source, query, params) }),
    })),
    ...webBookSources.map(source => ({
      sourceId: source.id,
      sourceName: source.name,
      run: async () => ({ books: await searchConfiguredBookSource(source, query, params) }),
    })),
  ];
  const responses = await concurrentMap(tasks, 12, async task => {
    try {
      const result = await task.run();
      return { ...task, ...result, succeeded: true };
    } catch {
      return { ...task, books: [] as Array<Record<string, unknown>>, succeeded: false };
    }
  });
  const seen = new Set<string>();
  const rankedBooks: Array<Record<string, unknown> & { id: string; sourceId: string; source: string; searchScore: number }> = responses.flatMap(response => response.books.map((book, index) => ({
    ...book,
    id: String(book.id || `${response.sourceId}:${index}`),
    sourceId: String(book.sourceId || response.sourceId),
    source: String(book.source || response.sourceName),
    searchScore: searchResultScore(query, book),
  }))) as Array<Record<string, unknown> & { id: string; sourceId: string; source: string; searchScore: number }>;
  const books = rankedBooks.filter(book => {
    if (seen.has(book.id)) return false;
    seen.add(book.id);
    const url = String(book.url || "");
    return Boolean(book.title && /^https?:\/\//iu.test(url) && !/[{}@]/u.test(url));
  }).sort((left, right) => Number(right.searchScore) - Number(left.searchScore)).slice(0, 150).map(({ searchScore: _searchScore, ...book }) => book);
  return {
    books,
    fontCss: responses.find(response => response.fontCss)?.fontCss || "",
    searchedSourceCount: tasks.length,
    responsiveSourceCount: responses.filter(response => response.succeeded).length,
    failedSourceCount: responses.filter(response => !response.succeeded).length,
  };
};

const downloadConfiguredBookSource = async (source: BookSourceDefinition, bookUrl: string, params?: Record<string, unknown>, maxChapters = Number.MAX_SAFE_INTEGER): Promise<Array<Record<string, unknown>>> => {
  let directoryUrl = bookUrl;
  if (source.directoryUrlTemplate) {
    const match = new URL(bookUrl).pathname.match(/\/([^/]+)\/?$/u);
    const bookId = match?.[1]?.replace(/\.html?$/iu, "") || "";
    if (bookId) directoryUrl = source.directoryUrlTemplate.replace(/%s/gu, bookId);
  }
  const directoryHtml = await fetchBookSourceHtml(directoryUrl, params, { encoding: source.encoding });
  const $ = loadHtml(directoryHtml);
  const links: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  $(source.directorySelector).each((_index, element) => {
    const anchor = $(element);
    const title = anchor.text().trim();
    const url = resolveBookUrl(directoryUrl, anchor.attr("href") || "");
    if (!title || !url || seen.has(url)) return;
    seen.add(url);
    links.push({ title, url });
  });
  const targets = links.slice(0, Math.max(1, Math.floor(maxChapters)));
  if (!targets.length) throw new Error("书源没有返回章节目录");
  const chapters: Array<Record<string, unknown>> = [];
  for (let index = 0; index < targets.length; index += 1) {
    const chapter = targets[index];
    try {
      const html = await fetchBookSourceHtml(chapter.url, params, { encoding: source.encoding });
      const content = cleanBookSourceContent(loadHtml(html)(source.contentSelector).html() || "", source.filterPatterns);
      chapters.push({ id: `${source.id}:chapter:${Buffer.from(chapter.url).toString("base64url")}`, number: index + 1, title: chapter.title, url: chapter.url, content, wordCount: content.length, downloaded: Boolean(content) });
    } catch {
      chapters.push({ id: `${source.id}:chapter:${Buffer.from(chapter.url).toString("base64url")}`, number: index + 1, title: chapter.title, url: chapter.url, content: "", wordCount: 0, downloaded: false });
    }
  }
  return chapters;
};

const downloadQianyueChapter = async (source: QianyueSource, chapter: Record<string, unknown>, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const chapterUrl = String(chapter.url || "").trim();
  if (!chapterUrl) throw new Error("该章节缺少可下载地址");
  const request = parseQianyueRequest(chapterUrl, source, {}, { key: "", page: "1", baseUrl: chapterUrl });
  const payload = await fetchQianyueResource(request, params);
  const contentJson = parseMaybeJson(payload);
  const rawContent = contentJson !== null ? qianyueValue(contentJson, source.ruleContent.content) : qianyueHtmlValues(payload, source.ruleContent.content)[0] || "";
  const content = cleanBookSourceContent(rawContent, []);
  if (!content) throw new Error("书源没有返回本章正文");
  return {
    ...chapter,
    content,
    wordCount: content.replace(/\s/gu, "").length,
    downloaded: true,
    unavailableReason: undefined,
  };
};

const normalizedBookMatchText = (value: unknown): string => String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const isCompleteChapterContent = (content: string, expectedWords = 0): boolean => {
  const characters = content.replace(/\s/gu, "").length;
  return characters >= Math.max(500, expectedWords > 0 ? Math.floor(expectedWords * 0.65) : 0);
};

// Fanqie can intentionally return a short web preview for a chapter. The
// configured sources are queried by exact book title, then the matching chapter
// title is fetched. A replacement is only accepted once it passes the same
// completeness threshold as a native Fanqie response.
const downloadFallbackChapter = async (title: string, chapterNumber: number, chapterTitle: string, expectedWords: number, params?: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
  const normalizedTitle = normalizedBookMatchText(title);
  const normalizedChapterTitle = normalizedBookMatchText(chapterTitle);
  const preferredSources = [
    qianyueSources.find(source => source.id === "qianyue-4"),
    qianyueSources.find(source => source.id === "qianyue-0"),
    qianyueSources.find(source => source.id === "qianyue-kuwo"),
  ].filter((source): source is QianyueSource => Boolean(source));

  for (const source of preferredSources) {
    try {
      const candidates = await searchQianyueSource(source, title, params);
      const candidate = candidates.find(item => normalizedBookMatchText(item.title) === normalizedTitle);
      if (!candidate?.url) continue;
      const links = await qianyueChapterLinks(source, String(candidate.url), params, Math.max(chapterNumber + 2, 50));
      const link = links.find(item => normalizedBookMatchText(item.title) === normalizedChapterTitle)
        || links.find(item => item.number === chapterNumber);
      if (!link?.url) continue;
      const downloaded = await downloadQianyueChapter(source, { number: chapterNumber, title: chapterTitle, url: link.url }, params);
      const content = String(downloaded.content || "");
      if (!isCompleteChapterContent(content, expectedWords)) continue;
      return { ...downloaded, sourceId: source.id, sourceName: source.name, fallbackSourceName: source.name };
    } catch {
      // A configured source can expire independently. Continue to the next one.
    }
  }
  return undefined;
};

const downloadConfiguredBookChapter = async (source: BookSourceDefinition, chapter: Record<string, unknown>, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const chapterUrl = String(chapter.url || "").trim();
  if (!chapterUrl) throw new Error("该章节缺少可下载地址");
  const html = await fetchBookSourceHtml(chapterUrl, params, { encoding: source.encoding });
  const content = cleanBookSourceContent(loadHtml(html)(source.contentSelector).html() || "", source.filterPatterns);
  if (!content) throw new Error("书源没有返回本章正文");
  return { ...chapter, content, wordCount: content.length, downloaded: true, unavailableReason: undefined };
};

const parseChineseNumber = (value: string): number | undefined => {
  const match = value.replace(/,/gu, "").match(/([\d.]+)\s*(万|亿)?/u);
  if (!match) return undefined;
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  const number = Number(match[1]) * multiplier;
  return Number.isFinite(number) ? Math.round(number) : undefined;
};

const parseNovelCatchRanking = (html: string, rankType: string, gender: string): Array<Record<string, unknown>> => {
  const $ = loadHtml(html);
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  $('div.border-b.border-line').each((_index, element) => {
    const card = $(element);
    const titleLink = card.find('a[href^="/book/"]').filter((_index, item) => Boolean($(item).text().trim())).first();
    const href = titleLink.attr('href') || '';
    const bookId = href.match(/\/(\d+)$/u)?.[1] || '';
    const title = titleLink.text().trim();
    if (!bookId || !title || seen.has(bookId)) return;
    seen.add(bookId);
    const info = card.find('.mt-1.flex.flex-wrap.items-center').first().text().replace(/\s+/gu, ' ').trim();
    const infoParts = info.split('·').map(item => item.trim()).filter(Boolean);
    const cardText = card.text().replace(/\s+/gu, ' ').trim();
    const rank = Number(card.find('.font-mono.text-\[15px\]').first().text().trim()) || rows.length + 1;
    const wordCount = parseChineseNumber(infoParts.find(item => /字$/u.test(item)) || '');
    const readMatch = cardText.match(/([\d.]+\s*万?)在读/u);
    rows.push({
      id: `fanqie:${bookId}`,
      sourceId: 'novelcatch-rank',
      sourceBookId: bookId,
      title,
      author: infoParts[0] || '未知作者',
      intro: card.find('p.line-clamp-2').first().text().replace(/\s+/gu, ' ').trim(),
      cover: resolveBookUrl('https://novelcatch.com/rank', card.find('img').first().attr('src') || '') || undefined,
      category: card.find('a[href^="/category/"]').first().text().trim() || undefined,
      rank,
      rankType,
      gender: gender === 'male' || gender === 'female' ? gender : 'all',
      platform: 'fanqie',
      url: `https://fanqienovel.com/page/${bookId}`,
      wordCount,
      readCount: readMatch ? parseChineseNumber(readMatch[1]) : undefined,
    });
  });
  return rows.slice(0, 60);
};

const novelCatchRankingSections = [
  { key: 'male-read', label: '男频阅读', gender: 'm', list: 'read' },
  { key: 'male-new', label: '男频新书', gender: 'm', list: 'new' },
  { key: 'female-read', label: '女频阅读', gender: 'f', list: 'read' },
  { key: 'female-new', label: '女频新书', gender: 'f', list: 'new' },
] as const;

const parseNovelCatchRankLinks = (html: string, section: typeof novelCatchRankingSections[number]) => {
  const $ = loadHtml(html);
  const categories: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  $('a[href^="/rank?"]').each((_index, element) => {
    const href = $(element).attr('href') || '';
    const url = resolveBookUrl('https://novelcatch.com/rank', href);
    if (!url || seen.has(url)) return;
    const parsed = new URL(url);
    if (parsed.searchParams.get('gender') !== section.gender || parsed.searchParams.get('list') !== section.list) return;
    const category = parsed.searchParams.get('category');
    if (!category) return;
    seen.add(url);
    categories.push({ id: category, label: $(element).text().trim(), url, gender: section.gender === 'f' ? 'female' : 'male', list: section.list });
  });
  return categories;
};

const fetchNovelCatchRankingCategories = async (params?: Record<string, unknown>) => {
  const sections = await Promise.all(novelCatchRankingSections.map(async section => {
    const url = `https://novelcatch.com/rank?gender=${section.gender}&list=${section.list}`;
    const html = await fetchWebText(url, params);
    return { key: section.key, label: section.label, url, categories: parseNovelCatchRankLinks(html, section) };
  }));
  if (!sections.some(section => section.categories.length)) throw new Error('NovelCatch 官方榜单没有返回分类链接');
  return sections;
};

const fetchNovelCatchRanking = async (rankType: string, gender: string, rankUrl: string | undefined, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const sectionGender = gender === 'female' ? 'f' : 'm';
  const sectionList = rankType === 'new' ? 'new' : 'read';
  const fallbackUrl = `https://novelcatch.com/rank?gender=${sectionGender}&list=${sectionList}&category=all`;
  const url = rankUrl && /^https:\/\/novelcatch\.com\/rank\?/u.test(rankUrl) ? rankUrl : fallbackUrl;
  const rows = parseNovelCatchRanking(await fetchWebText(url, params), rankType, gender);
  if (!rows.length) throw new Error('NovelCatch 官方榜单没有返回可用书籍，请稍后刷新');
  return rows;
};

const fetchQidianRanking = async (rankType: string, gender: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const basePath = rankType === "new" ? "signnewbook" : rankType === "read" ? "readindex" : "yuepiao";
  // 起点榜单统一使用官网默认榜单，不再区分男频/女频频道。
  const pageUrl = `https://www.qidian.com/rank/${basePath}/`;
  const parseRankingPage = (html: string) => {
    const $ = loadHtml(html);
    // 页面顶部也可能带 data-rid 的导航项；先筛出真实书籍行再截取，避免
    // 前置无关元素占满 slice 后造成“返回 0 本书”。
    const rankRows = $('[data-rid], li.rank-list-item, .rank-list .book-mid-info').toArray().filter(element => {
      const titleNode = $(element).find('.book-mid-info h2 a').first();
      return Boolean((titleNode.text().trim() && titleNode.attr('href')) || $(element).is('.book-mid-info'));
    }).slice(0, 60);
    const parsed = rankRows.map((element, index) => {
      const item = $(element);
      const scope = item.is('.book-mid-info') ? item : item;
      const titleNode = scope.find('.book-mid-info h2 a, h2 a, a[href*="/book/"]').filter((_i, node) => Boolean($(node).text().trim())).first();
      const href = resolveBookUrl(pageUrl, titleNode.attr('href') || '');
      const bookId = titleNode.attr('data-bid') || href.match(/\/book\/(\d+)/u)?.[1] || String(index);
      const categories = item.find('.book-mid-info .author a').toArray().slice(1).map(node => $(node).text().trim()).filter(Boolean);
      return {
        id: `qidian:${bookId}`, sourceBookId: bookId, title: titleNode.text().trim(),
        author: item.find('.book-mid-info .author a.name').first().text().trim() || '未知作者',
        intro: scope.find('.book-mid-info .intro, .intro, [class*="intro"]').first().text().trim(), cover: resolveBookUrl(pageUrl, scope.find('.book-img-box img, img').first().attr('src') || '') || undefined,
        category: categories.join(' · ') || undefined, rank: Number(item.attr('data-rid')) || index + 1,
        rankType, gender: 'all', platform: 'qidian', url: href,
      };
    }).filter(book => book.title && book.url);
    if (parsed.length) return parsed;
    // Fallback for markup changes: locate every canonical /book/<id> link and
    // walk to its nearest card for author, intro and cover metadata.
    const seen = new Set<string>();
    return $('a[href*="/book/"]').toArray().flatMap((node, index) => {
      const link = $(node);
      const href = resolveBookUrl(pageUrl, link.attr('href') || '');
      const id = href.match(/\/book\/(\d+)/u)?.[1] || '';
      const title = link.text().replace(/\s+/gu, ' ').trim();
      if (!id || !title || seen.has(id)) return [];
      seen.add(id);
      let card = link;
      for (let depth = 0; depth < 5 && card.length; depth += 1) {
        const text = card.text().trim();
        if (text.length > title.length + 10) break;
        card = card.parent();
      }
      return [{ id: `qidian:${id}`, sourceBookId: id, title, author: card.find('.author a.name, .author a').first().text().trim() || '未知作者', intro: card.find('.intro, [class*="intro"]').first().text().trim(), cover: resolveBookUrl(pageUrl, card.find('img').first().attr('src') || '') || undefined, category: undefined, rank: index + 1, rankType, gender: 'all', platform: 'qidian', url: href }];
    }).slice(0, 60);
  };
  const requestOptions = { headers: { Referer: 'https://www.qidian.com/rank/' } };
  let books = parseRankingPage(await fetchWebText(pageUrl, params, requestOptions));
  // 部分代理出口会被起点的 WAF 直接替换为探针页。榜单是公开页面，解析不到
  // 书籍时自动直连重试一次，避免把代理校验页误报为“榜单没有书”。
  if (!books.length && params?.proxyEnabled === true) {
    books = parseRankingPage(await fetchWebText(pageUrl, { ...params, proxyEnabled: false }, requestOptions));
  }
  if (!books.length) {
    const probe = await fetchWebText(pageUrl, { ...params, proxyEnabled: false }, requestOptions).catch(() => '');
    if (/C2WF946J0\/probe\.js|var\s+buid\s*=|challenge|verify/iu.test(probe)) throw new Error(`起点中文网${basePath}返回了反爬校验页，请更换代理出口或稍后重试`);
    throw new Error(`起点中文网${basePath}未找到书籍条目，官网结构可能已变化`);
  }
  return books;
};

const fetchFalooRanking = async (rankType: string, gender: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const pageUrl = "https://b.faloo.com/SR_1.html";
  const request = { url: pageUrl, method: "GET" as const, encoding: "gbk", headers: {} };
  const html = await fetchQianyueResource(request, params);
  const $ = loadHtml(html);
  const books = $('.c_td_d_data').toArray().slice(0, 60).map((element, index) => {
    const item = $(element);
    const titleNode = item.find('.c_td_d_d_title a').first();
    const href = resolveBookUrl(pageUrl, titleNode.attr('href') || '');
    const bookId = href.match(/\/(\d+)\.html/u)?.[1] || String(index);
    const metadata = item.find('.c_td_d_d_count').first().text().replace(/\s+/gu, ' ').trim();
    return {
      id: `faloo:${bookId}`, sourceBookId: bookId, title: titleNode.text().trim(),
      author: item.find('.c_td_d_d_author').first().text().trim() || '未知作者',
      intro: '', cover: (resolveBookUrl(pageUrl, item.find('.c_td_d_d_img img').attr('src') || '') || '').replace(/^http:/iu, 'https:') || undefined,
      category: item.find('.c_td_d_d_class').first().text().trim() || undefined,
      rank: Number(item.find('[class^="c_td_d_d_number"]').first().text().trim()) || index + 1,
      rankType: 'read', gender: 'all', platform: 'faloo', url: href,
      readCount: parseChineseNumber(metadata),
    };
  }).filter(book => book.title && book.url);
  if (!books.length) throw new Error('飞卢24小时畅销榜没有返回可用书籍，请稍后刷新');
  return books;
};

async function handleRequest(req: RPCRequest): Promise<RPCResponse> {
  try {
    if (req.method === "usage.summary") {
      return { id: req.id, result: getRuntimeUsageSummary() };
    }
    if (req.method === "gateway.usage") {
      const { apiKey, apiKeys, proxyEnabled, proxyURL, proxyBypassLocal } = req.params ?? {};
      if (!apiKey) return { id: req.id, error: { code: -32602, message: "请先在设置中填写 API Key。" } };
      const client = new ApiSaverClient({
        apiKey: String(apiKey), apiKeys: stringList(apiKeys, 12),
        proxyEnabled: Boolean(proxyEnabled), proxyURL: String(proxyURL || ""), proxyBypassLocal: proxyBypassLocal === true,
      });
      return { id: req.id, result: await client.getGatewayUsageSnapshot() };
    }
    if (req.method === "models.list") {
      const { apiKey, apiKeys, baseURL, apiMode, reasoningMode, contextWindow, proxyEnabled, proxyURL, proxyBypassLocal } = req.params ?? {};
      if (!apiKey) {
        return { id: req.id, error: { code: -32602, message: "Missing required params" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        proxyEnabled: Boolean(proxyEnabled),
        proxyURL: String(proxyURL || ""),
        proxyBypassLocal: proxyBypassLocal === true,
      });
      return { id: req.id, result: { models: await client.listModels() } };
    }
    if (req.method === "models.test") {
      const { apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || !model) {
        return { id: req.id, error: { code: -32602, message: "缺少测试模型所需参数" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      // Some relay models spend hidden reasoning tokens before emitting the
      // two-character answer. Keep this probe generous so a valid model is
      // not mistaken for an empty response when the gateway reports length.
      await client.chat([{ role: "user", content: "请只回复 OK" }], { max_tokens: 256, temperature: 0, retryAttempts: 2 });
      return { id: req.id, result: { tested: true, model: String(model) } };
    }
    if (req.method === "image.generate") {
      const { prompt, imageApiKey, imageModel, size, quality } = req.params ?? {};
      if (!String(prompt || '').trim() || !String(imageApiKey || '').trim()) {
        return { id: req.id, error: { code: -32602, message: "请先填写封面生图 API Key 和提示词" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(imageApiKey),
        baseURL: "https://api.apisaver.com/v1",
        defaultModel: String(imageModel || "gpt-image-2"),
        apiMode: "openai",
        ...networkProxyConfig(req.params),
      });
      const result = await client.generateImage(String(prompt), {
        apiKey: String(imageApiKey),
        model: String(imageModel || "gpt-image-2"),
        size: String(size || "1024x1536"),
        quality: String(quality || "high"),
      });
      return { id: req.id, result };
    }
    if (req.method === "project.generate") {
      const { field, source, title, synopsis, channel, tags, protagonist1, protagonist2, outlines, chapters, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || (field !== "title" && field !== "synopsis")) {
        return { id: req.id, error: { code: -32602, message: "缺少生成作品信息所需参数" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const tagRecord = tags && typeof tags === "object" ? tags as Record<string, unknown> : {};
      const tagText = Object.entries(tagRecord).flatMap(([kind, values]) => stringList(values).map(value => `${kind}：${value}`)).join("；");
      const outlineContext = Array.isArray(outlines) && outlines.length
        ? outlines.map(item => {
          const outline = item as Record<string, unknown>;
          return `### ${String(outline.kind || "大纲")}｜${String(outline.title || "未命名")}\n${String(outline.content || "").slice(0, 5000)}`;
        }).join("\n\n")
        : "（暂无可用大纲，请根据已有作品信息构思）";
      const chapterContext = Array.isArray(chapters) && chapters.length
        ? chapters.map(item => {
          const chapter = item as Record<string, unknown>;
          return `### ${String(chapter.title || "章节")}\n${String(chapter.content || "").slice(0, 4500)}`;
        }).join("\n\n")
        : "（暂无可用章节，请根据已有作品信息构思）";
      const selectedContext = source === "chapters" ? chapterContext : outlineContext;
      const common = `频道：${String(channel || "男频")}\n标签：${tagText || "暂无"}\n主角：${[protagonist1, protagonist2].filter(Boolean).map(String).join("、") || "暂无"}\n当前书名：${String(title || "暂无")}\n已有作品简介：${String(synopsis || "暂无")}\n\n## ${source === "chapters" ? "前 3 章正文" : "作品大纲"}\n${selectedContext}`;
      const prompt = field === "title"
        ? `你是番茄小说平台的网文责编。请根据下列素材拟定一个适合${String(channel || "男频")}读者、具备题材卖点和记忆点的中文网文书名。\n\n${common}\n\n只返回 JSON：\n{ "title": "书名" }\n\n规则：书名 4 到 15 个汉字或常用数字；不要加《》、引号、作者名、解释、标点或副标题；避免与素材无关的套路词。`
        : `你是番茄小说平台的网文责编。请根据下列素材撰写可直接用于上架页的作品简介。\n\n${common}\n\n只返回 JSON：\n{ "synopsis": "作品简介" }\n\n规则：180 到 320 个中文字符，最多 500 字；开头迅速给出主角处境、核心金手指或矛盾，中段明确升级目标与风险，结尾留下强钩子；突出标签卖点和读者预期；不加标题、Markdown、分段序号、免责声明或解释；不得编造与素材矛盾的事实。`;
      const response = await client.chat([{ role: "user", content: prompt }], {
        response_format: { type: "json_object" },
        temperature: field === "title" ? 0.9 : 0.7,
        max_tokens: field === "title" ? 180 : 900,
        retryAttempts: 2,
      });
      try {
        const cleanedResponse = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/u, "").trim();
        const result = JSON.parse(cleanedResponse) as Record<string, any>;
        return {
          id: req.id,
          result: {
            title: typeof result.title === "string" ? result.title.trim() : "",
            synopsis: typeof result.synopsis === "string" ? result.synopsis.trim() : "",
          },
        };
      } catch {
        const content = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/u, "").trim();
        return { id: req.id, result: field === "title" ? { title: content } : { synopsis: content } };
      }
    }
    if (req.method === "skill.write") {
      const { name, category, description, content, tags, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || (!name && !description && !content)) {
        return { id: req.id, error: { code: -32602, message: "缺少创建技能所需参数" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const prompt = `你是 skill-creator。请把用户的小说写作需求整理成一个可复用技能。\n\n名称：${String(name || "待命名技能")}\n分类：${String(category || "write")}\n用途：${String(description || "暂无")}\n草稿：${String(content || "暂无")}\n标签：${stringList(tags).join("、") || "暂无"}\n\n只返回 JSON：\n{\n  "name": "短名称（英文 kebab-case）",\n  "category": "setup|write|review|polish|import|analyze|tool|creator",\n  "description": "一句话用途",\n  "tags": ["标签"],\n  "content": "Markdown 技能正文，包含触发条件、输入、步骤、输出格式、质量检查和失败处理"\n}\n不要输出 JSON 以外的文字。`;
      const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.3, max_tokens: 2200 });
      try {
        const result = JSON.parse(response.content) as Record<string, unknown>;
        return { id: req.id, result: {
          name: typeof result.name === "string" ? result.name.trim() : String(name || "custom-skill"),
          category: typeof result.category === "string" ? result.category.trim() : String(category || "write"),
          description: typeof result.description === "string" ? result.description.trim() : String(description || ""),
          content: typeof result.content === "string" ? result.content.trim() : response.content,
          tags: stringList(result.tags, 12),
        } };
      } catch {
        return { id: req.id, result: { name: String(name || "custom-skill"), category: String(category || "write"), description: String(description || ""), content: response.content, tags: stringList(tags, 12) } };
      }
    }
    if (req.method === "memory.write") {
      const { projectTitle, chapterTitle, content, cards, knowledgeGraph, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!chapterTitle || !content || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "Missing required params" } };
      }
      const memoryBudgetBytes = contextBudgetBytes(Number(contextWindow) || undefined, 20, 8);
      const chapterContent = compactText(content, memoryBudgetBytes);
      const rawCards = Array.isArray(cards) ? cards.filter(card => card && typeof card === "object") as Array<Record<string, unknown>> : [];
      // A card that is neither named in this chapter nor selected by graph context cannot change here.
      const relevantCards = rawCards.filter(card => {
        const title = String(card.title || "").trim();
        return title.length > 0 && String(content).includes(title);
      }).slice(0, 10);
      const graphSummary = compactKnowledgeGraph(
        knowledgeGraph,
        `${String(chapterTitle)}\n${chapterContent}\n${relevantCards.map(card => String(card.title || "")).join(" ")}`,
        2400,
      );
      const memoryCacheKey = stableHash({
        projectTitle: String(projectTitle || ""), chapterTitle: String(chapterTitle), content: String(content),
        // updatedAt changes on every local save even when the chapter and card
        // facts are unchanged. Excluding it lets identical memory writes reuse
        // the persistent cache after restart.
        cards: relevantCards.map(card => ({ id: card.id, title: card.title, state: card.currentState, content: card.content })),
        graphSummary, model: String(model || "gpt-5.5"), apiMode: String(apiMode || "openai"),
      });
      const cachedMemory = chapterMemoryCache.get(memoryCacheKey) || await readPersistentContext<Record<string, unknown>>(`memory-${memoryCacheKey}`);
      if (cachedMemory) {
        chapterMemoryCache.set(memoryCacheKey, cachedMemory);
        const cachedReport: ContextReport = {
          cache: "hit",
          sourceBytes: byteLength(JSON.stringify({ content, cards: rawCards, knowledgeGraph })),
          packedBytes: byteLength(chapterContent) + byteLength(graphSummary),
          prunedBytes: Math.max(0, byteLength(JSON.stringify({ content, cards: rawCards, knowledgeGraph })) - byteLength(chapterContent) - byteLength(graphSummary)),
          budgetBytes: memoryBudgetBytes,
          sections: { chapter: byteLength(chapterContent), cards: 0, knowledgeGraph: byteLength(graphSummary) },
        };
        return { id: req.id, result: { ...cachedMemory, contextReport: cachedReport } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-5.5"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const cardContext = Array.isArray(cards) && cards.length
        ? `\n## 已有卡片及当前状态（仅更新正文有证据的卡片）\n${cards.map(card => { const item = card as Record<string, unknown>; return `${String(item.id || "")}|${String(item.title || "卡片")}：${String(item.content || "")}\n当前状态：${String(item.currentState || "暂无")}`; }).join("\n")}`
        : "";
      const graphContext = knowledgeGraph && typeof knowledgeGraph === "object"
        ? `\n## 已有知识图谱（用于增量更新）\n${JSON.stringify(knowledgeGraph).slice(0, 12000)}`
        : "";
      const compactCardContext = relevantCards.length
        ? `\n## 正文命中的卡片（仅可更新这些卡片）\n${relevantCards.map(card => {
          const history = Array.isArray(card.stateHistory) ? card.stateHistory.slice(-2).map(item => {
            const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
            return compactText(entry.changes || "", 180);
          }).filter(Boolean).join("；") : "";
          return `${String(card.id || "")} | ${compactText(card.title || "卡片", 100)}\n当前状态：${compactText(card.currentState || "暂无", 360)}${history ? `\n近期变化：${history}` : ""}\n知识：${compactText(card.content || "", 720)}`;
        }).join("\n\n")}`
        : "";
      const compactGraphContext = graphSummary ? `\n## 相关知识图谱（用于增量更新）\n${graphSummary}` : "";
      const compactMemoryPrompt = `请为《${String(projectTitle || "未命名小说")}》的${String(chapterTitle)}整理可检索的结构化章节记忆，并从正文抽取有证据的实体、关系和卡片变化。

## 本章正文
${chapterContent}${compactCardContext}${compactGraphContext}

返回 JSON：
{
  "summary": "180 字以内的事件、人物状态和未解决线索",
  "keywords": ["最多 8 个关键词"],
  "characterStateChanges": ["角色名：持续状态变化"],
  "knowledgeChanges": ["角色名：得知或隐瞒的信息"],
  "foreshadowingChanges": ["伏笔进展"],
  "foreshadowingItems": [{"text":"伏笔内容","status":"active|progressing|resolved|overdue","priority":"high|normal|low","plantedChapter":1,"targetChapter":5}],
  "timelineEvents": ["可排序事件"],
  "canonFacts": ["后续必须遵守的事实"],
  "conflicts": ["冲突和结果"],
  "endingHook": "章末未解决事项",
  "entities": [{"name":"实体","type":"人物|物品|地点|势力|事件|设定"}],
  "relations": [{"source":"实体","target":"实体","label":"关系","weight":0.7}],
  "cardUpdates": [{"cardId":"卡片 ID","cardTitle":"卡片名称","status":"changed|acquired|lost|revealed|updated","changes":"有正文依据的变化"}]
}

关系 weight 为 0.1 到 1.0 的正文证据强度：明确行动、身份、持有或状态变化为 0.85 以上；直接提及为 0.65 至 0.8；推断性弱关联不超过 0.6。实体不超过 30 个，关系不超过 60 条；无内容使用空数组或空字符串。`;
      const optimizedResponse = await client.chat([
        { role: "system", content: memoryEditorSystemPrompt },
        { role: "user", content: compactMemoryPrompt },
      ], { response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 1300, retryAttempts: 4 });
        const contextReport: ContextReport = {
        cache: "miss",
        sourceBytes: byteLength(JSON.stringify({ content, cards: rawCards, knowledgeGraph })),
        packedBytes: byteLength(chapterContent) + byteLength(compactCardContext) + byteLength(compactGraphContext),
        prunedBytes: Math.max(0, byteLength(JSON.stringify({ content, cards: rawCards, knowledgeGraph })) - byteLength(chapterContent) - byteLength(compactCardContext) - byteLength(compactGraphContext)),
        budgetBytes: memoryBudgetBytes,
        sections: { chapter: byteLength(chapterContent), cards: byteLength(compactCardContext), knowledgeGraph: byteLength(compactGraphContext) },
      };
      const memoryResult = normalizeMemoryResult(optimizedResponse.content);
      chapterMemoryCache.set(memoryCacheKey, memoryResult);
      void writePersistentContext(`memory-${memoryCacheKey}`, memoryResult);
      chapterMemoryCache.set(memoryCacheKey, memoryResult);
      return { id: req.id, result: { ...memoryResult, contextReport } };
    }
    if (req.method === "book.search") {
      const { query, source } = req.params ?? {};
      if (!String(query || "").trim()) return { id: req.id, error: { code: -32602, message: "请输入书名或作者" } };
      const sourceId = String(source || "fanqie");
      const searchQuery = String(query).trim();
      if (sourceId.startsWith("qianyue-")) {
        const definition = qianyueSources.find(item => item.id === sourceId);
        if (!definition) return { id: req.id, error: { code: -32602, message: "未知千阅小说书源" } };
        return { id: req.id, result: { books: await searchQianyueSource(definition, searchQuery, req.params), sourceId, sourceName: definition.name } };
      }
      if (sourceId !== "fanqie") {
        const definition = webBookSources.find(item => item.id === sourceId);
        if (!definition) return { id: req.id, error: { code: -32602, message: "未知书源" } };
        return { id: req.id, result: { books: await searchConfiguredBookSource(definition, searchQuery, req.params), sourceId, sourceName: definition.name } };
      }
      const result = await searchFanqieSource(searchQuery, req.params);
      return { id: req.id, result: { ...result, sourceId: "fanqie", sourceName: "番茄小说" } };
    }
    if (req.method === "book.search.all") {
      const query = String(req.params?.query || "").trim();
      if (!query) return { id: req.id, error: { code: -32602, message: "请输入书名或作者" } };
      return { id: req.id, result: await searchAllBookSources(query, req.params) };
    }
    if (req.method === "book.sources.list") {
      return { id: req.id, result: { sources: [{ id: "fanqie", name: "番茄小说" }, ...qianyueSources.map(source => ({ id: source.id, name: source.name })), ...webBookSources.map(source => ({ id: source.id, name: source.name }))], defaultSourceId: "qianyue-kuwo" } };
    }
    if (req.method === "ranking.categories") {
      return { id: req.id, result: { sections: await fetchNovelCatchRankingCategories(req.params) } };
    }
    if (req.method === "ranking.fetch") {
      const { platform, rankType, gender, rankUrl } = req.params ?? {};
      const selectedPlatform = String(platform || "fanqie");
      const type = String(rankType || "read");
      const selectedGender = String(gender || "all");
      if (selectedPlatform === "qidian") return { id: req.id, result: { books: await fetchQidianRanking(type, selectedGender, req.params), fetchedAt: new Date().toISOString() } };
      if (selectedPlatform === "faloo") return { id: req.id, result: { books: await fetchFalooRanking(type, selectedGender, req.params), fetchedAt: new Date().toISOString() } };
      if (selectedPlatform !== "fanqie") return { id: req.id, error: { code: -32602, message: "未知扫榜平台" } };
      const books = await fetchNovelCatchRanking(type, selectedGender, typeof rankUrl === "string" ? rankUrl : undefined, req.params);
      if (!books.length) throw new Error("NovelCatch 番茄官方榜单没有返回书籍，请稍后刷新");
      return { id: req.id, result: { books: books.slice(0, 60), fetchedAt: new Date().toISOString(), sourceName: "番茄小说网" } };
    }
    if (req.method === "book.chapter.download") {
      const { source, sourceBookId, chapter } = req.params ?? {};
      const sourceId = String(source || "").trim();
      if (!sourceId) return { id: req.id, error: { code: -32602, message: "该书籍缺少书源信息，无法重试本章" } };
      if (!chapter || typeof chapter !== "object") return { id: req.id, error: { code: -32602, message: "缺少需要重新下载的章节" } };
      const currentChapter = chapter as Record<string, unknown>;
      if (sourceId === "fanqie") {
        const chapterId = String(currentChapter.url || "").match(/\/reader\/(\d+)/u)?.[1];
        if (!chapterId) return { id: req.id, error: { code: -32602, message: "该番茄章节缺少有效地址" } };
        const result = await downloadFanqieChapter({
          id: chapterId,
          title: String(currentChapter.title || "未命名章节"),
          url: String(currentChapter.url),
          locked: false,
        }, Number(currentChapter.number) || 1, String(sourceBookId || ""), req.params);
        if (result.downloaded === true) return { id: req.id, result: { chapter: result } };
        const fallback = await downloadFallbackChapter(
          String(req.params?.bookTitle || ""),
          Number(currentChapter.number) || 1,
          String(currentChapter.title || ""),
          Number(result.expectedWords) || 0,
          req.params,
        );
        if (fallback) {
          return {
            id: req.id,
            result: {
              chapter: {
                ...result,
                ...fallback,
                id: result.id,
                number: result.number,
                title: result.title,
                url: result.url,
                unavailableReason: undefined,
                downloaded: true,
              },
            },
          };
        }
        return { id: req.id, result: { chapter: result } };
      }
      if (sourceId.startsWith("qianyue-")) {
        const definition = qianyueSources.find(item => item.id === sourceId);
        if (!definition) return { id: req.id, error: { code: -32602, message: "未知千阅小说书源" } };
        return { id: req.id, result: { chapter: await downloadQianyueChapter(definition, currentChapter, req.params) } };
      }
      const definition = webBookSources.find(item => item.id === sourceId);
      if (!definition) return { id: req.id, error: { code: -32602, message: "未知书源" } };
      return { id: req.id, result: { chapter: await downloadConfiguredBookChapter(definition, currentChapter, req.params) } };
    }
    if (req.method === "book.download") {
      const { title, author, source, sourceBookId, url, maxChapters } = req.params ?? {};
      const sourceId = String(source || "fanqie");
      if (!String(url || "").trim()) return { id: req.id, error: { code: -32602, message: "缺少可下载的书籍地址" } };
      if (sourceId.startsWith("qianyue-")) {
        const definition = qianyueSources.find(item => item.id === sourceId);
        if (!definition) return { id: req.id, error: { code: -32602, message: "未知千阅小说书源" } };
        const chapters = await downloadQianyueSource(definition, String(url), req.params, Number(maxChapters) || Number.MAX_SAFE_INTEGER);
        return { id: req.id, result: { title: String(title || "未命名书籍"), author: String(author || "未知作者"), sourceId, sourceName: definition.name, sourceBookId: String(sourceBookId || url), chapters } };
      }
      if (sourceId !== "fanqie") {
        const definition = webBookSources.find(item => item.id === sourceId);
        if (!definition) return { id: req.id, error: { code: -32602, message: "未知书源" } };
        const chapters = await downloadConfiguredBookSource(definition, String(url), req.params, Number(maxChapters) || Number.MAX_SAFE_INTEGER);
        return { id: req.id, result: { title: String(title || "未命名书籍"), author: String(author || "未知作者"), sourceId, sourceName: definition.name, sourceBookId: String(sourceBookId || url), chapters } };
      }
      const chapters = await downloadFanqieBook(String(url), String(sourceBookId || ""), req.params, Number(maxChapters) || Number.MAX_SAFE_INTEGER);
      const downloadedChapterCount = chapters.filter(chapter => String(chapter.content || "").trim()).length;
      if (!downloadedChapterCount) throw new Error("番茄正文没有返回有效内容，未保存空章节；请稍后重试或导入 TXT");
      const completedChapterCount = chapters.filter(chapter => chapter.downloaded === true).length;
      return { id: req.id, result: { title: String(title || "未命名书籍"), author: String(author || "未知作者"), sourceBookId: String(sourceBookId || ""), chapters, downloadedChapterCount, completedChapterCount } };
    }
    if (req.method === "ranking.analyze") {
      const { books, platform, rankType, gender, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || !Array.isArray(books) || books.length === 0) return { id: req.id, error: { code: -32602, message: "缺少榜单样本或模型配置" } };
      const client = new ApiSaverClient({
        apiKey: String(apiKey), apiKeys: stringList(apiKeys, 12), baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"), apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"), contextWindowKB: Number(contextWindow) || undefined, ...networkProxyConfig(req.params),
      });
      const samples = books.slice(0, 60).map((item, index) => {
        const book = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return `${index + 1}. ${compactText(book.title || "未命名", 80)}｜${compactText(book.author || "未知", 40)}｜${compactText(book.category || "未分类", 40)}｜${compactText(book.intro || "", 260)}`;
      }).join("\n");
      const prompt = `你执行 story-long-scan 扫榜技能。根据${String(platform || "番茄小说")} ${String(gender || "全部频道")} ${String(rankType || "read")}榜样本，输出一份可供原创选题使用的市场盘点。\n\n要求：仅分析样本里可观察到的题材、标题、卖点、人物关系和开篇承诺；区分“样本证据”和“推断”；不建议复制具体作品、人名、世界观或桥段。\n\n使用以下 Markdown 结构：\n## 榜单概览\n## 高频题材与组合\n## 标题与开篇承诺\n## 读者爽点和冲突结构\n## 可验证的选题机会\n## 避免同质化的方向\n\n样本：\n${samples}`;
      const response = await client.chat([{ role: "user", content: prompt }], { temperature: 0.25, max_tokens: 1800, retryAttempts: 3 });
      return { id: req.id, result: { report: response.content.trim() } };
    }
    if (req.method === "book.dismantle") {
      const { bookTitle, chapterTitle, chapterNumber, sourceContent, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || !sourceContent) {
        return { id: req.id, error: { code: -32602, message: "缺少拆书分析所需的正文或模型配置" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const source = compactText(sourceContent, Math.min(contextBudgetBytes(Number(contextWindow) || undefined, 35, 18), 28_000));
      const prompt = `你是长篇小说结构分析编辑。请拆解《${String(bookTitle || "未命名作品")}》第 ${Number(chapterNumber) || 1} 章《${String(chapterTitle || "未命名章节")}》的剧情结构，生成可用于原创创作的细纲。

要求：只提炼抽象剧情结构、人物目标、冲突、信息揭示、伏笔和节奏；不得抄录原文句子，不得复述大段原文。章节细纲必须可执行，保留因果关系但不保留特定表达。

## 待分析正文
${source}

只返回 JSON：
{
  "summary":"180 字以内剧情摘要",
  "detailedOutline":"Markdown 章节细纲，包含：本章目标、承接状态、四段事件链、人物动机与对抗、信息与伏笔、节奏、结尾钩子",
  "plotBeats":["4-8 条事件节点"],
  "characterDynamics":["人物目标或关系变化"],
  "setupPayoff":["伏笔/回收"],
  "pacing":"开场/发展/转折/收束的节奏判断"
}`;
      const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.25, max_tokens: 2400, retryAttempts: 3 });
      try {
        const parsed = JSON.parse(response.content) as Record<string, unknown>;
        return { id: req.id, result: {
          summary: String(parsed.summary || "").trim(),
          detailedOutline: String(parsed.detailedOutline || "").trim(),
          plotBeats: stringList(parsed.plotBeats, 10),
          characterDynamics: stringList(parsed.characterDynamics, 10),
          setupPayoff: stringList(parsed.setupPayoff, 10),
          pacing: String(parsed.pacing || "").trim(),
        } };
      } catch {
        return { id: req.id, result: { summary: "", detailedOutline: response.content.trim(), plotBeats: [], characterDynamics: [], setupPayoff: [], pacing: "" } };
      }
    }
    if (req.method === "book.style.distill") {
      const { bookTitle, styleName, samples, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || !Array.isArray(samples) || samples.length === 0) {
        return { id: req.id, error: { code: -32602, message: "请选择至少一个章节用于蒸馏文风" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const sampleText = compactText(samples.map((sample, index) => {
        const item = sample && typeof sample === "object" ? sample as Record<string, unknown> : {};
        return `### 样本 ${index + 1}｜${String(item.title || "章节")}\n${String(item.content || "")}`;
      }).join("\n\n"), Math.min(contextBudgetBytes(Number(contextWindow) || undefined, 45, 24), 36_000));
      const prompt = `你是小说文风编辑。请从《${String(bookTitle || "参考作品")}》的节选中蒸馏一份可复用的“文风 Skill”。

只描述抽象、可执行的写作特征：叙述视角、句长与段落、动作和感官比例、对话节奏、情绪张力、场景切换、悬念收束、禁忌项。不要引用、改写或模仿可识别的原文句式；输出必须用于创作独立的新故事。

## 样本
${sampleText}

只返回 JSON：
{
  "name":"文风名称",
  "description":"一句话特征说明",
  "tags":["标签"],
  "content":"Markdown 文风 Skill，包含适用范围、写作指令、段落节奏、对话、感官、钩子、禁止项和自检清单"
}`;
      const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.3, max_tokens: 2200, retryAttempts: 3 });
      try {
        const parsed = JSON.parse(response.content) as Record<string, unknown>;
        return { id: req.id, result: {
          name: String(parsed.name || styleName || "蒸馏文风").trim(),
          description: String(parsed.description || "从拆书章节提炼的原创写作约束。").trim(),
          tags: stringList(parsed.tags, 10),
          content: String(parsed.content || response.content).trim(),
        } };
      } catch {
        return { id: req.id, result: { name: String(styleName || "蒸馏文风"), description: "从拆书章节提炼的原创写作约束。", tags: ["蒸馏文风"], content: response.content.trim() } };
      }
    }
    if (req.method === "book.rewrite") {
      const { bookTitle, chapterTitle, detailedOutline, instruction, targetWords, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || !detailedOutline) {
        return { id: req.id, error: { code: -32602, message: "请先生成并确认章节细纲" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const wordLimit = Math.max(600, Math.min(8000, Math.floor(Number(targetWords) || 2200)));
      const prompt = `你是原创网络小说作者。根据下面从《${String(bookTitle || "参考作品")}》抽象出的章节结构，写一份完全独立的新章节草稿。

不可使用原作品的人名、地名、专有设定、原句、独特措辞或可识别事件细节；请重构人物、场景、冲突解决方式与情节表面，保留的只能是一般性的戏剧功能。只输出正文，不加标题、注释或 Markdown。

目标章节：${String(chapterTitle || "原创章节")}
作者要求：${String(instruction || "保留节奏和冲突强度，写成独立故事。")}
目标长度：约 ${wordLimit} 个中文字符。

## 抽象细纲
${compactText(detailedOutline, 14_000)}`;
      const response = await client.chat([{ role: "user", content: prompt }], { temperature: 0.75, max_tokens: Math.min(9000, Math.ceil(wordLimit * 1.7)), retryAttempts: 3 });
      return { id: req.id, result: { content: response.content.trim().replace(/^```(?:markdown|text)?\s*/i, "").replace(/```$/u, "").trim() } };
    }
    if (req.method === "book.adapt") {
      const { projectTitle, projectSynopsis, projectOutlines, chapterTitle, detailedOutline, rewriteContent, styleProfile, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || (!detailedOutline && !rewriteContent)) {
        return { id: req.id, error: { code: -32602, message: "请先准备章节细纲或原创改写稿" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const prompt = `你是《${String(projectTitle || "未命名小说")}》的章节作者。把下列原创章节素材转换成符合目标小说设定的可编辑正文。

只使用目标小说的人物、世界观和大纲；如果素材与设定冲突，以目标设定为准并重构。必须写成独立原创内容，不复用参考作品的专名、句子和可识别桥段。只输出章节正文，不加标题。

## 目标作品简介
${String(projectSynopsis || "暂无")}

## 目标作品大纲
${compactText(projectOutlines, 7000)}

${styleProfile ? `## 已绑定文风 Skill\n${compactText(styleProfile, 6000)}\n` : ""}
## 章节素材｜${String(chapterTitle || "新章节")}
${compactText(rewriteContent || detailedOutline, 14_000)}`;
      const response = await client.chat([{ role: "user", content: prompt }], { temperature: 0.72, max_tokens: 7000, retryAttempts: 3 });
      return { id: req.id, result: { title: String(chapterTitle || "新章节"), content: response.content.trim().replace(/^```(?:markdown|text)?\s*/i, "").replace(/```$/u, "").trim() } };
    }
    if (req.method === "text.transform") {
      const { mode, instruction, content, previousChapter, maxWords, projectTitle, chapterTitle, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || !content && !previousChapter) {
        return { id: req.id, error: { code: -32602, message: "缺少文本处理所需参数" } };
      }
      if (mode !== "polish" && mode !== "de-ai" && mode !== "continue") {
        return { id: req.id, error: { code: -32602, message: "不支持的文本处理类型" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const extraRequirement = String(instruction || "").trim();
      const numericLimit = Math.max(1, Math.floor(Number(maxWords) || 0));
      const prompt = mode === "polish"
        ? `你是小说文字编辑。请润色以下《${String(projectTitle || "未命名小说")}》${String(chapterTitle || "当前章节")}中的文本。\n\n要求：保持原意、人物口吻、叙述视角和情节事实不变；优化表达、动作逻辑、可读性和画面感；不要新增剧情，不要解释，不要加标题或 Markdown 标记。${extraRequirement ? `\n作者额外要求：${extraRequirement}` : ""}\n\n待润色文本：\n${String(content)}`
        : mode === "de-ai"
          ? `你是小说文字编辑。请为以下《${String(projectTitle || "未命名小说")}》${String(chapterTitle || "当前章节")}的文本去除机械化 AI 写作痕迹。\n\n要求：保持原意、人物、叙述视角、事实、情节与既有文风不变；拆除模板化套话、均匀句式、总结腔和机械因果衔接；优先使用准确的动作、感官细节与角色化表达；不要新增剧情、设定、人物或信息，不要解释，不加标题或 Markdown 标记。${extraRequirement ? `\n作者额外要求：${extraRequirement}` : ""}\n\n待改写文本：\n${String(content)}`
        : `你是长篇网络小说作者。请为《${String(projectTitle || "未命名小说")}》的${String(chapterTitle || "当前章节")}续写一段可直接插入正文的内容。\n\n要求：只输出续写正文，不复述已有内容，不加标题、注释或 Markdown 标记；承接已有的叙事视角、人物状态、时间线和文风；推进一个明确动作或事件，并自然收束在可继续写作的位置；输出不得超过 ${numericLimit} 个非空白字符。${extraRequirement ? `\n作者续写要求：${extraRequirement}` : ""}\n\n上一章结尾（仅在当前章为空时优先承接）：\n${String(previousChapter || "无")}\n\n当前章节已有内容：\n${String(content || "（当前章为空，请承接上一章）")}`;
      const response = await client.chat([{ role: "user", content: prompt }], {
        temperature: mode === "continue" ? 0.75 : mode === "de-ai" ? 0.45 : 0.35,
        max_tokens: mode === "continue" ? Math.min(7000, Math.max(500, Math.ceil(numericLimit * 1.6))) : 5000,
        retryAttempts: 2,
      });
      let result = response.content.trim().replace(/^```(?:markdown|text)?\s*/i, "").replace(/```$/u, "").trim();
      if (mode === "continue" && numericLimit > 0 && Array.from(result.replace(/\s/gu, "")).length > numericLimit) {
        const limited = Array.from(result).slice(0, numericLimit).join("");
        const ending = Math.max(limited.lastIndexOf("。"), limited.lastIndexOf("！"), limited.lastIndexOf("？"));
        result = (ending > numericLimit * 0.55 ? limited.slice(0, ending + 1) : limited).trim();
      }
      return { id: req.id, result: { content: result } };
    }
    if (req.method === "card.write") {
      const { projectTitle, synopsis, cardType, cardTitle, existingContent, instruction, chapterTitle, chapterContent, outlines, cards, sessionId, previousSessionId, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!projectTitle || !cardType || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "缺少生成卡片所需参数" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-5.5"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const runId = typeof req.params?.runId === "string" ? req.params.runId : "";
      const emitter = new StreamEmitter();
      emitter.subscribe(event => process.stdout.write(JSON.stringify({ type: "agent_stream", runId, event }) + "\n"));
      emitter.progress("draft", 20, "正在整理卡片资料");
      const outlineContext = Array.isArray(outlines) && outlines.length
        ? `## 作品大纲片段\n${outlines.map(outline => outline as Record<string, unknown>).sort((a, b) => String(a.id || a.title || "").localeCompare(String(b.id || b.title || ""), "zh-CN")).map(item => `### ${compactText(item.kind || "大纲", 80)}｜${compactText(item.title || "未命名", 100)}\n${compactText(item.content || "", 3000)}`).join("\n\n")}`
        : "";
      const cardContext = Array.isArray(cards) && cards.length
        ? `## 已有卡片（用于避免重复）\n${cards.map(card => card as Record<string, unknown>).sort((a, b) => String(a.id || a.title || "").localeCompare(String(b.id || b.title || ""), "zh-CN")).map(item => `${compactText(item.title || "卡片", 100)}：${compactText(item.content || "", 600)}`).join("\n")}`
        : "";
      const chapterContext = chapterContent
        ? `## 当前章节片段（用于提取事实）\n${compactText(chapterTitle || "当前章节", 120)}\n${compactText(chapterContent, 10000)}`
        : "";
      const stableProjectPacket = `## 作品资料\n书名：${compactText(projectTitle, 180)}\n作品简介：${compactText(synopsis || "暂无", 1400)}\n\n${[outlineContext, cardContext].filter(Boolean).join("\n\n") || "（暂无已确认大纲或卡片）"}`;
      const cardSessionKey = stableHash({ scope: "card", sessionId: String(sessionId || "default"), projectTitle, cardType, model, apiMode, stableProjectPacket });
      const storedCardSession = await readPersistentContext<unknown>(`card-session-${cardSessionKey}`);
      const inheritedCardSession = cardSessionCache.get(cardSessionKey)
        || (storedCardSession !== undefined ? normalizeAgentSession(storedCardSession) : undefined);
      const previousCardSessionState = previousSessionId && !inheritedCardSession
        ? await readPersistentContext<unknown>(`card-session-${stableHash({ scope: "card", sessionId: String(previousSessionId), projectTitle, cardType, model, apiMode, stableProjectPacket })}`)
        : undefined;
      const resolvedCardSession = inheritedCardSession || (previousCardSessionState !== undefined ? normalizeAgentSession(previousCardSessionState) : undefined);
      const cardDocumentSummary = await readPersistentDocument(`card-session-${cardSessionKey}`);
      const cardSession = compactAgentSession(cardDocumentSummary ? { ...(resolvedCardSession || { version: 1, recentTurns: [] }), summary: cardDocumentSummary } : (resolvedCardSession || { version: 1, summary: "", recentTurns: [] }), contextWindow, byteLength(stableProjectPacket)).state;
      const cardHistorySummary = renderSessionSummary(cardSession);
      const cardRecentTurns = renderRecentTurns(cardSession);
      const dynamicTask = `## 本次卡片任务\n类型：${compactText(cardType, 80)}\n作者指令：${compactText(instruction || "补全卡片知识，保持设定一致", 1800)}\n${cardTitle ? `用户给出的卡片名称：${compactText(cardTitle, 120)}` : "请根据上下文拟定一个准确、简洁的卡片名称。"}${existingContent ? `\n\n## 用户已有草稿\n${compactText(existingContent, 6000)}` : ""}${chapterContext ? `\n\n${chapterContext}` : ""}\n\n内容组织：角色卡写身份、性格、目标、能力、关系、当前状态和秘密；物品卡写来源、外观、能力、代价和持有者；地点卡写环境、势力、规则、资源和危险；势力卡写目标、组织结构、成员、资源和敌对关系；金手指卡写触发条件、能力、限制、升级路径和代价。未知部分明确标为待揭示。`;
      const response = await client.chatStream([
        { role: "system", content: cardWriterSystemPrompt },
        { role: "user", content: stableProjectPacket },
        ...(cardHistorySummary ? [{ role: "user" as const, content: compactText(cardHistorySummary, 7000) }] : []),
        { role: "user", content: dynamicTask },
        ...(cardRecentTurns ? [{ role: "user" as const, content: compactText(cardRecentTurns, 7000) }] : []),
      ], { response_format: { type: "json_object" } }, chunk => emitter.chunk(chunk));
      emitter.complete("卡片内容生成完成");
      const nextCardSession = appendAgentSession(cardSession, String(instruction || "补全卡片知识，保持设定一致"), response.content, contextWindow, byteLength(stableProjectPacket));
      cardSessionCache.set(cardSessionKey, nextCardSession.state);
      void writePersistentContext(`card-session-${cardSessionKey}`, nextCardSession.state);
      void writePersistentDocument(`card-session-${cardSessionKey}`, `# 卡片会话摘要\n\n${nextCardSession.state.summary || "暂无压缩摘要"}`);
      if (nextCardSession.compressed) emitter.progress("draft", 90, "会话动态上下文已超过 80%，已自动压缩为摘要并保留最近两轮");
      try {
        const result = JSON.parse(response.content) as Record<string, unknown>;
        return {
          id: req.id,
          result: {
            title: typeof result.title === "string" ? result.title.trim() : String(cardTitle || `${String(cardType)}设定`),
            content: typeof result.content === "string" ? result.content.trim() : response.content,
          },
        };
      } catch {
        return { id: req.id, result: { title: String(cardTitle || `${String(cardType)}设定`), content: response.content } };
      }
    }
    if (req.method === "outline.write") {
      const { projectTitle, kind, existingContent, instruction, synopsis, cards, knowledgeGraph, worldSetting, skills, preferredSkillNames, sessionId, previousSessionId, outlineId, targetChapter, sourceChapter, formatOutline, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!projectTitle || !kind || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "Missing required params" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const runId = typeof req.params?.runId === "string" ? req.params.runId : "";
      const emitter = new StreamEmitter();
      emitter.subscribe(event => process.stdout.write(JSON.stringify({ type: "agent_stream", runId, event }) + "\n"));
      emitter.progress("intent", 5, "步骤 1/5：识别大纲目标、正文依据与格式要求");
      const cardSection = Array.isArray(cards) && cards.length > 0
        ? `\n## 相关知识卡片\n${cards.slice(0, 8).map(card => card as Record<string, unknown>).sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh-CN")).map(item => `### ${compactText(item.title || "卡片", 80)}\n${compactText(item.content || "", 700)}`).join("\n\n")}`
        : "";
      const graphSection = knowledgeGraph && typeof knowledgeGraph === "object"
        ? `\n## 知识图谱约束\n${compactKnowledgeGraph(knowledgeGraph, String(projectTitle), 2800)}\n请保持已有实体和关系一致，新增关系标注为“待揭示”。`
        : "";
      const worldSettingSection = Array.isArray(worldSetting) && worldSetting.length > 0
        ? `\n## 世界观与作品设定（作者确认的固定资料，只可引用，不得改写）\n${worldSetting
          .slice(0, 2)
          .map(item => item && typeof item === "object"
            ? `### ${compactText((item as Record<string, unknown>).title || "世界观与作品设定", 100)}\n${compactText((item as Record<string, unknown>).content || "", 12000)}`
            : "")
          .filter(Boolean)
          .join("\n\n")}\n请以该固定设定为首章创作和后续章纲承接的边界，未知内容标记为“待揭示”。`
        : "";
      const outlineSkillName = kind === "总纲" ? "outline-total-planner" : kind === "章纲" ? "小说章纲生成器" : "world-setting-planner";
      const skillCatalog = Array.isArray(skills) ? skills
        .filter((skill): skill is Record<string, unknown> => Boolean(skill && typeof skill === "object"))
        .map(item => ({
          name: String(item.name || ""), displayName: String(item.displayName || item.name || ""), category: String(item.category || "write"),
          description: String(item.description || ""), tags: stringList(item.tags, 12), content: String(item.content || ""),
        })).filter(item => Boolean(item.name)) as SkillDefinition[]
        : [];
      const targetChapterRecord = targetChapter && typeof targetChapter === "object" ? targetChapter as Record<string, unknown> : undefined;
      const sourceChapterRecord = sourceChapter && typeof sourceChapter === "object" ? sourceChapter as Record<string, unknown> : undefined;
      const formatOutlineRecord = formatOutline && typeof formatOutline === "object" ? formatOutline as Record<string, unknown> : undefined;
      const targetChapterNumber = Number(targetChapterRecord?.number || 0);
      const sourceChapterNumber = Number(sourceChapterRecord?.number || 0);
      const isFirstChapter = kind === "章纲" && targetChapterNumber === 1 && !sourceChapterRecord;
      // The handoff skill is only appropriate for the immediate previous chapter.
      // Current-chapter input is a reverse outline of already written events.
      const isNextChapterHandoff = Boolean(targetChapterNumber && sourceChapterNumber === targetChapterNumber - 1);
      const automaticSelection = selectSkillsByIntent(String(instruction || ""), skillCatalog);
      const preferredNames = stringList(preferredSkillNames, 6);
      const continuityNames = kind === "章纲" && isNextChapterHandoff ? ["章纲承接规范", "next-chapter-plan", "conflict-escalation", "foreshadowing-manager", "ending-hook", "setting-consistency"] : [];
      const matchedSkills = [
        skillCatalog.find(item => item.name === outlineSkillName),
        ...skillCatalog.filter(item => preferredNames.includes(item.name)),
        ...skillCatalog.filter(item => automaticSelection.skills.some(selected => selected.name === item.name) && (item.category === "setup" || continuityNames.includes(item.name))),
        ...(sourceChapter && isNextChapterHandoff ? skillCatalog.filter(item => continuityNames.includes(item.name)) : []),
      ].filter((item, index, list): item is SkillDefinition => Boolean(item) && list.findIndex(candidate => candidate?.name === item?.name) === index).slice(0, 4);
      const recognizedIntent = kind === "章纲" && isNextChapterHandoff
        ? "上一章正文承接并规划下一章"
        : kind === "章纲" && sourceChapterRecord && sourceChapterNumber === targetChapterNumber
          ? "根据本章正文反推本章章纲"
          : kind === "章纲" && sourceChapterRecord ? "根据指定章节正文生成章纲"
            : isFirstChapter ? "首章创作：根据世界观、作品简介与作者指令生成" : automaticSelection.intent;
      emitter.progress("intent", 14, `步骤 1/5：意图识别完成：${recognizedIntent}`);
      emitter.context("intent", `已选技能：${matchedSkills.map(item => item.displayName || item.name).join("、") || "默认大纲规则"}`, { source: "OutlineSkillRouter", status: "selected", items: matchedSkills.length });
      const skillSection = matchedSkills.length
        ? `\n## 本次匹配技能\n${matchedSkills.map(item => `### ${compactText(item.displayName || item.name || "技能", 80)}\n${compactText(item.content || item.description || "", 700)}`).join("\n\n")}`
        : "";
      const stableProjectPacket = `## 作品资料\n书名：${String(projectTitle)}\n作品简介：${compactText(synopsis || "暂无", 1400)}${worldSettingSection}${skillSection}${graphSection}${cardSection}`;
      const outlineSessionKey = stableHash({ scope: "outline", outlineId: String(outlineId || "active"), sessionId: String(sessionId || "default"), projectTitle, kind, model, apiMode, targetChapterId: targetChapterRecord?.id, sourceChapterId: sourceChapterRecord?.id, formatOutlineId: formatOutlineRecord?.id, stableProjectPacket });
      const storedOutlineSession = await readPersistentContext<unknown>(`outline-session-${outlineSessionKey}`);
      const inheritedOutlineSession = outlineSessionCache.get(outlineSessionKey)
        || (storedOutlineSession !== undefined ? normalizeAgentSession(storedOutlineSession) : undefined);
      const previousOutlineSessionState = previousSessionId && !inheritedOutlineSession
        ? await readPersistentContext<unknown>(`outline-session-${stableHash({ scope: "outline", outlineId: String(outlineId || "active"), sessionId: String(previousSessionId), projectTitle, kind, model, apiMode, targetChapterId: targetChapterRecord?.id, sourceChapterId: sourceChapterRecord?.id, formatOutlineId: formatOutlineRecord?.id, stableProjectPacket })}`)
        : undefined;
      const outlineDocumentSummary = await readPersistentDocument(`outline-session-${outlineSessionKey}`);
      const outlineSession = compactAgentSession(outlineDocumentSummary ? { ...(inheritedOutlineSession || { version: 1, recentTurns: [] }), summary: outlineDocumentSummary } : (inheritedOutlineSession || (previousOutlineSessionState !== undefined ? normalizeAgentSession(previousOutlineSessionState) : undefined) || { version: 1, summary: "", recentTurns: [] }), contextWindow, byteLength(stableProjectPacket)).state;
      const outlineHistorySummary = renderSessionSummary(outlineSession);
      const outlineRecentTurns = renderRecentTurns(outlineSession);
      emitter.progress("retrieve", 32, "步骤 2/5：装载唯一正文依据、上一章结尾与格式参考");
      emitter.context("retrieve", "已装载唯一正文依据", { source: sourceChapterRecord ? `第 ${String(sourceChapterRecord.number || "")} 章正文` : "无正文依据", status: "loaded", bytes: byteLength(String(sourceChapterRecord?.content || "")), items: sourceChapterRecord ? 1 : 0 });
      if (formatOutlineRecord) emitter.context("retrieve", "已装载格式参考章纲", { source: String(formatOutlineRecord.title || "参考章纲"), status: "loaded", bytes: byteLength(String(formatOutlineRecord.content || "")), items: 1 });
      const targetSection = targetChapterRecord
        ? `## 目标章（本次要生成的章纲）\n第 ${String(targetChapterRecord.number || "")} 章《${compactText(targetChapterRecord.title || "未命名", 120)}》\n`
        : "";
      const sourceContent = String(sourceChapterRecord?.content || "");
      const sourceHandoff = sourceContent.length > 7000 ? sourceContent.slice(-7000) : sourceContent;
      const sourceSection = sourceChapterRecord
        ? `## 唯一正文依据（优先级最高）\n依据模式：${compactText(sourceChapterRecord.mode || "作者指定", 80)}\n第 ${String(sourceChapterRecord.number || "")} 章《${compactText(sourceChapterRecord.title || "未命名", 120)}》正文：\n${compactText(sourceContent, 26000)}\n\n${isNextChapterHandoff ? `## 章节交接状态（最高优先级，目标章必须从此处之后开始）\n以下是上一章结尾原文：\n${compactText(sourceHandoff, 7000)}\n\n硬性要求：目标章开场只能发生在上述结尾状态之后。上一章已发生的行动、战斗、跟踪发现、资源消耗、人物位置与情绪不得重新规划或倒退；必须承接其结果并推进新的事件。` : sourceChapterNumber === targetChapterNumber ? `## 本章复盘规则\n这是“根据本章正文生成本章章纲”。章纲必须忠实概括正文中已发生的事件、人物状态、冲突、伏笔与结尾；不得把正文结尾之后的计划写成已发生事实，也不得使用“下一章承接”规则。` : `## 指定正文参考规则\n这是指定章节正文的参考分析。只提取该正文可证实的事实；不要把它误当作目标章的上一章，也不要强行制造章节承接。`}\n\n章纲事件、人物状态和结尾承接必须来自这段正文；不得引用其他章节正文，不得把历史会话中的旧章节当作事实。`
        : `## 正文依据\n本次没有提供可用正文。只能生成通用结构，不得声称承接任何具体章节。`;
      const formatSection = formatOutlineRecord
        ? `## 格式参考章纲（仅参考表达密度，不得覆盖固定输出协议）\n参考模式：${compactText(formatOutlineRecord.mode || "上一章章纲格式", 100)}\n${compactText(formatOutlineRecord.title || "参考章纲", 120)}\n${compactText(formatOutlineRecord.content || "", 9000)}\n\n硬性要求：固定输出协议的栏目、顺序和字段名优先；只能参考这份章纲的详略和语气，不得照抄其人物、事件、数字、旧栏目或结尾。`
        : `## 格式要求\n没有可用的参考章纲，请严格使用“小说章纲生成器”技能定义的固定模板。`;
      const chapterLengthRule = kind === "章纲"
        ? "默认输出不超过700字（包括汉字、数字、空格、换行和标点符号）；压缩表达但不得丢失承接事实、冲突转折、释放点和章末钩子。"
        : "";
      const dynamicTask = `## 本次大纲任务\n类型：${String(kind)}\n作者指令：${compactText(instruction || "根据上一章正文生成下一章章纲", 1800)}\n${chapterLengthRule}\n\n${targetSection}${sourceSection}\n${formatSection}\n${kind === "章纲" ? chapterOutlineOutputProtocol : ""}\n## 标题要求（章纲必须执行）\n标题必须概括本章的核心事件、冲突或爽点，使用 8-24 个汉字或数字；不能只写“第${String(targetChapterNumber || "X")}章”、不能写“未命名”、不能直接复用上一章标题。标题要同时写入 Markdown 首行“# 章纲｜第X章 标题文字”，如果使用 JSON 包装，另返回非空的 title 字段。\n\n## 当前待完善文档（可被替换的旧草稿，不是事实来源）\n${compactText(existingContent || "暂无", 5000)}\n\n输出该类型的大纲 Markdown 正文。章纲必须严格逐项填写固定输出协议，不能使用旧的“核心主线与目标”“核心冲突与节奏”“分段剧情梗概”“实体与关系更新”等替代栏目。旧草稿若与唯一正文依据或章节交接状态冲突，必须完全丢弃冲突部分并重写。若作者指令与历史会话冲突，以本次目标章、唯一正文依据、固定输出协议和作者指令为准。不要输出分析过程、格式说明或额外前言。`;
      emitter.progress("plan", 48, isNextChapterHandoff ? "步骤 3/5：根据交接状态规划本章事件链与冲突升级" : sourceChapterNumber === targetChapterNumber ? "步骤 3/5：从本章正文提取事件链、冲突与伏笔" : "步骤 3/5：校验指定正文与目标章的事实边界");
      emitter.context("plan", isNextChapterHandoff ? "正在校验上一章结束状态，阻止重复事件" : sourceChapterNumber === targetChapterNumber ? "正在从本章正文提取已发生事件，避免虚构后续" : "正在校验指定正文与目标章的事实边界", { source: isNextChapterHandoff ? "章纲承接规范" : "正文事实校验", status: "loaded", bytes: byteLength(sourceHandoff), items: sourceChapterRecord ? 1 : 0 });
      emitter.progress("draft", 62, "步骤 4/5：调用模型生成章纲正文");
      const response = await client.chatStream([
        { role: "system", content: outlineWriterSystemPrompt },
        { role: "user", content: stableProjectPacket },
        ...(outlineHistorySummary ? [{ role: "user" as const, content: compactText(outlineHistorySummary, 7000) }] : []),
        ...(outlineRecentTurns ? [{ role: "user" as const, content: compactText(outlineRecentTurns, 7000) }] : []),
        // Keep the current target/source packet last so stale session turns
        // cannot override the chapter the author just selected.
        { role: "user", content: dynamicTask },
      ], { max_tokens: kind === "章纲" ? 1800 : 3000, temperature: 0.45, retryAttempts: 2 }, chunk => emitter.chunk(chunk));
      emitter.progress("review", 92, "步骤 5/5：校验章节承接、格式与章末钩子");
      emitter.complete("大纲内容生成完成");
      const nextOutlineSession = appendAgentSession(outlineSession, String(instruction || "补全结构并强化可执行性"), response.content, contextWindow, byteLength(stableProjectPacket));
      outlineSessionCache.set(outlineSessionKey, nextOutlineSession.state);
      void writePersistentContext(`outline-session-${outlineSessionKey}`, nextOutlineSession.state);
      void writePersistentDocument(`outline-session-${outlineSessionKey}`, `# 大纲会话摘要\n\n${nextOutlineSession.state.summary || "暂无压缩摘要"}`);
      if (nextOutlineSession.compressed) emitter.progress("plan", 90, "会话动态上下文已超过 80%，已自动压缩为摘要并保留最近两轮");
      return { id: req.id, result: {
        ...(kind === "章纲" ? { title: outlineTitleFromOutput(response.content, targetChapterNumber || 0) } : {}),
        content: kind === "章纲" ? normalizeChapterOutlineOutput(response.content) : response.content,
      } };
    }
    if (req.method === "chapter.review") {
      const { projectTitle, chapterTitle, content, outline, cards, memory, apiKey, apiKeys, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!projectTitle || !chapterTitle || !content || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "缺少章节审查所需参数" } };
      }
      const client = new ApiSaverClient({
        apiKey: String(apiKey),
        apiKeys: stringList(apiKeys, 12),
        baseURL: String(baseURL || "https://api.apisaver.com/v1"),
        defaultModel: String(model || "gpt-4o-mini"),
        apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
        reasoningMode: String(reasoningMode || "auto"),
        contextWindowKB: Number(contextWindow) || undefined,
        ...networkProxyConfig(req.params),
      });
      const cardContext = Array.isArray(cards) && cards.length
        ? cards.slice(0, 10).map(item => item && typeof item === "object" ? `${String((item as Record<string, unknown>).title || "卡片")}: ${compactText((item as Record<string, unknown>).content || "", 500)}` : "").filter(Boolean).join("\n")
        : "暂无人物卡或设定卡";
      const prompt = `## 作品：${compactText(projectTitle, 180)}
## 章节：${compactText(chapterTitle, 180)}
## 对应章纲
${compactText(outline || "暂无章纲", 6000)}
## 相关卡片
${cardContext}
## 上一版章节记忆
${compactText(memory || "暂无记忆", 2600)}
## 待审查正文
${compactText(content, 26000)}

请按审查规则输出 JSON。问题必须引用正文中的短证据，建议必须能直接指导作者修改；优先报告会造成读者理解错误的硬冲突。`;
      const response = await client.chat([
        { role: "system", content: chapterReviewSystemPrompt },
        { role: "user", content: prompt },
      ], { response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 1800, retryAttempts: 2 });
      try {
        const raw = JSON.parse(response.content) as Record<string, unknown>;
        const issues = Array.isArray(raw.issues) ? raw.issues.filter(item => item && typeof item === "object").slice(0, 30).map(item => {
          const issue = item as Record<string, unknown>;
          const severity = String(issue.severity || "medium").toLowerCase();
          return {
            severity: severity === "high" ? "high" : severity === "low" ? "low" : "medium",
            category: compactText(issue.category || "一致性", 60),
            evidence: compactText(issue.evidence || "", 220),
            suggestion: compactText(issue.suggestion || issue.fix || "", 500),
          };
        }).filter(item => item.evidence || item.suggestion) : [];
        return { id: req.id, result: {
          score: Math.max(0, Math.min(100, Number(raw.score) || (issues.length ? Math.max(35, 90 - issues.length * 8) : 95))),
          summary: compactText(raw.summary || "审查完成", 600),
          issues,
          suggestions: stringList(raw.suggestions, 12),
        } };
      } catch {
        return { id: req.id, result: { score: 0, summary: "审查结果解析失败，请重试。", issues: [], suggestions: [] } };
      }
    }
    if (req.method === "chapter.write") {
      const {
        projectId,
        projectTitle,
        chapterId,
        instruction,
        outline,
        outlines,
        activeOutlineId,
        cards,
        previousChapters,
        memories,
        memoryDocuments,
        knowledgeGraph,
        writingStyle,
        authorPreferences,
        preferredSkillNames,
        apiKey,
        apiKeys,
        baseURL,
        model,
        apiMode,
        reasoningMode,
        contextWindow,
        sessionId,
        previousSessionId,
      } = req.params ?? {};
      if (!projectId || !chapterId || !instruction || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "Missing required params" } };
      }
      const store = StoryStore.inMemory();
      const runId = typeof req.params?.runId === "string" ? req.params.runId : "";
      const streamEmitter = new StreamEmitter();
      streamEmitter.subscribe(event => {
        process.stdout.write(JSON.stringify({ type: "agent_stream", runId, event }) + "\n");
      });
      streamEmitter.progress("starting", 3, "运行环境已就绪，正在整理本章资料");
      const preparationKey = stableHash(cacheStableContext({
        projectId, chapterId, instruction, outline, outlines, activeOutlineId, cards,
        previousChapters, memories, memoryDocuments, knowledgeGraph, skills: req.params?.skills, preferredSkillNames,
        contextWindow: Number(contextWindow) || 128,
      }));
      const cachedPreparation = chapterPreparationCache.get(preparationKey)
        || await readPersistentContext<PreparedChapterInput>(`chapter-prep-${preparationKey}`);
      const prepared = cachedPreparation || prepareChapterInput({
        instruction: String(instruction), outline, outlines, activeOutlineId, cards, previousChapters,
        memories, memoryDocuments, knowledgeGraph, skills: req.params?.skills,
        contextWindowKB: Number(contextWindow) || undefined,
      });
      chapterPreparationCache.set(preparationKey, prepared);
      if (!cachedPreparation) void writePersistentContext(`chapter-prep-${preparationKey}`, prepared);
      const contextReport: ContextReport = {
        ...prepared.report,
        cache: cachedPreparation ? "hit" : "miss",
        sections: { ...prepared.report.sections },
      };
      const sessionKey = stableHash({ projectId: String(projectId), sessionId: String(sessionId || "default"), model: String(model || ""), apiMode: String(apiMode || "openai") });
      const storedChapterSession = await readPersistentContext<unknown>(`chapter-session-${sessionKey}`);
      const cachedChapterSession = novelSessionCache.get(sessionKey)
        || (storedChapterSession !== undefined ? normalizeAgentSession(storedChapterSession) : undefined);
      const previousChapterSession = previousSessionId && !cachedChapterSession
        ? await readPersistentContext<unknown>(`chapter-session-${stableHash({ projectId: String(projectId), sessionId: String(previousSessionId), model: String(model || ""), apiMode: String(apiMode || "openai") })}`)
        : undefined;
      const chapterDocumentSummary = await readPersistentDocument(`chapter-session-${sessionKey}`);
      const chapterSession = compactAgentSession(chapterDocumentSummary ? { ...(cachedChapterSession || { version: 1, recentTurns: [] }), summary: chapterDocumentSummary } : (cachedChapterSession || (previousChapterSession !== undefined ? normalizeAgentSession(previousChapterSession) : undefined) || { version: 1, summary: "", recentTurns: [] }), contextWindow, prepared.report.packedBytes).state;
      const sessionContext = renderAgentSession(chapterSession);
      if (!cachedPreparation && (cachedChapterSession || chapterDocumentSummary || previousChapterSession)) {
        contextReport.cache = "hit";
      }
      streamEmitter.progress("starting", 6, `${cachedPreparation ? "上下文缓存命中" : "上下文缓存未命中"}；已将 ${Math.max(0, contextReport.prunedBytes / 1024).toFixed(1)} KB 无关资料移出本次请求`);
      try {
        const normalizedProjectId = String(projectId);
        store.createProject({ id: normalizedProjectId, title: String(projectTitle || "未命名小说") });
        const chapters = prepared.previousChapters;
        chapters.forEach((chapter, index) => {
          if (!chapter || typeof chapter !== "object") return;
          const item = chapter as Record<string, unknown>;
          const content = String(item.content || "").trim();
          if (!content) return;
          store.saveMemory({
            id: `chapter-memory-${String(item.id || index)}`,
            projectId: normalizedProjectId,
            type: "event",
            title: String(item.title || `第 ${index + 1} 章`),
            content: content.slice(-5000),
            entityNames: [],
            confirmed: true,
            importance: 0.55,
          });
        });
        const memoryItems = prepared.memories;
        memoryItems.forEach((memory, index) => {
          if (!memory || typeof memory !== "object") return;
          const item = memory as Record<string, unknown>;
          const entityNames = Array.isArray(item.keywords)
            ? item.keywords.filter((keyword): keyword is string => typeof keyword === "string")
            : [];
          const title = String(item.title || `章节记忆 ${index + 1}`);
          const save = (suffix: string, type: "event" | "character_state" | "canon_fact" | "foreshadowing" | "timeline", label: string, values: string[], importance: number) => {
            const content = values.join("\n").trim();
            if (!content) return;
            store.saveMemory({
              id: `saved-memory-${String(item.id || index)}-${suffix}`,
              projectId: normalizedProjectId,
              type,
              title: `${title} · ${label}`,
              content,
              entityNames,
              confirmed: true,
              importance,
            });
          };
          save("summary", "event", "章节摘要", [String(item.summary || "")], 0.82);
          save("character-state", "character_state", "人物状态", stringList(item.characterStateChanges), 1);
          save("knowledge", "character_state", "角色认知", stringList(item.knowledgeChanges), 0.98);
          save("foreshadowing", "foreshadowing", "伏笔追踪", stringList(item.foreshadowingChanges), 0.98);
          save("timeline", "timeline", "时间线", stringList(item.timelineEvents), 0.94);
          save("canon", "canon_fact", "设定事实", stringList(item.canonFacts), 0.96);
          save("conflict", "canon_fact", "冲突", stringList(item.conflicts), 0.92);
          save("hook", "foreshadowing", "章末钩子", [typeof item.endingHook === "string" ? item.endingHook : ""], 0.93);
        });
        const documents = prepared.memoryDocuments;
        documents.forEach((document, index) => {
          if (!document || typeof document !== "object") return;
          const item = document as Record<string, unknown>;
          const content = String(item.content || "").trim();
          if (!content) return;
          const kind = String(item.kind || item.title || "章节快照");
          store.saveMemory({
            id: `memory-document-${kind}-${index}`,
            projectId: normalizedProjectId,
            type: memoryTypeForDocument(kind),
            title: `记忆文档 · ${String(item.title || kind)}`,
            content: content.slice(0, 6000),
            entityNames: [],
            confirmed: true,
            importance: kind === "人物状态" || kind === "伏笔追踪" ? 0.99 : 0.9,
          });
        });
        streamEmitter.progress("starting", 8, `已载入 ${chapters.length} 个章节片段、${memoryItems.length} 条章节记忆；上下文包 ${Math.ceil(contextReport.packedBytes / 1024)} KB`);

        const graph = createChapterGraph({
          store,
          apiKey: String(apiKey),
          apiKeys: stringList(apiKeys, 12),
          baseURL: String(baseURL || "https://api.apisaver.com/v1"),
          model: String(model || "gpt-4o-mini"),
          apiMode: String(apiMode || "openai") as "openai" | "responses" | "anthropic",
          reasoningMode: String(reasoningMode || "auto"),
          contextWindowKB: Number(contextWindow) || undefined,
          ...networkProxyConfig(req.params),
          streamEmitter,
        });
        const earlierMemorySummary = prepared.memoryDocuments
          .find(document => /前\s*\d+\s*章.*摘要|memory-summary/iu.test(`${String(document.title || "")} ${String(document.id || "")}`));
        const result = await graph.invoke({
          projectId: normalizedProjectId,
          chapterId: String(chapterId),
          instruction: String(instruction),
          worldSetting: prepared.worldSetting,
          writingStyle: writingStyle && typeof writingStyle === "object" ? { name: String((writingStyle as Record<string, unknown>).name || "绑定文风"), content: compactText((writingStyle as Record<string, unknown>).content || "", 3000) } : undefined,
          outline: prepared.outline,
          previousChapters: prepared.previousChapters,
          earlierMemorySummary: earlierMemorySummary ? String(earlierMemorySummary.content || "") : undefined,
          knowledgeGraph: prepared.knowledgeGraph,
          cards: prepared.cards,
          skillCatalog: prepared.skills,
          preferredSkillNames: stringList(preferredSkillNames, 8),
          contextReport,
          sessionContext,
          authorPreferences: stringList(authorPreferences, 20),
        });
        const resultRecord = result as Record<string, unknown>;
        const handoff = [resultRecord.chapterPlan, resultRecord.summary, resultRecord.reviewResult && JSON.stringify(resultRecord.reviewResult)].filter(Boolean).join("\n");
        if (handoff) {
          const nextChapterSession = appendAgentSession(chapterSession, String(instruction), handoff, contextWindow, prepared.report.packedBytes);
          novelSessionCache.set(sessionKey, nextChapterSession.state);
          void writePersistentContext(`chapter-session-${sessionKey}`, nextChapterSession.state);
          void writePersistentDocument(`chapter-session-${sessionKey}`, `# 章节会话摘要\n\n${nextChapterSession.state.summary || "暂无压缩摘要"}`);
          if (nextChapterSession.compressed) streamEmitter.progress("review", 96, "会话动态上下文已超过 80%，已自动压缩为摘要并保留最近两轮");
        }
        const resultWithUsage = {
          ...result,
          contextReport: {
            ...contextReport,
            ...(result.contextReport || {}),
            upstreamUsage: result.upstreamUsage,
          },
        };
        streamEmitter.complete("章节草稿和一致性审查已完成");
        return { id: req.id, result: resultWithUsage };
      } catch (error) {
        streamEmitter.error(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        store.close();
      }
    }
    return { id: req.id, error: { code: -32601, message: "Method not found" } };
  } catch (err) {
    return { id: req.id, error: { code: -32000, message: String(err) } };
  }
}

async function main() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line) as RPCRequest;
        const res = await handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch (err) {
        process.stdout.write(JSON.stringify({ error: { code: -32700, message: "Parse error" } }) + "\n");
      }
    }
  }
}

main().catch(console.error);
