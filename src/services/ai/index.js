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

// Available models: current, non-thinking (or least-thinking) options only. `reasoning` /
// `thinkingLevel` are sent so the model answers directly instead of spending billed thinking tokens.
// Checked 2026-10-21 against the providers' model and pricing docs; prices are per 1M tokens in/out.
const availableModels = {
  openai: [
    { id: 'gpt-6-luna', name: 'GPT-6 Luna · $0.10 / $0.50', reasoning: 'none', default: true },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna · $0.20 / $1.20', reasoning: 'none' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini · $0.75 / $4.50', reasoning: 'none' }
  ],
  gemini: [
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite · $0.30 / $2.50', thinkingLevel: 'minimal', default: true },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite · $0.25 / $1.50', thinkingLevel: 'minimal' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash · $0.75 / $3.75', thinkingLevel: 'low' }
  ]
};
function modelInfo(providerName, model) { return availableModels[providerName]?.find(item => item.id === model) || {}; }

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

  const info = modelInfo(providerName, model);
  return provider.call(prompt, {
    model,
    reasoning: info.reasoning,
    thinkingLevel: info.thinkingLevel,
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
