import resendInterviewInvite from './resendInterviewInvite.tool.js';
import sendInterviewBookingLink from './sendInterviewBookingLink.tool.js';
import scheduleInterview from './scheduleInterview.tool.js';
import { DOMAIN } from './common.js';

export default {
  domain: DOMAIN,
  summary: 'Draft interview actions for confirmation: schedule an interview, re-send invites, send a booking link.',
  instructions: [
    'Interview actions only draft: each shows the user a confirm card and nothing happens until they press Confirm. ' +
      'Never say an interview was scheduled or an email was sent — say it is ready to confirm.',
    'Draft only when the user asks you to DO it ("schedule", "resend", "send the booking link"). A question about ' +
      'interviews ("when is", "who is on", "did the invite go out") is answered with list_interviews / get_interview, never a draft.',
    'schedule_interview and send_interview_booking_link need an application id: get it from list_applications ' +
      '(applicant name + job). Several applications fit → ask which one; never guess.',
    'schedule_interview: scheduledAt is ISO 8601 with an explicit offset; a time the user gives without a zone is IST ' +
      '(+05:30). Hosts are user ids or login emails of DharwinOne users; omit hosts to make the user the host.',
    'resend_interview_invite takes an interview id from list_interviews / get_interview, or the candidate name.',
    'send_interview_booking_link lets the candidate pick their own time; schedule_interview fixes the time now.',
  ].join('\n'),
  tools: [scheduleInterview, resendInterviewInvite, sendInterviewBookingLink],
};
