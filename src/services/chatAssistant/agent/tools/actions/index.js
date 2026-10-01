import interviews from './interviews/index.js';
import { instructions as documentInstructions, tools as documentTools } from './documents/index.js';
import training from './training/index.js';
import { instructions as taskInstructions, tools as taskTools } from './tasks/index.js';

// One find_tools domain for every confirm-first write; each subfolder keeps its own tools and rules.
export default {
  domain: 'actions',
  summary: 'send reminders, invites, request documents, assign training, create tasks — drafts you confirm',
  instructions: [interviews.instructions, documentInstructions, training.instructions, taskInstructions].join('\n'),
  tools: [...interviews.tools, ...documentTools, ...training.tools, ...taskTools],
};
