import { StateGraph, Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { StoryStore } from "../storage/story-store.js";
import { ApiSaverClient, type ApiUsage } from "../models/api-saver.js";
import type { StreamEmitter } from "../streaming/stream-handler.js";
import { StreamAccumulator } from "../streaming/stream-handler.js";
import { byteLength, compactText, formatContextReport, type ContextReport } from "../context/context-optimizer.js";

export interface SkillDefinition {
  name: string;
  displayName?: string;
  category?: string;
  description?: string;
  tags?: string[];
  content: string;
}

type UsageTotals = NonNullable<ContextReport["upstreamUsage"]>;
const addUsage = (left: UsageTotals | undefined, right: ApiUsage | undefined): UsageTotals => ({
  inputTokens: (left?.inputTokens || 0) + (right?.inputTokens || 0),
  outputTokens: (left?.outputTokens || 0) + (right?.outputTokens || 0),
  totalTokens: (left?.totalTokens || 0) + (right?.totalTokens || 0),
  cachedInputTokens: (left?.cachedInputTokens || 0) + (right?.cachedInputTokens || 0),
  cacheWriteTokens: (left?.cacheWriteTokens || 0) + (right?.cacheWriteTokens || 0),
  reasoningTokens: (left?.reasoningTokens || 0) + (right?.reasoningTokens || 0),
  requests: (left?.requests || 0) + (right ? 1 : 0),
});

const intentLabels: Record<string, string> = {
  setup: "项目设定与大纲",
  write: "章节创作与续写",
  review: "一致性审查与修改",
  polish: "文字润色与去模板化",
  import: "作品导入与结构化",
  analyze: "拆书分析与市场判断",
  tool: "写作辅助工具",
  creator: "技能设计",
};

// Keep these prompts byte-for-byte stable. Compatible providers can reuse this
// prefix on successive chapter runs instead of reprocessing the common rules.
const chapterAgentSystemPrompt = `你是专业长篇网络小说创作 Agent。只根据作者提供的作品资料工作，不编造与资料冲突的设定。

写作原则：
1. 服从章节任务、细纲、人物状态、时间线和已确认设定，资料冲突时以“已确认记忆”和作者任务为准。
2. 用具体动作、感官、对话和因果推进剧情；避免复述资料、解释写作过程、机械总结或套话。
3. 保持人物称谓、视角、时序、物品归属与关系一致；不把未知信息写成角色已知事实。
4. 正文使用自然的中文网文叙事，段落有节奏，结尾停在可继续发展的行动、发现或风险上。
5. 严格执行最后一条消息指定的阶段任务与输出格式，不输出隐藏思考。`;

const chapterWriterTaskPrompt = `你正在执行“章节正文”阶段。返回严格 JSON 对象，不要代码围栏或额外说明：{"content":"章节正文 Markdown","summary":"200 字以内章节摘要"}。`;

/** JSON 传输信封绝不能成为展示给作者的章节正文。 */
function unwrapChapterDraft(value: unknown, depth = 0): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  if (depth >= 4 || !text.startsWith("{")) return value.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const nested = typeof parsed.draftContent === "string" ? parsed.draftContent : typeof parsed.content === "string" ? parsed.content : "";
    return nested ? unwrapChapterDraft(nested, depth + 1) : value.trim();
  } catch {
    return value.trim();
  }
}

function chapterSummaryFromEnvelope(value: unknown, depth = 0): string {
  if (typeof value !== "string" || depth >= 4) return "";
  try {
    const parsed = JSON.parse(value.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "")) as Record<string, unknown>;
    if (typeof parsed.summary === "string") return parsed.summary.trim();
    const nested = typeof parsed.draftContent === "string" ? parsed.draftContent : typeof parsed.content === "string" ? parsed.content : "";
    return nested ? chapterSummaryFromEnvelope(nested, depth + 1) : "";
  } catch {
    return "";
  }
}

