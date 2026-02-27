# Webhook Configuration for Both Bolna Agents

## 📡 Webhook Endpoint

**Both agents use the SAME webhook endpoint:**

```
https://your-domain.com/api/v1/webhooks/bolna-calls
```

Or for local testing:
```
https://your-ngrok-url.ngrok-free.dev/api/v1/webhooks/bolna-calls
```

---

## 🔄 How It Works

### Webhook Flow:

1. **Bolna Makes Call** → Agent (BOLNA_AGENT_ID or BOLNA_CANDIDATE_AGENT_ID)
2. **Call Completes** → Bolna sends webhook to your endpoint
3. **Webhook Received** → `/api/v1/webhooks/bolna-calls` (POST)
4. **Controller Processes** → `bolna.controller.js` → `receiveWebhook()`
5. **Service Stores** → `callRecord.service.js` → `createFromWebhook()`
6. **Database Updated** → CallRecord created/updated with:
   - Execution ID
   - Call status
   - Transcript
   - Recording URL
   - Duration
   - All metadata

### What the Webhook Stores:

```javascript
{
  executionId: "abc-123",           // Bolna execution ID
  recipientPhone: "+1234567890",    // Who was called
  recipientName: "John Doe",        // Candidate/Recruiter name
  status: "completed",              // Call status
  transcript: "...",                // Full conversation
  recordingUrl: "https://...",      // Call recording
  duration: 180,                    // Call duration (seconds)
  language: "en",                   // Language used
  createdAt: "2026-02-19...",      // When webhook received
  raw: { /* full Bolna payload */ }
}
```

---

## 🎯 Configuration for Both Agents

### Agent 1: Job Verification (Recruiter)
**Bolna Dashboard:**
- Agent Name: Job Verification Agent
- Agent ID: `BOLNA_AGENT_ID=6afbccea-0495-4892-937c-6a5c9af12440`
- Webhook: `https://your-domain.com/api/v1/webhooks/bolna-calls`
- Purpose: Verify job postings with recruiters

### Agent 2: Candidate Verification (Student)
**Bolna Dashboard:**
- Agent Name: Job Application Verification Agent
- Agent ID: `BOLNA_CANDIDATE_AGENT_ID=your_new_agent_id`
- Webhook: `https://your-domain.com/api/v1/webhooks/bolna-calls`
- Purpose: Thank candidates for applying

**Both use the SAME webhook URL!**

---

## 📝 How to Add Webhook to Bolna

### For Both Agents:

1. **Login to Bolna Dashboard**
   - Go to https://app.bolna.ai
   - Login with your account

2. **Configure Agent 1 (Job Verification)**
   - Click on your **Job Verification Agent**
   - Go to **Settings** → **Webhooks**
   - Add webhook URL: `https://your-domain.com/api/v1/webhooks/bolna-calls`
   - Enable: ✅
   - Save

3. **Configure Agent 2 (Candidate Verification)**
   - Click on your **Candidate Verification Agent**
   - Go to **Settings** → **Webhooks**
   - Add webhook URL: `https://your-domain.com/api/v1/webhooks/bolna-calls`
   - Enable: ✅
   - Save

---

## 🔍 How the Backend Identifies Which Agent

The webhook handler doesn't need to distinguish between agents because:

1. **Execution ID is Unique** → Each call has unique execution ID
2. **CallRecord Purpose Field** → Set when call initiated:
   - Job verification: `purpose: 'job_verification'`
   - Candidate application: `purpose: 'job_application_verification'`
3. **Related Records** → Linked to Job or JobApplication
4. **Same Storage** → All calls stored in `CallRecord` model

---

## 🧪 Testing the Webhook

### Test Webhook Endpoint

```bash
# Test if webhook endpoint is accessible
curl -X POST https://your-domain.com/api/v1/webhooks/bolna-calls \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'

# Should return:
{
  "success": true,
  "executionId": null,
  "message": "Webhook received and stored"
}
```

### Monitor Webhook Calls

```bash
# Watch backend logs
tail -f logs/combined.log | grep -E "(webhook|Bolna)"

# Check database
db.callrecords.find().sort({ createdAt: -1 }).limit(5)
```

---

## 📊 Webhook Payload Structure

Bolna sends this data to your webhook:

```json
{
  "id": "execution-id-123",
  "agent_id": "6afbccea-0495-4892-937c-6a5c9af12440",
  "status": "completed",
  "recipient_phone_number": "+1234567890",
  "duration": 180,
  "transcript": "Full conversation text...",
  "recording_url": "https://bolna.ai/recordings/...",
  "language": "en",
  "created_at": "2026-02-19T10:30:00Z",
  "user_data": {
    "candidate_name": "John Doe",
    "job_title": "Software Engineer",
    ...
  }
}
```

The backend automatically processes this and stores it.

---

## ✅ Verification Checklist

### Setup Complete When:

- [ ] Both agents created in Bolna dashboard
- [ ] Webhook URL added to both agents
- [ ] `BOLNA_AGENT_ID` set in `.env`
- [ ] `BOLNA_CANDIDATE_AGENT_ID` set in `.env`
- [ ] Backend restarted
- [ ] Test call made (job or application)
- [ ] Webhook received (check logs)
- [ ] CallRecord created in database

### Check Backend Logs:

```bash
grep "Webhook received" logs/combined.log
```

Should see:
```
Webhook received and stored: execution-id-123
```

### Check Database:

```javascript
// Check call records
db.callrecords.find({ 
  executionId: { $exists: true } 
}).sort({ createdAt: -1 })

// Should show records with:
// - transcript
// - recordingUrl
// - status: "completed"
```

---

## 🐛 Troubleshooting

### Webhook Not Receiving Data

**Problem**: No calls stored in database

**Check**:
1. Is webhook URL correct in Bolna dashboard?
2. Is domain accessible from internet (not localhost)?
3. Is webhook enabled in Bolna?

**Fix**:
- For local testing, use ngrok
- Check firewall/security groups
- Verify webhook URL format

### Test Webhook Manually:

```bash
# From Bolna dashboard
# Settings → Webhooks → Test Webhook

# Or use curl
curl -X POST https://your-domain.com/api/v1/webhooks/bolna-calls \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-123",
    "status": "completed",
    "recipient_phone_number": "+1234567890"
  }'
```

### Calls Not Showing Transcript

**Problem**: CallRecord exists but no transcript

**Possible Causes**:
1. Call still in progress
2. Transcript not available yet
3. Webhook not sent by Bolna

**Solution**:
- Wait a few minutes after call completes
- Check Bolna dashboard for transcript
- Run sync manually: `POST /api/v1/bolna/sync-missing`

---

## 📂 Related Files

### Routes
- `src/routes/v1/webhook.route.js` - Webhook endpoints

### Controllers
- `src/controllers/bolna.controller.js` - Webhook handler (`receiveWebhook`)

### Services
- `src/services/callRecord.service.js` - Process webhook data (`createFromWebhook`)
- `src/services/bolna.service.js` - Bolna API client

### Models
- `src/models/callRecord.model.js` - Call records storage

---

## 🎉 Summary

✅ **Single Webhook for Both Agents**
- URL: `/api/v1/webhooks/bolna-calls`
- Handles both job verification and candidate application calls
- Automatically stores all call data

✅ **What Gets Stored**
- Execution ID
- Call status
- Transcript
- Recording URL
- Duration
- Metadata

✅ **Setup Steps**
1. Add webhook URL to both Bolna agents
2. Ensure agents are configured in `.env`
3. Restart backend
4. Make test calls
5. Verify data in database

**The webhook is ready to receive data from both agents!** 🚀
