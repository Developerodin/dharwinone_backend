# Bolna Agent Variables Reference

> **Overview and links:** [BOLNA.md](./BOLNA.md)

## Variables to Pass from Backend

When initiating a call via Bolna API, these variables should be included in the `user_data` object:

### Required Variables

```javascript
{
  // Candidate Information
  candidate_name: "Sarah Johnson",              // Full name of applicant
  candidate_email: "sarah.johnson@email.com",   // Email address to verify
  
  // Job Information
  job_title: "Senior Software Engineer",        // Position title
  job_type: "Full-time",                        // Full-time, Part-time, Contract, Internship
  location: "San Francisco, CA - Hybrid",       // Job location
  experience_level: "Senior Level",             // Entry, Mid, Senior, Executive
  salary_range: "$150,000 to $180,000 per year", // Formatted salary string
  
  // Company Information
  company_name: "TechCorp Inc.",                // Organization name
  
  // Application Information
  application_date: "February 15, 2026"         // When they applied
}
```

### Optional Variables

```javascript
{
  // Additional Contact Info
  candidate_phone: "+1234567890",               // For reference only
  
  // Additional Company Info
  company_email: "hr@techcorp.com",             // HR contact email
  hiring_manager_email: "manager@techcorp.com", // Hiring manager email
  
  // Internal Tracking
  application_id: "app_12345"                   // Application reference ID
}
```

## Usage in Backend Code

### Current Implementation Location
File: `uat.dharwin.backend/src/services/applicationVerificationCall.scheduler.js`

### Example from Existing Code

```javascript
const userData = {
  candidate_name: candidate.fullName,
  job_title: job.title,
  company_name: job.organisation?.name || 'Our Company',
  job_type: job.employmentType || 'Full-time',
  location: `${job.location || 'Remote'}${job.workMode ? ` - ${job.workMode}` : ''}`,
  experience_level: job.experienceLevel || 'Not specified',
  salary_range: formatSalaryRange(job.salaryMin, job.salaryMax, job.currency),
  application_date: new Date(application.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
  candidate_email: candidate.email,
};
```

### Variable Mapping from Database Models

| Variable | Source | Example Code |
|----------|--------|--------------|
| `candidate_name` | Candidate model | `candidate.fullName` |
| `candidate_email` | Candidate model | `candidate.email` |
| `candidate_phone` | Candidate model | `candidate.phoneNumber` |
| `job_title` | Job model | `job.title` |
| `job_type` | Job model | `job.employmentType` |
| `location` | Job model | `job.location + job.workMode` |
| `experience_level` | Job model | `job.experienceLevel` |
| `salary_range` | Job model | `formatSalaryRange(job.salaryMin, job.salaryMax)` |
| `company_name` | Job.organisation | `job.organisation?.name` |
| `company_email` | Job.organisation | `job.organisation?.email` |
| `application_date` | JobApplication model | `new Date(application.createdAt).toLocaleDateString()` |
| `application_id` | JobApplication model | `application._id.toString()` |

## Bolna API Call Format

```javascript
const bolnaPayload = {
  agent_id: config.bolna.agentId,
  recipient_phone_number: candidatePhone, // E.164 format
  user_data: {
    candidate_name: "Sarah Johnson",
    candidate_email: "sarah.johnson@email.com",
    job_title: "Senior Software Engineer",
    job_type: "Full-time",
    location: "San Francisco, CA - Hybrid",
    experience_level: "Senior Level",
    salary_range: "$150,000 to $180,000 per year",
    company_name: "TechCorp Inc.",
    application_date: "February 15, 2026"
  },
  from_phone_number: config.bolna.fromPhoneNumber // Optional
};
```

## Variable Usage in Agent Prompt

These variables are automatically replaced in the agent prompt using double curly braces:

```
Hello! This is the recruitment assistant calling from {{company_name}}. 
Am I speaking with {{candidate_name}}?

Thank you for applying to the {{job_title}} position.

The salary range is {{salary_range}}.
```

## Testing Variables

To test if variables are working correctly:

1. Create a test application through the public job portal
2. Check the backend logs for the Bolna call payload
3. Verify all variables are populated correctly
4. Listen to the call recording in Bolna dashboard to ensure variables are spoken correctly

## Common Issues

### Variable Not Showing
- **Issue**: Variable appears as `{{variable_name}}` in the call
- **Cause**: Variable not included in `user_data` object
- **Fix**: Add the variable to the payload in `applicationVerificationCall.scheduler.js`

### Variable Shows "undefined" or "null"
- **Issue**: Variable value is `undefined` or `null`
- **Cause**: Database field is empty or missing
- **Fix**: Provide default values using `||` operator (e.g., `job.title || 'Position'`)

### Variable Format Issues
- **Issue**: Date shows as timestamp instead of readable format
- **Cause**: Not formatted before sending
- **Fix**: Use `.toLocaleDateString()` or custom formatting function

## Notes

- All variables are case-sensitive
- Use descriptive, readable text for better voice synthesis
- Format numbers and dates in spoken-word format (e.g., "one hundred fifty thousand" reads better than "150000")
- Provide fallback values for optional fields to prevent awkward pauses
