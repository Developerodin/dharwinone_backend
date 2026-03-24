# Candidate Verification Call System - Complete Setup

## 🎯 System Overview

The candidate verification call system is **fully implemented and running**. It automatically calls candidates after they apply to jobs.

---

## 📞 Webhook URL

Add this webhook to your **Bolna Candidate Agent** dashboard:

### Production:
```
https://your-domain.com/api/v1/webhooks/bolna-calls
```

### Local Development (using ngrok):
```
https://your-ngrok-url.ngrok-free.dev/api/v1/webhooks/bolna-calls
```

**Note**: Both agents (Job Recruiter & Candidate Verification) use the **same webhook endpoint**.

---

## 🔄 How It Works

### 1. Immediate Call (On Application Submit)
When a candidate applies through the public portal:
- Call is initiated **immediately** in `job.service.js` (`publicApplyToJobService`)
- Uses `initiateCandidateVerificationCall` → **PATCH** full system prompt on `BOLNA_CANDIDATE_AGENT_ID`, then `POST /call`
- Creates `CallRecord` with purpose: `job_application_verification`
- Updates `JobApplication` with call execution ID

### 2. Backup Scheduler (Every 2 Minutes)
A cron job runs every 2 minutes to catch any missed calls:
- **File**: `src/services/applicationVerificationCall.scheduler.js`
- **Started in**: `src/index.js` (line 36)
- **Interval**: 2 minutes
- **Function**: `startApplicationVerificationCallScheduler(2)`

**What it does**:
1. Finds applications created in last 10 minutes without call
2. Initiates calls using `BOLNA_CANDIDATE_AGENT_ID` (same **patch-then-call** path as manual ATS and public apply)
3. Creates call records
4. Updates application status

### 3. Call Status Sync (Every 2 Minutes)
The same scheduler also syncs call status from Bolna:
- Fetches execution details from Bolna API
- Updates call records with transcript/recording
- Updates application `verificationCallStatus`
- Possible statuses: `pending`, `completed`, `failed`, `no_answer`

---

## 📊 Database Tracking

### JobApplication Model
```javascript
{
  verificationCallExecutionId: String,      // Bolna execution ID
  verificationCallInitiatedAt: Date,        // When call started
  verificationCallStatus: Enum              // Call result status
    // Values: 'pending', 'completed', 'failed', 'no_answer'
}
```

### CallRecord Model
```javascript
{
  executionId: String,                      // Bolna execution ID
  recipientPhone: String,                   // Candidate phone
  recipientName: String,                    // Candidate name
  recipientEmail: String,                   // Candidate email
  purpose: 'job_application_verification',  // Call purpose
  relatedJobApplication: ObjectId,          // Link to application
  relatedJob: ObjectId,                     // Link to job
  relatedCandidate: ObjectId,               // Link to candidate
  status: String,                           // Call status
  transcript: String,                       // Call transcript (synced)
  recordingUrl: String,                     // Recording URL (synced)
  duration: Number,                         // Call duration (synced)
}
```

---

## 🔧 Configuration

### Environment Variables (.env)
```env
# Bolna API
BOLNA_API_KEY=bn-d32269d4ecf34227b9b929655e9dbf2f
BOLNA_FROM_PHONE_NUMBER=+18336990430
BOLNA_API_BASE=https://api.bolna.ai

# Agent IDs
BOLNA_AGENT_ID=6afbccea-0495-4892-937c-6a5c9af12440              # General/Job recruiter agent
BOLNA_CANDIDATE_AGENT_ID=your_candidate_agent_id_here           # Candidate verification agent
```

### Scheduler Settings
- **File**: `src/services/applicationVerificationCall.scheduler.js`
- **Interval**: 2 minutes (configurable)
- **Call window**: Last 10 minutes
- **Max calls per run**: 10 applications
- **Auto-start**: Yes (on server start)
- **Auto-cleanup**: Yes (on server shutdown)

---

## 📝 Call Context Variables

The following variables are automatically passed to the Bolna agent:

```javascript
{
  candidate_name: "John Doe",
  candidate_email: "john@email.com",
  job_title: "Senior Software Engineer",
  job_type: "Full-time",
  location: "San Francisco, CA - Hybrid",
  experience_level: "Senior Level",
  salary_range: "one hundred fifty thousand to one hundred eighty thousand dollars per year",
  company_name: "TechCorp Inc.",
  application_date: "February 19, 2026"
}
```

---

## 🚀 Setup Steps

### 1. Create Bolna Agent
Follow: `BOLNA_QUICK_SETUP.md`

### 2. Add Webhook to Bolna Dashboard
1. Go to https://app.bolna.ai
2. Open your **Candidate Verification Agent**
3. Settings → Webhooks
4. Add webhook URL: `https://your-domain.com/api/v1/webhooks/bolna-calls`
5. Save

