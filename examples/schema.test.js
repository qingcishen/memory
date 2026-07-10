// 数据库 schema 锁定测试: 防止知识图谱表 / 索引 / RPC 在分支合并时再次被误删。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../sql/knowledge-graph.sql', import.meta.url), 'utf8');
let passed = 0;

function ok(name, condition) {
  assert.ok(condition, name);
  console.log('  ✓', name);
  passed++;
}

console.log('knowledge graph database schema');
ok('定义 knowledge_entities 表', /create table if not exists knowledge_entities\s*\(/i.test(schema));
ok('定义 knowledge_relations 表', /create table if not exists knowledge_relations\s*\(/i.test(schema));
ok('实体按 user + companion + key 唯一', /unique\s*\(user_id,\s*companion_id,\s*entity_key\)/i.test(schema));
ok('关系带来源和目标实体外键', /source_entity_id[\s\S]*references knowledge_entities/i.test(schema) && /target_entity_id[\s\S]*references knowledge_entities/i.test(schema));
ok('关系置信度限制在 0..1', /check\s*\(confidence\s*>=\s*0\s+and\s+confidence\s*<=\s*1\)/i.test(schema));
ok('关系可追溯到来源记忆', /source_memory_id\s+uuid\s+references memories/i.test(schema));
ok('实体有向量索引', /knowledge_entities_embedding_idx[\s\S]*vector_cosine_ops/i.test(schema));
ok('关系有双向遍历索引', schema.includes('knowledge_relations_source_idx') && schema.includes('knowledge_relations_target_idx'));
ok('定义 match_knowledge_entities RPC', /create or replace function match_knowledge_entities\s*\(/i.test(schema));
ok('RPC 严格按 user 和 companion 隔离', /e\.user_id\s*=\s*p_user_id/i.test(schema) && /e\.companion_id\s*=\s*p_companion_id/i.test(schema));
ok('提供可单独执行的幂等迁移', /begin;/i.test(migration) && /create table if not exists knowledge_entities/i.test(migration) && /create or replace function match_knowledge_entities/i.test(migration) && /commit;/i.test(migration));
ok('迁移完成后刷新 Supabase 结构缓存', /notify\s+pgrst\s*,\s*'reload schema'/i.test(migration));

console.log(`\n数据库 schema 全部 ${passed} 条断言通过 ✅`);
