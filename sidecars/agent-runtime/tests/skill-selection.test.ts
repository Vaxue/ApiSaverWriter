import { describe, expect, it } from "vitest";
import { routeSkillsWithModel, selectSkillsByIntent } from "../src/graphs/chapter-write.graph.js";

describe("chapter skill intent selection", () => {
  const catalog = [
    { name: "story-long-write", category: "write", description: "长篇章节续写", tags: ["章节", "正文"], content: "write" },
    { name: "story-review", category: "review", description: "一致性审查", tags: ["审查", "逻辑"], content: "review" },
    { name: "story-deslop", category: "polish", description: "去 AI 味润色", tags: ["润色"], content: "polish" },
  ];

  it("selects review skills from an author's intent", () => {
    const result = selectSkillsByIntent("请检查本章逻辑和人物状态是否一致", catalog);
    expect(result.intent).toContain("审查");
    expect(result.skills.map(skill => skill.name)).toContain("story-review");
  });

  it("falls back to long-form writing when intent is implicit", () => {
    const result = selectSkillsByIntent("继续写下一章，结尾留下悬念", catalog);
    expect(result.skills[0]?.name).toBe("story-long-write");
  });

  it("marks ambiguous instructions as not confident for model routing", () => {
    const result = selectSkillsByIntent("把第三章捋顺一点", catalog);
    expect(result.confident).toBe(false);
    expect(result.topScore).toBe(0);
  });
});

describe("tiered skill routing with models", () => {
  const catalog = [
    { name: "story-long-write", category: "write", description: "长篇章节续写", content: "write" },
    { name: "story-deslop", category: "polish", description: "去 AI 味润色", content: "polish" },
  ];

  it("matches model-returned skill names when confidence is high", async () => {
    const chat = async () => ({ content: JSON.stringify({ skills: ["story-deslop"], confidence: 0.9 }) });
    const result = await routeSkillsWithModel("把这段改得更像人写的", catalog, undefined, chat as never, "fast");
    expect(result?.skills.map(skill => skill.name)).toEqual(["story-deslop"]);
    expect(result?.confidence).toBe(0.9);
  });

  it("returns empty skills when the router is uncertain", async () => {
    const chat = async () => ({ content: JSON.stringify({ skills: ["story-deslop"], confidence: 0.3 }) });
    const result = await routeSkillsWithModel("随便写写", catalog, undefined, chat as never, "fast");
    expect(result?.skills).toEqual([]);
  });

  it("returns undefined so callers fall back when the router call fails", async () => {
    const chat = async () => { throw new Error("boom"); };
    const result = await routeSkillsWithModel("写下一章", catalog, undefined, chat as never, "strong");
    expect(result).toBeUndefined();
  });
});
