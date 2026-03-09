import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import bolnaService from '../services/bolna.service.js';
import callRecordService from '../services/callRecord.service.js';
import { getJobById } from '../services/job.service.js';
import Job from '../models/job.model.js';
import { numberToWords, currencyToWords } from '../utils/numberToWords.js';

function jobContextFromDoc(job) {
  if (!job) return {};
  const orgName = job.organisation?.name || job.organisation || '';
  let salaryRange = '';
  if (job.salaryRange) {
    const { min, max, currency } = job.salaryRange;
    const curr = currencyToWords(currency);
    if (min != null && max != null) salaryRange = `${numberToWords(min)} to ${numberToWords(max)} ${curr}`;
    else if (min != null) salaryRange = `From ${numberToWords(min)} ${curr}`;
    else if (max != null) salaryRange = `Up to ${numberToWords(max)} ${curr}`;
  }
  return {
    jobTitle: job.title,
    organisation: orgName,
    jobType: job.jobType,
    location: job.location,
    experienceLevel: job.experienceLevel,
    salaryRange: salaryRange || undefined,
  };
}

const initiateCall = catchAsync(async (req, res) => {
  const body = req.body;
  const candidateName = body.candidateName || body.name;
  if (!candidateName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'candidateName or name is required');
  }
  if (!body.jobId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'jobId is required for job posting verification call');
  }

  const job = await getJobById(body.jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }
  const jobContext = jobContextFromDoc(job);

  const result = await bolnaService.initiateCall({
    phone: body.phone,
    candidateName,
    fromPhoneNumber: body.fromPhoneNumber,
    ...jobContext,
  });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to initiate call');
  }
  if (result.executionId) {
    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          verificationCallExecutionId: result.executionId,
          verificationCallInitiatedAt: new Date(),
        },
      }
    );
    // Seed a minimal record immediately so recruiter/job calls never remain uncategorized.
    await callRecordService.updateCallRecordByExecutionId(
      result.executionId,
      {
        purpose: 'job_posting_verification',
        job: job._id,
        status: 'initiated',
      },
      { upsert: true }
    );
  }
  res.status(httpStatus.OK).send({
    success: true,
    executionId: result.executionId,
    message: 'Call initiated successfully',
  });
});

