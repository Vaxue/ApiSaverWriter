import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ProxyAgent } from "undici";
import { normalizePromptWhitespace } from "../context/context-optimizer.js";

export type ApiSaverProvider = "openai" | "claude";

export interface ApiSaverModelInput {
  provider: ApiSaverProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ApiSaverModelConfig {
  provider: ApiSaverProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature?: number;
  maxTokens?: number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const isQuotaExceeded = (value: string): boolean => /quota\s+(?:has\s+been\s+)?exceeded|insufficient[\s_-]*quota|billing[\s_-]*(?:limit|quota)|余额不足|额度(?:已)?用尽/i.test(value);
const API_SAVER_BASE_URL = "https://api.apisaver.com/v1";

function supportsOpenAIJsonMode(model: string): boolean {
  // Gemini's OpenAI-compatible adapters commonly reject response_format at
  // the upstream gateway, even though a plain chat completion works.
  return !/^gemini(?:[-:/]|$)/iu.test(model.trim());
}

function supportsOpenAIReasoning(model: string): boolean {
  return /^(?:gpt-|o\d|chatgpt-)/iu.test(model.trim());
}

function apiErrorMessage(status: number, detail: string, statusText: string, attempts: number, routeHint = "", requestHint = ""): string {
  const retrySuffix = attempts > 1 ? `，已自动重试 ${attempts - 1} 次` : "";
  if (isQuotaExceeded(detail)) {
    return `API 中转服务额度已用尽${routeHint}。章节正文已保存，本章记忆将在额度恢复后再更新。`;
  }
  if ([502, 503, 504, 524].includes(status)) {
    const compact = detail.trim().startsWith("<") ? "" : detail.trim().replace(/\s+/g, " ").slice(0, 180);
    return `API 中转服务当前返回 ${status}（可能来自代理或 API 上游网关）${requestHint}${routeHint}${retrySuffix}${compact ? `：${compact}` : ""}`;
  }
  if (status === 429) return `API 中转服务请求过于频繁${routeHint}${retrySuffix}，请稍后再试。`;
  if (status === 401 || status === 403) return `API Key 或模型权限校验失败（${status}）${routeHint}，请在设置中检查配置。`;

  const compact = detail.trim().startsWith("<")
    ? "服务返回了网页错误页面"
    : detail.trim().replace(/\s+/g, " ").slice(0, 240);
  return `API Saver 请求失败（${status}）${routeHint}：${compact || statusText || "未知错误"}`;
}

export function buildModelConfig(input: ApiSaverModelInput): ApiSaverModelConfig {
  const raw = trimTrailingSlash(input.baseUrl?.trim() || "https://api.apisaver.com");
  const baseUrl = input.provider === "openai"
    ? raw.endsWith("/v1") ? raw : `${raw}/v1`
    : raw.endsWith("/messages") ? raw : `${raw}/v1/messages`;
  return {
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    baseUrl,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  };
}

export function createChatModel(config: ApiSaverModelConfig): BaseChatModel {
  if (config.provider === "openai") {
    return new ChatOpenAI({
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      configuration: { baseURL: config.baseUrl },
    });
  }
  return new ChatAnthropic({
    anthropicApiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens ?? 4096,
    clientOptions: { baseURL: config.baseUrl },
  });
}

// Simple client for direct API calls
export interface ApiSaverClientConfig {
  apiKey: string;
  apiKeys?: string[];
  baseURL?: string;
  defaultModel?: string;
  apiMode?: "openai" | "responses" | "anthropic";
  reasoningMode?: string;
  contextWindowKB?: number;
  proxyEnabled?: boolean;
  proxyURL?: string;
  proxyBypassLocal?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  retryAttempts?: number;
}

export interface ImageGenerationResult {
  dataUrl?: string;
  url?: string;
  revisedPrompt?: string;
}

export interface ApiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface RuntimeUsageSummary extends Required<ApiUsage> {
  requests: number;
  startedAt: string;
}

export interface GatewayUsageSnapshot {
  fetchedAt: string;
  status?: Record<string, unknown>;
  pricing?: Array<Record<string, unknown>>;
  accounts: Array<{ keyIndex: number; keyHint: string; usage?: Record<string, unknown>; logs: Array<Record<string, unknown>>; error?: string }>;
  errors: string[];
}

const runtimeUsage: RuntimeUsageSummary = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, startedAt: new Date().toISOString(),
};

function recordRuntimeUsage(usage?: ApiUsage): void {
  if (!usage) return;
  runtimeUsage.inputTokens += usage.inputTokens || 0;
  runtimeUsage.outputTokens += usage.outputTokens || 0;
  runtimeUsage.totalTokens += usage.totalTokens || 0;
  runtimeUsage.cachedInputTokens += usage.cachedInputTokens || 0;
  runtimeUsage.cacheWriteTokens += usage.cacheWriteTokens || 0;
  runtimeUsage.reasoningTokens += usage.reasoningTokens || 0;
  runtimeUsage.requests += 1;
}

export function getRuntimeUsageSummary(): RuntimeUsageSummary {
  return { ...runtimeUsage };
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsage(value: unknown): ApiUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const prompt = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const input = usage.input_tokens_details as Record<string, unknown> | undefined;
  const completion = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const output = usage.output_tokens_details as Record<string, unknown> | undefined;
  const result: ApiUsage = {
    inputTokens: numeric(usage.prompt_tokens) ?? numeric(usage.input_tokens),
    outputTokens: numeric(usage.completion_tokens) ?? numeric(usage.output_tokens),
    totalTokens: numeric(usage.total_tokens),
    cachedInputTokens: numeric(prompt?.cached_tokens) ?? numeric(input?.cached_tokens) ?? numeric(usage.cache_read_input_tokens) ?? numeric(usage.cached_tokens) ?? numeric(usage.prompt_cache_hit_tokens),
    cacheWriteTokens: numeric(prompt?.cache_write_tokens) ?? numeric(input?.cache_write_tokens) ?? numeric(usage.cache_creation_input_tokens),
    reasoningTokens: numeric(completion?.reasoning_tokens) ?? numeric(output?.reasoning_tokens),
  };
  if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return Object.values(result).some(value => value !== undefined) ? result : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(item => extractText(item)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return "";
}

function emptyCompletionError(data: Record<string, unknown>, maxTokens: number): Error {
  const choice = Array.isArray(data.choices) && data.choices[0] && typeof data.choices[0] === "object"
    ? data.choices[0] as Record<string, unknown>
    : undefined;
  const message = choice?.message && typeof choice.message === "object"
    ? choice.message as Record<string, unknown>
    : undefined;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
  if (finishReason === "length") {
    return new Error(`API Saver 模型输出被截断（max_tokens=${maxTokens}），请重试或提高输出上限`);
  }
  const reasoningLength = [message?.reasoning_content, message?.reasoning]
    .find(value => typeof value === "string");
  if (typeof reasoningLength === "string" && reasoningLength.length > 0) {
    return new Error("API Saver 只返回了推理内容，没有正文；请关闭推理模式或提高输出上限");
  }
  const topKeys = Object.keys(data).slice(0, 12).join(",");
  const choiceKeys = choice ? Object.keys(choice).slice(0, 12).join(",") : "";
  return new Error(`API Saver 返回内容为空（响应字段：${topKeys || "无"}；choice：${choiceKeys || "无"}）`);
}

const proxyAgents = new Map<string, ProxyAgent>();
// API keys can belong to different relay groups. `/v1/models` is scoped to
// the authenticated key, so retain this association instead of flattening all
// models into one list and accidentally sending a Gemini model through a
// Claude-only key.
const modelsByApiKey = new Map<string, Set<string>>();
const modelLookupInFlight = new Map<string, Promise<Set<string> | undefined>>();

export function resetModelKeyRoutingCache(): void {
  modelsByApiKey.clear();
  modelLookupInFlight.clear();
}

export function seedModelKeyRoutingCache(key: string, models: string[]): void {
  modelsByApiKey.set(key, new Set(models));
}

const isPrivateOrLocalHost = (hostname: string) => {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "::1" || host.startsWith("127.")) return true;
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
};

const proxyURLForRequest = (targetURL: string, config: Pick<ApiSaverClientConfig, "proxyEnabled" | "proxyURL" | "proxyBypassLocal">) => {
  if (!config.proxyEnabled || !config.proxyURL?.trim()) return "";
  try {
    const proxy = new URL(config.proxyURL.trim());
    const target = new URL(targetURL);
    if (!/^https?:$/i.test(proxy.protocol)) return "";
    if (config.proxyBypassLocal === true && isPrivateOrLocalHost(target.hostname)) return "";
    return proxy.toString();
  } catch {
    return "";
  }
};

const proxyDispatcherFor = (targetURL: string, config: Pick<ApiSaverClientConfig, "proxyEnabled" | "proxyURL" | "proxyBypassLocal">) => {
  const proxyURL = proxyURLForRequest(targetURL, config);
  if (!proxyURL) return undefined;
  const existing = proxyAgents.get(proxyURL);
  if (existing) return existing;
  const agent = new ProxyAgent(proxyURL);
  proxyAgents.set(proxyURL, agent);
  return agent;
};

const proxyRouteHint = (targetURL: string, config: Pick<ApiSaverClientConfig, "proxyEnabled" | "proxyURL" | "proxyBypassLocal">) => {
  const proxyURL = proxyURLForRequest(targetURL, config);
  if (!proxyURL) return "";
  try {
    const proxy = new URL(proxyURL);
    return `，已通过代理 ${proxy.protocol}//${proxy.host}`;
  } catch {
    return "，已通过应用代理";
  }
};

function limitMessagesToKB(messages: ChatMessage[], contextWindowKB?: number): ChatMessage[] {
  // Final transport-level pass catches raw document fields that bypassed the
  // context packer. It affects only the request payload, never local files.
  const normalizedMessages = messages.map(message => ({
    ...message,
    content: normalizePromptWhitespace(message.content),
  }));
  const budget = Math.floor(Number(contextWindowKB || 0) * 1024);
  if (!budget || normalizedMessages.reduce((sum, message) => sum + message.content.length, 0) <= budget) return normalizedMessages;
  let remaining = budget;
  return normalizedMessages.map(message => {
    if (remaining <= 0) return { ...message, content: "" };
    const content = message.content.length <= remaining
      ? message.content
      : remaining <= 4096
        ? message.content.slice(0, remaining)
        : `${message.content.slice(0, remaining - 2048)}\n...[上下文已按 KB 限制截断]...\n${message.content.slice(-2048)}`;
    remaining -= content.length;
    return { ...message, content };
  }).filter(message => message.content.trim());
}

export class ApiSaverClient {
  private config: ApiSaverClientConfig;

