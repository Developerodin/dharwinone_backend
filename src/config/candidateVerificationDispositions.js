/** Bolna disposition specs for candidate verification extractions (category + field names must match parser). */

export const CANDIDATE_VERIFICATION_CATEGORY = 'Candidate Verification';

export function getCandidateVerificationDispositionSpecs() {
  return [
    {
      name: 'Name Confirmed',
      question:
        'Did the candidate confirm their name is {candidate_name}? Return true if they agreed it is correct, false if they said it was wrong or gave a different name.',
      category: CANDIDATE_VERIFICATION_CATEGORY,
      is_subjective: true,
      is_objective: false,
      subjective_type: 'boolean',
    },
    {
      name: 'Corrected Name',
      question:
        'If the candidate said the name on file was wrong and gave a different name, return that corrected full name. Otherwise return empty.',
      category: CANDIDATE_VERIFICATION_CATEGORY,
      is_subjective: true,
      is_objective: false,
      subjective_type: 'text',
    },
    {
      name: 'Job Confirmed',
      question:
        'Did the candidate confirm the position they applied for is {job_title}? Return true if confirmed, false if they disagreed.',
      category: CANDIDATE_VERIFICATION_CATEGORY,
      is_subjective: true,
      is_objective: false,
      subjective_type: 'boolean',
    },
    {
      name: 'Availability',
      question:
        'When did the candidate say they could join or start if selected? Return their stated availability (e.g. "immediately", "in two weeks"). Empty if not stated.',
      category: CANDIDATE_VERIFICATION_CATEGORY,
      is_subjective: true,
      is_objective: false,
      subjective_type: 'text',
    },
    {
      name: 'Current Location',
      question:
        'What current city or location did the candidate state? Return it. Empty if not provided.',
      category: CANDIDATE_VERIFICATION_CATEGORY,
      is_subjective: true,
      is_objective: false,
      subjective_type: 'text',
    },
    {
      name: 'Still Interested',
      question:
        'Is the candidate still interested in this role? Select the best matching outcome.',
      category: CANDIDATE_VERIFICATION_CATEGORY,
      is_subjective: false,
      is_objective: true,
      objective_options: [
        { value: 'interested', condition: 'Candidate remains interested in the role' },
        { value: 'not_interested', condition: 'Candidate is not interested or declined' },
        {
          value: 'withdrew',
          condition: 'Candidate explicitly asked to withdraw their application',
        },
      ],
    },
    {
      name: 'Call Outcome',
      question: 'Overall outcome of the verification call. Select the best matching outcome.',
      category: CANDIDATE_VERIFICATION_CATEGORY,
      is_subjective: false,
      is_objective: true,
      objective_options: [
        { value: 'fully_confirmed', condition: 'All key verification details were confirmed' },
        { value: 'partially_confirmed', condition: 'Some but not all key details were confirmed' },
        { value: 'refused', condition: 'Candidate refused to verify or ended the call abruptly' },
        { value: 'voicemail', condition: 'Call reached voicemail without live conversation' },
        { value: 'no_data', condition: 'Insufficient data to determine the outcome' },
      ],
    },
  ];
}

export const CANDIDATE_VERIFICATION_FIELD_NAMES = getCandidateVerificationDispositionSpecs().map(
  (d) => d.name
);
