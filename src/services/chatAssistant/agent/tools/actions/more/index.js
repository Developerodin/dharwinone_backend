import allocateToProject from './allocateToProject.tool.js';
import sendInterviewReminder from './sendInterviewReminder.tool.js';
import decideLeaveRequest from './decideLeaveRequest.tool.js';

// Merged by the orchestrator into actions/index.js. Not its own find_tools domain.
export const instructions = [
  'These actions only draft a confirm card. Nothing is allocated, sent or decided until the user presses Confirm. ' +
    'Never say it already happened — say it is ready to confirm.',
  'Draft only when the user asks you to DO it.',
  '- "Add / allocate / assign <named people> to <project>" → allocate_to_project. Name people one per entry ' +
    '(at most 10), never "everyone" or a whole team. A question about who is free, who is suitable, or whether ' +
    'someone CAN be added is get_allocation (mode can_assign), never a draft.',
  '- "Send a reminder for <interview>" → send_interview_reminder, one interview (id or candidate name). ' +
    'A question about whether a reminder was sent or when it will send is get_interview, never a draft.',
  '- "Approve / reject <leave request>" → decide_leave_request. A question about leave (pending, who is off, ' +
    'was it approved) is list_leave_requests or count_leave_requests, never a draft.',
  'Someone already on 2 other active projects cannot be allocated; the draft is refused and names them. ' +
    'A leave request that is not pending cannot be approved or rejected. A cancelled or past interview cannot be reminded.',
].join('\n');

export const tools = [allocateToProject, sendInterviewReminder, decideLeaveRequest];