### 3. Update .env
```env
BOLNA_CANDIDATE_AGENT_ID=your_new_agent_id_from_dashboard
```

### 4. Restart Backend
```bash
cd uat.dharwin.backend
npm run dev
```

---

## 🔍 Monitoring

### Check Scheduler Status
```bash
# Backend logs
tail -f logs/combined.log | grep "verification call"

# Should see:
# 📞 Application verification call scheduler started (every 2 min)
# ✅ Verification call initiated for John Doe (+1234567890)
# Synced application call record abc-123 with transcript/recording
```

### Check Call Records
```bash
# In MongoDB
db.callrecords.find({ 
  purpose: 'job_application_verification' 
}).sort({ createdAt: -1 })

# Check application status
db.jobapplications.find({
  verificationCallExecutionId: { $exists: true }
})
```

### Bolna Dashboard
- View calls: https://app.bolna.ai/calls
- Filter by agent: Use `BOLNA_CANDIDATE_AGENT_ID`
- Check recordings and transcripts
- Monitor success rate

---

## 🐛 Troubleshooting

### Scheduler Not Running

**Check**:
```bash
# Look for this in logs
grep "Application verification call scheduler started" logs/combined.log
```

**Fix**: Restart backend server

### Calls Not Initiated

**Check**:
1. Is `BOLNA_CANDIDATE_AGENT_ID` set?
2. Does candidate have valid phone number?
3. Is phone number in correct format?

**Debug**:
```bash
# Check config
node -e "import('./src/config/config.js').then(c => console.log(c.default.bolna))"

# Check recent applications
db.jobapplications.find().sort({ createdAt: -1 }).limit(5)
```

### Webhook Not Receiving Data

**Check**:
1. Is webhook URL correct in Bolna dashboard?
2. Is backend accessible from internet (not localhost)?
3. Check webhook endpoint logs

**Test**:
```bash
# Check webhook endpoint
curl https://your-domain.com/api/v1/webhooks/bolna-calls
```

### Call Status Not Updating

**Check**:
1. Is call record being created?
2. Is sync running?
3. Check Bolna execution details

**Debug**:
```javascript
// Manually sync a call
import bolnaService from './src/services/bolna.service.js';
const result = await bolnaService.getExecutionDetails('execution-id');
console.log(result);
```

---

## System prompt, concurrency, admin overrides

- **Two Bolna agents required**: `BOLNA_AGENT_ID` = job **posting / recruiter** verification (prompt from Bolna dashboard only; not PATCHed by this app). `BOLNA_CANDIDATE_AGENT_ID` = **applicant** verification (receives a full system prompt PATCH before each call). If both env vars resolve to the **same** agent ID, applicant PATCHes overwrite the recruiter agent and the two flows **mix**. The backend **refuses** applicant verification calls until the IDs differ; check server logs on startup for `[Bolna] BOLNA_AGENT_ID and BOLNA_CANDIDATE_AGENT_ID are identical`.
- **Prompt builder**: `src/services/candidateVerificationPrompt.service.js` — intro names **Dharwin** as the platform and **hiring company** from the job; edge cases for wrong name / different role.
- **Orchestration**: `src/services/bolnaCandidateVerification.service.js` — loads optional DB overrides, builds prompt, **serializes** PATCH + outbound call per agent ID (in-process queue) to reduce prompt races when two calls overlap.
- **Admin text fields**: MongoDB `BolnaCandidateAgentSettings` (singleton `key: default`). **API**: `GET` / `PATCH /v1/bolna/candidate-agent-settings` (requires `users.manage`). **UI**: Settings → **Voice agent (Bolna)**.
- **Observability**: Successful PATCH logs a short **SHA-256 prefix** of the system prompt (`promptHash` in logs) for correlating with Bolna executions.

---

## Prompt changelog (candidate verification)

Updates below apply to `src/services/candidateVerificationPrompt.service.js` (system prompt PATCH before each call).

- **Application date** — Shown under Candidate knowledge as `Application submitted`; Step 2 references it when the application record has `createdAt`.
- **Priority tiers** — **Tier A:** email (3a) + location (3f) after job confirmation. **Tier B:** motivation, experience, skills, availability, salary. **Busy path:** email only, then short Step 4 + Step 7.
- **Voice / TTS** — Do not read full job description or long skill lists; summarize role in ≤2 short sentences; cap spoken skills/experience to brief themes.
- **Email correction** — After spell-out, read back the address once and confirm before continuing.
- **Other openings** — Described as examples of active listings on the platform, not personalized “fits.”
- **GUARDRAILS vs timeline** — Follow-up timing comes **only** from Step 4 wording (standard vs busy quick path); no extra invented deadlines.

## Legal / compliance placeholders

