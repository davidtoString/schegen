const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
  const nodes = new Map();
  const node = () => ({ value: '', hidden: false, required: false, textContent: '', replaceChildren(...children) { this.children = children; } });
  const document = { addEventListener() {}, createElement: node, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } };
  const context = vm.createContext({ document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/modelPicker.js'), 'utf8'), context);
  return { context, get: id => document.getElementById(id) };
}
test('model dropdown maps selections to IDs, preserves custom saved models, and rejects blank custom values', () => {
  const { context, get } = fixture();
  vm.runInContext("setupModelPicker('model', [{id:'gpt-4o',name:'GPT-4o'}], 'private-model', 'Default');", context);
  assert.equal(get('model-choice').value, '__custom__');
  assert.equal(get('model-custom').hidden, false);
  assert.equal(vm.runInContext("selectedModel('model')", context), 'private-model');
  get('model-choice').value = 'gpt-4o'; get('model-choice').onchange();
  assert.equal(get('model-custom').hidden, true);
  assert.equal(vm.runInContext("selectedModel('model')", context), 'gpt-4o');
  get('model-choice').value = '__custom__'; get('model-choice').onchange();
  assert.throws(() => vm.runInContext("selectedModel('model')", context), /Enter a custom/);
  get('model-choice').value = ''; get('model-choice').onchange();
  assert.equal(vm.runInContext("selectedModel('model')", context), '');
});
test('switching providers restores each generation model instead of resetting the selection', () => {
  const { context, get } = fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/workspace.js'), 'utf8'), context);
  vm.runInContext("configuredAI = {providers:{openai:{models:[{id:'gpt-4o',name:'GPT-4o'}],model:'gpt-4o'},gemini:{models:[{id:'gemini-2.5-flash',name:'Flash'}],model:'gemini-2.5-flash'}}};", context);
  get('ai-provider').value = 'openai'; vm.runInContext('applyAIProvider()', context);
  get('ai-model-choice').value = '__custom__'; get('ai-model-choice').onchange(); get('ai-model').value = 'custom-openai';
  get('ai-provider').value = 'gemini'; vm.runInContext('applyAIProvider()', context);
  assert.equal(get('ai-model').value, 'gemini-2.5-flash');
  get('ai-provider').value = 'openai'; vm.runInContext('applyAIProvider()', context);
  assert.equal(get('ai-model').value, 'custom-openai');
  assert.equal(get('ai-model-choice').value, '__custom__');
});
