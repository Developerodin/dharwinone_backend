import interviews from './interviews/index.js';
import { instructions as documentInstructions, tools as documentTools } from './documents/index.js';
import training from './training/index.js';
import { instructions as taskInstructions, tools as taskTools } from './tasks/index.js';
import { instructions as moreInstructions, tools as moreTools } from './more/index.js';

// One find_tools domain for every confirm-first write; each subfolder keeps its own tools and rules.
export default {
  domain: 'actions',
  summary:
    'Drafts you confirm: invites, reminders, documents, training, project allocation, leave decisions, task lists.',
  instructions: [
    interviews.instructions, documentInstructions, training.instructions, taskInstructions, moreInstructions,
  ].join('\n'),
  tools: [...interviews.tools, ...documentTools, ...training.tools, ...taskTools, ...moreTools],
};