const chapterReviewSystemPrompt = `你是长篇小说一致性编辑。审查时只依据给出的约束与章节正文，不做文风重写，也不虚构问题。

重点检查：人物状态、已知信息、时间线、实体关系、物品归属和剧情因果。返回严格 JSON 对象，不要代码围栏或解释：{"consistent":true,"issues":["明确矛盾"],"suggestions":["可执行修订建议"]}。没有明确问题时 issues 和 suggestions 返回空数组。`;

const chapterPlanSystemPrompt = `你是长篇网络小说主编。先为下一章制作一份短小、可执行的写作计划，不写正文，不输出隐藏思考。
只依据给定资料，优先处理上一章结尾。返回严格 JSON 对象：{"plan":"人类可读的 Markdown 计划","handoff":"下一章交接"}。plan 字段必须直接是普通 Markdown 文字，绝不能在 plan 字段中再次嵌套 JSON、JSON 字符串、代码围栏或字段对象。
计划必须包含：承接锚点（人物位置、情绪、未解决事件、道具/线索、时间线、伏笔、章末钩子）、人物目标与动机、核心事件链、冲突升级、四段节奏（开场/发展/转折/收束）、本章新增信息、伏笔推进、结尾钩子、下一章交接。未知项标为待确认，不能凭空补设定。`;

const planFieldLabels: Record<string, string> = {
  opening: "开篇承接", openingAnchor: "开篇承接", handoff: "下一章交接", continuity: "承接锚点", continuityAnchor: "承接锚点",
  story: "这章的故事", plot: "核心事件链", events: "核心事件链", characters: "这章的人物", characterGoals: "人物目标与动机",
  conflict: "冲突升级", pacing: "节奏安排", rhythm: "节奏安排", newInformation: "本章新增信息", foreshadowing: "伏笔推进",
  ending: "章末钩子", hook: "章末钩子", style: "写法与禁区",
};

function cleanPlanText(value: string): string {
  return value.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

function formatPlanValue(value: unknown): string {
  if (typeof value === "string") return cleanPlanText(value);
  if (Array.isArray(value)) return value.map(formatPlanValue).filter(Boolean).join("；");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${planFieldLabels[key] || key}：${formatPlanValue(entry)}`)
    .filter(entry => !entry.endsWith("：")).join("\n");
  return value === undefined || value === null ? "" : String(value);
}

function planObjectToMarkdown(value: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || key === "plan" || key === "content") continue;
    const label = planFieldLabels[key] || key.replace(/([a-z])([A-Z])/gu, "$1 $2");
    if (typeof entry === "string") {
      const text = cleanPlanText(entry);
      if (text) lines.push(`## ${label}\n${text}`);
      continue;
    }
    if (Array.isArray(entry)) {
      const items = entry.map(item => typeof item === "string" ? item.trim() : formatPlanValue(item)).filter(Boolean);
      if (items.length) lines.push(`## ${label}\n${items.map(item => `- ${item}`).join("\n")}`);
      continue;
    }
    const text = formatPlanValue(entry);
    if (text) lines.push(`## ${label}\n${text}`);
  }
  return lines.join("\n\n");
}

/** Providers sometimes encode the plan object twice despite JSON mode. Never expose that envelope to the author. */
export function normalizeChapterPlan(value: unknown): string {
  if (typeof value === "string") {
    const text = cleanPlanText(value);
    if (!text) return "";
    try { return normalizeChapterPlan(JSON.parse(text) as unknown); }
    catch { return text; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const object = value as Record<string, unknown>;
  if (object.plan !== undefined) {
    const plan = normalizeChapterPlan(object.plan);
    const handoff = normalizeChapterPlan(object.handoff);
    return [plan, handoff && !plan.includes(handoff) ? `## 下一章交接\n${handoff}` : ""].filter(Boolean).join("\n\n");
  }
  if (object.content !== undefined && Object.keys(object).length === 1) return normalizeChapterPlan(object.content);
  return planObjectToMarkdown(object);
}

function buildPrewriteCheck(state: ChapterStateType): { blockers: string[]; warnings: string[]; summary: string } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!state.outline?.trim()) blockers.push("缺少当前章纲或可执行大纲");
  if (!state.instruction.trim()) blockers.push("缺少本章创作指令");
  if (/(待定|待补|todo|\{.+?\}|\[待.+?\])/iu.test(`${state.outline || ""}\n${state.instruction}`)) warnings.push("章纲或指令含待补占位信息，正文将标记为待确认而不自行补设定");
  if (!state.previousChapters?.length) warnings.push("没有上一章正文，无法执行跨章承接检查");
  if (!state.knowledgeGraph?.trim()) warnings.push("知识图谱为空，本章只依据章纲、卡片与记忆校验设定");
  return { blockers, warnings, summary: blockers.length ? `写前检查发现 ${blockers.length} 项阻断` : `写前检查通过${warnings.length ? `，${warnings.length} 项提醒` : ""}` };
}

