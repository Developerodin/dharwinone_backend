import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutAwarePageText } from '../documentExtraction.service.js';
import { categorizedJsonToEmployeeSkills } from '../resumeSkillsExtract.service.js';

/** Build a fake pdfjs text item. transform = [a, b, c, d, x, y]; d carries glyph height. */
function item(str, x, y, width, height = 10) {
  return { str, width, height, transform: [height, 0, 0, height, x, y] };
}

test('layoutAwarePageText inserts a space between kerned runs with no space glyph', () => {
  const text = layoutAwarePageText([item('React', 0, 700, 30), item('Node.js', 40, 700, 40)], 600);
  assert.equal(text, 'React Node.js');
});

test('layoutAwarePageText does not split a word whose runs are adjacent', () => {
  const text = layoutAwarePageText([item('Java', 0, 700, 24), item('Script', 24.5, 700, 32)], 600);
  assert.equal(text, 'JavaScript');
});

test('layoutAwarePageText groups items into lines by baseline, top to bottom', () => {
  const text = layoutAwarePageText(
    [item('second', 0, 680, 40), item('first', 0, 700, 30), item('line', 40, 700, 25)],
    600
  );
  assert.equal(text, 'first line\nsecond');
});

test('layoutAwarePageText emits a two-column page one column at a time', () => {
  // Content-stream order interleaves sidebar and main column, as designed resume
  // templates do; reading order must put the whole sidebar before the main column.
  const items = [];
  for (let i = 0; i < 12; i++) {
    const y = 700 - i * 20;
    items.push(item(`L${i}`, 20, y, 80)); // sidebar: x 20..100
    items.push(item(`R${i}`, 320, y, 80)); // main: x 320..400
  }

  const text = layoutAwarePageText(items, 600);
  const [left, right] = text.split('\n\n');

  assert.equal(left, Array.from({ length: 12 }, (_, i) => `L${i}`).join('\n'));
  assert.equal(right, Array.from({ length: 12 }, (_, i) => `R${i}`).join('\n'));
});

test('layoutAwarePageText still finds the gutter when pdfjs spans it with a space item', () => {
  // pdfjs emits a synthesized whitespace item covering the gap between columns. Counting it
  // as occupied text hides the gutter and silently collapses the page back to one column.
  const items = [];
  for (let i = 0; i < 12; i++) {
    const y = 700 - i * 20;
    items.push(item(`L${i}`, 20, y, 80));
    items.push(item(' ', 100, y, 220, 0)); // gutter-spanning gap marker
    items.push(item(`R${i}`, 320, y, 80));
  }

  const text = layoutAwarePageText(items, 600);
  const [left, right] = text.split('\n\n');

  assert.equal(left, Array.from({ length: 12 }, (_, i) => `L${i}`).join('\n'));
  assert.equal(right, Array.from({ length: 12 }, (_, i) => `R${i}`).join('\n'));
});

test('layoutAwarePageText keeps a single-column page in one block', () => {
  const items = [];
  for (let i = 0; i < 24; i++) items.push(item(`line${i}`, 50, 700 - i * 20, 400));

  const text = layoutAwarePageText(items, 600);
  assert.ok(!text.includes('\n\n'), 'single-column page must not be split into columns');
  assert.equal(text.split('\n').length, 24);
});

test('layoutAwarePageText returns empty string when the page has no text layer', () => {
  assert.equal(layoutAwarePageText([], 600), '');
});

test('categorizedJsonToEmployeeSkills keeps excluded buckets out of skills', () => {
  const parsed = {
    technical: [{ name: 'JavaScript', level: 'Advanced' }],
    certifications: [{ name: 'AWS Certified Solutions Architect' }, { name: 'B.Tech' }],
  };

  const out = categorizedJsonToEmployeeSkills(parsed, {
    source: 'resume',
    excludeBuckets: ['certifications'],
  });

  assert.deepEqual(
    out.skills.map((s) => s.name),
    ['JavaScript']
  );
  // Still reported, so the caller can log or surface them later.
  assert.deepEqual(out.buckets.certifications, ['AWS Certified Solutions Architect', 'B.Tech']);
});

test('categorizedJsonToEmployeeSkills is unchanged for callers that pass no excludeBuckets', () => {
  const parsed = {
    technical: [{ name: 'JavaScript', level: 'Advanced' }],
    certifications: [{ name: 'PMP' }],
  };

  const out = categorizedJsonToEmployeeSkills(parsed, { source: 'resume' });

  assert.deepEqual(
    out.skills.map((s) => s.name),
    ['JavaScript', 'PMP']
  );
  assert.equal(out.skills[1].category, 'Certifications');
});
