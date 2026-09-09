import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StoryStore } from "../src/storage/story-store.js";
import { LocalEmbeddingProvider } from "../src/embedding/embedding-provider.js";

// 模拟生产接线：持久化文件库 + 本地 MiniLM 向量化 + 混合检索
describe("story store production smoke", () => {
  const dir = mkdtempSync(join(tmpdir(), "story-smoke-"));
  const dbPath = join(dir, "story.sqlite");
  const provider = new LocalEmbeddingProvider();
  const store = StoryStore.open(dbPath);
  store.enableVectorSearch(provider);

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists memories across store instances and finds them semantically", async () => {
    store.createProject({ id: "p1", title: "冒烟测试" });
    store.saveMemory({
      id: "m-1", projectId: "p1", type: "character_state",
      title: "林晚状态", content: "林晚左臂骨折未愈，藏在城南旧当铺养伤。",
      entityNames: ["林晚"], confirmed: true, importance: 1,
    });
    await store.saveMemoryVector("m-1", "林晚左臂骨折未愈，藏在城南旧当铺养伤。");

    // 重开同一个文件库，模拟下一次请求
    const reopened = StoryStore.open(dbPath);
    reopened.enableVectorSearch(provider);
    const semantic = await reopened.searchSemantic("p1", "林晚的伤势怎么样", 5);
    expect(semantic.length).toBeGreaterThan(0);
    expect(semantic[0].title).toContain("林晚");
    const hybrid = await reopened.searchHybrid("p1", "林晚养伤", 5);
    expect(hybrid.length).toBeGreaterThan(0);
    reopened.close();
  });
});