function buildCandidateAgentPrompt(ctx) {
  return `You are Ava, a warm and professional recruitment assistant at Dharwin. You are calling a candidate who applied for a job through the Dharwin portal. Your job is to verify their application, ask basic screening questions, share next steps, and optionally tell them about other openings if they ask.

Keep the call under 5 minutes. Be natural, not robotic. Use the candidate's first name to build rapport.

CANDIDATE INFORMATION:
- Name: ${ctx.candidate_name}
- Email: ${ctx.candidate_email}
- Phone: ${ctx.candidate_phone}
- Location: ${ctx.candidate_location}
- Qualifications: ${ctx.candidate_qualifications}
- Work Experience: ${ctx.candidate_experience}
- Skills: ${ctx.candidate_skills}
- Visa Type: ${ctx.candidate_visa_type}
- Expected Salary: ${ctx.candidate_expected_salary}
- Bio: ${ctx.candidate_bio}

JOB THEY APPLIED FOR:
- Job Title: ${ctx.job_title}
- Company: ${ctx.company_name}
- Company Website: ${ctx.company_website}
- Company Description: ${ctx.company_description}
- Job Type: ${ctx.job_type}
- Location: ${ctx.job_location}
- Experience Level: ${ctx.experience_level}
- Salary Range: ${ctx.salary_range}
- Required Skills: ${ctx.required_skills}
- Job Description: ${ctx.job_description}

OTHER OPEN POSITIONS (mention only if candidate asks):
${ctx.other_openings}
Total other openings: ${ctx.total_other_openings}

CALL SCRIPT — Follow this structure:

STEP 1 — GREETING
Start with exactly: "Hello! I am Ava, I am from Dharwin. Am I speaking with ${ctx.candidate_name}?"
Wait for confirmation. If wrong person, apologize and end call.
If confirmed: "Hi ${ctx.candidate_name}! Thank you for picking up. This will just take a few minutes of your time. Is now a good time?"
If busy: "No problem at all! I can call back later, or send you the details via email to ${ctx.candidate_email}. What works better for you?"

STEP 2 — APPLICATION VERIFICATION
"${ctx.candidate_name}, I can see that you recently applied for the ${ctx.job_title} position at ${ctx.company_name} through our Dharwin portal. Can you confirm that for me?"
Wait for confirmation. If they don't remember: "No worries! It's a ${ctx.job_type} role based in ${ctx.job_location}. The position is for ${ctx.experience_level} level. Does that ring a bell?"
Once confirmed: "Great! Thank you for applying. I just have a few quick questions to help us with the initial screening."

STEP 3 — SCREENING QUESTIONS (ask one at a time, wait for answer)

a) Email check: "First, let me confirm — is ${ctx.candidate_email} your current email address?"
   If wrong: "Could you spell out the correct one for me?"

b) Motivation: "What made you interested in this ${ctx.job_title} role at ${ctx.company_name}?"

c) Experience:
   ${ctx.candidate_experience !== 'No experience listed' ? `"I see you've worked as ${ctx.candidate_experience}. How does that experience relate to this role?"` : `"Could you tell me a bit about your background and why you think you'd be a good fit?"`}

d) Skills:
   ${ctx.candidate_skills !== 'Not provided' ? `"Your profile shows skills in ${ctx.candidate_skills}. This role requires ${ctx.required_skills}. Are you comfortable with these?"` : `"This role requires ${ctx.required_skills}. Can you tell me about your experience with any of these?"`}

e) Availability: "If you're selected, when would you be available to start?"

f) Location: "The job is based in ${ctx.job_location}. Does that work for you?"

g) Salary: "The salary range for this position is ${ctx.salary_range}. Does that match your expectations?"

STEP 4 — NEXT STEPS
"Thank you for answering those questions, ${ctx.candidate_name}. Here's what happens next — our team will review your application along with today's conversation and get back to you within 3 to 5 business days."
"All updates will be sent to ${ctx.candidate_email}, so please keep an eye on your inbox. You can also check your application status anytime on the Dharwin portal."

STEP 5 — OTHER JOBS (only if candidate asks)
If they ask about other opportunities: "Absolutely! We currently have ${ctx.total_other_openings} other open positions. Let me mention a couple that might interest you:" then mention 2-3 from the other openings list.
"You can browse all of them on our Dharwin portal anytime."
If they don't ask, skip this entirely.

STEP 6 — CANDIDATE QUESTIONS
"Before I let you go — do you have any questions about the role or the process?"
For technical questions: "That's a great question! I'd suggest discussing that directly with the hiring manager once you're in the interview stage."
For company info: "${ctx.company_name} is ${ctx.company_description}. You can learn more at ${ctx.company_website}."

STEP 7 — CLOSING
"Thank you so much for your time, ${ctx.candidate_name}. We at Dharwin really appreciate your interest in the ${ctx.job_title} position at ${ctx.company_name}. You'll be hearing from us soon. Wishing you the best of luck — have a wonderful day!"

VOICEMAIL (if candidate doesn't pick up):
"Hello ${ctx.candidate_name}, this is Ava calling from Dharwin about your application for the ${ctx.job_title} position at ${ctx.company_name}. We'd love to speak with you briefly. Please check your email at ${ctx.candidate_email} for details, or call us back at your convenience. Thank you and have a great day!"

RULES:
1. Always start with "Hello! I am Ava, I am from Dharwin" — never skip the introduction
2. Always say the candidate's name right after confirming identity
3. Always verify the job and company name before moving to questions
4. Never promise selection or guarantee any outcome
5. Never share other candidates' details
6. Never make up information — if you don't have it, say "I don't have that detail right now, but our team will share it via email"
7. Never pressure the candidate — if they want to end the call, wrap up gracefully
8. Keep the tone friendly, encouraging, and human
9. Speak at a moderate pace — not too fast
10. Use the candidate's name naturally 2-3 times during the call
11. Pause after each question to let them respond fully

HANDLING EDGE CASES:
- Candidate wants to withdraw: "I completely understand. I'll note that down. If you ever change your mind, you're always welcome to reapply on Dharwin. Thank you for your time!"
- Candidate not interested: "No problem at all, ${ctx.candidate_name}. Would you like me to mention a few other openings that might be a better fit?"
- Don't have info: "I don't have that specific detail right now, but I'll make sure our team follows up via email with that information."
- Candidate frustrated: "I understand, and I appreciate your patience. Let me know how you'd like to proceed — I'm here to help."`;
}

