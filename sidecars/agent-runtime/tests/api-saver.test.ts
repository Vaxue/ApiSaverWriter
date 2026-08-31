import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiSaverClient, buildModelConfig, createChatModel, resetModelKeyRoutingCache, seedModelKeyRoutingCache } from "../src/models/api-saver.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetModelKeyRoutingCache();
});

describe("API Saver model configuration", () => {
  it("normalizes an OpenAI-compatible API Saver base URL", () => {
    expect(buildModelConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o-mini",
      baseUrl: "https://api.apisaver.com",
    })).toEqual({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o-mini",
      baseUrl: "https://api.apisaver.com/v1",
    });
  });

  it("preserves an explicit Claude messages endpoint", () => {
    expect(buildModelConfig({
      provider: "claude",
      apiKey: "test-key",
      model: "claude-3-5-sonnet",
      baseUrl: "https://api.apisaver.com/v1/messages",
    }).baseUrl).toBe("https://api.apisaver.com/v1/messages");
  });

  it("creates a LangChain chat model for both providers", () => {
    expect(createChatModel(buildModelConfig({ provider: "openai", apiKey: "x", model: "gpt-4o-mini" }))._llmType()).toBe("openai");
    expect(createChatModel(buildModelConfig({ provider: "claude", apiKey: "x", model: "claude-3-5-sonnet" }))._llmType()).toBe("anthropic");
  });

  it("retries temporary gateway failures before returning a response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }))
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "gpt-test",
        choices: [{ message: { content: "生成完成" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const request = new ApiSaverClient({ apiKey: "test-key", baseURL: "https://example.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]);
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ content: "生成完成", model: "gpt-test" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rotates through configured supplier keys on retries", async () => {
    vi.useFakeTimers();
    seedModelKeyRoutingCache("primary-key", ["gpt-test"]);
    seedModelKeyRoutingCache("backup-key", ["gpt-test"]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "gpt-test",
        choices: [{ message: { content: "OK" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const request = new ApiSaverClient({ apiKey: "primary-key", apiKeys: ["primary-key", "backup-key"], baseURL: "https://example.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]);
    await vi.runAllTimersAsync();
    await expect(request).resolves.toEqual({ content: "OK", model: "gpt-test" });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer primary-key" });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer backup-key" });
  });

  it("merges model lists returned by multiple configured keys", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "gpt-a" }, { id: "gpt-shared" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "gpt-shared" }, { id: "gpt-b" }] }), { status: 200 }));

    const models = await new ApiSaverClient({ apiKey: "primary-key", apiKeys: ["backup-key"], baseURL: "https://invalid.example/v1" }).listModels();

    expect(models).toEqual(["gpt-a", "gpt-shared", "gpt-b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.apisaver.com/v1/models");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.apisaver.com/v1/models");
  });

  it("uses the API key that advertised the selected model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-fable-5" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "gemini-3.7-flash" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "gemini-3.7-flash", choices: [{ message: { content: "OK" } }] }), { status: 200 }));
    const client = new ApiSaverClient({ apiKey: "claude-key", apiKeys: ["gemini-key"], defaultModel: "gemini-3.7-flash" });

    await client.listModels();
    await expect(client.chat([{ role: "user", content: "测试" }])).resolves.toMatchObject({ content: "OK" });

    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({ Authorization: "Bearer gemini-key" });
  });

  it("discovers the matching key before the first model request after a restart", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-fable-5" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "gemini-3.7-flash" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "gemini-3.7-flash", choices: [{ message: { content: "OK" } }] }), { status: 200 }));

    await expect(new ApiSaverClient({
      apiKey: "claude-key", apiKeys: ["gemini-key"], defaultModel: "gemini-3.7-flash", apiMode: "openai",
    }).chat([{ role: "user", content: "测试" }])).resolves.toMatchObject({ content: "OK" });

    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({ Authorization: "Bearer gemini-key" });
  });

  it("always uses chat completions even when an obsolete Responses mode is stored", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "gpt-5.6-terra", choices: [{ message: { content: "OK" } }] }), { status: 200 }));

    await expect(new ApiSaverClient({
      apiKey: "test-key", defaultModel: "gpt-5.6-terra", apiMode: "responses",
    }).chat([{ role: "user", content: "测试" }], { response_format: { type: "json_object" } }))
      .resolves.toMatchObject({ content: "OK" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.apisaver.com/v1/chat/completions");
  });

  it("uses the managed gateway even when a legacy custom address is supplied", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: "OK" } }] }), { status: 200 }));

    await expect(new ApiSaverClient({ apiKey: "test-key", baseURL: "https://legacy.example/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]))
      .resolves.toEqual({ content: "OK", model: "gpt-test" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.apisaver.com/v1/chat/completions");
  });

  it("omits OpenAI-only JSON and reasoning options for Gemini-compatible models", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ model: "gemini-3.7-flash", choices: [{ message: { content: "{}" } }] }), { status: 200 }));

    await new ApiSaverClient({
      apiKey: "test-key", defaultModel: "gemini-3.7-flash", reasoningMode: "high",
    }).chat([{ role: "user", content: "请输出 JSON" }], { response_format: { type: "json_object" } });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(requestBody).not.toHaveProperty("response_format");
    expect(requestBody).not.toHaveProperty("reasoning");
  });

  it("extracts text from OpenAI-compatible content blocks and legacy text choices", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: [{ type: "text", text: "第一段" }, { text: "第二段" }] } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "gpt-test", choices: [{ text: "旧格式正文" }] }), { status: 200 }));

    await expect(new ApiSaverClient({ apiKey: "test-key", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }])).resolves.toMatchObject({ content: "第一段\n第二段" });
    await expect(new ApiSaverClient({ apiKey: "test-key", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }])).resolves.toMatchObject({ content: "旧格式正文" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports truncation instead of a generic empty response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "gemini-3.7-flash",
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
    }), { status: 200 }));

    await expect(new ApiSaverClient({ apiKey: "test-key", defaultModel: "gemini-3.7-flash" })
      .chat([{ role: "user", content: "测试" }], { max_tokens: 8, retryAttempts: 1 }))
      .rejects.toThrow("模型输出被截断（max_tokens=8）");
  });

  it("explains when a gateway returns reasoning without visible content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-test",
      choices: [{ message: { reasoning_content: "内部推理" }, finish_reason: "stop" }],
    }), { status: 200 }));

    await expect(new ApiSaverClient({ apiKey: "test-key", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }], { retryAttempts: 1 }))
      .rejects.toThrow("只返回了推理内容");
  });

  it("finishes an SSE response on finish_reason even when the relay keeps the connection open", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            `data: ${JSON.stringify({ choices: [{ delta: { content: "第一段" }, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 7 } })}`,
            "",
          ].join("\n")));
          // Deliberately do not close: some relays omit [DONE] and leave the
          // HTTP connection open after sending the terminal choice event.
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));

    await expect(new ApiSaverClient({ apiKey: "test-key", defaultModel: "gpt-test" })
      .chatStream([{ role: "user", content: "测试" }]))
      .resolves.toMatchObject({ content: "第一段", model: "gpt-test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an exhausted quota response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "The quota has been exceeded" } }), { status: 429 }));

    const request = new ApiSaverClient({ apiKey: "test-key", baseURL: "https://example.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]);

    await expect(request).rejects.toThrow("API 中转服务额度已用尽");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the dedicated image key and returns generated base64 artwork", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: "aGVsbG8=" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(new ApiSaverClient({ apiKey: "text-key", defaultModel: "gpt-test" }).generateImage("竖版小说封面", {
      apiKey: "image-key", model: "gpt-image-2",
    })).resolves.toMatchObject({ dataUrl: "data:image/png;base64,aGVsbG8=" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.apisaver.com/v1/images/generations");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer image-key" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: "gpt-image-2", size: "1024x1536", n: 1 });
  });

  it("materializes a URL image into a local data URL when the CDN is readable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: "https://cdn.example/cover.png" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } }));
    await expect(new ApiSaverClient({ apiKey: "text-key" }).generateImage("封面", { apiKey: "image-key" }))
      .resolves.toMatchObject({ dataUrl: "data:image/png;base64,AQID", url: "https://cdn.example/cover.png" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
