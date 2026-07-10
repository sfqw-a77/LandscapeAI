/**
 * LandscapeAI 景观设计规范审查后端服务（V1.1 RAG 版）
 *
 * 功能：
 * 1. 静态文件服务 —— 提供 ../4.原型/ 目录下的原型页面访问
 * 2. POST /api/review —— RAG 检索 + AI 规范审查
 * 3. GET /api/health —— 健康检查（含 RAG 状态）
 * 4. GET /api/rag/status —— RAG 服务状态
 *
 * 运行：npm start（需先 npm install）
 */

// 加载 .env 环境变量
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const {
  buildMessages,
  buildMessagesWithRAG,
  extractJSON,
  validateAIResponse,
  validateProjectType,
} = require('./promptBuilder');
const embeddingService = require('./embeddingService');
const retrievalService = require('./retrievalService');

const app = express();
const PORT = process.env.PORT || 3001;

// AI API 请求超时时间（毫秒）—— agnes-2.0-flash 完整审查约 15-30s，预留充足余量
const AI_TIMEOUT_MS = 120000;
// AI 调用最大尝试次数（初次 + 重试）
const MAX_ATTEMPTS = 2;
// 最大输出 token 数（agnes-2.0-flash 为推理模型，需预留 reasoning tokens，故设为 8000）
const AI_MAX_TOKENS = 8000;
// RAG 检索返回的条文数量（9 指标 × ~3-4 条/指标 ≈ 30）
const RAG_TOP_K = 30;

// ============================================================
// 中间件
// ============================================================

// CORS 允许所有来源
app.use(cors());

// 解析 JSON 请求体
app.use(express.json({ limit: '2mb' }));

// 请求日志（简单记录）
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ============================================================
// 路径常量
// ============================================================

// 当前文件位于 src/server.js，原型目录在 ../../4.原型/
const PROTOTYPE_DIR = path.join(__dirname, '..', 'public');
// 知识库目录位于 ../knowledge/
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

// 项目类型到知识库文件的映射（后续可扩展更多类型）
const KNOWLEDGE_FILES = {
  住宅: 'standards-residential.json',
};

// ============================================================
// 静态文件服务：提供原型页面访问
// 访问 http://localhost:3001/prototype.html 即可查看原型
// ============================================================
app.use(express.static(PROTOTYPE_DIR));

// ============================================================
// 工具函数
// ============================================================

/**
 * 根据项目类型加载知识库
 * @param {string} projectType - 项目类型（如"住宅"）
 * @returns {Array} 知识库条文数组
 * @throws {Error} 当项目类型不支持或文件不存在时抛出
 */
