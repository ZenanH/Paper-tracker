import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paperTitle } from '../components/paper-title.ts';

test('paper title display uses one initial capital and lowercase thereafter', () => {
  assert.equal(paperTitle('A STUDY OF THE EFFECTS OF AI'), 'A study of the effects of ai');
  assert.equal(paperTitle('a study of the effects of ai'), 'A study of the effects of ai');
  assert.equal(paperTitle('“DEEP LEARNING FOR SCIENCE”'), '“Deep learning for science”');
  assert.equal(paperTitle('基于 LLM 的论文翻译'), '基于 llm 的论文翻译');
});
