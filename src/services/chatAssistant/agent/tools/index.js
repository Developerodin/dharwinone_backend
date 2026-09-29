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

// Domain modules for Sage's tool registry (agent/toolRegistry.js); each entry is { domain, instructions, tools }.
export default [jobs, people, employees, candidates, applications, hiring, meetings, knowledge, schedule, org, training, attendance, projects];
