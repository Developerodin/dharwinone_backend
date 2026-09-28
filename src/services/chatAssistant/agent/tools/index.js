import jobs from './jobs/index.js';
import people from './people/index.js';
import employees from './employees/index.js';
import candidates from './candidates/index.js';
import applications from './applications/index.js';

// Domain modules for Sage's tool registry (agent/toolRegistry.js); each entry is { domain, instructions, tools }.
export default [jobs, people, employees, candidates, applications];
