import fs from 'fs';
import path from 'path';

const srcRoot = path.join('src');
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory() && !name.name.startsWith('.')) walk(p, out);
    else if (name.name.endsWith('.js') || name.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}
for (const f of walk(srcRoot)) {
  let c = fs.readFileSync(f, 'utf8');
  if (!c.includes('candidate.service.js')) continue;
  const n = c.split('candidate.service.js').join('employee.service.js');
  fs.writeFileSync(f, n, 'utf8');
  console.log(f);
}
