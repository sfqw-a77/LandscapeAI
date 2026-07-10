/**
 * Prompt 组装模块
 * 负责：System Prompt / 规范知识库 / User Prompt 的组装，以及 AI 响应的校验
 */

// 9 个核心指标的固定顺序
const EXPECTED_ORDER = [
  '消防',
  '无障碍',
  '绿地率',
  '停车位',
  '台阶及坡度',
  '水深',
  '覆土',
  '竖向与排水',
  '种植设计',
];

// 合法的状态值
const VALID_STATUSES = ['不合规', '警告', '通过', '信息不足'];

// summary 必须包含的字段
const REQUIRED_SUMMARY_FIELDS = [
  'total_issues',
  'non_compliant',
  'warnings',
  'passed',
  'insufficient',
  'overall_assessment',
];

// ============================================================
// 项目类型配置：关键词 + 类型相关审查标准
// ============================================================
const PROJECT_TYPE_PROFILES = {
  住宅: {
    keywords: ['住宅', '小区', '居住', '住户', '户型', '宅', '居民', '业主', '商品房', '保障房', '别墅', '洋房', '高层住宅', '多层住宅'],
    greeneryRate: '≥30%（GB 50180-2018）',
    parkingRatio: '≥1.0车位/户（地方标准通常要求1:1）',
    specialNotes: '居住区应重点关注儿童/老人活动场地安全、宅间道路宽度、底层住户采光',
  },
  商业: {
    keywords: ['商业', '商场', '购物', '零售', '店铺', '商铺', '综合体', '步行街', '购物中心', '商业街'],
    greeneryRate: '≥20%（地方标准通常要求≥20%）',
    parkingRatio: '≥0.8车位/100㎡建筑面积',
    specialNotes: '商业项目应重点关注人流疏散通道、货车流线、外摆区域安全',
  },
  公园: {
    keywords: ['公园', '绿地', '游园', '园', '景观', '广场', '湿地', '植物园', '森林公园'],
    greeneryRate: '≥65%（GB 51192-2016）',
    parkingRatio: '按游人容量计算，≥1车位/100人',
    specialNotes: '公园应重点关注水域安全（水深）、儿童活动区、无障碍游线、植物毒性',
  },
  学校: {
    keywords: ['学校', '校园', '小学', '中学', '大学', '幼儿园', '校区', '教学楼', '操场', '教育'],
    greeneryRate: '≥35%（地方标准通常要求≥35%）',
    parkingRatio: '≥1车位/100学生',
    specialNotes: '学校应重点关注学生疏散通道、运动场地安全、植物毒性（有毒有刺植物禁用）',
  },
  办公: {
    keywords: ['办公', '写字楼', '总部', '产业园', '科技园', '办公区', '企业', '研发'],
    greeneryRate: '≥25%（地方标准通常要求≥25%）',
    parkingRatio: '≥0.7车位/100㎡建筑面积',
    specialNotes: '办公项目应重点关注机动车流线、消防回车场、员工休闲区安全',
  },
  滨水: {
    keywords: ['滨水', '河', '湖', '江', '水岸', '驳岸', '堤', '水景', ' waterfront', '水边'],
    greeneryRate: '≥40%（地方标准通常要求≥40%）',
    parkingRatio: '按游人容量计算',
    specialNotes: '滨水项目应重点关注水域安全（水深/护栏）、防洪退让、驳岸稳定、潮汐影响',
  },
};

/**
 * 校验项目类型与方案描述是否匹配
 * @param {string} projectType - 项目类型
 * @param {string} description - 方案描述
 * @returns {{matched: boolean, matchedKeywords: string[], allKeywords: string[]}}
 */
function validateProjectType(projectType, description) {
  const profile = PROJECT_TYPE_PROFILES[projectType];
  if (!profile) {
    return { matched: true, matchedKeywords: [], reason: '未知类型，跳过校验' };
  }

  const matchedKeywords = profile.keywords.filter((kw) => description.includes(kw));
  return {
    matched: matchedKeywords.length > 0,
    matchedKeywords,
    allKeywords: profile.keywords,
  };
}