- **Recording and region-specific disclosure** — Any mandatory recording notice or AI/disclosure line must be **legal-reviewed** before production. Do not add fixed compliance strings in code without sign-off.
- **Future option** — If product later supplies a short notice string (e.g. via Bolna user data), the prompt can instruct the agent to speak it after the greeting; that is not wired in the current Phase 1 scope.

---

## Operations: ASR, latency, mid-call drops

Use this when candidates report **wrong transcription**, **slow replies**, or **calls ending after ~2–3 minutes**.

### Bolna dashboard / agent

1. **Speech / language** — Set STT locale to match candidates (e.g. Indian English vs US English) if configurable.
2. **Max call duration / silence** — In the Bolna dashboard, open the **Call** tab on **each** agent (job-posting `BOLNA_AGENT_ID` and candidate `BOLNA_CANDIDATE_AGENT_ID`) and set **maximum call duration** in **seconds**. Backend defaults to **900** (15 minutes) via `BOLNA_MAX_CALL_DURATION_SECONDS` and sends `max_call_duration_seconds` on `POST /call` when the value is > 0; **dashboard and API should match** so behavior is predictable. Official guide: [Terminate Bolna Voice AI calls](https://www.bolna.ai/docs/disconnect-calls). Also check **silence timeout** and **hangup prompts** vs the hard time limit.
3. **Execution record** — Open the execution for the `executionId` stored on `JobApplication.verificationCallExecutionId` or `CallRecord.executionId`. Inspect **status**, **end_reason** (or equivalent), **error_message**, and linked **recording** duration.
4. **Billing / trial** — Trial or credit limits can end calls early; confirm account status if drops correlate with time/credits.

### Plivo / telephony

1. **SIP / hangup cause** — For disconnects, check Plivo **debug** or **call detail** for **SIP BYE** reason, **media timeout**, or **max duration** on the number/trunk.
2. **Caller ID** — `BOLNA_FROM_PHONE_NUMBER` / `CALLER_ID` must be valid; misconfiguration can cause failed or short calls in some regions.

### Application layer (this repo)

- **HTTP timeout** — `bolna.service.js` uses a **30s** timeout only for the **REST** request that *starts* the call, not for live call duration.
- **Concurrency** — Multiple simultaneous verification calls share one Bolna agent ID; the **serialized** patch+call reduces wrong-prompt races but does not increase capacity; for high volume consider a **second agent** (duplicate Bolna agent + env ID).

### Product / compliance

- Outbound recruiting may require **consent / disclosure** depending on region; confirm with legal/product before changing scripts.

---

## 📂 Related Files

### Scheduler
- `src/services/applicationVerificationCall.scheduler.js` - Main scheduler
- `src/index.js` - Scheduler integration (start/stop)

### Services
- `src/services/job.service.js` - Immediate call on application
- `src/services/bolna.service.js` - Bolna API client (`initiateCall`, `updateAgentPrompt`, execution fetch)
- `src/services/bolnaCandidateVerification.service.js` - Patch + serialized call for candidate verification
- `src/services/candidateVerificationPrompt.service.js` - Shared prompt context + system prompt text
- `src/services/bolnaCandidateAgentSettings.service.js` - Admin prompt overrides
- `src/services/callRecord.service.js` - Call record management

### Models
- `src/models/jobApplication.model.js` - Application with call tracking
- `src/models/callRecord.model.js` - Call records
- `src/models/bolnaCandidateAgentSettings.model.js` - Singleton settings for extra instructions / greeting override

### Webhooks
- `src/routes/v1/webhook.route.js` - Webhook routes
- `src/controllers/webhook.controller.js` - Webhook handlers

---

## ✅ What's Already Working

1. ✅ **Immediate calls** on application submit
2. ✅ **Backup scheduler** runs every 2 minutes
3. ✅ **Call records** created and tracked
4. ✅ **Status sync** from Bolna API
5. ✅ **Webhook endpoint** ready at `/api/v1/webhooks/bolna-calls`
6. ✅ **Application tracking** with call execution ID
7. ✅ **Auto-start** on server startup
8. ✅ **Auto-cleanup** on server shutdown

---

## 📌 Next Steps

1. ✅ Create Bolna Candidate Agent (if not done)
2. ✅ Add webhook URL to agent dashboard
3. ✅ Update `BOLNA_CANDIDATE_AGENT_ID` in `.env`
4. ✅ Restart backend
5. ✅ Test with real application
6. ✅ Monitor logs and dashboard

---

## 🎉 Summary

The candidate verification call system is **production-ready**:

- **Two-layer approach**: Immediate call + backup scheduler
- **Reliable**: Catches missed calls every 2 minutes
- **Tracked**: Full call history in database
- **Synced**: Status updates from Bolna
- **Monitored**: Detailed logs and dashboard
- **Same webhook**: Reuses existing endpoint

Just add the webhook URL to your Bolna agent dashboard and update the agent ID in `.env`!
