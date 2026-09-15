const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assess } = require('../src/services/schemaDecision');
const graph = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', '@id': 'app' }] };
const rankMath = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', '@id': 'rankmath' }] };
test('existing Rank Math output is kept by default and overlaps require explicit review', () => {
  assert.equal(assess({ schema: null }, [rankMath], graph, 'keep', true).skip, true);
  assert.ok(assess({ schema: null }, [rankMath], graph, 'replace-managed', true).blocked);
  const review = assess({ schema: null }, [rankMath], graph, 'review', true);
  assert.equal(review.requiresAcknowledgement, true); assert.equal(review.conflicts.length, 1);
  assert.equal(review.blocked, '');
  assert.ok(assess({ schema: null }, [rankMath], rankMath, 'review', true).blocked);
});
test('unowned REST values cannot be replaced; app nodes inside Rank Math graph are recognized', () => {
  assert.ok(assess({ metaKey: 'vendor_field', encoding: 'object', rawValue: graph }, [], graph, 'review', false).blocked);
  const merged = { ...graph, '@graph': [...rankMath['@graph'], ...graph['@graph']] };
  const review = assess({ schema: graph }, [merged], graph, 'review', true);
  assert.deepEqual(review.thirdParty, rankMath['@graph']);
});
test('Rank Math removal and replacement require current connector and explicit acknowledgement', () => {
  for (const mode of ['replace-existing', 'remove-existing']) {
    assert.ok(assess({ schema: null }, [rankMath], graph, mode, true).blocked);
    const preview = assess({ schema: null, schemaControl: 1 }, [rankMath], mode === 'remove-existing' ? null : graph, mode, true);
    assert.equal(preview.blocked, '');
    assert.equal(preview.suppressRankMath, true);
    assert.equal(preview.requiresAcknowledgement, true);
  }
});