/**
 * 构建系统提示词（System Prompt）
 * 包含：角色设定、任务描述、输出约束、审查判断标准、项目类型审查标准、JSON 输出结构
 * @param {string} [projectType] - 项目类型（可选，注入类型相关审查标准）
 * @returns {string} 系统提示词
 */
function buildSystemPrompt(projectType) {
  // 如果有项目类型，注入类型相关的审查标准
  let typeProfileText = '';
  if (projectType && PROJECT_TYPE_PROFILES[projectType]) {
    const profile = PROJECT_TYPE_PROFILES[projectType];
    typeProfileText = `

##项目类型审查标准（${projectType}）
当前项目类型为「${projectType}」，请按以下类型相关标准审查：
- 绿地率要求：${profile.greeneryRate}
- 停车位配比：${profile.parkingRatio}
- 特别关注：${profile.specialNotes}
- 注意：不同项目类型的绿地率/停车位标准不同，请严格按上述标准判断`;
  }

  return `##角色设定
你是一名拥有 15 年经验的景观设计规范审查专家，精通中国景观行业现行规范标准，尤其擅长居住区、商业、公园、学校、办公项目的景观方案规范审查。

##任务描述
针对用户输入的项目类型和方案描述，逐项审查 9 个核心指标（消防/无障碍/绿地率/停车位/台阶及坡度/水深/覆土/竖向与排水/种植设计），对照知识库中的规范条文，检查方案中是否存在不合规、遗漏或不明确的问题。
${typeProfileText}

##输出约束
1. 必须按指定 JSON 结构输出，包含 summary 和 results 两部分
2. 9 个指标按固定顺序排列：消防 → 无障碍 → 绿地率 → 停车位 → 台阶及坡度 → 水深 → 覆土 → 竖向与排水 → 种植设计
3. 每个指标的问题按严重程度排序：不合规在前，警告在后
4. 如未查询到规范，不得编造回答，必须返回 status=信息不足 + missing_info 说明缺什么
5. 如方案中某指标符合规范，返回 status=通过 + issues 为空数组
6. 规范引用必须包含规范名称和条款号，如"GB 50016-2014(2018版) 第7.1.8条"
7. 只返回JSON，不要包含markdown代码块标记或任何解释性文字

##审查判断标准
- 不合规：方案中的数值明确违反规范要求（如消防车道3.5m < 要求4.0m）
- 警告：方案数值等于规范限值或接近限值（如坡度1:12等于限值），建议优化
- 通过：方案中的数值符合规范要求且有余量
- 信息不足：方案中未提及该指标相关信息，无法判断

##JSON 输出结构
{
  "summary": {
    "total_issues": number,
    "non_compliant": number,
    "warnings": number,
    "passed": number,
    "insufficient": number,
    "overall_assessment": string
  },
  "results": [
    {
      "indicator": string,
      "status": string,
      "standard_ref": string,
      "issues": [
        {
          "severity": string,
          "description": string,
          "current_value": string,
          "required_value": string,
          "suggestion": string,
          "clause": string
        }
      ]
    }
  ]
}`;
}

/**
 * 构建规范知识库注入提示词（MVP 全量注入模式）
 * @param {string} projectType - 项目类型（如"住宅"）
 * @param {string} standardsJSON - 知识库 JSON 字符串
 * @returns {string} 知识库提示词
 */
function buildKnowledgePrompt(projectType, standardsJSON) {
  return `##规范知识库
以下是${projectType}项目相关的规范条文，请严格对照审查：

${standardsJSON}`;
}

/**
 * 构建 RAG 检索结果注入提示词
 * 将检索到的条文按指标分组，格式化为可读文本（比 JSON 更省 Token）
 * @param {string} projectType - 项目类型
 * @param {Array} retrievedClauses - 检索到的条文数组
 * @param {number} totalCount - 知识库总条数
 * @returns {string} RAG 知识库提示词
 */
