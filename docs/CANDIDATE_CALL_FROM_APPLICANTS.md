# Candidate Verification Calls from Job Applicants Panel

## Overview

This feature allows you to initiate candidate verification calls directly from the job applicants panel in the ATS interface. You can select individual candidates (or multiple candidates) and initiate verification calls using the `BOLNA_CANDIDATE_AGENT_ID` agent.

## Key Features

1. **Selective Calling**: Select individual candidates from the applicants list using checkboxes
2. **Multi-Select Support**: Call multiple candidates at once by selecting them
3. **Select All**: Quickly select all candidates with phone numbers using the header checkbox
4. **Smart Filtering**: Only candidates with valid phone numbers can be selected
5. **Visual Feedback**: Selected candidates are highlighted with a light blue background
6. **Separate Agent**: Uses `BOLNA_CANDIDATE_AGENT_ID` (not the job recruiter verification agent)
7. **Tab-Specific**: The "Initiate Call" button behavior changes based on the active tab:
   - **Applicants Tab**: Calls selected candidates (candidate verification)
   - **Job Details Tab**: Calls the job recruiter (job verification - original behavior)

## How to Use

### From the Frontend (ATS Jobs Page)

1. **Open a Job**: Click on any job in the jobs list to open the preview panel
2. **Switch to Applicants Tab**: Click on the "Applicants" tab
3. **Select Candidates**: 
   - Check the boxes next to candidates you want to call
   - Or use the header checkbox to select all candidates with phone numbers
   - Candidates without phone numbers cannot be selected (checkbox is disabled)
4. **Initiate Calls**: Click the "Call Selected (N)" button at the bottom
5. **Confirmation**: You'll get an alert with the number of calls initiated

### Visual Indicators

- **Phone Icon**: Candidates without phone numbers show a gray phone icon
- **Selected Row**: Selected candidates have a light blue background (`bg-primary/5`)
- **Button State**: 
  - Shows count of selected candidates: "Call Selected (3)"
  - Changes to "Calling Candidates..." while processing
  - Button is disabled if no candidates are selected
- **Header Counter**: Shows "(N selected)" next to the "Applied" heading when candidates are selected

## Backend API

### Endpoint

```
POST /v1/bolna/candidate-call
```

### Request Body

```json
{
  "candidateId": "507f1f77bcf86cd799439011",
  "candidateName": "John Doe",
  "email": "john@example.com",
  "phoneNumber": "9876543210",
  "countryCode": "IN",
  "jobId": "507f1f77bcf86cd799439012",
  "jobTitle": "Senior Developer",
  "companyName": "Acme Corp"
}
```

### Response

```json
{
  "success": true,
  "executionId": "exec_abc123xyz",
  "message": "Candidate verification call initiated successfully"
}
```

### What Happens Behind the Scenes

1. **Candidate & Job Validation**: Verifies both candidate and job exist
2. **Phone Formatting**: Formats phone number to E.164 format (`+919876543210`)
3. **Context Preparation**: Prepares call context with:
   - Candidate name, email
   - Job title, company name
   - Job type, location, experience level
   - Salary range (in words)
4. **Call Initiation**: Calls Bolna API using `BOLNA_CANDIDATE_AGENT_ID`
5. **Record Creation**: Creates a call record with `purpose: 'job_application_verification'`
6. **Application Update**: Updates the `JobApplication` with:
   - `verificationCallExecutionId`: The Bolna execution ID
   - `verificationCallStatus`: 'initiated'
   - `verificationCallInitiatedAt`: Current timestamp

## Webhook Handling

Candidate verification calls use a **separate webhook** from job recruiter calls:

- **Job Recruiter Calls**: `/v1/webhooks/bolna-calls`
- **Candidate Calls**: `/v1/webhooks/bolna-candidate-calls`

### Webhook Configuration

In your Bolna agent dashboard for `BOLNA_CANDIDATE_AGENT_ID`, set:

```
Webhook URL: https://your-domain.com/v1/webhooks/bolna-candidate-calls
```

### What the Webhook Does

