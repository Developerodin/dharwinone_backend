import getPerson360 from './getPerson360.tool.js';
import findDuplicatePeople from './findDuplicatePeople.tool.js';

const instructions = [
  'Person 360: one person across every module, and duplicate profiles.',
  '- "Tell me everything about X", "full picture / 360 of X", "what do we have on X" → get_person_360 with person. ' +
    'Omit person for the signed-in user ("everything about me").',
  '- "What is X doing today" → get_person_360 focus today. "Does X have pending actions", "what is pending for X" → ' +
    'focus pending.',
  '- ONE fact is NOT a 360: "who is X\'s manager / team lead", "which department / group is X in" → ' +
    'get_reporting_chain mode chain; "when did X join", "what is X\'s role" → get_user. Call the 360 only when ' +
    'several facts are asked.',
  '- If get_person_360 returns matches, ask which person and stop - never pick one. notFound = no such person.',
  '- Report every section by its status: ok = its summary and rows; restricted = say the user has no access to ' +
    'that section and nothing else about it; notRecorded = nothing on record (say why, from its note); notCaptured = ' +
    'not captured in DharwinOne; error / timeout = that section could not be loaded. Never fill a restricted or ' +
    'failed section from another section or from memory.',
  '- scanTruncated in a section means only part of the records were read - say so.',
  '- "Duplicate candidates / employees", "same email or phone on two profiles" → find_duplicate_people ' +
    '(by email / phone / both; population candidates / employees / all). Report totalGroups, then the groups.',
].join('\n');

export default {
  domain: 'person',
  summary: 'One person across every module (360, today, pending) and duplicate profiles by shared email or phone.',
  instructions,
  tools: [getPerson360, findDuplicatePeople],
};