  constructor(config: ApiSaverClientConfig) {
    this.config = config;
  }

  async generateImage(prompt: string, options: { apiKey?: string; model?: string; size?: string; quality?: string } = {}): Promise<ImageGenerationResult> {
    const key = String(options.apiKey || this.config.apiKey || '').trim();
    if (!key) throw new Error('缺少生图 API Key');
    const model = String(options.model || 'gpt-image-2').trim() || 'gpt-image-2';
    const endpoint = `${API_SAVER_BASE_URL}/images/generations`;
    const dispatcher = proxyDispatcherFor(endpoint, this.config);
    const body = JSON.stringify({
      model,
      prompt: normalizePromptWhitespace(prompt),
      size: options.size || '1024x1536',
      quality: options.quality || 'high',
      n: 1,
    });
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
          body,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        const raw = await response.text();
        if (!response.ok) {
          lastError = apiErrorMessage(response.status, raw, response.statusText, attempt, proxyRouteHint(endpoint, this.config), `，模型 ${model} · ${endpoint}`);
          if ([408, 429, 500, 502, 503, 504, 524].includes(response.status) && !isQuotaExceeded(raw) && attempt < 3) {
            await sleep(700 * 2 ** (attempt - 1));
            continue;
          }
          throw new Error(lastError);
        }
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(raw) as Record<string, unknown>; }
        catch { throw new Error('生图接口返回了无效 JSON'); }
        const first = Array.isArray(payload.data) && payload.data[0] && typeof payload.data[0] === 'object'
          ? payload.data[0] as Record<string, unknown>
          : undefined;
        const b64 = typeof first?.b64_json === 'string' ? first.b64_json.trim() : '';
        const url = typeof first?.url === 'string' ? first.url.trim() : '';
        if (!b64 && !url) throw new Error('生图接口没有返回图片');
        if (!b64 && url) {
          try {
            const imageResponse = await fetch(url, { ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
            if (imageResponse.ok) {
              const contentType = imageResponse.headers.get('content-type') || 'image/png';
              const encoded = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
              return { dataUrl: `data:${contentType};base64,${encoded}`, url, ...(typeof first?.revised_prompt === 'string' ? { revisedPrompt: first.revised_prompt } : {}) };
            }
          } catch { /* Keep the remote URL as a fallback when CDN fetch is unavailable. */ }
        }
        return {
          ...(b64 ? { dataUrl: `data:image/png;base64,${b64}` } : {}),
          ...(url ? { url } : {}),
          ...(typeof first?.revised_prompt === 'string' ? { revisedPrompt: first.revised_prompt } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('API ')) throw error;
        lastError = message;
        if (attempt < 3) { await sleep(500 * 2 ** (attempt - 1)); continue; }
      }
    }
    throw new Error(lastError || '生图请求失败');
  }

