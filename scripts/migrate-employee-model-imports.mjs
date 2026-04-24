import fs from 'fs';
import path from 'path';

const srcRoot = path.join('src');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory() && !name.name.startsWith('.')) walk(p, out);
    else if (name.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(srcRoot);
let changed = 0;
for (const f of files) {
  let c = fs.readFileSync(f, 'utf8');
  if (!c.includes('candidate.model.js') && !c.match(/\bCandidate\./) && !c.match(/const Candidate = \(await import\('[^']*candidate\.model/)) {
    continue;
  }
  const orig = c;
  c = c.split('candidate.model.js').join('employee.model.js');
  c = c.replace(/import Candidate from /g, 'import Employee from ');
  c = c.replace(/const Candidate = \(await import\('([^']*employee\.model\.js)'\)\)\.default/g, "const Employee = (await import('$1')).default");
  c = c.replace(/const Candidate = \(await import\("([^"]*employee\.model\.js)"\)\)\.default/g, 'const Employee = (await import("$1")).default');
  c = c.replace(/Candidate\./g, 'Employee.');
  if (c !== orig) {
    fs.writeFileSync(f, c, 'utf8');
    changed++;
    console.log('updated', f);
  }
}
console.log('files changed:', changed);
