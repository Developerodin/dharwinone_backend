# Bolna Agent Setup for Job Application Verification Calls

This document explains how to set up a Bolna AI agent to automatically call candidates after they apply for jobs, thank them, verify their details, and provide job information.

## Overview

The system automatically:
1. Detects new job applications (within 10 minutes)
2. Initiates a call to the candidate's phone number
3. Thanks them for applying
4. Verifies their contact information
5. Provides detailed job information
6. Records the conversation for future reference

## Architecture

```
Job Application Created
        ↓
Application Scheduler (runs every 2 min)
        ↓
Find applications without verification calls
        ↓
Call Bolna API with candidate + job context
        ↓
Bolna Agent calls candidate
        ↓
Conversation recorded & synced
        ↓
Application status updated
```

## Prerequisites

1. **Bolna AI Account**: Sign up at https://bolna.ai
2. **Bolna API Key**: Get from Bolna dashboard
3. **Bolna Agent ID**: Create an agent in Bolna dashboard
4. **Phone Number**: Verified caller ID in Bolna (for outbound calls)

## Environment Variables

Add these to your `.env` file:

```bash
# Bolna Configuration
BOLNA_API_KEY=your_bolna_api_key_here
BOLNA_AGENT_ID=your_bolna_agent_id_here
BOLNA_FROM_PHONE_NUMBER=+1234567890  # Your verified caller ID
BOLNA_API_BASE=https://api.bolna.ai
```

## Bolna Agent Configuration

### Agent Prompt Template

Create a new agent in Bolna dashboard with this prompt:

```
You are a friendly recruitment assistant calling on behalf of {{company_name}}.

Your role is to:
1. Thank the candidate for applying to the {{job_title}} position
2. Verify their contact information (phone and email)
3. Provide details about the job they applied for
4. Answer any initial questions they might have
5. Inform them about next steps in the hiring process

CONTEXT PROVIDED:
- Candidate Name: {{candidate_name}}
- Job Title: {{job_title}}
- Company: {{company_name}}
- Job Type: {{job_type}}
- Location: {{location}}
- Experience Level: {{experience_level}}
- Salary Range: {{salary_range}}
- Application Date: {{applicationDate}}
- Candidate Email: {{candidate_email}}

CONVERSATION FLOW:

1. GREETING:
   "Hello, this is the recruitment assistant calling from {{company_name}}. 
   May I speak with {{candidate_name}}?"

2. PURPOSE:
   "Thank you for applying to our {{job_title}} position on {{applicationDate}}. 
   I'm calling to thank you for your interest and share some important details about the role."

3. VERIFY DETAILS:
   "Before we continue, I'd like to verify your contact information. 
   Can you confirm your email address is {{candidate_email}}?"

4. JOB DETAILS:
   "Let me share some key details about the position:
   - Position: {{job_title}}
   - Job Type: {{job_type}}
   - Location: {{location}}
   - Experience Level: {{experience_level}}
   - Salary Range: {{salary_range}}
   
   Our hiring team will review your application and contact you within 3-5 business days 
   if your profile matches our requirements."

5. Q&A:
   "Do you have any questions about the role or the application process?"

6. CLOSING:
   "Thank you for your time and interest in {{company_name}}. 
   We wish you the best with your application. Have a great day!"

IMPORTANT GUIDELINES:
- Be warm, professional, and concise
- If the candidate is busy, offer to call back at a better time
- If they have detailed questions, direct them to email the HR team
- Keep the call under 3-4 minutes
- Always end on a positive note
```

### Agent Settings

**Voice Settings:**
- Language: English (US)
- Voice: Choose a professional, friendly voice
- Speed: Normal
- Pitch: Default

**Call Settings:**
- Max Call Duration: 5 minutes
- End Call on Silence: 30 seconds
- Enable Recording: Yes
- Enable Transcript: Yes

**Context Variables:**
The system automatically provides these variables:
- `candidate_name` - Full name of the applicant
- `job_title` - Title of the job they applied for
- `company_name` - Organization name
- `job_type` - Full-time, Part-time, etc.
- `location` - Job location
- `experience_level` - Entry, Mid, Senior, Executive
- `salary_range` - Formatted salary range in words
- `applicationDate` - Date they applied
- `candidate_email` - Their email address

## Database Schema

The `JobApplication` model includes these fields for tracking verification calls:

```javascript
{
  // ... existing fields ...
  verificationCallExecutionId: String,    // Bolna execution ID
  verificationCallInitiatedAt: Date,       // When call was initiated
  verificationCallStatus: String,          // pending, completed, failed, no_answer
}
```

