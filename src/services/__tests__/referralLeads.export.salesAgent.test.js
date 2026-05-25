import test from 'node:test';
import assert from 'node:assert/strict';

test('CSV header includes sales_agent and lifecycle columns', () => {
  const header = [
    'candidate_id',
    'candidate_name',
    'candidate_email',
    'referrer_id',
    'referrer_name',
    'referrer_role',
    'referral_context',
    'job_id',
    'job_title',
    'referral_jti',
    'status',
    'referred_at',
    'attribution_locked_at',
    'org_id',
    'sales_agent_name',
    'sales_agent_email',
    'sales_agent_assigned_at',
    'sales_agent_scope',
    'lifecycle_stage',
    'employee_converted',
    'joining_date',
    'attribution_job_id',
    'attribution_job_title',
  ].join(',');
  assert.match(
    header,
    /sales_agent_name,sales_agent_email,sales_agent_assigned_at,sales_agent_scope,lifecycle_stage,employee_converted,joining_date,attribution_job_id,attribution_job_title/
  );
});
