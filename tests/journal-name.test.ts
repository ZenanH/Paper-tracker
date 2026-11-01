import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalName } from '../components/journal-name.ts';

test('期刊名称统一为英文标题式大小写并保留缩写', () => {
  assert.equal(journalName('journal of the american chemical society'), 'Journal of the American Chemical Society');
  assert.equal(journalName('journal of science: a study on materials'), 'Journal of Science: A Study on Materials');
  assert.equal(journalName('IEEE Transactions on pattern analysis and machine intelligence'), 'IEEE Transactions on Pattern Analysis and Machine Intelligence');
  assert.equal(journalName('JOURNAL OF the IEEE TRANSACTIONS'), 'Journal of the IEEE Transactions');
  assert.equal(journalName('JOURNAL OF THE AMERICAN CHEMICAL SOCIETY'), 'Journal of the American Chemical Society');
  assert.equal(journalName('IEEE AEROSPACE AND ELECTRONIC SYSTEMS MAGAZINE'), 'IEEE Aerospace and Electronic Systems Magazine');
  assert.equal(journalName('Ieee transactions on pattern analysis and machine intelligence'), 'IEEE Transactions on Pattern Analysis and Machine Intelligence');
  assert.equal(journalName('ACM COMPUTING SURVEYS'), 'ACM Computing Surveys');
});
