/**
 * 检索服务（纯函数模块，无副作用）
 *
 * 职责：
 * 1. 计算余弦相似度（Cosine Similarity）
 * 2. 从向量库中检索 Top-K 最相关条文
 * 3. 按指标分组统计检索结果
 *
 * 注意：嵌入向量已归一化（normalize: true），故余弦相似度 = 点积
 */

// ============================================================
// 余弦相似度（归一化向量简化为点积）
// ============================================================
function cosineSimilarity(queryEmbedding, clauseEmbedding) {
  let dot = 0;
  for (let i = 0; i < queryEmbedding.length; i++) {
    dot += queryEmbedding[i] * clauseEmbedding[i];
  }
  return dot;
}

// ============================================================
// Top-K 检索
// ============================================================
/**
 * 从向量库中检索与查询最相关的 Top-K 条文
 *
 * @param {number[]} queryEmbedding - 查询向量（384维）
 * @param {Array<{id, embedding}>} clauseEmbeddings - 全部条文向量
 * @param {Array} knowledgeBase - 完整知识库（用于回填条文详情）
 * @param {number} topK - 返回数量，默认 25
 * @returns {Array<{id, score, indicator, standard_name, standard_code, clause_number, content, review_point}>}
 */
function retrieve(queryEmbedding, clauseEmbeddings, knowledgeBase, topK = 25) {
  // 1. 构建知识库查找表（id → 条文详情）
  const clauseMap = new Map();
  for (const clause of knowledgeBase) {
    clauseMap.set(clause.id, clause);
  }

  // 2. 计算相似度并排序
  const scored = clauseEmbeddings.map((item) => ({
    id: item.id,
    score: cosineSimilarity(queryEmbedding, item.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);

  // 3. 取 Top-K 并回填条文详情
  const results = scored.slice(0, topK).map((item) => {
    const clause = clauseMap.get(item.id);
    return {
      id: item.id,
      score: Math.max(0, item.score), // 相似度不低于 0
      indicator: clause.indicator,
      standard_name: clause.standard_name,
      standard_code: clause.standard_code,
      clause_number: clause.clause_number,
      content: clause.content,
      review_point: clause.review_point,
    };
  });

  return results;
}

// ============================================================
// 按指标分组统计
// ============================================================
/**
 * 将检索结果按指标分组，用于前端展示
 *
 * @param {Array} retrievedClauses - retrieve() 的返回值
 * @returns {Object} { 消防: [...], 无障碍: [...], ... }
 */
function groupByIndicator(retrievedClauses) {
  const groups = {};
  for (const clause of retrievedClauses) {
    if (!groups[clause.indicator]) {
      groups[clause.indicator] = [];
    }
    groups[clause.indicator].push(clause);
  }
  return groups;
}

// ============================================================
// 检索摘要（用于日志和前端展示）
// ============================================================
function getRetrievalSummary(retrievedClauses) {
  const groups = groupByIndicator(retrievedClauses);
  const indicators = Object.keys(groups).sort();
  const parts = indicators.map((ind) => `${ind}: ${groups[ind].length}条`);
  const avgScore =
    retrievedClauses.reduce((sum, c) => sum + c.score, 0) / retrievedClauses.length;
  return {
    totalRetrieved: retrievedClauses.length,
    indicatorsCovered: indicators.length,
    distribution: parts.join(' | '),
    avgSimilarity: avgScore.toFixed(4),
    topScore: retrievedClauses[0]?.score.toFixed(4) || 'N/A',
  };
}

module.exports = {
  cosineSimilarity,
  retrieve,
  groupByIndicator,
  getRetrievalSummary,
};