function loadKnowledge(projectType) {
  const fileName = KNOWLEDGE_FILES[projectType];
  if (!fileName) {
    throw new Error(
      `暂不支持「${projectType}」类型项目，目前仅支持：${Object.keys(KNOWLEDGE_FILES).join('、')}`
    );
  }
  const filePath = path.join(KNOWLEDGE_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`知识库文件不存在：${fileName}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`知识库文件 JSON 解析失败：${fileName}`);
  }
}

/**
 * 调用 DeepSeek AI API（兼容 OpenAI 格式）
 * @param {Array<{role: string, content: string}>} messages - 消息数组
 * @returns {Promise<object>} AI 返回的完整响应
 * @throws {Error} 当配置缺失、超时、或 API 返回错误时抛出
 */
async function callAgnesAPI(messages) {
  const apiKey = process.env.AGNES_API_KEY;
  const baseUrl = process.env.AGNES_BASE_URL;
  const model = process.env.AGNES_MODEL;

  if (!apiKey || !baseUrl || !model) {
    throw new Error(
      'AI 服务配置不完整，请检查 .env 文件中的 AGNES_API_KEY / AGNES_BASE_URL / AGNES_MODEL'
    );
  }

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages,
    temperature: 0.3,
    max_tokens: AI_MAX_TOKENS,
  };

  // 使用 AbortController 实现 120s 超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`AI API 返回错误 ${response.status}: ${errText.slice(0, 500)}`);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    // 超时（AbortError）
    if (err.name === 'AbortError') {
      throw new Error(`AI API 请求超时（${AI_TIMEOUT_MS / 1000}s）`);
    }
    // 网络错误等
    throw new Error(`AI API 请求失败: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 从 AI 响应中提取并校验结果
 * @param {object} aiData - AI 返回的完整响应
 * @returns {object} 校验通过的审查结果
 * @throws {Error} 当内容为空、JSON 解析失败或格式校验失败时抛出
 */
function parseAndValidate(aiData) {
  const choice = aiData?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;
  if (!content) {
    // content 为空时，根据 finish_reason 给出更明确的提示
    if (finishReason === 'length') {
      throw new Error(
        'AI 返回内容为空，可能因 max_tokens 不足被截断（finish_reason=length），请增大 AI_MAX_TOKENS'
      );
    }
    throw new Error('AI 返回内容为空（choices[0].message.content 缺失）');
  }

  // 提取并清理 JSON（处理 ```json 标记等情况）
  let parsed;
  try {
    parsed = extractJSON(content);
  } catch (err) {
    throw new Error(`AI 返回内容 JSON 解析失败: ${err.message}`);
  }

  // 校验 JSON 结构
  const { valid, error } = validateAIResponse(parsed);
  if (!valid) {
    throw new Error(`AI 响应格式校验失败: ${error}`);
  }

  return parsed;
}

/**
 * 统一错误响应构造
 * @param {*} res - Express 响应对象
 * @param {number} status - HTTP 状态码
 * @param {string} message - 错误信息
 */
function sendError(res, status, message) {
  return res.status(status).json({ error: true, message });
}

// ============================================================
// API 接口
// ============================================================

/**
 * 健康检查接口（含 RAG 状态）
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    model: process.env.AGNES_MODEL || '未配置',
    rag: {
      enabled: true,
      ready: embeddingService.isReady(),
      clauseCount: embeddingService.getKnowledgeBase().length,
      topK: RAG_TOP_K,
    },
  });
});

/**
 * GET /api/rag/status —— RAG 服务状态
 */
app.get('/api/rag/status', (_req, res) => {
  const ready = embeddingService.isReady();
  const kb = embeddingService.getKnowledgeBase();
  const embeddings = embeddingService.getEmbeddings();
  res.json({
    ready,
    knowledgeBaseSize: kb.length,
    embeddingsCount: embeddings.length,
    topK: RAG_TOP_K,
    model: 'Xenova/multilingual-e5-small',
    dimensions: 384,
  });
});

/**
 * POST /api/review —— 规范审查接口（RAG 模式）
 *
 * 流程：参数校验 → RAG 检索 → Prompt 组装 → AI 审查 → 返回结果
 *
 * 请求体：{ projectType: string, description: string }
 * 响应体：{ error: false, data: {...审查结果}, rag: {...检索信息} }
 *        或 { error: true, message: string }
 */
app.post('/api/review', async (req, res) => {
  try {
    const { projectType, description, forceReview } = req.body || {};

    // ---- 参数校验 ----
    if (!projectType || typeof projectType !== 'string') {
      return sendError(res, 400, '缺少必要参数 projectType（项目类型）');
    }
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return sendError(res, 400, '缺少必要参数 description（方案描述）');
    }

    // ---- 类型-描述匹配校验（用户可强制跳过）----
    if (!forceReview) {
      const typeCheck = validateProjectType(projectType, description);
      if (!typeCheck.matched) {
        console.log(`[审查] 类型不匹配: 选择了「${projectType}」，但描述中未检测到相关关键词`);
        return res.json({
          error: false,
          typeWarning: {
            matched: false,
            projectType,
            message: `您选择了「${projectType}」类型，但方案描述中未检测到与${projectType}相关的关键词（如：${typeCheck.allKeywords.slice(0, 5).join('、')}等）。请确认类型选择是否正确，或补充方案描述中的项目类型信息。`,
            suggestedKeywords: typeCheck.allKeywords.slice(0, 8),
          },
        });
      }
      console.log(`[审查] 类型匹配通过: 「${projectType}」命中关键词 ${typeCheck.matchedKeywords.join('、')}`);
    } else {
      console.log('[审查] 用户强制跳过类型校验，直接审查');
    }

    // ---- RAG 就绪检查 ----
    if (!embeddingService.isReady()) {
      return sendError(res, 503, 'RAG 服务尚未就绪，请稍后重试');
    }

    // ---- RAG 检索 ----
    console.log('[审查] 开始 RAG 检索...');
    const retrievalStart = Date.now();
    const queryEmbedding = await embeddingService.embedQuery(description);
    const clauseEmbeddings = embeddingService.getEmbeddings();
    const knowledgeBase = embeddingService.getKnowledgeBase();
    const retrievedClauses = retrievalService.retrieve(
      queryEmbedding,
      clauseEmbeddings,
      knowledgeBase,
      RAG_TOP_K
    );
    const retrievalElapsed = Date.now() - retrievalStart;

    const ragSummary = retrievalService.getRetrievalSummary(retrievedClauses);
    console.log(`[审查] RAG 检索完成 (${retrievalElapsed}ms) | 命中 ${ragSummary.totalRetrieved} 条 | 覆盖 ${ragSummary.indicatorsCovered} 指标 | ${ragSummary.distribution} | 平均相似度 ${ragSummary.avgSimilarity}`);

    // ---- 组装 Prompt（RAG 模式）----
    const messages = buildMessagesWithRAG(
      projectType,
      description,
      retrievedClauses,
      knowledgeBase.length
    );

    // ---- 调用 AI（含重试机制：初次 + 1 次重试）----
    let lastError = null;
    let result = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`[审查] 第 ${attempt}/${MAX_ATTEMPTS} 次调用 AI...`);
        const aiData = await callAgnesAPI(messages);
        result = parseAndValidate(aiData);
        console.log(`[审查] 第 ${attempt} 次调用成功，校验通过`);
        break; // 成功则跳出重试循环
      } catch (err) {
        lastError = err;
        console.error(`[审查] 第 ${attempt} 次调用失败: ${err.message}`);
        if (attempt < MAX_ATTEMPTS) {
          console.log('[审查] 准备重试...');
        }
      }
    }

    // ---- 所有尝试均失败 ----
    if (!result) {
      return sendError(
        res,
        502,
        `AI 审查失败，已重试 ${MAX_ATTEMPTS} 次。最后错误：${lastError?.message || '未知错误'}`
      );
    }

    // ---- 返回成功结果（含 RAG 检索信息）----
    return res.json({
      error: false,
      data: result,
      rag: {
        retrievedClauses: retrievedClauses.map((c) => ({
          id: c.id,
          score: parseFloat(c.score.toFixed(4)),
          indicator: c.indicator,
          standard_name: c.standard_name,
          standard_code: c.standard_code,
          clause_number: c.clause_number,
          content: c.content,
        })),
        summary: {
          totalRetrieved: ragSummary.totalRetrieved,
          indicatorsCovered: ragSummary.indicatorsCovered,
          distribution: ragSummary.distribution,
          avgSimilarity: parseFloat(ragSummary.avgSimilarity),
          topScore: parseFloat(ragSummary.topScore),
          retrievalMs: retrievalElapsed,
          knowledgeBaseSize: knowledgeBase.length,
        },
      },
    });
  } catch (err) {
    console.error('[审查] 接口异常:', err);
    return sendError(res, 500, err.message || '服务器内部错误');
  }
});

