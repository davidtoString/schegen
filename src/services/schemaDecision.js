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
  if (!skip && occupied && !owned) blocked = 'WordPress already stores schema for this page that Schematic did not write, so it will not be overwritten. Choose "Replace it with the new schema" or "Keep existing".';
  if (!skip && thirdParty.length && decision !== 'review' && !suppress) blocked = 'This page already has other schema (usually Rank Math\'s). This option only replaces Schematic\'s own schema. Choose "Replace it with the new schema" to replace it, or "Advanced: keep Rank Math output and add app schema" to add yours alongside.';
  if (!skip && !suppress && conflicts.some(message => message.startsWith('Same entity ID:'))) blocked = 'The new schema uses the same entity ID as schema already on the page. Choose "Replace it with the new schema" so only one of them is output.';
  if (suppress && (before.metaKey || !before.schemaControl)) blocked = 'Replacing/removing Rank Math output requires Schematic Connector 1.2 or later. Update the connector and use connector integration.';
  return { before, after: generated, existing, thirdParty, conflicts: [...new Set(conflicts)], decision, skip, blocked, suppressRankMath: suppress, requiresAcknowledgement: !skip && (suppress || thirdParty.length > 0) };
}
module.exports = { assess, storedGraph };
