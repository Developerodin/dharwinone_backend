# Public Job Application - Candidate Visibility & Verification Call Setup

## Issues Fixed

### 1. **Candidate Not Visible in Candidates List** ✅

**Problem**: When candidates applied through the public job portal, they were created but only visible in the "Users" list, not in the "Candidates" list.

**Root Cause**: The candidate controller filters candidates by `owner: req.user._id` if the user doesn't have `candidates.manage` permission. Self-registered candidates had `owner: user._id` (themselves), so they weren't visible to admins.

**Solution**: Assign public applicants to the job creator/owner instead of themselves.

**File Changed**: `uat.dharwin.backend/src/services/job.service.js`

```javascript
// Before (line 567-569)
const candidateData = {
  owner: user._id,
  adminId: user._id, // Self-registered candidates
  ...
};

// After
const candidateData = {
  owner: jobCreatorId || user._id, // Assign to job creator
  adminId: jobCreatorId || user._id, // Use same for adminId
  ...
};
```

Now candidates who apply through public links will:
- Show up in the job creator's candidates list
- Be manageable by the admin who posted the job
- Still have their own user account for login

---

### 2. **Verification Call on Job Application** ✅

**Problem**: No automated verification call was initiated when candidates applied through the public portal.

**Solution**: Added Bolna verification call immediately after application submission.

**File Changed**: `uat.dharwin.backend/src/services/job.service.js`