1. Creates/updates the call record in the database
2. Automatically updates the `JobApplication` status based on call outcome:
   - `completed`: Call was successful
   - `failed`: Call failed or error occurred
   - `no_answer`: No answer or busy

## Database Schema Updates

### JobApplication Model

```javascript
{
  verificationCallExecutionId: String,
  verificationCallStatus: {
    type: String,
    enum: ['pending', 'initiated', 'completed', 'failed', 'no_answer']
  },
  verificationCallInitiatedAt: Date
}
```

### CallRecord Model

```javascript
{
  purpose: {
    type: String,
    enum: ['job_posting_verification', 'job_application_verification']
  },
  candidate: { type: Schema.Types.ObjectId, ref: 'Candidate' },
  job: { type: Schema.Types.ObjectId, ref: 'Job' }
}
```

## Code Changes Summary

### Frontend

1. **JobPreviewPanel.tsx**: 
   - Added state for `selectedCandidates` and `callingCandidates`
   - Added checkboxes to applicant table (with "select all" in header)
   - Modified "Initiate Call" button to change behavior based on active tab
   - Added `handleInitiateCandidateCall` function for calling selected candidates
   - Added `useEffect` to reset selections when switching tabs

2. **bolna.ts**: 
   - Added `InitiateCandidateVerificationCallParams` type
   - Added `initiateCandidateVerificationCall` function

3. **jobApplications.ts**: 
   - Added `countryCode` to candidate type in `JobApplication` interface

### Backend

1. **bolna.route.js**: 
   - Added `/candidate-call` POST route

2. **bolna.validation.js**: 
   - Added `initiateCandidateCall` validation schema

3. **bolna.controller.js**: 
   - Added `initiateCandidateCall` controller function
   - Handles phone formatting, context preparation, call initiation, and record creation

4. **jobApplication.service.js**: 
   - Updated `populate` calls to include `countryCode` field

## Phone Number Formatting

The system handles phone numbers robustly:

1. **Remove non-digits**: `phoneNumber.replace(/\D/g, '')`
2. **Add country prefix** if not present (91, 1, 44, 61 based on countryCode)
3. **Add + prefix**: For E.164 format
4. **Validate length**: Must be 10-15 digits (excluding the + sign)

Example:
- Input: `9876543210`, countryCode: `IN`
- Output: `+919876543210`

## Testing

### Test the Feature

1. Create a candidate with a valid phone number
2. Have them apply to a job (or manually create a job application)
3. Go to ATS Jobs page → Click on the job → Applicants tab
4. Select the candidate and click "Call Selected (1)"
5. Check the console logs for call initiation
6. Verify in the database:
   - `CallRecord` created with correct `purpose`, `candidate`, `job`
   - `JobApplication` updated with `verificationCallExecutionId`, `verificationCallStatus`, `verificationCallInitiatedAt`

### Monitor Calls

- Check backend logs for call initiation messages (📞, ✅ emojis)
- Use the Call Records page in the admin panel to see all calls
- Check the Bolna dashboard for execution details

## Important Notes

1. **No Job Verification Changes**: The original job verification call functionality (calling recruiters from the Job Details tab) remains completely unchanged
2. **Separate Agents**: Candidate calls use `BOLNA_CANDIDATE_AGENT_ID`, job calls use `BOLNA_AGENT_ID`
3. **Separate Webhooks**: Each agent has its own webhook URL for proper tracking
4. **Error Handling**: If a call fails for one candidate, others will still be attempted
5. **Phone Number Required**: Candidates without phone numbers cannot be selected for calls

## Environment Variables

```env
BOLNA_API_KEY=your_bolna_api_key
BOLNA_AGENT_ID=your_job_verification_agent_id
BOLNA_CANDIDATE_AGENT_ID=your_candidate_verification_agent_id
```

## Related Documentation

- [BOLNA.md](./BOLNA.md) - Bolna overview, env vars, doc index
- [BOLNA_APPLICATION_CALLS_SETUP.md](./BOLNA_APPLICATION_CALLS_SETUP.md) - Job application verification calls (Bolna)
- [SEPARATE_WEBHOOKS.md](./SEPARATE_WEBHOOKS.md) - Webhook configuration details