const initiateCandidateCall = catchAsync(async (req, res) => {
  const {
    candidateId,
    candidateName,
    email,
    phoneNumber,
    countryCode,
    jobId,
    jobTitle,
    companyName,
  } = req.body;

  const Candidate = (await import('../models/candidate.model.js')).default;
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  const job = await getJobById(jobId);
  if (!job) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job not found');
  }

  // Format phone number to E.164
  let formattedPhone = String(phoneNumber || candidate.phoneNumber).replace(/\D/g, '');
  const cc = countryCode || candidate.countryCode || 'US';

  if (!formattedPhone.startsWith('91') && !formattedPhone.startsWith('1') &&
      !formattedPhone.startsWith('44') && !formattedPhone.startsWith('61')) {
    const countryPrefix = cc === 'IN' ? '91' : cc === 'US' ? '1' : cc === 'GB' ? '44' : cc === 'AU' ? '61' : '1';
    formattedPhone = countryPrefix + formattedPhone;
  }
  formattedPhone = '+' + formattedPhone;

  const digitsOnly = formattedPhone.replace(/\D/g, '');
  if (digitsOnly.length < 10 || digitsOnly.length > 15) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid phone number format');
  }

  const { numberToWords: numToWords, currencyToWords: currToWords } = await import('../utils/numberToWords.js');

  function salaryToWords(range) {
    if (!range) return 'Not disclosed';
    const { min, max, currency } = range;
    const curr = currToWords(currency);
    if (min != null && max != null) return `${numToWords(min)} to ${numToWords(max)} ${curr}`;
    if (min != null) return `From ${numToWords(min)} ${curr}`;
    if (max != null) return `Up to ${numToWords(max)} ${curr}`;
    return 'Not disclosed';
  }

  const qualifications = (candidate.qualifications || [])
    .map(q => `${q.degree} from ${q.institute}${q.endYear ? ` (${q.endYear})` : ''}`).join('; ');

  const experiences = (candidate.experiences || [])
    .map(e => `${e.role} at ${e.company}${e.currentlyWorking ? ' (current)' : ''}`).join('; ');

  const skills = (candidate.skills || [])
    .map(s => `${s.name} (${s.level})`).join(', ');

  const promptContext = {
    candidate_name: candidate.fullName,
    candidate_email: candidate.email,
    candidate_phone: formattedPhone,
    candidate_qualifications: qualifications || 'Not provided',
    candidate_experience: experiences || 'No experience listed',
    candidate_skills: skills || 'Not provided',
    candidate_visa_type: candidate.visaType || candidate.customVisaType || 'Not specified',
    candidate_location: candidate.address
      ? [candidate.address.city, candidate.address.state, candidate.address.country].filter(Boolean).join(', ')
      : 'Not specified',
    candidate_bio: candidate.shortBio || '',
    candidate_expected_salary: candidate.salaryRange || 'Not specified',
    job_title: jobTitle || job.title,
    company_name: companyName || job.organisation?.name || '',
    company_website: job.organisation?.website || '',
    company_description: job.organisation?.description || '',
    job_type: job.jobType || 'Full-time',
    job_location: job.location || 'Not specified',
    experience_level: job.experienceLevel || 'Not specified',
    salary_range: salaryToWords(job.salaryRange),
    job_description: (job.jobDescription || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
    required_skills: (job.skillTags || []).join(', ') || 'Not specified',
  };

  // Fetch other active jobs
  const Job = (await import('../models/job.model.js')).default;
  const otherJobs = await Job.find({ status: 'Active', _id: { $ne: job._id } }).limit(10).lean();

  const otherJobsList = otherJobs.map(j => ({
    title: j.title,
    company: j.organisation?.name || '',
    type: j.jobType,
    location: j.location,
    experience: j.experienceLevel || 'Not specified',
    salary: salaryToWords(j.salaryRange),
    skills: (j.skillTags || []).join(', '),
  }));

  promptContext.other_openings = otherJobsList.length > 0
    ? otherJobsList.map((j, i) => `${i + 1}. ${j.title} at ${j.company} - ${j.type}, ${j.location}, ${j.experience}, Salary: ${j.salary}${j.skills ? ', Skills: ' + j.skills : ''}`).join('\n')
    : 'No other openings at this time';
  promptContext.total_other_openings = otherJobsList.length;

  const config = (await import('../config/config.js')).default;
  const candidateAgentId = config.bolna.candidateAgentId;

  // Push the full prompt to the Bolna agent before calling
  const systemPrompt = buildCandidateAgentPrompt(promptContext);
  const patchResult = await bolnaService.updateAgentPrompt(candidateAgentId, systemPrompt);
  if (!patchResult.success) {
    console.error('⚠️ Failed to update agent prompt, proceeding with existing prompt:', patchResult.error);
  } else {
    console.log('✅ Candidate agent prompt updated with full context');
  }

  console.log('📞 Initiating candidate verification call:', {
    candidateId,
    candidateName: candidate.fullName,
    phone: formattedPhone,
    jobId,
    jobTitle: promptContext.job_title,
    otherJobsCount: otherJobsList.length,
  });

  const result = await bolnaService.initiateCall({
    phone: formattedPhone,
    candidateName: candidate.fullName,
    agentId: candidateAgentId,
    jobTitle: promptContext.job_title,
    organisation: promptContext.company_name,
    jobType: promptContext.job_type,
    location: promptContext.job_location,
    experienceLevel: promptContext.experience_level,
    salaryRange: promptContext.salary_range,
    userData: {
      ...promptContext,
      other_openings: promptContext.other_openings,
      total_other_openings: promptContext.total_other_openings,
    },
  });

  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to initiate call');
  }

  // Create call record via webhook-style payload
  const CallRecord = (await import('../models/callRecord.model.js')).default;
  await CallRecord.create({
    executionId: result.executionId,
    recipientPhoneNumber: formattedPhone,
    purpose: 'job_application_verification',
    candidate: candidateId,
    job: jobId,
    status: 'initiated',
  });

  // Update JobApplication with call details
  const JobApplication = (await import('../models/jobApplication.model.js')).default;
  await JobApplication.updateOne(
    { candidate: candidateId, job: jobId },
    {
      $set: {
        verificationCallExecutionId: result.executionId,
        verificationCallStatus: 'initiated',
        verificationCallInitiatedAt: new Date(),
      },
    }
  );

  console.log('✅ Candidate verification call initiated:', result.executionId);

  res.status(httpStatus.OK).send({
    success: true,
    executionId: result.executionId,
    message: 'Candidate verification call initiated successfully',
  });
});