**Features Added**:
- Initiates Bolna call using `BOLNA_CANDIDATE_AGENT_ID`
- Formats phone number to E.164 format automatically
- Passes all job and candidate details to the agent
- Creates call record for tracking
- Updates JobApplication with call execution ID
- Runs asynchronously (doesn't block application submission)

**Variables Passed to Bolna Agent**:
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

### 3. **Auto-Assign Student Role** ✅

**Problem**: Public applicants need to have the "Student" role automatically assigned so they have proper permissions and access to training features.

**Solution**: Automatically assign Student role during user creation.

**File Changed**: `uat.dharwin.backend/src/services/job.service.js`

```javascript
// Get Student role for auto-assignment
const { getRoleByName } = await import('./role.service.js');
const studentRole = await getRoleByName('Student');

// Create new user with Student role
const user = await User.create({
  name: fullName,
  email: email.toLowerCase(),
  password,
  phoneNumber,
  countryCode,
  role: 'user', // Base role
  roleIds: [studentRole._id], // Student role assigned
  status: 'active',
});
```

**Benefits**:
- Public applicants automatically get Student role
- Access to training modules and student features
- Visible in Users list with proper role badge
- Compatible with existing Student management features

---

## Implementation Details

### Call Flow

1. **User Applies** → Public job application form
2. **User Created** → New user account with `Student` role ✅
3. **Candidate Created** → Candidate profile assigned to job creator
4. **Application Created** → JobApplication record
5. **Welcome Email Sent** → Email with credentials and login link
6. **✨ Verification Call Initiated** → Bolna calls candidate immediately
7. **Call Record Created** → Tracked in database
8. **Application Updated** → Marked with call execution ID

### Code Location

All changes in: `uat.dharwin.backend/src/services/job.service.js`

**Starting Line**: ~608 (after welcome email)

**Key Code Block**:
```javascript
// Initiate verification call via Bolna (async, don't wait)
if (phoneNumber && countryCode) {
  const bolnaService = (await import('./bolna.service.js')).default;
  
  // Format phone number to E.164
  let formattedPhone = phoneNumber.replace(/\D/g, '');
  if (!formattedPhone.startsWith('+')) {
    const countryPrefix = getCountryPrefix(countryCode);
    formattedPhone = `${countryPrefix}${formattedPhone}`;
  }

  // Prepare context for Bolna agent
  const callContext = {
    phone: formattedPhone,
    agentId: config.bolna.candidateAgentId, // Uses separate agent
    candidate_name: fullName,
    candidate_email: email,
    job_title: job.title,
    // ... all other variables
  };

  // Initiate call
  bolnaService.initiateCall(callContext).then((result) => {
    if (result.success) {
      // Update application & create call record
    }
  });
}
```

---

## Environment Configuration

### Required Variables

```env
# Existing Bolna configuration
BOLNA_API_KEY=bn-d32269d4ecf34227b9b929655e9dbf2f
BOLNA_FROM_PHONE_NUMBER=+18336990430

# General agent (existing)
BOLNA_AGENT_ID=6afbccea-0495-4892-937c-6a5c9af12440

# NEW: Candidate verification agent
BOLNA_CANDIDATE_AGENT_ID=your_new_agent_id_here
```

### Setup Steps

1. ✅ Create Bolna agent using `BOLNA_QUICK_SETUP.md`
2. ✅ Copy agent ID from Bolna dashboard
3. ✅ Update `BOLNA_CANDIDATE_AGENT_ID` in `.env`
4. ✅ Restart backend server

---

## Testing

### Test Public Application

1. **Open Public Job URL**: `/public-job/{jobId}`
2. **Fill Application Form**:
   - Full Name
   - Email
   - Password
   - Phone Number (with country code)
   - Resume (required)
   - Cover Letter (optional)
3. **Submit Application**

### Expected Results

✅ Application submitted successfully  
✅ User created with `Student` role assigned via roleIds  
✅ Candidate visible in admin's candidates list  
✅ JobApplication created with status "Applied"  
✅ Welcome email sent with login credentials  
✅ **Verification call initiated within seconds**  
✅ Call record created in database  
✅ Application updated with `verificationCallExecutionId`

### Verify Student Role Assignment

**Check in UI**:
1. Go to **Settings → Users**
2. Find the newly registered user
3. Verify they have "Student" role badge

**Check in Database**:
```javascript
// Find the user
db.users.findOne({ email: "john@example.com" })

// Should have:
{
  role: 'user',
  roleIds: [ObjectId("...")], // Student role ID
  status: 'active'
}

// Verify Student role
db.roles.findOne({ name: 'Student' })
// The ObjectId should match the one in user's roleIds
```

### Check Logs

```bash
# Backend logs for verification call
tail -f uat.dharwin.backend/logs/combined.log | grep "verification call"

# Should see:
# ✅ Verification call initiated for John Doe (+1234567890) - Execution: abc-123
```

### Check Bolna Dashboard

1. Go to https://app.bolna.ai
2. Navigate to **Calls** section
3. Verify recent call to the candidate's phone
4. Listen to recording (if available)
5. Review transcript

### Check Database

```javascript
// Check application has call ID
db.jobapplications.findOne({ 
  candidate: ObjectId("...") 
})
// Should have: verificationCallExecutionId, verificationCallInitiatedAt, verificationCallStatus

// Check call record
db.callrecords.findOne({ 
  executionId: "abc-123" 
})
// Should exist with purpose: 'job_application_verification'
```

---

## Database Schema Updates

### JobApplication Model

Already has these fields (no migration needed):
- `verificationCallExecutionId`: String
- `verificationCallInitiatedAt`: Date
- `verificationCallStatus`: Enum ['pending', 'completed', 'failed', 'no_answer']

### CallRecord Model

Already supports:
- `purpose: 'job_application_verification'`
- `relatedJobApplication`: Reference to JobApplication
- `relatedJob`: Reference to Job
- `relatedCandidate`: Reference to Candidate

---

## Error Handling

### Call Initiation Failures

The system gracefully handles failures:

**Scenarios**:
- No phone number provided → Call skipped silently
- Invalid phone format → Call skipped with warning
- Bolna API error → Application still succeeds, error logged
- Network timeout → Application still succeeds, error logged

**Important**: Application submission NEVER fails due to call issues. The call is initiated asynchronously after the application is saved.

### Logging

```javascript
// Success
console.log(`✅ Verification call initiated for ${fullName} (${phone}) - Execution: ${executionId}`);

// Failure
console.warn(`❌ Verification call failed for ${fullName}: ${error}`);

// Error
console.error('Failed to initiate verification call:', err);
```

---

## Monitoring

### Real-Time Monitoring

```bash
# Watch for new applications and calls
tail -f logs/combined.log | grep -E "(Application|verification call)"
```

### Scheduled Sync

The existing scheduler (`applicationVerificationCall.scheduler.js`) runs every 2 minutes and will:
- Pick up any missed calls (if direct initiation failed)
- Sync call statuses from Bolna
- Update application records

### Bolna Dashboard

- View all calls: https://app.bolna.ai/calls
- Filter by agent ID: `BOLNA_CANDIDATE_AGENT_ID`
- Review recordings and transcripts
- Check call success rate

---

## Benefits

1. **✨ Immediate Engagement**: Candidates receive a call within seconds of applying
2. **📞 Professional Experience**: Automated yet personalized verification
3. **✅ Data Verification**: Email and contact details verified during call
4. **📊 Better Tracking**: All calls recorded and linked to applications
5. **👥 Admin Visibility**: Self-registered candidates now visible in admin's list
6. **🔄 Seamless Integration**: Works with existing scheduler and call records

---

## Troubleshooting

### Candidate Not Visible in List

**Check**:
1. Is the candidate created? Look in Users list
2. Check candidate's `owner` field in database
3. Verify admin has `candidates.manage` permission

**Solution**: Already fixed - candidates are now assigned to job creator

### Call Not Initiated

**Check**:
1. Is `BOLNA_CANDIDATE_AGENT_ID` set in `.env`?
2. Is backend server restarted after `.env` change?
3. Does candidate have valid phone number?
4. Check backend logs for errors

**Debug**:
```bash
# Check config
node -e "import('./src/config/config.js').then(c => console.log(c.default.bolna))"

# Check logs
grep "verification call" logs/combined.log
```

### Call Fails

**Common Causes**:
- Phone number not in E.164 format → Auto-formatted now
- Bolna API key invalid → Check `.env`
- Agent ID incorrect → Verify in Bolna dashboard
- Phone number not verified in Bolna (trial accounts)

**Solution**: Check Bolna dashboard for specific error message

---

## Related Files

- `uat.dharwin.backend/src/services/job.service.js` - Main implementation
- `uat.dharwin.backend/src/services/bolna.service.js` - Call initiation
- `uat.dharwin.backend/src/services/applicationVerificationCall.scheduler.js` - Backup scheduler
- `uat.dharwin.backend/src/models/jobApplication.model.js` - Application schema
- `uat.dharwin.backend/src/controllers/candidate.controller.js` - Candidate filtering logic

## Documentation

- `BOLNA_QUICK_SETUP.md` - Agent creation guide
- `BOLNA_AGENT_COMPLETE_PROMPT.md` - Full agent prompt
- `BOLNA_AGENT_VARIABLES.md` - Variable reference
- `BOLNA_MULTI_AGENT_SETUP.md` - Multi-agent setup

---

✅ **Status**: Fully implemented and ready to test!
