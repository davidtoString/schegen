const { isDeepStrictEqual: equal } = require('node:util');
function storedGraph(snapshot) {
  if (!snapshot.metaKey) return snapshot.schema;
  if (snapshot.encoding === 'object') return snapshot.rawValue;
  try { return JSON.parse(snapshot.rawValue); } catch { return snapshot.rawValue; }
}
function hasValue(value) { return value !== null && value !== undefined && value !== '' && !(typeof value === 'object' && Object.keys(value).length === 0); }
function assess(before, existing, generated, decision, owned) {
  if (!['keep', 'replace-managed', 'review', 'replace-existing', 'remove-existing'].includes(decision)) throw new Error('Choose an existing-schema policy.');
  const suppress = ['replace-existing', 'remove-existing'].includes(decision);
  const current = storedGraph(before);
  const occupied = hasValue(current);
  const nodes = value => {
    const list = value?.['@graph'] || (Array.isArray(value) ? value : value ? [value] : []);
    return (Array.isArray(list) ? list : [list]).map(node => node && typeof node === 'object' ? node : { invalidJSONLD: true });
  };
  const managedNodes = nodes(current);
  const thirdParty = existing.flatMap(nodes).filter(node => !managedNodes.some(managed => equal(node, managed)));
  const conflicts = nodes(generated).flatMap(node => thirdParty.flatMap(old => {
    if (node['@id'] && node['@id'] === old['@id']) return [`Same entity ID: ${node['@id']}`];
    const types = [node['@type']].flat().filter(Boolean);
    return [old['@type']].flat().some(type => types.includes(type)) ? [`Potential type overlap: ${types.join(', ')}`] : [];
  }));
  const skip = decision === 'keep' && (occupied || existing.length > 0);
  let blocked = '';
  if (!skip && occupied && !owned) blocked = 'The mapped field contains schema not recorded as app-managed. Keep it or use a separate empty field; it will not be overwritten.';
  if (!skip && thirdParty.length && decision !== 'review' && !suppress) blocked = 'Other public JSON-LD exists. Review conflicts and explicitly acknowledge it before publishing.';
  if (!skip && !suppress && conflicts.some(message => message.startsWith('Same entity ID:'))) blocked = 'Proposed schema reuses an existing third-party entity ID. Resolve it before publishing.';
  if (suppress && (before.metaKey || !before.schemaControl)) blocked = 'Replacing/removing Rank Math output requires Workspace Connector 1.2 or later. Update the connector and use connector integration.';
  return { before, after: generated, existing, thirdParty, conflicts: [...new Set(conflicts)], decision, skip, blocked, suppressRankMath: suppress, requiresAcknowledgement: !skip && (suppress || thirdParty.length > 0) };
}
module.exports = { assess, storedGraph };
