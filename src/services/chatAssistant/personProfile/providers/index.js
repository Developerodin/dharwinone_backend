// src/services/chatAssistant/personProfile/providers/index.js

import employee from './employee.js';
import candidate from './candidate.js';
import student from './student.js';
import mentor from './mentor.js';
import { makeUserScalarProvider } from './userScalar.js';

export const PROVIDERS = {
  employee,
  candidate,
  student,
  mentor,
  recruiter:     makeUserScalarProvider('recruiter', 'recruiters'),
  agent:         makeUserScalarProvider('agent', 'agents'),
  administrator: makeUserScalarProvider('administrator', null),
};

/**
 * Local precedence, owned by personProfile/. Deliberately NOT
 * columnVisibility.ROLE_PRECEDENCE — that is module-private and answers a
 * different question (which RBAC tier is the VIEWER).
 */
export const PROVIDER_PRECEDENCE = [
  'employee', 'candidate', 'student', 'mentor',
  'recruiter', 'agent', 'administrator',
];

/**
 * Boot-time guard. The first draft of this feature listed relatedTools naming
 * two tools that never existed, so every Agent profile offered a dead end.
 * @param {string[]} registeredToolNames
 */
export function assertRelatedToolsExist(registeredToolNames) {
  const known = new Set(registeredToolNames);
  for (const p of Object.values(PROVIDERS)) {
    for (const t of p.relatedTools ?? []) {
      if (!known.has(t)) {
        throw new Error(`[personProfile] provider "${p.role}" lists "${t}", which is not a registered tool`);
      }
    }
  }
}
