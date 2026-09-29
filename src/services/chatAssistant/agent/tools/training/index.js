import getTrainingProgress from './getTrainingProgress.tool.js';

const instructions = [
  'Training: LMS course progress on Student profiles.',
  '- "My courses / my training / how far am I" → get_training_progress with no person; a named person → person.',
  '- noStudentProfile means the person is not enrolled as a student — say that, never "0 courses".',
].join('\n');

export default {
  domain: 'training',
  instructions,
  tools: [getTrainingProgress],
};