  private async modelsForKey(key: string): Promise<Set<string> | undefined> {
    const cached = modelsByApiKey.get(key);
    if (cached) return cached;
    const inflight = modelLookupInFlight.get(key);
    if (inflight) return inflight;
    const endpoint = `${API_SAVER_BASE_URL}/models`;
    const lookup = (async () => {
      try {
        const dispatcher = proxyDispatcherFor(endpoint, this.config);
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        if (!response.ok) return undefined;
        const payload = await response.json() as { data?: Array<{ id?: string } | string>; models?: Array<{ id?: string } | string> };
        const models = new Set((payload.data ?? payload.models ?? [])
          .map(item => typeof item === "string" ? item : item.id)
          .filter((model): model is string => Boolean(model)));
        modelsByApiKey.set(key, models);
        return models;
      } catch {
        // Do not turn a temporary models endpoint failure into a hard writing
        // failure. The real completion request still has its normal retries.
        return undefined;
      } finally {
        modelLookupInFlight.delete(key);
      }
    })();
    modelLookupInFlight.set(key, lookup);
    return lookup;
  }

  private async keysForModel(keys: string[], model: string): Promise<string[]> {
    if (keys.length <= 1) return keys;
    // This happens once per key per runtime and survives all later chapter,
    // outline, card and streaming calls. It also works after an app restart,
    // before the user has manually pressed “拉取模型”.
    const known = await Promise.all(keys.map(async key => ({ key, models: await this.modelsForKey(key) })));
    const matched = known.filter(item => item.models?.has(model)).map(item => item.key);
    if (matched.length) return matched;
    const unavailable = known.filter(item => !item.models).map(item => item.key);
    if (!unavailable.length) {
      throw new Error(`当前配置的 API Key 都不支持模型 ${model}。请在模型配置中重新拉取模型，并选择该模型所在分组对应的 API Key。`);
    }
    // A transient model-list outage must not stop a request outright. Only
    // unverified keys remain as a last-resort fallback; known wrong keys are
    // explicitly excluded.
    return unavailable;
  }