const getCallStatus = catchAsync(async (req, res) => {
  const { executionId } = req.params;
  const result = await bolnaService.getExecutionDetails(executionId);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to fetch call status');
  }
  res.status(httpStatus.OK).send({
    success: true,
    details: result.details,
  });
});

const getCallRecords = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id?.toString();
  const isAdmin = await userIsAdmin(req.user);
  const options = {
    page: req.query.page,
    limit: req.query.limit,
    search: req.query.search,
    status: req.query.status,
    language: req.query.language,
    sortBy: req.query.sortBy,
    order: req.query.order,
    userId,
    isAdmin,
  };
  const data = await callRecordService.listCallRecords(options);
  res.status(httpStatus.OK).send({
    success: true,
    records: data.results,
    total: data.total,
    totalPages: data.totalPages,
    page: data.page,
    limit: data.limit,
  });
});

const syncMissingCallRecords = catchAsync(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const backfill = await callRecordService.backfillFromBolna({ maxPages: 2 });
  const sync = await callRecordService.syncMissingData(limit);
  res.status(httpStatus.OK).send({
    success: true,
    backfilled: backfill.backfilled,
    synced: sync.synced,
    errors: backfill.errors + sync.errors,
    message: `Backfilled ${backfill.backfilled} record(s) from Bolna, synced ${sync.synced} with transcript/recording.`,
  });
});

const deleteCallRecord = catchAsync(async (req, res) => {
  const record = await callRecordService.deleteCallRecord(req.params.id);
  if (!record) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Call record not found');
  }
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Call record deleted',
  });
});

