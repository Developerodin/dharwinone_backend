# Separate Webhook URLs for Both Agents

## 🔗 Webhook URLs

### Job Verification Agent (Recruiter Calls)
```
https://your-domain.com/api/v1/webhooks/bolna-calls
```

**Local (ngrok):**
```
https://inspiratory-cristie-cherishingly.ngrok-free.dev/api/v1/webhooks/bolna-calls
```

**Use for**: `BOLNA_AGENT_ID` - Calls recruiters when they post jobs

---

### Candidate Verification Agent (Student/Candidate Calls)
```
https://your-domain.com/api/v1/webhooks/bolna-candidate-calls
```

**Local (ngrok):**
```
https://inspiratory-cristie-cherishingly.ngrok-free.dev/api/v1/webhooks/bolna-candidate-calls
```

**Use for**: `BOLNA_CANDIDATE_AGENT_ID` - Calls candidates when they apply

---

## ✅ What's Different

### Old Setup (Single Webhook)
Both agents used: `/api/v1/webhooks/bolna-calls`

### New Setup (Separate Webhooks)
- **Job Agent**: `/api/v1/webhooks/bolna-calls`
- **Candidate Agent**: `/api/v1/webhooks/bolna-candidate-calls` ✨ NEW

---

## 🎯 Features of New Candidate Webhook

The new `/bolna-candidate-calls` endpoint automatically:

1. ✅ **Stores call record** in database
2. ✅ **Sets purpose** as `job_application_verification`
3. ✅ **Updates JobApplication** status automatically:
   - `completed` → Application marked as verified
   - `failed` → Application marked as failed
   - `no_answer` → Application marked as no answer
4. ✅ **Stores transcript** and recording URL
5. ✅ **Links to application** via execution ID

---

## 📝 Setup Instructions

### Step 1: Configure Job Verification Agent

1. Go to https://app.bolna.ai
2. Open your **Job Verification Agent** (BOLNA_AGENT_ID)
3. Settings → Webhooks
4. Add webhook:
   ```
   https://inspiratory-cristie-cherishingly.ngrok-free.dev/api/v1/webhooks/bolna-calls
   ```
5. Save

### Step 2: Configure Candidate Verification Agent

1. Stay in https://app.bolna.ai
2. Open your **Candidate Verification Agent** (BOLNA_CANDIDATE_AGENT_ID)
3. Settings → Webhooks
4. Add webhook:
   ```
   https://inspiratory-cristie-cherishingly.ngrok-free.dev/api/v1/webhooks/bolna-candidate-calls
   ```
5. Save

---

## 🔄 How It Works

### When Candidate Applies:

1. **Application Created** → Student applies to job
2. **Call Initiated** → Bolna calls candidate using `BOLNA_CANDIDATE_AGENT_ID`
3. **Call Completes** → Candidate conversation finished
4. **Webhook Triggered** → Bolna sends data to `/bolna-candidate-calls`
5. **Data Processed**:
   - CallRecord created with transcript/recording
   - JobApplication status updated automatically
   - Purpose set as `job_application_verification`
6. **Backup Sync** → Scheduler runs every 2 minutes as fallback

### When Job Posted:

1. **Job Created** → Recruiter posts job
2. **Call Initiated** → Bolna calls recruiter using `BOLNA_AGENT_ID`
3. **Call Completes** → Recruiter conversation finished
4. **Webhook Triggered** → Bolna sends data to `/bolna-calls`
5. **Data Processed**:
   - CallRecord created with transcript/recording
   - Job status updated
6. **Backup Sync** → Scheduler runs every 1 minute as fallback

---

## 📊 Database Updates

### CallRecord (Both Webhooks)
```javascript
{
  executionId: "abc-123",
  recipientPhone: "+1234567890",
  recipientName: "John Doe",
  status: "completed",
  transcript: "Full conversation...",
  recordingUrl: "https://...",
  duration: 180,
  purpose: "job_application_verification", // Auto-set for candidate webhook
  createdAt: "2026-02-19..."
}
```

### JobApplication (Candidate Webhook Only)
```javascript
{
  verificationCallExecutionId: "abc-123",
  verificationCallStatus: "completed", // Auto-updated from webhook
  verificationCallInitiatedAt: "2026-02-19..."
}
```

---

## 🧪 Testing the Webhooks

### Test Job Verification Webhook:
```bash
curl -X POST https://your-domain.com/api/v1/webhooks/bolna-calls \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-job-123",
    "status": "completed",
    "recipient_phone_number": "+1234567890",
    "transcript": "Test transcript"
  }'

# Response:
{
  "success": true,
  "executionId": "test-job-123",
  "message": "Webhook received and stored"
}
```

### Test Candidate Verification Webhook:
```bash
curl -X POST https://your-domain.com/api/v1/webhooks/bolna-candidate-calls \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-candidate-123",
    "status": "completed",
    "recipient_phone_number": "+1234567890",
    "transcript": "Test transcript"
  }'

# Response:
{
  "success": true,
  "executionId": "test-candidate-123",
  "message": "Candidate verification webhook received and stored"
}
```

---

## 📂 Files Modified

### Routes
- `src/routes/v1/webhook.route.js` - Added `/bolna-candidate-calls` route

### Controllers
- `src/controllers/bolna.controller.js` - Added `receiveCandidateWebhook` function

---

## 🔍 Monitoring

### Check Webhook Logs:
```bash
# Watch for webhook calls
tail -f logs/combined.log | grep -E "(webhook|Bolna)"

# Job verification webhooks
tail -f logs/combined.log | grep "Webhook received and stored"

# Candidate verification webhooks
tail -f logs/combined.log | grep "Candidate verification webhook"
```

### Check Database:
```javascript
// All call records
db.callrecords.find().sort({ createdAt: -1 }).limit(10)

// Candidate verification calls only
db.callrecords.find({ 
  purpose: 'job_application_verification' 
}).sort({ createdAt: -1 })

// Check if application was updated
db.jobapplications.find({
  verificationCallExecutionId: { $exists: true }
})
```

---

## ✅ Benefits of Separate Webhooks

1. **Clear Separation** - Easy to identify which agent sent the data
2. **Auto-Classification** - Candidate calls automatically marked with correct purpose
3. **Auto-Updates** - JobApplication status updated automatically
4. **Better Tracking** - Separate logs for job vs candidate calls
5. **Debugging** - Easier to troubleshoot specific agent issues

---

## 🎉 Summary

**Job Verification Webhook:**
- URL: `/api/v1/webhooks/bolna-calls`
- Agent: `BOLNA_AGENT_ID`
- For: Recruiter calls

**Candidate Verification Webhook:** ✨ NEW
- URL: `/api/v1/webhooks/bolna-candidate-calls`
- Agent: `BOLNA_CANDIDATE_AGENT_ID`
- For: Candidate/Student calls
- Auto-updates: JobApplication status

**Next Steps:**
1. ✅ Add candidate webhook URL to Bolna agent dashboard
2. ✅ Test with real application
3. ✅ Check logs and database
4. ✅ Verify application status updates

Both webhooks work in parallel with the schedulers as backup!
