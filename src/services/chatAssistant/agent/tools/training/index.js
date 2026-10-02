import getTrainingProgress from './getTrainingProgress.tool.js';

const instructions = [
  'Training: LMS course progress on Student profiles.',
  '- "My courses / my training / how far am I" -> get_training_progress with no person; a named person -> person.',
  '- One person\'s last access and quiz score are on each course (lastAccessedAt, score). score null means no graded quiz: say it is not recorded, never 0. Do not copy enrolledAt into last access.',
  '- requiredCourses are the courses mapped to that person\'s position (Curriculum Setup). There is no mandatory flag. "All mandatory training complete" means every requiredCourses entry is enrolled and status completed. allRequiredComplete null means unknown or no courses are mapped, never "all complete". If requiredCourses is null, say the position map is not available.',
  '- "Which course has the lowest completion" -> mode cohort with lowestCompletion true (optionally position). Ranked lowest first. Do not say overdue.',
  '- Anything about a GROUP of learners ("who scored above 90 in React", "who hasn\'t started the Java course", ' +
    '"completion rate for Data Analysts", "who hasn\'t opened their course in 2 weeks") -> mode cohort with ' +
    'course and/or position and progress / scoreBand / inactiveDays.',
  '- "Which courses / folders does position X get" -> mode position_map.',
  '- noStudentProfile (person) and withoutStudentProfile (cohort) mean no Student profile, so no training data: ' +
    'say that and name them, never "0%" or "0 courses".',
  '- "Overdue" training is unavailable: courses store no due or expiry date, so do not invent a count and do not ' +
    'call last access, enrollment, or inactivity overdue. Say that no due date is stored.',
].join('\n');

export default {
  domain: 'training',
  summary: 'LMS progress for one person (last access, quiz score, position-mapped courses) or a cohort, including lowest completion.',
  instructions,
  tools: [getTrainingProgress],
};
