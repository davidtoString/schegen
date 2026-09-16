/**
 * Google Gemini Provider
 * Supports Gemini 2.0 Flash, Gemini 2.5 Flash, Gemini 2.5 Pro
 */

const axios = require('axios');

const name = 'Google Gemini';

/**
 * Check if provider is configured (via .env)
 */
function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

/**
 * Call Gemini API
 * @param {string} prompt - The prompt
 * @param {object} options - { model, temperature, maxTokens, apiKey }
 */
async function call(prompt, options = {}) {
  // Allow API key from options (UI input) or fall back to .env
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not provided. Enter your API key in the UI or add GEMINI_API_KEY to .env file.');
  }

  const model = options.model || 'gemini-2.5-flash-lite';
  const temperature = options.temperature || 0.3;
  const maxTokens = options.maxTokens || 2000;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens
        },
        systemInstruction: {
          parts: [
            {
              text: 'You are a helpful assistant that analyzes web pages and extracts structured data. Always respond with valid JSON when asked.'
            }
          ]
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    // Extract text from Gemini response with validation
    if (!response.data) {
      throw new Error('Gemini API returned no data');
    }

    if (!response.data.candidates || !Array.isArray(response.data.candidates) || response.data.candidates.length === 0) {
      // Check for blocked content or other issues
      if (response.data.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked the request: ${response.data.promptFeedback.blockReason}`);
      }
      throw new Error('Gemini API returned no candidates');
    }

    const candidate = response.data.candidates[0];
    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Gemini response was blocked due to safety filters');
    }

    const content = candidate.content?.parts?.[0]?.text;

    if (!content) {
      throw new Error('Empty response from Gemini - no text content in response');
    }

    return content;
  } catch (error) {
    if (error.response) {
      const errorMsg = error.response.data.error?.message || error.response.statusText;
      throw new Error(`Gemini API error: ${errorMsg}`);
    }
    throw new Error(`Gemini request failed: ${error.message}`);
  }
}

module.exports = {
  name,
  isConfigured,
  call
};
