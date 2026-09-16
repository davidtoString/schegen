/**
 * OpenAI Provider
 * Supports GPT-4, GPT-4 Turbo, GPT-3.5 Turbo
 */

const axios = require('axios');

const name = 'OpenAI';

/**
 * Check if provider is configured (via .env)
 */
function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Call OpenAI API
 * @param {string} prompt - The prompt
 * @param {object} options - { model, temperature, maxTokens, apiKey }
 */
async function call(prompt, options = {}) {
  // Allow API key from options (UI input) or fall back to .env
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OpenAI API key not provided. Enter your API key in the UI or add OPENAI_API_KEY to .env file.');
  }

  const model = options.model || 'gpt-4.1-nano';
  const temperature = options.temperature || 0.3;
  const maxTokens = options.maxTokens || 2000;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that analyzes web pages and extracts structured data. Always respond with valid JSON when asked.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature,
        max_tokens: maxTokens
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    if (error.response) {
      throw new Error(`OpenAI API error: ${error.response.data.error?.message || error.response.statusText}`);
    }
    throw new Error(`OpenAI request failed: ${error.message}`);
  }
}

module.exports = {
  name,
  isConfigured,
  call
};
