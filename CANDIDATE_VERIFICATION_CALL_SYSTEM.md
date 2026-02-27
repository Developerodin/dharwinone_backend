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
- Call is initiated **immediately** in `job.service.js` (line ~625)
- Uses `BOLNA_CANDIDATE_AGENT_ID`
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
2. Initiates calls using `BOLNA_CANDIDATE_AGENT_ID`
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

## 📂 Related Files

### Scheduler
- `src/services/applicationVerificationCall.scheduler.js` - Main scheduler
- `src/index.js` - Scheduler integration (start/stop)

### Services
- `src/services/job.service.js` - Immediate call on application
- `src/services/bolna.service.js` - Bolna API client
- `src/services/callRecord.service.js` - Call record management

### Models
- `src/models/jobApplication.model.js` - Application with call tracking
- `src/models/callRecord.model.js` - Call records

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
