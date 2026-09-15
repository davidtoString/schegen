/* Shared by generation and settings; the backing input always holds the API model ID. */
function setupModelPicker(id, models, value, defaultLabel) {
  const select = document.getElementById(`${id}-choice`);
  const input = document.getElementById(id);
  const custom = document.getElementById(`${id}-custom`);
  const options = [{ id: '', name: defaultLabel }, ...models, { id: '__custom__', name: 'Custom model ID…' }];
  select.replaceChildren(...options.map(model => {
    const option = document.createElement('option'); option.value = model.id; option.textContent = model.name; return option;
  }));
  input.value = value || '';
  select.value = value && !models.some(model => model.id === value) ? '__custom__' : value || '';
  const updateVisibility = () => { custom.hidden = select.value !== '__custom__'; input.required = !custom.hidden; };
  updateVisibility();
  select.onchange = () => {
    input.value = select.value === '__custom__' ? '' : select.value;
    updateVisibility();
  };
}
function selectedModel(id) {
  const input = document.getElementById(id);
  const value = input.value.trim();
  if (document.getElementById(`${id}-choice`).value === '__custom__' && !value) throw new Error('Enter a custom model ID or choose a listed model.');
  return value;
}
if (typeof module !== 'undefined') module.exports = { setupModelPicker, selectedModel };