function buildRAGKnowledgePrompt(projectType, retrievedClauses, totalCount) {
  // 按指标分组
  const groups = {};
  for (const clause of retrievedClauses) {
    if (!groups[clause.indicator]) groups[clause.indicator] = [];
    groups[clause.indicator].push(clause);
  }

  // 格式化为可读文本
  let text = `##规范知识库（RAG 检索结果）
以下是通过语义检索从 ${totalCount} 条规范中找到的与本方案最相关的 ${retrievedClauses.length} 条条文，请严格对照审查：\n`;

  for (const indicator of EXPECTED_ORDER) {
    const clauses = groups[indicator];
    if (!clauses || clauses.length === 0) continue;
    text += `\n### ${indicator}\n`;
    clauses.forEach((c, i) => {
      text += `${i + 1}. [${c.standard_code} ${c.clause_number}] ${c.content}\n`;
      text += `   审查要点：${c.review_point}\n`;
    });
  }

  text += `\n注：以上为检索结果，如某指标未出现在列表中，说明知识库中暂无与方案描述高度相关的条文，请返回 status=信息不足 并在 missing_info 中说明。`;
  return text;
}

/**
 * 构建用户提示词（User Prompt）
 * @param {string} projectType - 项目类型
 * @param {string} description - 方案描述
 * @returns {string} 用户提示词
 */
function buildUserPrompt(projectType, description) {
  return `##项目类型
${projectType}

##方案描述
${description}

请对照规范知识库，逐项审查上述方案描述中的7个核心指标，按指定JSON结构输出审查结果。只返回JSON，不要包含其他内容。`;
}

/**
 * 组装完整的 messages 数组（供 AI API 调用使用）
 * System Prompt 中已合并知识库内容
 * @param {string} projectType - 项目类型
 * @param {string} description - 方案描述
 * @param {string} standardsJSON - 知识库 JSON 字符串
 * @returns {Array<{role: string, content: string}>} messages 数组
 */
