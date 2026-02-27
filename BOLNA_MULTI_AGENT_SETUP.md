# Bolna Multi-Agent Setup Summary

## Overview

Your system now supports **two separate Bolna agents**:

1. **General Agent** (`BOLNA_AGENT_ID`) - Your existing agent (ID: `6afbccea-0495-4892-937c-6a5c9af12440`)
2. **Candidate Verification Agent** (`BOLNA_CANDIDATE_AGENT_ID`) - New agent for job application verification calls

## Configuration

### Environment Variables

**`.env` file:**
```env
# Bolna API Configuration
BOLNA_API_KEY=bn-d32269d4ecf34227b9b929655e9dbf2f
BOLNA_FROM_PHONE_NUMBER=+18336990430

# Existing general agent
BOLNA_AGENT_ID=6afbccea-0495-4892-937c-6a5c9af12440

# NEW: Candidate verification agent (update after creating in Bolna dashboard)
BOLNA_CANDIDATE_AGENT_ID=your_new_agent_id_here
```

### How It Works

1. **Default Behavior**: When `BOLNA_CANDIDATE_AGENT_ID` is not set, the system falls back to using `BOLNA_AGENT_ID`

2. **Candidate Verification Calls**: The application verification scheduler automatically uses `BOLNA_CANDIDATE_AGENT_ID` for post-application calls

3. **General Calls**: Other parts of your system continue to use `BOLNA_AGENT_ID`

## Setup Steps

### Step 1: Create the Agent in Bolna Dashboard

1. Go to https://app.bolna.ai
2. Navigate to **Create Agent**
3. Use the configuration from `BOLNA_QUICK_SETUP.md`:
   - Copy each section into the corresponding field
   - All variables ({{candidate_name}}, {{job_title}}, etc.) are included
4. **Save** and copy the new Agent ID

### Step 2: Update Configuration

Update your `.env` file:
```env
BOLNA_CANDIDATE_AGENT_ID=<paste_your_new_agent_id_here>
```

### Step 3: Restart Backend

```bash
cd uat.dharwin.backend
npm run dev
```

### Step 4: Test

1. Go to the public job portal
2. Apply for a job as a candidate
3. Check the backend logs for call initiation
4. Monitor the call in Bolna dashboard

## Technical Details

### Code Changes Made

1. **`src/config/config.js`**
   - Added `BOLNA_CANDIDATE_AGENT_ID` to Joi schema
   - Added `candidateAgentId` to config export with fallback logic

2. **`src/services/bolna.service.js`**
   - Updated `initiateCall()` to accept optional `agentId` parameter
   - Allows overriding the default agent ID per call

3. **`src/services/applicationVerificationCall.scheduler.js`**
   - Updated to pass `agentId: config.bolna.candidateAgentId` when initiating calls
   - Ensures candidate verification calls use the dedicated agent

4. **`.env` and `.env.example`**
   - Added `BOLNA_CANDIDATE_AGENT_ID` with documentation

### Fallback Logic

```javascript
// In config.js
candidateAgentId: envVars.BOLNA_CANDIDATE_AGENT_ID || 
                  envVars.BOLNA_AGENT_ID || 
                  '6afbccea-0495-4892-937c-6a5c9af12440'
```

**Priority:**
1. Use `BOLNA_CANDIDATE_AGENT_ID` if set
2. Fall back to `BOLNA_AGENT_ID` if not set
3. Fall back to hardcoded default

## Variables Available to Agents

Both agents have access to these dynamic variables:

| Variable | Source | Example |
|----------|--------|---------|
| `{{candidate_name}}` | Candidate model | Sarah Johnson |
| `{{candidate_email}}` | Candidate model | sarah@email.com |
| `{{job_title}}` | Job model | Senior Software Engineer |
| `{{job_type}}` | Job model | Full-time |
| `{{location}}` | Job model | San Francisco, CA |
| `{{experience_level}}` | Job model | Senior Level |
| `{{salary_range}}` | Job model | $150K to $180K per year |
| `{{company_name}}` | Job.organisation | TechCorp Inc. |
| `{{application_date}}` | JobApplication model | February 19, 2026 |

See `BOLNA_AGENT_VARIABLES.md` for complete variable reference.

## Monitoring

### Backend Logs
```bash
# Watch for call initiation
tail -f logs/combined.log | grep "verification call"
```

### Bolna Dashboard
- View all calls: https://app.bolna.ai/calls
- Check agent performance
- Listen to call recordings
- Review transcripts

### Database
```javascript
// Check applications with calls
db.jobapplications.find({
  verificationCallExecutionId: { $exists: true, $ne: null }
})

// Check call records
db.callrecords.find({
  purpose: 'job_application_verification'
}).sort({ createdAt: -1 })
```

## Troubleshooting

### Call Not Initiated

**Problem**: No call after job application

**Check:**
1. Is `BOLNA_CANDIDATE_AGENT_ID` set in `.env`?
2. Is backend server restarted after updating `.env`?
3. Does candidate have valid phone number and country code?
4. Check backend logs for errors

**Solution:**
```bash
# Check logs
grep "verification call" logs/combined.log

# Verify config
node -e "import('./src/config/config.js').then(c => console.log(c.default.bolna))"
```

### Variables Not Showing in Call

**Problem**: Agent says "{{candidate_name}}" instead of actual name

**Check:**
1. Are variables formatted with double curly braces in agent prompt?
2. Is `user_data` being passed correctly in the API call?

**Solution:**
Check the scheduler logs to see what data is being sent:
```javascript
// In applicationVerificationCall.scheduler.js
console.log('Bolna context:', context);
```

### Wrong Agent Being Used

**Problem**: General agent is being used instead of candidate agent

**Check:**
1. Is `BOLNA_CANDIDATE_AGENT_ID` set?
2. Is the scheduler passing the agent ID?

**Solution:**
```javascript
// Verify in bolna.service.js
console.log('Using agent ID:', payload.agent_id);
```

## Benefits of Separate Agents

1. **Specialized Prompts**: Each agent optimized for its specific purpose
2. **Independent Monitoring**: Track candidate calls separately
3. **A/B Testing**: Test different approaches for each use case
4. **Scalability**: Easy to add more specialized agents
5. **Maintenance**: Update one agent without affecting others

## Next Steps

1. ✅ Create candidate verification agent in Bolna dashboard
2. ✅ Update `BOLNA_CANDIDATE_AGENT_ID` in `.env`
3. ✅ Restart backend server
4. ✅ Test with a real job application
5. ✅ Monitor first few calls
6. ✅ Refine agent prompt based on feedback
7. ✅ Scale up once satisfied with performance

## Support

- **Bolna Documentation**: https://docs.bolna.ai
- **Bolna Dashboard**: https://app.bolna.ai
- **Setup Guide**: See `BOLNA_QUICK_SETUP.md`
- **Complete Prompt**: See `BOLNA_AGENT_COMPLETE_PROMPT.md`
- **Variable Reference**: See `BOLNA_AGENT_VARIABLES.md`
