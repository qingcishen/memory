// K1 · 结构化知识图谱门面 (见 docs/DEVELOPMENT.md §0 K1, 表结构 sql/knowledge-graph.sql)。
export { extractKnowledge, parseKnowledgeExtraction, normalizeEntityKey, normalizeRelation, ENTITY_TYPES } from './extract.js';
export { observeKnowledge, upsertEntities, upsertRelations } from './store.js';
export { recallKnowledge, expandGraph, formatKnowledgeFacts } from './recall.js';