/** A deterministic, stable prefix lets compatible upstreams reuse prompt cache. */
function stableProjectPacket(state: ChapterStateType): string {
  return [
    state.worldSetting ? `## 世界观与作品设定（作者确认的只读固定规则；只可引用，不得自动改写或推断变化）\n${state.worldSetting}` : "",
    state.writingStyle ? `## 绑定文风（作品固定约束）\n名称：${state.writingStyle.name}\n${state.writingStyle.content}` : "",
  ].filter(Boolean).join("\n\n");
}

function splitSessionContext(value?: string): { summary: string; recent: string } {
  const context = compactText(value || "", 2200);
  if (!context) return { summary: "", recent: "" };
  const marker = "## 最近会话轮次";
  const index = context.indexOf(marker);
  if (index < 0) return { summary: context, recent: "" };
  return { summary: context.slice(0, index).trim(), recent: context.slice(index).trim() };
}

export function selectSkillsByIntent(instruction: string, catalog: SkillDefinition[]): { intent: string; skills: SkillDefinition[] } {
  const query = instruction.toLowerCase();
  const scored = catalog.map(skill => {
    const terms = [skill.name, skill.displayName || "", skill.category || "", skill.description || "", ...(skill.tags || [])]
      .join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let score = terms.reduce((total, term) => total + (term.length > 1 && query.includes(term) ? 2 : 0), 0);
    const categoryTerms: Record<string, string[]> = {
      setup: ["大纲", "设定", "世界观", "人物卡", "角色"],
      write: ["写", "续", "章节", "正文", "日更", "开书"],
      review: ["审查", "检查", "一致性", "逻辑", "矛盾"],
      polish: ["润色", "改写", "去ai", "自然", "文风"],
      import: ["导入", "解析", "已有小说"],
      analyze: ["分析", "拆书", "扫榜", "趋势", "题材"],
      tool: ["封面", "浏览器", "榜单"],
      creator: ["技能", "skill"],
    };
    score += (categoryTerms[skill.category || ""] || []).reduce((total, term) => total + (query.includes(term) ? 3 : 0), 0);
    return { skill, score };
  }).sort((left, right) => right.score - left.score);
  const selected = scored.filter(item => item.score > 0).slice(0, 3).map(item => item.skill);
  const fallback = catalog.find(skill => skill.name === "story-long-write") || catalog.find(skill => skill.category === "write");
  const skills = selected.length ? selected : (fallback ? [fallback] : []);
  const category = skills[0]?.category || "write";
  return { intent: intentLabels[category] || "章节创作与续写", skills };
}