function buildMessages(projectType, description, standardsJSON) {
  const systemPrompt = buildSystemPrompt();
  const knowledgePrompt = buildKnowledgePrompt(projectType, standardsJSON);
  const userPrompt = buildUserPrompt(projectType, description);

  // System Prompt 与知识库合并为同一条 system 消息
  return [
    { role: 'system', content: systemPrompt + '\n\n' + knowledgePrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 组装 RAG 模式的 messages 数组
 * 使用检索到的条文替代全量知识库
 * @param {string} projectType - 项目类型
 * @param {string} description - 方案描述
 * @param {Array} retrievedClauses - 检索到的条文数组
 * @param {number} totalCount - 知识库总条数
 * @returns {Array<{role: string, content: string}>} messages 数组
 */
function buildMessagesWithRAG(projectType, description, retrievedClauses, totalCount) {
  const systemPrompt = buildSystemPrompt(projectType);
  const knowledgePrompt = buildRAGKnowledgePrompt(projectType, retrievedClauses, totalCount);
  const userPrompt = buildUserPrompt(projectType, description);

  return [
    { role: 'system', content: systemPrompt + '\n\n' + knowledgePrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 从 AI 返回的文本中提取 JSON
 * 处理可能包含 ```json 代码块标记的情况
 * @param {string} content - AI 返回的原始文本
 * @returns {object} 解析后的 JSON 对象
 * @throws {Error} 当 JSON 解析失败时抛出
 */
function extractJSON(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('AI 返回内容为空或非字符串');
  }

  let text = content.trim();

  // 去除可能存在的 markdown 代码块标记
  // 匹配 ```json ... ``` 或 ``` ... ``` 形式
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  // 再次去除可能残留的标记字符
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '').trim();

  // 尝试提取第一个 { 到最后一个 } 之间的内容（应对前后有杂乱文字的情况）
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  // 清理 JSON 中未转义的控制字符（AI 常在文本中输出裸换行符/制表符）
  // JSON 规范禁止字符串值内出现 0x00-0x1F 的裸控制字符，全部替换为空格
  // 注意：合法的 \n \t 转义序列是两个字符（\ + n），不受此替换影响
  text = text.replace(/[\x00-\x1F]/g, ' ');

  return JSON.parse(text);
}

/**
 * 校验 AI 返回的 JSON 结构是否符合规范
 * 校验内容：顶层结构、summary 字段、results 顺序与状态、summary 数量一致性
 * @param {object} data - AI 返回并解析后的对象
 * @returns {{valid: boolean, error: string|null}} 校验结果
 */
function validateAIResponse(data) {
  // 1. 顶层结构校验
  if (!data || typeof data !== 'object') {
    return { valid: false, error: '返回数据不是有效对象' };
  }
  if (!data.summary || !data.results) {
    return { valid: false, error: '缺少 summary 或 results 字段' };
  }
  if (!Array.isArray(data.results) || data.results.length !== EXPECTED_ORDER.length) {
    return { valid: false, error: `results 应为包含 ${EXPECTED_ORDER.length} 个指标的数组，实际 ${Array.isArray(data.results) ? data.results.length : '非数组'}` };
  }

  // 2. summary 字段校验
  for (const field of REQUIRED_SUMMARY_FIELDS) {
    if (data.summary[field] === undefined) {
      return { valid: false, error: `summary 缺少字段：${field}` };
    }
  }

  // 3. results 每项结构校验（含固定顺序）
  for (let i = 0; i < EXPECTED_ORDER.length; i++) {
    const item = data.results[i];
    if (!item || typeof item !== 'object') {
      return { valid: false, error: `第 ${i + 1} 个指标数据无效` };
    }
    if (!item.indicator || item.indicator !== EXPECTED_ORDER[i]) {
      return { valid: false, error: `第 ${i + 1} 个指标应为「${EXPECTED_ORDER[i]}」，实际为「${item.indicator || '空'}」` };
    }
    if (!VALID_STATUSES.includes(item.status)) {
      return { valid: false, error: `指标「${item.indicator}」状态非法：${item.status}` };
    }
    if (!item.standard_ref) {
      // standard_ref 为空时自动补全，不报错
      if (item.status === '信息不足') {
        item.standard_ref = '无（知识库中暂无相关条文）';
      } else {
        item.standard_ref = '见规范知识库相关条文';
      }
    }
    if (!Array.isArray(item.issues)) {
      return { valid: false, error: `指标「${item.indicator}」的 issues 不是数组` };
    }

    // 校验 issues 中每项的必要字段
    for (const issue of item.issues) {
      if (!issue.severity || !issue.description || !issue.suggestion) {
        return { valid: false, error: `指标「${item.indicator}」存在不完整的 issue（缺少 severity/description/suggestion）` };
      }
    }
  }

  // 4. summary 数量自动纠正（AI 经常计错数，用实际结果重算）
  let nonCompliant = 0;
  let warnings = 0;
  let passed = 0;
  let insufficient = 0;
  let issueCount = 0;

  data.results.forEach((item) => {
    if (item.status === '不合规') nonCompliant++;
    else if (item.status === '警告') warnings++;
    else if (item.status === '通过') passed++;
    else if (item.status === '信息不足') insufficient++;
    issueCount += Array.isArray(item.issues) ? item.issues.length : 0;
  });

  // 检测是否有计数不一致
  const mismatches = [];
  if (data.summary.non_compliant !== nonCompliant) mismatches.push(`non_compliant: ${data.summary.non_compliant}→${nonCompliant}`);
  if (data.summary.warnings !== warnings) mismatches.push(`warnings: ${data.summary.warnings}→${warnings}`);
  if (data.summary.passed !== passed) mismatches.push(`passed: ${data.summary.passed}→${passed}`);
  if (data.summary.insufficient !== insufficient) mismatches.push(`insufficient: ${data.summary.insufficient}→${insufficient}`);
  if (data.summary.total_issues !== issueCount) mismatches.push(`total_issues: ${data.summary.total_issues}→${issueCount}`);

  // 如果有计数不一致，自动纠正（而非报错失败）
  if (mismatches.length > 0) {
    console.log(`[校验] AI summary 计数有误，已自动纠正: ${mismatches.join(', ')}`);
    data.summary.non_compliant = nonCompliant;
    data.summary.warnings = warnings;
    data.summary.passed = passed;
    data.summary.insufficient = insufficient;
    data.summary.total_issues = issueCount;
  }

  return { valid: true, error: null };
}

module.exports = {
  EXPECTED_ORDER,
  VALID_STATUSES,
  PROJECT_TYPE_PROFILES,
  buildSystemPrompt,
  buildKnowledgePrompt,
  buildRAGKnowledgePrompt,
  buildUserPrompt,
  buildMessages,
  buildMessagesWithRAG,
  extractJSON,
  validateAIResponse,
  validateProjectType,
};
