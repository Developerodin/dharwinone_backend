import assignTraining from './assignTraining.tool.js';
import sendCourseReminder from './sendCourseReminder.tool.js';

const instructions = [
  'Training actions (drafts only — the user presses Confirm; never say it is done).',
  '- "Assign / enrol Priya and Ravi to the Java course" → assign_training with each person named. It only adds; ' +
    'nobody is removed.',
  '- "Remind Priya to finish React Basics" → send_course_reminder. Courses have no due date: never say "overdue".',
  '- Both need people named one by one (name or email). "Everyone in a position" or "all students" is not a ' +
    'list: look them up with get_training_progress first and ask the user which people to include.',
  '- Questions about who is enrolled or who finished are get_training_progress, not a draft.',
].join('\n');

export default {
  domain: 'training_actions',
  summary: 'Draft training actions for named people: assign a course, send a course reminder.',
  instructions,
  tools: [assignTraining, sendCourseReminder],
};