export const ChapterState = Annotation.Root({
  projectId: Annotation<string>,
  chapterId: Annotation<string>,
  instruction: Annotation<string>,
  worldSetting: Annotation<string | undefined>,
  writingStyle: Annotation<{ name: string; content: string } | undefined>,
  outline: Annotation<string | undefined>,
  previousChapters: Annotation<Array<{ id?: string | number; title: string; content: string }> | undefined>,
  earlierMemorySummary: Annotation<string | undefined>,
  knowledgeGraph: Annotation<string | undefined>,
  cards: Annotation<Array<{ type?: string; title: string; content: string }> | undefined>,
  skillCatalog: Annotation<SkillDefinition[]>({ reducer: (_prev, next) => next, default: () => [] }),
  preferredSkillNames: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  selectedSkills: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  recognizedIntent: Annotation<string | undefined>,
  retrievedContext: Annotation<string[]>({
    reducer: (prev, next) => next,
    default: () => [],
  }),
  continuityContext: Annotation<string | undefined>,
  prewriteCheck: Annotation<{ blockers: string[]; warnings: string[]; summary: string } | undefined>,
  chapterPlan: Annotation<string | undefined>,
  draftContent: Annotation<string | undefined>,
  summary: Annotation<string | undefined>,
  contextReport: Annotation<ContextReport | undefined>,
  sessionContext: Annotation<string | undefined>,
  authorPreferences: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  upstreamUsage: Annotation<UsageTotals | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
  reviewResult: Annotation<{
    consistent: boolean;
    issues: string[];
    suggestions: string[];
  } | undefined>,
  errors: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

export type ChapterStateType = typeof ChapterState.State;

interface ChapterGraphConfig {
  store: StoryStore;
  apiKey: string;
  apiKeys?: string[];
  baseURL?: string;
  model?: string;
  apiMode?: "openai" | "responses" | "anthropic";
  reasoningMode?: string;
  contextWindowKB?: number;
  proxyEnabled?: boolean;
  proxyURL?: string;
  proxyBypassLocal?: boolean;
  skillCatalog?: SkillDefinition[];
  streamEmitter?: StreamEmitter;
}

export function createChapterGraph(config: ChapterGraphConfig) {
  const store = config.store;
  const client = new ApiSaverClient({
    apiKey: config.apiKey,
    apiKeys: config.apiKeys,
    baseURL: config.baseURL,
    defaultModel: config.model,
    apiMode: config.apiMode,
    reasoningMode: config.reasoningMode,
    contextWindowKB: config.contextWindowKB,
    proxyEnabled: config.proxyEnabled,
    proxyURL: config.proxyURL,
    proxyBypassLocal: config.proxyBypassLocal,
  });
  const emitter = config.streamEmitter;

  const graph = new StateGraph(ChapterState)
    .addNode("prewrite", async (state: ChapterStateType) => {
      const prewriteCheck = buildPrewriteCheck(state);
      emitter?.progress("starting", 5, prewriteCheck.summary);
      return { prewriteCheck };
    })
    .addNode("intent", async (state: ChapterStateType) => {
      const selection = selectSkillsByIntent(state.instruction, state.skillCatalog);
      const isWriting = selection.skills.some(skill => skill.category === "write") || /章节|正文|续写|创作|写作/u.test(state.instruction);
      const mandatoryNames = isWriting
        ? ["chapter-continuity", "next-chapter-plan"]
        : [];
      const mandatory = mandatoryNames.map(name => state.skillCatalog.find(skill => skill.name === name)).filter((skill): skill is SkillDefinition => Boolean(skill));
      const preferred = state.preferredSkillNames.map(name => state.skillCatalog.find(skill => skill.name === name)).filter((skill): skill is SkillDefinition => Boolean(skill));
      const selectedSkills = [...mandatory, ...preferred, ...selection.skills].filter((skill, index, list) => list.findIndex(item => item.name === skill.name) === index).slice(0, 6);
      const preferenceMessage = preferred.length ? `；手动优先：${preferred.map(skill => skill.name).join("、")}` : "";
      emitter?.progress("intent", 8, `工具 SkillRouter：识别意图“${selection.intent}”；已选技能：${selectedSkills.map(skill => skill.displayName || skill.name).join("、") || "默认写作规则"}${preferenceMessage}`);
      emitter?.context("intent", "自动匹配写作技能", { source: "SkillRouter", status: "selected", items: selectedSkills.length });
      return {
        recognizedIntent: selection.intent,
        selectedSkills: selectedSkills.map(skill => skill.name),
      };
    })
    .addNode("retrieve", async (state: ChapterStateType) => {
      emitter?.progress("retrieve", 10, "正在检索相关记忆...");
      emitter?.context("retrieve", "检索章节记忆、人物状态和时间线", { source: "StoryStore.searchHybrid", status: "searching" });

      // 首章没有可检索的历史章节或结构化记忆时，直接跳过数据库检索。
      // 这样不会把“空记忆”误显示成持续检索，也避免空 FTS/向量请求阻塞正文生成。
      const hasPreviousChapter = Boolean(state.previousChapters?.some(chapter => chapter?.content?.trim()));
      const hasStoredMemory = store.listConfirmed(state.projectId, 1).length > 0;
      if (!hasPreviousChapter && !hasStoredMemory) {
        emitter?.progress("retrieve", 25, "首章暂无历史记忆，已跳过检索");
        emitter?.context("retrieve", "首章无历史记忆，使用世界观、章纲和作者指令", { source: "StoryStore.searchHybrid", status: "selected", items: 0 });
        return { retrievedContext: [], contextReport: state.contextReport ? { ...state.contextReport, retrievedBytes: 0 } : undefined };
      }
      
      // 从指令和细纲中提取关键词
      const query = [state.instruction, state.outline].filter(Boolean).join(" ");
      
      // 使用混合检索：FTS5 + 向量语义（如果已启用）
      let results;
      let retrievalSource = "StoryStore.searchHybrid";
      try {
        results = await store.searchHybrid(state.projectId, query, 5);
      } catch {
        // 如果向量检索未启用，降级到 FTS5
        retrievalSource = "StoryStore.searchExact";
        results = store.searchExact(state.projectId, query, 5).map(r => ({
          ...r,
          similarity: 0.5,
        }));
      }

      // Structured memories are durable story constraints. Keep a small, high-priority
      // pack even when a new instruction has little lexical overlap with old chapters.
      const priorityTypes = new Set(["character_state", "foreshadowing", "timeline", "canon_fact"]);
      const priority = store.listConfirmed(state.projectId, 32)
        .filter(item => priorityTypes.has(item.type))
        .slice(0, 4)
        .map(item => ({ ...item, similarity: 1 }));
      const seen = new Set<string>();
      results = [...priority, ...results].filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).slice(0, 7);
      
      let remaining = 4600;
      const context = results.flatMap(r => {
        if (remaining < 180) return [];
        const heading = `[${r.type} · ${compactText(r.title, 120)}]`;
        const content = compactText(r.content, Math.max(150, Math.min(760, remaining - byteLength(heading) - 8)));
        const item = `${heading}\n${content}`;
        remaining -= byteLength(item) + 2;
        return content ? [item] : [];
      });
      const retrievedBytes = byteLength(context.join("\n\n"));
      const contextReport = state.contextReport ? { ...state.contextReport, retrievedBytes } : undefined;
      
      emitter?.progress("retrieve", 25, `工具 StoryStore.searchHybrid：找到 ${context.length} 条相关记忆${contextReport ? `；${formatContextReport(contextReport)}` : ""}`);
      emitter?.context("retrieve", `记忆检索完成：${context.length} 条`, { source: retrievalSource, status: "loaded", bytes: retrievedBytes, items: context.length });
      return { retrievedContext: context, contextReport };
    })
    .addNode("continuity", async (state: ChapterStateType) => {
      const previous = state.previousChapters?.[state.previousChapters.length - 1];
      if (!previous?.content?.trim()) {
        emitter?.progress("retrieve", 29, "没有上一章正文，按当前章节开篇创作");
        emitter?.context("retrieve", "未找到上一章正文，跳过承接资料", { source: "上一章正文", status: "selected", items: 0 });
        return { continuityContext: "（没有上一章正文；本章负责建立新的场景、人物位置和冲突。）" };
      }
      const relatedMemory = state.retrievedContext.find(item => item.includes(previous.title));
      const tail = compactText(previous.content, 2600);
      const continuityContext = `上一章：${previous.title}\n上一章结尾（最高优先级）：\n${tail}${relatedMemory ? `\n\n上一章结构记忆：\n${compactText(relatedMemory, 900)}` : ""}\n\n承接清单：开头先确认人物位置和情绪，处理未完成事件与章末钩子；场景或时间跳跃必须给出因果过渡。`;
      emitter?.progress("retrieve", 29, `已锁定${previous.title}结尾，生成阶段将优先承接`);
      emitter?.context("retrieve", "锁定上一章结尾作为承接锚点", { source: previous.title, status: "selected", bytes: byteLength(tail), items: 1 });
      return { continuityContext };
    })
    .addNode("plan", async (state: ChapterStateType) => {
      emitter?.progress("plan", 30, "工具 ChapterPlanner：正在根据承接清单制作下一章计划");
      emitter?.context("plan", "装载本章章纲与承接清单", { source: "ChapterPlanner", status: "loaded", bytes: byteLength(state.outline || "") });
      const skillSection = state.skillCatalog
        .filter(skill => state.selectedSkills.includes(skill.name))
        .slice(0, 6)
        .map(skill => `### ${skill.displayName || skill.name}\n${compactText(skill.content, 420)}`)
        .join("\n\n");
      const stablePacket = stableProjectPacket(state);
      const session = splitSessionContext(state.sessionContext);
      const planPrompt = [
        state.outline ? "## 章节细纲\n" + compactText(state.outline, 1800) : "",
        state.continuityContext ? "## 上一章承接（最高优先级）\n" + compactText(state.continuityContext, 3200) : "",
        state.earlierMemorySummary ? "## 更早章节压缩摘要（仅作连续性参考）\n" + compactText(state.earlierMemorySummary, 4200) : "",
        state.retrievedContext.length ? "## 结构化记忆\n" + compactText(state.retrievedContext.join("\n\n"), 2600) : "",
        state.knowledgeGraph ? "## 相关知识图谱\n" + compactText(state.knowledgeGraph, 1800) : "",
        skillSection ? "## 执行技能\n" + skillSection : "",
        state.prewriteCheck?.warnings.length ? `## 写前提醒\n${state.prewriteCheck.warnings.map(item => `- ${item}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      const planInstruction = `${chapterPlanSystemPrompt}\n\n## 本章任务\n${state.instruction}\n\n请输出一份 600 字以内的五段写作任务书，计划是正文生成的硬约束。格式固定为：1. 开篇承接；2. 这章的故事；3. 这章的人物；4. 怎么写更顺（节奏、文风、禁区）；5. 收在哪里（章末钩子）。`;
      const response = await client.chat([
        { role: "system", content: chapterAgentSystemPrompt },
        { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
        ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
        { role: "user", content: planPrompt },
        ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
        { role: "user", content: planInstruction },
      ], { response_format: { type: "json_object" }, temperature: 0.25, max_tokens: 900, retryAttempts: 2 });
      let chapterPlan = "";
      try {
        const result = JSON.parse(response.content) as Record<string, unknown>;
        chapterPlan = normalizeChapterPlan(result);
      } catch {
        chapterPlan = normalizeChapterPlan(response.content);
      }
      if (!chapterPlan) chapterPlan = "1. 开篇承接：确认上一章人物位置与情绪。\n2. 这章的故事：推进当前目标并制造有效阻力。\n3. 这章的人物：每人按动机行动。\n4. 怎么写更顺：用动作、因果和对话推进，避免解释。\n5. 收在哪里：以有因果依据的未解行动或风险收尾。";
      emitter?.progress("plan", 42, `模型规划完成（${chapterPlan.length.toLocaleString()} 字）；已交给正文节点执行`);
      return { chapterPlan, upstreamUsage: addUsage(state.upstreamUsage, response.usage) };
    })
    .addNode("draft", async (state: ChapterStateType) => {
      emitter?.progress("draft", 44, "工具 ContextAssembler：正在组织章节计划、设定、记忆和技能提示");
      
      // 构建 prompt
      const contextSection = state.retrievedContext.length > 0
        ? `\n## 相关背景\n${state.retrievedContext.join("\n\n")}\n`
        : "";
      
      const outlineSection = state.outline
        ? `\n## 章节细纲\n${state.outline}\n`
        : "";
      const graphSection = state.knowledgeGraph
        ? `\n## 知识图谱约束\n${state.knowledgeGraph}\n保持实体名称、类型和关系与图谱一致；新增关系需在正文中有依据。\n`
        : "";
      const cardsSection = state.cards?.length
        ? `\n## 本章知识卡片\n${state.cards.map(card => `### ${card.type || "知识卡"}：${card.title}\n${card.content}`).join("\n\n")}\n`
        : "";
      const skillsSection = state.selectedSkills.length
        ? `\n## 意图识别\n${state.recognizedIntent || "章节创作与续写"}\n\n## 自动选用技能\n${state.skillCatalog.filter(skill => state.selectedSkills.includes(skill.name)).slice(0, 3).map(skill => `### ${skill.displayName || skill.name}\n${compactText(skill.content, skill.name === "chapter-continuity" ? 1800 : 700)}`).join("\n\n")}\n`
        : "";

      const continuitySection = state.continuityContext
        ? `\n## 章节承接（最高优先级）\n${state.continuityContext}\n`
        : "";
      const earlierMemorySection = state.earlierMemorySummary
        ? `\n## 更早章节压缩摘要（只用于补足连续性，不得覆盖上一章）\n${compactText(state.earlierMemorySummary, 4200)}\n`
        : "";
      const planSection = state.chapterPlan ? `\n## 下一章计划（必须执行）\n${state.chapterPlan}\n` : "";
      // Keep project facts first and byte-stable; only the dynamic turn changes after it.
      const stablePacket = stableProjectPacket(state);
      const session = splitSessionContext(state.sessionContext);
      // Skill routing is the first dynamic section so the model sees the task
      // method before chapter-specific material; stable canon remains above it.
      const mutableProjectContext = [skillsSection, outlineSection, cardsSection, graphSection].filter(Boolean).join("");
      // Keep the stable project facts first, then the durable session handoff;
      // chapter-specific material follows so upstream prefix caches remain stable.
      const dynamicPacket = [mutableProjectContext, continuitySection, earlierMemorySection, planSection, contextSection].filter(Boolean).join("");
      emitter?.context("draft", "组装稳定设定与动态上下文", { source: "ContextAssembler", status: "loaded", bytes: byteLength(dynamicPacket), items: state.selectedSkills.length + (state.cards?.length || 0) });
      const hasPreviousChapter = Boolean(state.previousChapters?.some(chapter => chapter?.content?.trim()));
      const continuityInstruction = hasPreviousChapter
        ? "先承接上一章最后的动作、位置和情绪，再推进计划中的事件"
        : "这是第一章，没有上一章正文；先依据世界观、章纲和作者指令建立场景、人物与初始冲突";
      const taskPrompt = `${chapterWriterTaskPrompt}\n\n## 本章任务\n${state.instruction}\n\n请严格按照“下一章计划”创作 2000-3000 字左右正文：${continuityInstruction}；不要复述计划或解释过程。`;
      const draftInputBytes = byteLength(chapterAgentSystemPrompt) + byteLength(stablePacket) + byteLength(dynamicPacket) + byteLength(taskPrompt);
      const contextReport = state.contextReport ? { ...state.contextReport, draftInputBytes } : undefined;
      if (contextReport?.cache === "hit") emitter?.context("draft", "命中本地资料指纹缓存", { source: "持久化上下文缓存", status: "cached", bytes: draftInputBytes });
      if (contextReport?.prunedBytes) emitter?.context("draft", "按上下文预算裁剪低相关资料", { source: "ContextOptimizer", status: "pruned", bytes: contextReport.prunedBytes });

      // 流式生成文本
      emitter?.progress("draft", 38, "已提交模型请求，正在生成正文");
      const response = await client.chatStream([
        { role: "system", content: chapterAgentSystemPrompt },
        { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
        ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
        { role: "user", content: `## 本章动态资料\n${dynamicPacket || "（暂无动态资料）"}` },
        ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
        { role: "user", content: taskPrompt },
      ], { response_format: { type: "json_object" } }, chunk => emitter?.chunk(chunk));
      emitter?.progress("draft", 70, "章节生成完成");

      return {
        draftContent: unwrapChapterDraft(response.content),
        summary: chapterSummaryFromEnvelope(response.content),
        contextReport,
        upstreamUsage: addUsage(state.upstreamUsage, response.usage),
      };
    })
    .addNode("review", async (state: ChapterStateType) => {
      emitter?.progress("review", 75, "工具 ConsistencyChecker：正在审查人物、设定、时间线和因果...");
      
      if (!state.draftContent) {
        return {
          reviewResult: {
            consistent: false,
            issues: ["没有生成章节内容"],
            suggestions: [],
          },
        };
      }

      // 构建审查 prompt
      const contextSection = state.retrievedContext.length > 0
        ? `\n## 已知背景信息\n${state.retrievedContext.join("\n\n")}\n`
        : "";
      const cardsSection = state.cards?.length
        ? `\n## 本章引用卡片状态\n${state.cards.map(card => `${card.title}：${compactText(card.content, 260)}`).join("\n")}`
        : "";
      const graphSection = state.knowledgeGraph
        ? `\n## 知识图谱约束\n${state.knowledgeGraph}\n`
        : "";
      const earlierMemorySection = state.earlierMemorySummary
        ? `\n## 更早章节压缩摘要\n${compactText(state.earlierMemorySummary, 4200)}\n`
        : "";

      const reviewConstraints = `${cardsSection}${graphSection}${earlierMemorySection}${contextSection}`;
      const reviewDraft = compactText(state.draftContent, 10000);
      const reviewPrompt = `## 约束摘要\n${reviewConstraints || "（暂无额外约束）"}\n\n## 待审查章节\n${reviewDraft}`;
      const stablePacket = stableProjectPacket(state);
      const session = splitSessionContext(state.sessionContext);
      const reviewInstruction = chapterReviewSystemPrompt;
      const previousReport = state.contextReport;
      const reviewInputBytes = byteLength(chapterAgentSystemPrompt) + byteLength(stablePacket) + byteLength(session.summary) + byteLength(reviewPrompt) + byteLength(session.recent) + byteLength(reviewInstruction);
      const contextReport = previousReport ? {
        ...previousReport,
        reviewInputBytes,
        estimatedInputTokens: Math.ceil(((previousReport.draftInputBytes || 0) + reviewInputBytes) / 3),
      } : undefined;

      const response = await client.chat([
        { role: "system", content: chapterAgentSystemPrompt },
        { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
        ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
        { role: "user", content: reviewPrompt },
        ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
        { role: "user", content: reviewInstruction },
      ], { response_format: { type: "json_object" }, max_tokens: 650 });

      emitter?.progress("review", 95, "审查完成");

      try {
        const result = JSON.parse(response.content);
        return {
          reviewResult: {
            consistent: result.consistent ?? true,
            issues: result.issues || [],
            suggestions: result.suggestions || [],
          },
          contextReport,
          upstreamUsage: addUsage(state.upstreamUsage, response.usage),
        };
      } catch {
        return {
          reviewResult: {
            consistent: true,
            issues: [],
            suggestions: ["无法解析审查结果"],
          },
          contextReport,
          upstreamUsage: addUsage(state.upstreamUsage, response.usage),
        };
      }
    })
    .addEdge("__start__", "prewrite")
    .addEdge("prewrite", "intent")
    .addEdge("intent", "retrieve")
    .addEdge("retrieve", "continuity")
    .addEdge("continuity", "plan")
    .addEdge("plan", "draft")
    .addEdge("draft", "review")
    .addEdge("review", "__end__");

  return graph.compile();
}
