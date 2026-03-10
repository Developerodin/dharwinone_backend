const allRoles = {
  user: ['getUsers', 'manageUsers'],
  recruiter: ['getUsers', 'manageCandidates', 'manageJobs'],
  supervisor: ['getUsers', 'manageUsers', 'manageCandidates', 'manageJobs'],
  admin: ['getUsers', 'manageUsers', 'manageCandidates', 'manageJobs'],
  Administrator: ['getUsers', 'manageUsers', 'manageCandidates', 'manageJobs'],
  agent: ['getUsers'],
  Candidate: ['getUsers'],
  Manager: ['getUsers', 'manageUsers', 'manageCandidates', 'manageJobs'],
  Mentor: ['getUsers', 'manageCandidates', 'manageJobs'],
  Student: ['getUsers'],
};

const roles = Object.keys(allRoles);
const roleRights = new Map(Object.entries(allRoles));

export { roles, roleRights };
