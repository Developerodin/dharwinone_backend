import jobs from './jobs/index.js';
import people from './people/index.js';
import employees from './employees/index.js';
import candidates from './candidates/index.js';
import applications from './applications/index.js';
import hiring from './hiring/index.js';
import meetings from './meetings/index.js';
import knowledge from './knowledge/index.js';
import schedule from './schedule/index.js';
import org from './org/index.js';
import training from './training/index.js';
import attendance from './attendance/index.js';
import projects from './projects/index.js';
import calls from './calls/index.js';
import communication from './communication/index.js';
import audit from './audit/index.js';
import referrals from './referrals/index.js';
import person from './person/index.js';
import crosscheck from './crosscheck/index.js';
import insights from './insights/index.js';
import advice from './advice/index.js';

// Domain modules for Sage's tool registry (agent/toolRegistry.js); each entry is { domain, summary, instructions, tools }.
export default [
  jobs, people, employees, candidates, applications, hiring, meetings, knowledge, schedule, org, training, attendance,
  projects, calls, communication, audit, referrals, person, crosscheck, insights, advice,
];