## Scheduler Configuration

The scheduler runs every **2 minutes** by default and:

1. **Find Applications**: Queries for applications created in last 10 minutes without verification calls
2. **Validate Phone**: Ensures candidate has a valid phone number
3. **Format Context**: Prepares all job and candidate data for Bolna
4. **Initiate Call**: Calls Bolna API to start the call
5. **Track Status**: Creates a call record and updates application
6. **Sync Results**: Periodically fetches call outcomes from Bolna

## Call Records

All calls are tracked in the `CallRecord` collection with:

```javascript
{
  executionId: String,              // Bolna execution ID
  recipientPhone: String,           // Candidate's phone
  recipientName: String,            // Candidate's name
  recipientEmail: String,           // Candidate's email
  purpose: 'job_application_verification',
  relatedJobApplication: ObjectId, // Link to application
  relatedJob: ObjectId,            // Link to job
  relatedCandidate: ObjectId,      // Link to candidate
  status: String,                  // initiated, completed, failed, etc.
  transcript: String,              // Call transcript (synced later)
  recordingUrl: String,            // Recording URL (synced later)
  duration: Number,                // Call duration in seconds
  // ... more fields ...
}
```

## Monitoring

### Check Scheduler Status

The scheduler logs to console:

```bash
# Start message
📞 Application verification call scheduler started (every 2 min)

# Per application
Found 3 applications needing verification calls
Initiating verification call for application 123abc to +1234567890
✅ Verification call initiated for John Doe (+1234567890)

# Sync results
Synced application call record abc123 with transcript/recording from Bolna
Application call records sync completed: 5 executions synced
```

### View Call Records

Query the database:

```javascript
// Find recent verification calls
db.callrecords.find({ 
  purpose: 'job_application_verification' 
}).sort({ createdAt: -1 }).limit(10)

// Find calls for specific application
db.callrecords.find({ 
  relatedJobApplication: ObjectId('application_id_here') 
})

// Check application call status
db.jobapplications.find({
  verificationCallExecutionId: { $exists: true }
}).count()
```

## Testing

### Test with a Single Application

1. Create a test job application via the public portal
2. Ensure candidate has a valid phone number
3. Check logs for scheduler activity within 2 minutes
4. Verify call record is created in database
5. Check Bolna dashboard for execution details

### Manual Trigger (for debugging)

```javascript
// In Node.js REPL or script
import scheduler from './src/services/applicationVerificationCall.scheduler.js';

// Run once immediately
await scheduler.run();
```

## Troubleshooting

### Issue: No calls being initiated

**Check:**
1. `BOLNA_API_KEY` is set in `.env`
2. `BOLNA_AGENT_ID` is correct
3. Scheduler is running (check logs)
4. Applications have valid phone numbers
5. Applications are less than 10 minutes old

### Issue: Calls failing

**Check:**
1. Phone numbers are in E.164 format (+1234567890)
2. `BOLNA_FROM_PHONE_NUMBER` is verified in Bolna
3. Bolna account has credits/quota
4. Check Bolna dashboard for error details

### Issue: Transcripts not syncing

**Check:**
1. Call record sync scheduler is running
2. Bolna API is accessible
3. Check logs for sync errors
4. Wait at least 5-10 minutes after call (Bolna processing time)

## Production Considerations

1. **Call Timing**: Consider time zones - don't call late at night
2. **Volume**: Monitor Bolna quota/credits for high application volumes
3. **Phone Verification**: Validate phone numbers in application form
4. **Retry Logic**: Failed calls are not retried (by design)
5. **Privacy**: Store call recordings securely, comply with regulations
6. **Opt-out**: Provide mechanism for candidates to opt out of calls

## Cost Estimation

Bolna pricing (as of 2024):
- ~$0.02-0.05 per minute of call
- Average call: 3-4 minutes = ~$0.10-0.20 per call

For 100 applications/day:
- Daily cost: $10-20
- Monthly cost: $300-600

## Future Enhancements

Potential improvements:
- [ ] Schedule calls based on candidate's timezone
- [ ] Retry failed calls (with exponential backoff)
- [ ] A/B test different agent prompts
- [ ] Sentiment analysis of conversations
- [ ] Automatic scheduling of interviews for positive responses
- [ ] Multi-language support based on candidate preference

## Support

For issues or questions:
- Bolna Documentation: https://docs.bolna.ai
- Bolna Dashboard: https://app.bolna.ai
- Internal Team: Contact backend development team
