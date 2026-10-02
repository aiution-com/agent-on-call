import { query } from './db';

export async function createPolicy(orgId: string, ruleType: string, ruleValue: object, agentType?: string) {
  const rows = await query(
    `INSERT INTO policies (org_id, agent_type, rule_type, rule_value)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [orgId, agentType || null, ruleType, JSON.stringify(ruleValue)]
  );
  return rows[0];
}

export async function listPolicies(orgId: string) {
  return query('SELECT * FROM policies WHERE org_id = $1 AND active = true', [orgId]);
}