async function sendPostCallEmailAndNotification(record, application) {
  if (!record?.executionId || !application) return;
  const callStatus = record.status || 'pending';
  const endedStatuses = ['completed', 'failed', 'no_answer', 'busy', 'error', 'call_disconnected'];
  const isEnded = endedStatuses.some((s) => String(callStatus).toLowerCase().includes(s));
  if (!isEnded) return;

  const JobApplication = (await import('../models/jobApplication.model.js')).default;
  const Candidate = (await import('../models/candidate.model.js')).default;
  const Job = (await import('../models/job.model.js')).default;
  const User = (await import('../models/user.model.js')).default;

  let appCallStatus = 'completed';
  if (['failed', 'error'].some((s) => String(callStatus).toLowerCase().includes(s))) appCallStatus = 'failed';
  else if (['no_answer', 'busy'].some((s) => String(callStatus).toLowerCase().includes(s))) appCallStatus = 'no_answer';

  await JobApplication.findByIdAndUpdate(application._id, { $set: { verificationCallStatus: appCallStatus } });

  const candidate = await Candidate.findById(application.candidate);
  const job = await Job.findById(application.job);
  if (!candidate || !job) {
    console.warn('📧 Post-call email skipped: candidate or job not found');
    return;
  }

  try {
    const config = (await import('../config/config.js')).default;
    const loginUrl = `${config.frontendBaseUrl || 'http://localhost:3001'}/authentication/sign-in/`;
    const portalUrl = `${config.frontendBaseUrl || 'http://localhost:3001'}/public-job/`;
    const otherJobsCount = await Job.countDocuments({ status: 'Active', _id: { $ne: job._id } });

    const { sendPostCallThankYouEmail } = await import('../services/email.service.js');
    await sendPostCallThankYouEmail(candidate.email, {
      candidateName: candidate.fullName,
      jobTitle: job.title,
      companyName: job.organisation?.name || 'Our Company',
      jobType: job.jobType,
      jobLocation: job.location,
      loginUrl,
      callDuration: record.duration ?? null,
      otherJobsCount,
      portalUrl,
    });
    console.log(`📧 Post-call thank-you email sent to ${candidate.email}`);

    const user = await User.findOne({ email: candidate.email.toLowerCase() });
    if (user) {
      const { createNotification } = await import('../services/notification.service.js');
      await createNotification(user._id, {
        type: 'general',
        title: 'Thank you for your call!',
        message: `We appreciate you taking the time to speak with us about the ${job.title} position at ${job.organisation?.name || 'our company'}. Our team will review your responses and get back to you soon.`,
        link: '/ats/jobs/',
      });
      console.log(`🔔 Post-call notification sent to ${candidate.fullName}`);
    }
  } catch (err) {
    console.error('Failed to send post-call email/notification:', err);
  }
}

const receiveWebhook = catchAsync(async (req, res) => {
  const payload = req.body || {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(httpStatus.BAD_REQUEST).send({
      success: false,
      error: 'Body must be a JSON object',
    });
  }
  const record = await callRecordService.createFromWebhook(payload);

  // Fallback: if this webhook is for a candidate call (executionId matches JobApplication), send email
  if (record.executionId) {
    const JobApplication = (await import('../models/jobApplication.model.js')).default;
    const application = await JobApplication.findOne({ verificationCallExecutionId: record.executionId })
      .select('candidate job')
      .lean();
    if (application) {
      sendPostCallEmailAndNotification(record, application).catch((err) =>
        console.error('Post-call email fallback error:', err)
      );
    }
  }

  res.status(httpStatus.OK).send({
    success: true,
    id: record._id?.toString(),
    executionId: record.executionId,
    message: 'Webhook received and stored',
  });
});

const receiveCandidateWebhook = catchAsync(async (req, res) => {
  const payload = req.body || {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(httpStatus.BAD_REQUEST).send({
      success: false,
      error: 'Body must be a JSON object',
    });
  }

  const enrichedPayload = { ...payload, purpose: 'job_application_verification' };
  const record = await callRecordService.createFromWebhook(enrichedPayload);

  if (record.executionId) {
    const JobApplication = (await import('../models/jobApplication.model.js')).default;
    const application = await JobApplication.findOne({ verificationCallExecutionId: record.executionId })
      .select('candidate job')
      .lean();
    if (application) {
      sendPostCallEmailAndNotification(record, application).catch((err) =>
        console.error('Post-call email error:', err)
      );
    } else {
      console.warn(`📞 Candidate webhook: no JobApplication found for executionId=${record.executionId}`);
    }
  }

  res.status(httpStatus.OK).send({
    success: true,
    id: record._id?.toString(),
    executionId: record.executionId,
    message: 'Candidate verification webhook received and stored',
  });
});

export {
  initiateCall,
  initiateCandidateCall,
  getCallStatus,
  getCallRecords,
  receiveWebhook,
  receiveCandidateWebhook,
  syncMissingCallRecords,
  deleteCallRecord,
};

