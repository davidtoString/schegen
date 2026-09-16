/**
 * AI Service - Modular AI provider abstraction
 * Easy to add new providers/models as they're released
 */

const openaiProvider = require('./providers/openai');
const geminiProvider = require('./providers/gemini');

// Available providers - add new ones here
const providers = {
  openai: openaiProvider,
  gemini: geminiProvider
};

// Available models - update this as new models are released
const availableModels = {
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', default: true }
  ],
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', default: true },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }
  ]
};

/**
 * Get available providers and their models
 */
function getAvailableProviders() {
  const result = {};

  for (const [providerName, models] of Object.entries(availableModels)) {
    const provider = providers[providerName];
    result[providerName] = {
      name: provider.name,
      configured: provider.isConfigured(),
      models: models
    };
  }

  return result;
}

/**
 * Get the default model for a provider
 */
function getDefaultModel(providerName) {
  const models = availableModels[providerName];
  if (!models) return null;
  const defaultModel = models.find(m => m.default);
  return defaultModel ? defaultModel.id : models[0].id;
}

/**
 * Call AI with a prompt
 * @param {string} providerName - 'openai' or 'gemini'
 * @param {string} prompt - The prompt to send
 * @param {object} options - { model, temperature, maxTokens, apiKey }
 */
async function call(providerName, prompt, options = {}) {
  const provider = providers[providerName];

  if (!provider) {
    throw new Error(`Unknown AI provider: ${providerName}`);
  }

  // Allow API key from options (UI) or fall back to checking .env
  const hasApiKey = options.apiKey || provider.isConfigured();
  if (!hasApiKey) {
    throw new Error(`${provider.name} API key not provided. Enter your API key in the UI or add it to the .env file.`);
  }

  const model = options.model || getDefaultModel(providerName);

  return provider.call(prompt, {
    model,
    temperature: options.temperature || 0.3,
    maxTokens: options.maxTokens || 2000,
    apiKey: options.apiKey  // Pass API key to provider
  });
}

/**
 * Call AI and parse JSON response
 */
async function callJSON(providerName, prompt, options = {}) {
  const response = await call(providerName, prompt, options);

  // Try to extract JSON from response
  try {
    // Handle markdown code blocks
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    return JSON.parse(jsonStr.trim());
  } catch (e) {
    throw new Error(`Failed to parse AI response as JSON: ${e.message}`);
  }
}

module.exports = {
  getAvailableProviders,
  getDefaultModel,
  call,
  callJSON,
  providers,
  availableModels
};