// ============================================================
// 启动服务（先初始化 RAG，再启动 Express）
// ============================================================
async function startServer() {
  console.log('========================================');
  console.log('  LandscapeAI 后端服务启动中（V1.1 RAG）');
  console.log('========================================');

  // 1. 初始化 RAG Embedding 服务
  try {
    await embeddingService.init();
  } catch (err) {
    console.error('[启动] RAG 初始化失败:', err.message);
    console.error('[启动] 服务器将以降级模式运行（RAG 不可用）');
  }

  // 2. 启动 Express 服务
  app.listen(PORT, () => {
    console.log('========================================');
    console.log('  LandscapeAI 后端服务已启动');
    console.log(`  端口:           ${PORT}`);
    console.log(`  原型访问:       http://localhost:${PORT}/prototype.html`);
    console.log(`  审查接口:       POST http://localhost:${PORT}/api/review`);
    console.log(`  健康检查:       GET  http://localhost:${PORT}/api/health`);
    console.log(`  RAG 状态:       GET  http://localhost:${PORT}/api/rag/status`);
    console.log(`  AI 模型:        ${process.env.AGNES_MODEL || '未配置'}`);
    console.log(`  RAG:            ${embeddingService.isReady() ? '✅ 就绪' : '❌ 未就绪'}`);
    console.log(`  知识库:         ${embeddingService.getKnowledgeBase().length} 条规范条文`);
    console.log(`  检索 Top-K:     ${RAG_TOP_K} 条`);
    console.log('========================================');
  });
}

startServer().catch((err) => {
  console.error('[启动] 服务器启动失败:', err);
  process.exit(1);
});
