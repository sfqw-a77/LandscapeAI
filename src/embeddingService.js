/**
 * Embedding 服务
 *
 * 职责：
 * 1. 加载 @xenova/transformers 的 multilingual-e5-small 模型
 * 2. 将知识库 141 条规范条文向量化（首次运行自动生成，后续从缓存加载）
 * 3. 提供查询向量化接口
 *
 * 模型说明：
 * - Xenova/multilingual-e5-small：384 维，支持中文，模型约 90MB
 * - E5 模型需要前缀：passage: 用于文档，query: 用于查询
 */

const { pipeline, env } = require('@xenova/transformers');
const fs = require('fs');
const path = require('path');

// 配置 HuggingFace 国内镜像（解决模型下载失败问题）
env.allowRemoteModels = true;
env.remoteHost = 'https://hf-mirror.com';

// ============================================================
// 配置
// ============================================================
const MODEL_NAME = 'Xenova/multilingual-e5-small';
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'embeddings.json');
const KNOWLEDGE_FILE = path.join(__dirname, '..', 'knowledge', 'standards-all.json');

// ============================================================
// 状态
// ============================================================
let extractor = null;          // 模型 pipeline 实例
let knowledgeBase = [];        // 完整知识库条文
let clauseEmbeddings = [];     // 向量数组：[{ id, embedding: number[] }]
let isInitialized = false;

// ============================================================
// 初始化（启动时调用一次）
// ============================================================
async function init() {
  console.log('[Embedding] 开始初始化...');

  // 1. 加载知识库
  const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8');
  knowledgeBase = JSON.parse(raw);
  console.log(`[Embedding] 知识库加载完成: ${knowledgeBase.length} 条条文`);

  // 2. 检查缓存
  if (fs.existsSync(CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    // 验证缓存与知识库一致
    if (cache.clauseCount === knowledgeBase.length && cache.model === MODEL_NAME) {
      clauseEmbeddings = cache.embeddings;
      console.log(`[Embedding] 从缓存加载 ${clauseEmbeddings.length} 条向量，跳过模型加载`);
      isInitialized = true;
      return;
    }
    console.log('[Embedding] 缓存与知识库不匹配，重新生成向量');
  }

  // 3. 加载模型（首次运行会下载，约 90MB）
  console.log('[Embedding] 正在加载模型（首次运行需下载 ~90MB）...');
  const startTime = Date.now();
  extractor = await pipeline('feature-extraction', MODEL_NAME, {
    progress_callback: (data) => {
      if (data.status === 'progress') {
        const pct = (data.progress || 0).toFixed(1);
        process.stdout.write(`\r[Embedding] 模型下载进度: ${pct}%`);
      }
    },
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Embedding] 模型加载完成 (${elapsed}s)`);

  // 4. 逐条生成向量
  console.log(`[Embedding] 正在为 ${knowledgeBase.length} 条条文生成向量...`);
  clauseEmbeddings = [];
  for (let i = 0; i < knowledgeBase.length; i++) {
    const clause = knowledgeBase[i];
    // E5 模型要求 passage 前缀
    const text = 'passage: ' + clause.content;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    clauseEmbeddings.push({
      id: clause.id,
      embedding: Array.from(output.data),
    });
    if ((i + 1) % 20 === 0) {
      console.log(`[Embedding] 已处理 ${i + 1}/${knowledgeBase.length} 条`);
    }
  }
  console.log(`[Embedding] 向量生成完成: ${clauseEmbeddings.length} 条`);

  // 5. 写入缓存
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const cacheData = {
    model: MODEL_NAME,
    dimensions: 384,
    generatedAt: new Date().toISOString(),
    clauseCount: knowledgeBase.length,
    embeddings: clauseEmbeddings,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData));
  const cacheSize = (fs.statSync(CACHE_FILE).size / 1024).toFixed(0);
  console.log(`[Embedding] 缓存已写入: ${CACHE_FILE} (${cacheSize}KB)`);

  isInitialized = true;
  console.log('[Embedding] 初始化完成');
}

// ============================================================
// 查询向量化
// ============================================================
async function embedQuery(text) {
  if (!isInitialized) {
    throw new Error('Embedding 服务未初始化，请先调用 init()');
  }

  // 如果模型未加载（从缓存启动的情况），按需加载
  if (!extractor) {
    console.log('[Embedding] 按需加载模型用于查询向量化...');
    extractor = await pipeline('feature-extraction', MODEL_NAME);
  }

  // E5 模型要求 query 前缀
  const prefixedText = 'query: ' + text;
  const output = await extractor(prefixedText, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ============================================================
// 获取向量列表
// ============================================================
function getEmbeddings() {
  return clauseEmbeddings;
}

// ============================================================
// 获取知识库
// ============================================================
function getKnowledgeBase() {
  return knowledgeBase;
}

// ============================================================
// 是否已初始化
// ============================================================
function isReady() {
  return isInitialized;
}

module.exports = {
  init,
  embedQuery,
  getEmbeddings,
  getKnowledgeBase,
  isReady,
};
