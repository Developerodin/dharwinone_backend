import getTrainingProgress from './getTrainingProgress.tool.js';

const instructions = [
  'Training: LMS course progress on Student profiles.',
  '- "My courses / my training / how far am I" → get_training_progress with no person; a named person → person.',
  '- Anything about a GROUP of learners ("who scored above 90 in React", "who hasn\'t started the Java course", ' +
    '"completion rate for Data Analysts", "who hasn\'t opened their course in 2 weeks") → mode cohort with ' +
    'course and/or position and progress / scoreBand / inactiveDays.',
  '- "Which courses / folders does position X get" → mode position_map.',
  '- noStudentProfile (person) and withoutStudentProfile (cohort) mean no Student profile, so no training data: ' +
    'say that and name them, never "0%" or "0 courses".',
  '- "Overdue" training is not captured (courses have no due date): say so and offer atRisk instead.',
].join('\n');

export default {
  domain: 'training',
  summary: 'LMS course progress: one person, a course or position cohort, and the position-to-course map.',
  instructions,
  tools: [getTrainingProgress],
};