  async listModels(): Promise<string[]> {
    const endpoint = `${API_SAVER_BASE_URL}/models`;
    const keys = Array.from(new Set([this.config.apiKey, ...(this.config.apiKeys || [])].map(key => key.trim()).filter(Boolean)));
    if (!keys.length) throw new Error("缺少 API Key");
    const results = await Promise.allSettled(keys.map(async key => {
      const models = await this.modelsForKey(key);
      if (!models) throw new Error(`模型列表请求失败：${endpoint}`);
      return [...models];
    }));
    const models = Array.from(new Set(results.flatMap(result => result.status === "fulfilled" ? result.value : [])));
    if (!models.length) {
      const errors = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
      throw new Error(errors.length ? `所有 API Key 拉取模型失败：${errors.join("；")}` : "接口没有返回可用模型");
    }
    return models;
  }

  /** Read-only dashboard data exposed by New API for the currently configured
   * relay keys. These endpoints deliberately authenticate each key on its own,
   * so the app never needs a dashboard cookie and cannot see another user. */
  async getGatewayUsageSnapshot(): Promise<GatewayUsageSnapshot> {
    const root = "https://api.apisaver.com";
    const endpoint = (path: string) => `${root}${path}`;
    const keys = Array.from(new Set([this.config.apiKey, ...(this.config.apiKeys || [])]
      .map(key => key.trim()).filter(Boolean)));
    if (!keys.length) throw new Error("请先在设置中填写 API Key。");
    const requestJSON = async (path: string, key?: string): Promise<Record<string, unknown>> => {
      const url = endpoint(path);
      const dispatcher = proxyDispatcherFor(url, this.config);
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      const body = await response.text();
      if (!response.ok) throw new Error(`${path} 请求失败（${response.status}）：${body.replace(/\s+/g, " ").slice(0, 180)}`);
      try { return JSON.parse(body) as Record<string, unknown>; }
      catch { throw new Error(`${path} 没有返回 JSON 数据`); }
    };
    const [statusResult, accountResults] = await Promise.all([
      requestJSON("/api/status").catch(error => ({ __error: String(error) })),
      Promise.all(keys.map(async (key, keyIndex) => {
        const keyHint = `${key.slice(0, 4)}••••${key.slice(-4)}`;
        const [usageResult, logsResult, pricingResult] = await Promise.allSettled([
          requestJSON("/api/usage/token", key),
          requestJSON("/api/log/token", key),
          requestJSON("/api/pricing", key),
        ]);
        const failures = [usageResult, logsResult, pricingResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => String(result.reason));
        const usagePayload = usageResult.status === "fulfilled" ? usageResult.value : undefined;
        const logsPayload = logsResult.status === "fulfilled" ? logsResult.value : undefined;
        const pricingPayload = pricingResult.status === "fulfilled" ? pricingResult.value : undefined;
        const logs = Array.isArray(logsPayload?.data) ? logsPayload.data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
        return {
          keyIndex,
          keyHint,
          usage: usagePayload && typeof usagePayload.data === "object" && usagePayload.data ? usagePayload.data as Record<string, unknown> : undefined,
          logs,
          pricing: Array.isArray(pricingPayload?.data) ? pricingPayload.data.filter((item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [],
          group: usagePayload?.data && typeof usagePayload.data === "object" && typeof (usagePayload.data as Record<string, unknown>).group === "string" ? String((usagePayload.data as Record<string, unknown>).group) : undefined,
          groupRatios: pricingPayload?.group_ratio && typeof pricingPayload.group_ratio === "object" ? pricingPayload.group_ratio as Record<string, number> : undefined,
          usableGroups: pricingPayload?.usable_group && typeof pricingPayload.usable_group === "object" ? pricingPayload.usable_group as Record<string, unknown> : undefined,
          ...(failures.length ? { error: failures.join("；") } : {}),
        };
      })),
    ]);
    const errors = [statusResult.__error].filter((value): value is string => typeof value === "string");
    const statusPayload = statusResult as Record<string, unknown>;
    const statusData = statusPayload["data"];
    const pricing = accountResults.flatMap(account => account.pricing || []).filter((item, index, all) => all.findIndex(other => String(other.model_name) === String(item.model_name)) === index);
    return {
      fetchedAt: new Date().toISOString(),
      status: statusData && typeof statusData === "object" ? statusData as Record<string, unknown> : undefined,
      pricing,
      accounts: accountResults,
      errors,
    };
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): Promise<{ content: string; model: string; usage?: ApiUsage }> {
    const model = options.model || this.config.defaultModel || "gpt-4o-mini";
    const baseURL = API_SAVER_BASE_URL;
    // All managed ApiSaver models use the verified OpenAI-compatible wire.
    // A stale settings value must not route a normal write request to a
    // different endpoint with a different response schema.
    const apiMode = "openai";
    const contextMessages = limitMessagesToKB(messages, this.config.contextWindowKB);
    const configuredKeys = Array.from(new Set([this.config.apiKey, ...(this.config.apiKeys || [])].map(key => key.trim()).filter(Boolean)));
    const apiKeys = await this.keysForModel(configuredKeys, model);
    const maxTokens = options.max_tokens ?? 4000;
    const reasoningMode = this.config.reasoningMode;
    const reasoning = supportsOpenAIReasoning(model) && reasoningMode && !["auto", "off"].includes(reasoningMode)
      ? { effort: reasoningMode === "custom" ? "medium" : reasoningMode }
      : undefined;
    let endpoint = `${baseURL}/chat/completions`;
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    let body: string;

    body = JSON.stringify({
      model,
      messages: contextMessages,
      temperature: options.temperature ?? 0.7,
      max_tokens: maxTokens,
      // Gemini models use this same route but do not consistently implement
      // response_format. Prompt-level JSON rules remain in place.
      response_format: supportsOpenAIJsonMode(model) ? options.response_format : undefined,
      reasoning,
    });
    const maxAttempts = Math.max(1, Math.min(5, options.retryAttempts ?? 3));
    let lastNetworkError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const requestKey = apiKeys[(attempt - 1) % Math.max(1, apiKeys.length)] || this.config.apiKey;
        const requestHeaders = { ...headers };
        requestHeaders.Authorization = `Bearer ${requestKey}`;
        const dispatcher = proxyDispatcherFor(endpoint, this.config);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: requestHeaders,
          body,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        if (response.ok) {
          const data = await response.json() as Record<string, unknown>;
          const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
          const firstChoice = choices[0];
          const firstMessage = firstChoice?.message as Record<string, unknown> | undefined;
          const content = extractText(firstMessage?.content) || extractText(firstChoice?.text);
          if (!content) throw emptyCompletionError(data, maxTokens);
          const usage = parseUsage(data.usage);
          recordRuntimeUsage(usage);
          return { content, model: typeof data.model === "string" ? data.model : model, usage };
        }

        const detail = await response.text();
        const retryable = [408, 429, 500, 502, 503, 504, 524].includes(response.status) && !isQuotaExceeded(detail);
        if (retryable && attempt < maxAttempts) {
          // Some upstream OpenAI-compatible adapters turn unsupported optional
          // fields into a 503. Retry the same task once with only core fields.
          if (response.status === 503 && apiMode === "openai" && attempt === 1) {
            try {
              const compatibilityBody = JSON.parse(body) as Record<string, unknown>;
              delete compatibilityBody.response_format;
              delete compatibilityBody.reasoning;
              body = JSON.stringify(compatibilityBody);
            } catch { /* The original request remains valid for the next retry. */ }
          }
          await sleep(800 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(apiErrorMessage(response.status, detail, response.statusText, attempt, proxyRouteHint(endpoint, this.config), `，模型 ${model} · ${endpoint}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("API ")) throw error;
        lastNetworkError = message;
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
      }
    }
    throw new Error(`无法连接 API 中转服务，已自动重试 ${maxAttempts - 1} 次：${lastNetworkError || "网络连接失败"}`);
  }

  async chatStream(messages: ChatMessage[], options: ChatOptions = {}, onChunk?: (chunk: string) => void): Promise<{ content: string; model: string; usage?: ApiUsage }> {
    // All managed models use the same OpenAI-compatible SSE transport.
    // Never let a stale protocol selection silently degrade writing to a
    // non-streaming request.
    const model = options.model || this.config.defaultModel || "gpt-4o-mini";
    const baseURL = API_SAVER_BASE_URL;
    const endpoint = `${baseURL}/chat/completions`;
    const contextMessages = limitMessagesToKB(messages, this.config.contextWindowKB);
    const dispatcher = proxyDispatcherFor(endpoint, this.config);
    const configuredKeys = Array.from(new Set([this.config.apiKey, ...(this.config.apiKeys || [])].map(key => key.trim()).filter(Boolean)));
    const apiKeys = await this.keysForModel(configuredKeys, model);
    if (!apiKeys.length) throw new Error("缺少 API Key");
    let response: Response | null = null;
    let lastStreamError = "";
    for (const key of apiKeys) {
      const candidate = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: contextMessages, temperature: options.temperature ?? 0.7, max_tokens: options.max_tokens ?? 4000, response_format: supportsOpenAIJsonMode(model) ? options.response_format : undefined, stream: true, stream_options: { include_usage: true } }),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      if (candidate.ok && candidate.body) {
        response = candidate;
        break;
      }
      const detail = await candidate.text();
      lastStreamError = apiErrorMessage(candidate.status, detail, candidate.statusText, 1, proxyRouteHint(endpoint, this.config), `，模型 ${model} · ${endpoint}`);
    }
    const responseBody = response?.body;
    if (!responseBody) throw new Error(lastStreamError || "所有 API Key 的流式请求均失败");
    const reader = responseBody.getReader(); const decoder = new TextDecoder(); let buffer = ""; let content = ""; let usage: ApiUsage | undefined;
    try {
      streamLoop: while (true) {
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE 首个响应超时")), content ? 45000 : 30000)),
        ]); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const line of lines) {
          const text = line.trim().replace(/^data:\s*/, "");
          if (!text) continue;
          if (text === "[DONE]") break streamLoop;
          try {
            const event = JSON.parse(text) as Record<string, unknown>;
            const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> : undefined;
            const delta = choice?.delta as Record<string, unknown> | undefined;
            const chunk = typeof delta?.content === "string" ? delta.content : "";
            if (chunk) { content += chunk; onChunk?.(chunk); }
            usage = parseUsage(event.usage) || usage;
            // A number of OpenAI-compatible relays omit the terminal [DONE]
            // event but do provide choice.finish_reason. Stop as soon as the
            // model reports completion so the UI cannot remain stuck waiting
            // for another read from an otherwise open connection.
            if (typeof choice?.finish_reason === "string" && choice.finish_reason.trim()) break streamLoop;
          } catch { /* Ignore proxy keep-alives. */ }
        }
      }
    } catch (error) {
      if (!content) {
        const fallback = await this.chat(messages, options);
        onChunk?.(fallback.content);
        return fallback;
      }
      throw new Error(`API Saver 流式连接中断：${error instanceof Error ? error.message : String(error)}`);
    }
    recordRuntimeUsage(usage);
    // Some OpenAI-compatible gateways accept stream=true but answer with one
    // ordinary JSON response. Preserve compatibility and still update UI once.
    if (!content) {
      const fallback = await this.chat(messages, options);
      onChunk?.(fallback.content);
      return fallback;
    }
    return { content, model, usage };
  }
}
