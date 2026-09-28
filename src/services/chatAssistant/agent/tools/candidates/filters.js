import Joi from 'joi';

export const candidateFilters = Joi.object({
  search: Joi.string().min(1).description('Name, email or id — like the Candidates list search box.'),
  designation: Joi.string().min(1).description('Target job title / position. Partial match.'),
  skills: Joi.array().items(Joi.string().min(1)).max(10)
    .description('Candidate has ANY of these skills.'),
  location: Joi.string().min(1).description('City / state / country. Partial match.'),
  agent: Joi.string().min(1).description('Name of the agent the candidate is assigned to.'),
}).description('Candidate filters. Omit a key to leave it unfiltered.');
