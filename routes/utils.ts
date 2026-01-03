import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SessionConfig } from '../types/index.js';
import { getConfiguration } from '../config/app.config.js';
import { FUNCTION_DEFINITIONS } from '../functions/index.js';
import { createLogger } from '../logger.js';

dotenv.config();

const log = createLogger('utils');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error("🔴 OpenAI API key not configured");
}

// Function to load and process prompt template
function loadPromptTemplate(language: string, personaType?: string): string {
  const config = getConfiguration(personaType);
  // Check if we're in dist (compiled) or source directory
  const isCompiled = __dirname.includes('dist');
  const promptsDir = isCompiled 
    ? path.join(__dirname, '..', '..', 'prompts', 'templates')  // dist/routes -> project root
    : path.join(__dirname, '..', 'prompts', 'templates');       // routes -> project root
  const templatePath = path.join(promptsDir, `${language}.template.txt`);
  
  try {
    let template = fs.readFileSync(templatePath, 'utf-8');
    
    // Replace template variables with actual values from persona
    template = template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      switch (key) {
        case 'name':
          return config.persona.name;
        case 'role':
          return config.persona.role;
        case 'company':
          return config.persona.company;
        case 'tone':
          return config.persona.tone;
        case 'contextTemplate':
          return config.persona.contextTemplate;
        case 'instructionsTemplate':
          return config.persona.instructionsTemplate;
        default:
          // Check if it's a custom variable
          return config.persona.variables[key] || match;
      }
    });
    
    return template;
  } catch (error) {
    log.warn('Error loading prompt template', { language, error: error instanceof Error ? error.message : error });
    // Fallback to English template
    const fallbackPath = path.join(promptsDir, 'english.template.txt');
    try {
      let fallbackTemplate = fs.readFileSync(fallbackPath, 'utf-8');
      // Apply same variable substitution for fallback
      fallbackTemplate = fallbackTemplate.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        const value = config.persona[key as keyof typeof config.persona] ||
                     config.persona.variables[key] ||
                     match;
        return typeof value === 'string' ? value : match;
      });
      return fallbackTemplate;
    } catch (fallbackError) {
      log.error('Failed to load fallback template', { error: fallbackError instanceof Error ? fallbackError.message : fallbackError });
      return `You are ${config.persona.name}, a ${config.persona.role} at ${config.persona.company}. Please assist the customer professionally.`;
    }
  }
}

export function makeHeaders(contentType?: string): Record<string, string> {
  const obj: Record<string, string> = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  };
  if (contentType) obj["Content-Type"] = contentType;
  return obj;
}

export function makeSession(language: string = 'english', personaType?: string): SessionConfig {
  const config = getConfiguration(personaType, language);
  
  // Validate language against supported languages
  const selectedLanguage = config.bot.supportedLanguages.includes(language) 
    ? language 
    : config.bot.defaultLanguage;
    
  // For external config, instructions are already processed in contextTemplate
  const instructions = config.persona.contextTemplate || loadPromptTemplate(selectedLanguage, personaType);
  
  return {
    type: "realtime",
    model: config.bot.model,
    instructions: instructions,
    turn_detection: { type: "server_vad" },
    temperature: config.bot.temperature || 0.8,
    voice: config.bot.voice,
    tools: FUNCTION_DEFINITIONS,
    tool_choice: "auto",
    audio: {
      input: { noise_reduction: { type: "near_field" } },
      output: { voice: config.bot.voice },
    },
  };
}

export function getAvailableLanguages(): string[] {
  const config = getConfiguration();
  return config.bot.supportedLanguages;
}

export function getAppConfiguration(personaType?: string, language?: string) {
  return getConfiguration(personaType, language);
}