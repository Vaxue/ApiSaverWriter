import type { Skill } from '../App';
import { advancedBuiltinSkills } from './advanced-skills';

const builtinSkillDefinitions: Skill[] = [
  ...advancedBuiltinSkills,
  {
    id: 'builtin-outline-total', name: 'outline-total-planner', displayName: '番茄小说总纲生成器', category: 'setup',
    description: '生成具备差异化卖点、分卷爽点、冲突升级和伏笔回收的番茄小说总纲。', tags: ['总纲', '番茄', '卖点', '分卷', '伏笔'], rating: 5, usageCount: 0, builtin: true,
    content: '# 番茄小说总纲生成器\n\n## 输出内容\n\n1. **题材卖点与差异化钩子**：明确目标读者、核心爽感、市场常见套路，以及本书在设定、人物、冲突或叙事上的独特记忆点；用一句话写出可用于简介的核心钩子。\n2. **主线目标**：写清主角最终目标、阶段目标、必须完成的关键节点、失败代价和倒计时压力。\n3. **人物动机与成长弧**：分别说明主角和关键配角的初始欲望、隐藏需求、核心矛盾、关键选择、阶段变化与最终成长；每名关键配角都必须有独立作用，不能只是工具人。\n4. **分卷推进**：逐卷列出卷名、卷目标、主要阻力、核心转折、阶段钩子、爽点主类型（打脸/升级/得宝/揭秘/装逼/复仇/收女等）。每卷必须有独立爽点和明确追读钩子。\n5. **冲突升级**：按“个人 → 小团体/势力 → 世界/时代”逐级扩大对手、代价、影响范围与 stakes，说明每次升级由什么事件触发。\n6. **伏笔布局与回收清单**：列出伏笔编号、首次埋设位置、表层信息、真实指向、计划回收卷/节点、回收方式和当前状态；区分已埋、待推进、已回收。\n7. **结局方向**：说明最终对决、主线目标的达成方式、人物关系落点、世界状态变化、主要伏笔如何回收，以及是否保留续作空间。\n\n## 硬性要求\n\n- 每卷都要有独立爽点、阶段性成果和章末/卷末追读钩子。\n- 主线、人物动机、冲突升级和伏笔回收必须互相因果关联，不能各写各的。\n- 先给出总览，再按分卷展开；信息具体到可直接继续生成章纲。\n- 不擅自引入与作品设定冲突的新规则；未知信息标记为“待确认”。',
  },
  {
    id: 'builtin-outline-chapter', name: '小说章纲生成器', displayName: '番茄小说章纲生成器', category: 'setup',
    description: '默认根据上一章正文自动识别章节编号生成下一章章纲，控制在700字以内（含标点），并保证承接与钩子完整。', tags: ['章纲', '番茄', '爽点', '情绪闭环', '章末钩子'], rating: 5, usageCount: 0, builtin: true,
    content: '# 番茄小说章纲生成器 Skill\n\n## 技能说明\n\n适用于番茄系快节奏网文（都市高武、系统流、打脸爽文、灵气复苏等）。根据用户提供的情节信息，自动生成符合番茄爆款逻辑、事实完整、可直接执行的章纲。\n\n## 强制输出格式\n\n每章章纲必须包含以下模块，参考章纲只能借鉴叙事密度，不能替换栏目或字段。篇幅以内容完整和事实清晰为准，不设置固定字数上限，不得为了凑长度或压缩长度而截断场景、人物、伏笔和钩子。\n\n### 1. 章节标题\n\n格式：`# 章纲｜第X章 标题文字`\n\n### 2. 核心爽点类型（主+副）\n\n从以下类型中选择：打脸/升级/得宝/揭秘/装逼/复仇/收女/差异感/低调装逼/异性倾慕。\n\n### 3. 情绪曲线四段式\n\n| 阶段 | 内容 | 字数占比 |\n|------|------|---------|\n| 压抑 | 主角被嘲讽/压制/陷入困境 | 20% |\n| 爆发 | 主角反击/展现实力/打脸 | 50% |\n| 余韵 | 众人震惊/势力反应/装逼收尾 | 20% |\n| 新危机 | 更强敌人/新伏笔/新任务 | 10% |\n\n### 4. 场景划分（1-3个）\n\n每个场景写清地点、人物、目标、冲突、转折。需要更多场景时，以剧情完整为准，不得合并或截断关键场景。\n\n### 5. 人物功能分配\n\n每人独立作用，避免工具人。\n\n### 6. 信息揭示与伏笔\n\n至少 1 个新信息和 1 个可回收伏笔；伏笔必须标注“待揭示”。\n\n### 7. 爽点拆解\n\n必须包含至少两类爽点：差异感、低调装逼、异性倾慕、因果铺陈。\n\n### 8. 强章末钩子\n\n落在具体动作、对话或画面上，不写“欲知后事如何”。\n\n## 硬性要求\n\n1. 不设章纲固定字数上限，以模块完整、事实准确、可执行为第一优先级。\n2. 每章必须有释放点（情绪闭环）和追读钩子（悬念/反转/新危机/惊人之语）。\n3. 情绪占比通常为 20/50/20/10，爆发段占一半，但可按剧情需要调整。\n4. 人物动机不能与正文已有设定冲突。\n5. 伏笔必须标注“待揭示”，不提前暴露答案。\n6. 每章至少 1 个新信息和 1 个可回收伏笔。\n\n## 输出模板\n\n```markdown\n# 章纲｜第X章 标题\n\n## 核心爽点类型\n主：____\n副：____\n\n## 情绪曲线\n压抑：____（20%）\n爆发：____（50%）\n余韵：____（20%，本章释放点）\n新危机：____（10%）\n\n## 场景划分\n场景一：\n- 地点：____\n- 人物：____\n- 目标：____\n- 冲突：____\n- 转折：____\n\n## 人物功能\n**主角**：____\n**配角**：____\n\n## 信息揭示与伏笔\n新信息：____\n伏笔：____（待揭示）\n\n## 爽点拆解\n- 差异感：____\n- 低调装逼：____\n- 异性倾慕：____\n- 因果铺陈：____\n\n## 章末钩子\n（具体画面/对话/动作）\n```',
  },
  {
    id: 'builtin-outline-continuity', name: '章纲承接规范', displayName: '章纲承接规范', category: 'setup',
    description: '以紧邻上一章正文的结尾状态为唯一交接事实，规划下一章而不重复已发生事件。', tags: ['章纲承接', '上一章结尾', '连续性', '下一章'], rating: 5, usageCount: 0, builtin: true,
    content: '# 章纲承接规范\n\n## 适用范围\n\n仅用于“上一章正文 → 下一章章纲”。上一章正文及其最后一段是最高优先级事实；总纲、旧会话、旧章纲只能辅助，发生冲突时全部让位。\n\n## 交接清单\n\n生成前必须从上一章结尾确认：\n\n1. 人物位置、动作、伤势、情绪与彼此关系。\n2. 已发生事件及其不可撤销结果，禁止再次安排。\n3. 资源与数值：钱、物品、能力、伤势、任务进度和明确数字。\n4. 未解决行动、线索、风险、对手动向与章末钩子。\n5. 时间与场景：本章是否紧接、跳过多久、如何自然转场。\n\n## 规划规则\n\n- 本章第一项正文推进必须从交接清单的结果开始，不能退回到上一章已经结束的战斗、跟踪、交易或发现。\n- 要推进“上一章留下的后果”，而非重复“上一章的过程”。例如上一章发现被跟踪，本章应写应对、试探、反制或代价，不能再写首次发现跟踪。\n- 若发生时间或地点跳跃，章纲必须明确过渡原因、跳过内容与人物情绪余波。\n- 任何新增事件必须服务于上一章留下的目标、风险或钩子；未知信息标记为待揭示，不能倒推为既定事实。\n\n## 交付检查\n\n输出前逐项检查：本章是否重复上一章已发生事件；人物是否从上一章结尾合理移动；资源和数值是否前后一致；上一章钩子是否被承接或明确延后；本章结尾是否留下新的下一章交接点。',
  },
  {
    id: 'builtin-outline-world', name: 'world-setting-planner', displayName: '世界观与作品设定生成器', category: 'setup',
    description: '建立世界规则、力量体系、势力结构、地图和设定边界。', tags: ['世界观', '设定', '力量体系'], rating: 5, usageCount: 0, builtin: true,
    content: '# 世界观与作品设定生成器\n\n仅在创建世界规则文件时使用一次：输出时代背景、世界规则、力量/职业体系、资源与代价、势力结构、地理地图、社会秩序、关键名词和设定边界。创建完成后，该文件是作者确认的固定规则，后续章节、大纲、卡片和知识图谱只可引用，不自动梳理、改写、补全或推断其中的内容变化。\n\n所有未确定内容在首次创建时标记为“待作者确认”；作者确认保存后视为固定设定。若正文与世界规则冲突，标记冲突并交给作者手动修改世界规则文件，不自动覆盖。',
  },
  {
    id: 'builtin-story-setup', name: 'story-setup', category: 'setup',
    description: '搭建小说写作工程，检查章节、大纲、卡片与记忆目录。',
    tags: ['项目初始化', '目录', '工作流'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-setup\n\n先检查本地小说目录、元数据、章节、大纲、卡片和记忆中心，再补齐缺失结构；保留已有内容，采用合并更新。',
  },
  {
    id: 'builtin-story-long-write', name: 'story-long-write', category: 'write',
    description: '从选题、世界观和人物，到大纲、细纲与章节正文的长篇写作流程。',
    tags: ['长篇', '大纲', '续写'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-long-write\n\n先确定读者情绪与题材，再建立总纲、细纲、角色卡和伏笔表；每章只加载必要记忆，完成正文、章末钩子和下一章承接。',
  },
  {
    id: 'builtin-chapter-continuity', name: 'chapter-continuity', category: 'write',
    description: '在新章节开始前提取上一章结尾，确保人物、情绪、事件、道具、时间线和钩子连续。',
    tags: ['章节承接', '上一章结尾', '连续性', '悬念'], rating: 5, usageCount: 0, builtin: true,
    content: `# chapter-continuity

## 核心目标
确保本章与上一章在人物、情节、情绪、设定四个维度无缝衔接。上一章结尾是本章开头的最高优先级资料。

## 承接步骤
1. 读取上一章最后 1800 字和该章记忆中的摘要、章末钩子。
2. 明确上一章结束时每个人物的位置、动作和情绪；本章开头必须给出合理延续。
3. 找出未完成的对话、决定、行动、目的地、道具和线索，在本章开头承接或交代转移。
4. 检查时间间隔、场景变化和伏笔状态；有跳跃时用一句到一段过渡交代因果。
5. 判断承接强度：危机/对话未完用强承接，数小时到一天用中承接，数天以上用弱承接并保留情绪余波。
6. 用上一章的一个细节、物品、话语余音或身体感受作为锚点；不要把上一章结尾的钩子直接丢掉。

## 输出约束
先在内部形成“位置、情绪、未解决事件、道具线索、时间线、伏笔、章节钩子”七项承接清单，再写正文。正文第一段自然承接，不要复述清单或解释写作过程。

## 禁止
上一章在冲突中，本章无过渡直接跳到平静日常；忽略上一章钩子和伏笔；人物从 A 地愤怒地跳到 B 地平静而没有原因。`,
  },
  {
    id: 'builtin-story-review', name: 'story-review', category: 'review',
    description: '从结构、人物、设定、节奏和文字自然度多视角审查章节。',
    tags: ['审查', '一致性', '修改建议'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-review\n\n输出问题清单、证据位置、严重程度和可执行修改建议；优先检查人物状态、时间线、伏笔回收和读者契约。',
  },
  {
    id: 'builtin-story-deslop', name: 'story-deslop', category: 'polish',
    description: '降低模板化、过度工整和解释腔，让网文正文更自然。',
    tags: ['去 AI 味', '润色', '保留剧情'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-deslop\n\n少改多保留：删除重复解释，增加具体动作、停顿和口语感；保留伏笔、钩子、角色特征和情节因果。',
  },
  {
    id: 'builtin-story-import', name: 'story-import', category: 'import',
    description: '把已有小说反向解析为可继续写作的本地项目工程。',
    tags: ['导入', '拆解', '续写'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-import\n\n读取已有 Markdown 或文本，提取章节、人物、设定、时间线和伏笔，生成标准本地目录；原文和分析结果均保留。',
  },
  {
    id: 'builtin-story-long-analyze', name: 'story-long-analyze', category: 'analyze',
    description: '深度拆解长篇小说的黄金开篇、人设架构、爽点与节奏。',
    tags: ['拆书', '市场分析', '结构'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-long-analyze\n\n按黄金开篇、人物关系、剧情推进、爽点密度、冲突升级和设定资产输出结构化分析。',
  },
  {
    id: 'builtin-story-long-scan', name: 'story-long-scan', category: 'analyze',
    description: '分析起点、番茄、晋江等平台榜单中的题材与读者趋势。',
    tags: ['扫榜', '题材', '趋势'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-long-scan\n\n跨平台比较样本，提炼重复出现的题材、设定、书名词和开篇卖点，输出可验证的选题候选。',
  },
  {
    id: 'builtin-story-short-write', name: 'story-short-write', category: 'write',
    description: '面向短篇小说的选题、结构、节奏和正文写作流程。',
    tags: ['短篇', '结构', '正文'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-short-write\n\n先确定单一核心冲突和结局，再压缩人物与场景数量，按开端、升级、转折、收束完成短篇正文。',
  },
  {
    id: 'builtin-story-short-analyze', name: 'story-short-analyze', category: 'analyze',
    description: '拆解短篇小说的冲突密度、反转、情绪曲线和结尾回收。',
    tags: ['短篇', '拆解', '反转'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-short-analyze\n\n提取核心冲突、人物目标、关键转折、情绪节点和结尾回收，输出可迁移的结构卡片。',
  },
  {
    id: 'builtin-story-short-scan', name: 'story-short-scan', category: 'analyze',
    description: '分析短篇平台的热门题材、标题、开篇钩子和结尾模式。',
    tags: ['短篇', '扫榜', '选题'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-short-scan\n\n从多个样本中提炼重复的标题结构、开篇承诺、情绪卖点和结尾机制，形成选题候选。',
  },
  {
    id: 'builtin-story-cover', name: 'story-cover', category: 'tool',
    description: '根据书名、作者名和题材生成小说封面提示词与制作方案。',
    tags: ['封面', '视觉', '题材风格'], rating: 5, usageCount: 0, builtin: true,
    content: '# story-cover\n\n读取书名、作者名、频道和题材，生成封面构图、色彩、主体、字体层级和平台尺寸方案。',
  },
  {
    id: 'builtin-browser-cdp', name: 'browser-cdp', category: 'tool',
    description: '通过浏览器 CDP 复用登录态，采集榜单与公开资料。',
    tags: ['浏览器', '榜单', '采集'], rating: 5, usageCount: 0, builtin: true,
    content: '# browser-cdp\n\n仅在用户明确启动浏览器采集时使用；先检测 CDP 状态，再导航、等待、提取页面数据并保存来源。',
  },
  {
    id: 'builtin-skill-creator', name: 'skill-creator', category: 'creator',
    description: '把一句创作需求整理为可复用的技能名称、触发词、步骤和输出契约。',
    tags: ['自创建', '技能模板', '提示词'], rating: 5, usageCount: 0, builtin: true,
    content: '# skill-creator\n\n输入目标、适用场景、触发词、输入字段、执行步骤和输出格式，生成一份可复用 Markdown 技能；保存前检查名称、边界和失败处理。',
  },
  {
    id: 'builtin-baidu-drive', name: 'baidu-drive', displayName: '百度网盘备份与同步', category: 'tool',
    description: '使用 bdpan CLI 备份、恢复和检查本地小说目录，远端范围固定在 /apps/bdpan/。',
    tags: ['百度网盘', '备份', '同步', '恢复'], rating: 5, usageCount: 0, builtin: true,
    content: '# 百度网盘备份与同步\n\n## 适用场景\n作者明确要求备份小说、恢复小说、同步本地项目或检查百度网盘登录状态时使用。\n\n## 操作规范\n1. 只操作应用自己的 `/apps/bdpan/ApiSaverWriter/` 目录，不访问其他云端路径。\n2. 备份前先保存本地小说目录，再上传 `projects` 文件夹；不要删除云端文件。\n3. 恢复前明确提示会覆盖同名本地文件；下载后合并到本地 `projects` 目录并重新加载。\n4. 未登录或 CLI 不存在时，返回登录/安装提示，不伪造成功。\n5. 不读取、输出或记录 access token、密码等凭据。\n\n## 输出格式\n报告操作、远端目录、文件数量或 CLI 返回结果；失败时保留原始错误和下一步处理建议。',
  },
];

// Keep the English names as stable routing keys while presenting every built-in
// skill in Chinese throughout the application.
const builtinSkillDisplayNames: Record<string, string> = {
  'natural-fiction-writing': '自然人感小说写作',
  'writing-framework': '长篇小说写作框架',
  'fanqie-writing': '番茄爆款写作',
  'qidian-writing': '起点精品写作',
  'novel-improver': '小说质量改良',
  'strategy-writing': '智斗与博弈写作',
  'outline-total-planner': '小说总纲生成器',
  '小说章纲生成器': '小说章纲生成器',
  '章纲承接规范': '章纲承接规范',
  'world-setting-planner': '世界观与作品设定生成器',
  'next-chapter-plan': '下一章计划',
  'mainline-check': '主线检查',
  'character-motivation': '人物动机',
  'conflict-escalation': '冲突升级',
  'foreshadowing-manager': '伏笔管理',
  'ending-hook': '结尾钩子',
  'pacing-check': '节奏检查',
  'prose-output-protocol': '正文输出协议',
  'suspense-design': '悬念设计',
  'character-entrance': '人物出场',
  'worldview-implant': '世界观植入',
  'setting-consistency': '设定一致性',
  'faction-structure': '势力结构',
  'map-progression': '地图推进',
  'scene-description': '场景描写',
  'dialogue-design': '对话设计',
  transition: '转场过渡',
  'emotion-rendering': '情绪渲染',
  'story-setup': '项目初始化',
  'story-long-write': '长篇写作',
  'chapter-continuity': '章节承接',
  'story-review': '故事审查',
  'story-deslop': '去 AI 味',
  'story-import': '小说导入',
  'story-long-analyze': '长篇拆解',
  'story-long-scan': '长篇扫榜',
  'story-short-write': '短篇写作',
  'story-short-analyze': '短篇拆解',
  'story-short-scan': '短篇扫榜',
  'story-cover': '小说封面',
  'browser-cdp': '浏览器采集',
  'skill-creator': '技能创建器',
  'baidu-drive': '百度网盘备份与同步',
};

export const builtinSkills: Skill[] = builtinSkillDefinitions.map(skill => ({
  ...skill,
  displayName: builtinSkillDisplayNames[skill.name] || skill.displayName || skill.name,
  // The first Markdown heading is also user-visible in the skill editor.
  content: skill.content.replace(new RegExp(`^#\\s*${skill.name}\\b`, 'm'), `# ${builtinSkillDisplayNames[skill.name] || skill.displayName || skill.name}`),
}));
