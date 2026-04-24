import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(__dirname, '../src');
const copies = [
  ['controllers/candidate.controller.js', 'controllers/employee.controller.js'],
  ['validations/candidate.validation.js', 'validations/employee.validation.js'],
  ['routes/v1/candidate.route.js', 'routes/v1/employee.route.js'],
  ['services/candidate.scheduler.js', 'services/employee.scheduler.js'],
];
for (const [from, to] of copies) {
  fs.copyFileSync(path.join(base, from), path.join(base, to));
  console.log('copied', from, '->', to);
}
let route = fs.readFileSync(path.join(base, 'routes/v1/employee.route.js'), 'utf8');
route = route.replace(
  "import * as candidateValidation from '../../validations/candidate.validation.js';",
  "import * as employeeValidation from '../../validations/employee.validation.js';"
);
route = route.replace(
  "import * as candidateController from '../../controllers/candidate.controller.js';",
  "import * as employeeController from '../../controllers/employee.controller.js';"
);
route = route.split('candidateValidation').join('employeeValidation');
route = route.split('candidateController').join('employeeController');
fs.writeFileSync(path.join(base, 'routes/v1/employee.route.js'), route, 'utf8');
console.log('rewired employee.route.js');

const sched = fs.readFileSync(path.join(base, 'services/employee.scheduler.js'), 'utf8');
const sched2 = sched
  .split('candidate.model.js')
  .join('employee.model.js')
  .replace('import Candidate from', 'import Employee from')
  .replace(/Candidate\./g, 'Employee.');
fs.writeFileSync(path.join(base, 'services/employee.scheduler.js'), sched2, 'utf8');
console.log('rewired employee.scheduler.js');

const ctrl = fs.readFileSync(path.join(base, 'controllers/employee.controller.js'), 'utf8');
if (ctrl.includes("candidate.service.js")) {
  const ctrl2 = ctrl.split('candidate.service.js').join('employee.service.js');
  fs.writeFileSync(path.join(base, 'controllers/employee.controller.js'), ctrl2, 'utf8');
  console.log('fixed service import in employee.controller.js');
}
