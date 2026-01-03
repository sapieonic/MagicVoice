import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { ExternalConfig } from '../types/external-config.js';
import { AppConfiguration } from '../types/config.js';
import { createLogger } from '../logger.js';

dotenv.config();

const log = createLogger('external-config-loader');

// Default configuration directory - can be overridden by CONFIG_DIR env variable
const DEFAULT_CONFIG_DIR = path.join(process.cwd(), 'config-external');
const CONFIG_DIR = process.env.CONFIG_DIR || DEFAULT_CONFIG_DIR;

class ExternalConfigLoader {
  private configCache: Map<string, AppConfiguration> = new Map();
  private promptCache: Map<string, string> = new Map();

  constructor() {
    log.info('Using configuration directory', { configDir: CONFIG_DIR });
  }

  /**
   * Load configuration from external config.json file
   */
  private loadConfigFile(): ExternalConfig {
    const configPath = path.join(CONFIG_DIR, 'config.json');
    
    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file not found: ${configPath}`);
    }

    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config: ExternalConfig = JSON.parse(configContent);
      
      // Validate required fields
      this.validateConfig(config);
      
      log.info('Loaded configuration', { appName: config.app.name, personaType: config.persona.type });
      return config;
    } catch (error) {
      throw new Error(`Failed to parse config.json: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate that required configuration fields are present
   */
  private validateConfig(config: ExternalConfig): void {
    const requiredFields = [
      'app.name',
      'bot.defaultLanguage',
      'bot.supportedLanguages',
      'persona.type',
      'persona.name',
      'persona.role',
      'persona.company'
    ];

    for (const field of requiredFields) {
      const keys = field.split('.');
      let value: any = config;
      
      for (const key of keys) {
        value = value?.[key];
      }
      
      if (value === undefined || value === null || value === '') {
        throw new Error(`Required configuration field missing: ${field}`);
      }
    }

    // Validate supported languages array
    if (!Array.isArray(config.bot.supportedLanguages) || config.bot.supportedLanguages.length === 0) {
      throw new Error('bot.supportedLanguages must be a non-empty array');
    }

    // Validate default language is in supported languages
    if (!config.bot.supportedLanguages.includes(config.bot.defaultLanguage)) {
      throw new Error(`bot.defaultLanguage "${config.bot.defaultLanguage}" must be in bot.supportedLanguages`);
    }
  }

  /**
   * Load prompt template from external prompt file
   */
  private loadPromptFile(language: string, personaType: string): string {
    const cacheKey = `${language}_${personaType}`;
    
    if (this.promptCache.has(cacheKey)) {
      return this.promptCache.get(cacheKey)!;
    }

    // Try persona-specific prompt file first, then fallback to generic language file
    const possibleFiles = [
      `${personaType}.${language}.prompt.txt`,
      `${language}.prompt.txt`,
      `${personaType}.english.prompt.txt`,
      `english.prompt.txt`
    ];

    for (const filename of possibleFiles) {
      const promptPath = path.join(CONFIG_DIR, filename);
      
      if (fs.existsSync(promptPath)) {
        try {
          const content = fs.readFileSync(promptPath, 'utf-8');
          this.promptCache.set(cacheKey, content);
          log.info('Loaded prompt', { filename });
          return content;
        } catch (error) {
          log.warn('Failed to read prompt file', { filename, error: error instanceof Error ? error.message : error });
        }
      }
    }

    // Ultimate fallback
    const fallbackPrompt = `You are {{name}}, a {{role}} at {{company}}. Please assist the customer professionally in ${language}.`;
    log.warn('No prompt file found, using fallback', { language, personaType });
    this.promptCache.set(cacheKey, fallbackPrompt);
    return fallbackPrompt;
  }

  /**
   * Process prompt template by substituting variables
   */
  private processPromptTemplate(template: string, config: ExternalConfig): string {
    let processed = template;

    // Replace standard template variables
    const variables: Record<string, string> = {
      name: config.persona.name,
      role: config.persona.role,
      company: config.persona.company,
      tone: config.persona.tone,
      appName: config.app.name,
      ...config.persona.variables || {}
    };

    // Replace {{variable}} patterns
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      processed = processed.replace(regex, String(value));
    }

    return processed;
  }

  /**
   * Convert external config to internal AppConfiguration format
   */
  private convertToAppConfiguration(externalConfig: ExternalConfig, language?: string): AppConfiguration {
    const selectedLanguage = language && externalConfig.bot.supportedLanguages.includes(language) 
      ? language 
      : externalConfig.bot.defaultLanguage;

    // Load and process prompt
    const promptTemplate = this.loadPromptFile(selectedLanguage, externalConfig.persona.type);
    const processedPrompt = this.processPromptTemplate(promptTemplate, externalConfig);

    return {
      app: {
        name: externalConfig.app.name,
        description: externalConfig.app.description,
        version: externalConfig.app.version || '1.0.0'
      },
      bot: {
        defaultLanguage: externalConfig.bot.defaultLanguage,
        supportedLanguages: externalConfig.bot.supportedLanguages,
        voice: externalConfig.bot.voice ?? 'alloy',
        model: externalConfig.bot.model ?? 'gpt-4o-realtime-preview',
        temperature: externalConfig.bot.temperature ?? 0.8
      },
      persona: {
        type: externalConfig.persona.type,
        name: externalConfig.persona.name,
        role: externalConfig.persona.role,
        company: externalConfig.persona.company,
        tone: externalConfig.persona.tone,
        contextTemplate: processedPrompt,
        instructionsTemplate: processedPrompt,
        variables: externalConfig.persona.variables || {}
      },
      features: {
        allowInterruption: externalConfig.features?.allowInterruption ?? true,
        enableLogging: externalConfig.features?.enableLogging ?? true,
        recordCalls: externalConfig.features?.recordCalls ?? false,
        maxCallDuration: externalConfig.features?.maxCallDuration ?? 600
      },
      twilio: {
        webhookBasePath: '/twilio-realtime',
        statusCallbackEvents: ['initiated', 'ringing', 'answered', 'completed']
      },
      openai: {
        realtimeApiUrl: 'wss://api.openai.com/v1/realtime',
        audioFormat: 'pcmu',
        turnDetection: 'server_vad'
      }
    };
  }

  /**
   * Get configuration with optional language override
   */
  getConfiguration(language?: string): AppConfiguration {
    const cacheKey = `config_${language || 'default'}`;
    
    if (this.configCache.has(cacheKey)) {
      return this.configCache.get(cacheKey)!;
    }

    try {
      const externalConfig = this.loadConfigFile();
      const appConfig = this.convertToAppConfiguration(externalConfig, language);
      
      this.configCache.set(cacheKey, appConfig);
      return appConfig;
    } catch (error) {
      log.error('Failed to load external configuration', { error: error instanceof Error ? error.message : error });
      throw error;
    }
  }

  /**
   * Clear caches (useful for hot-reloading config changes)
   */
  clearCache(): void {
    this.configCache.clear();
    this.promptCache.clear();
    log.info('Configuration cache cleared');
  }

  /**
   * Check if external configuration exists
   */
  hasExternalConfig(): boolean {
    return fs.existsSync(path.join(CONFIG_DIR, 'config.json'));
  }

  /**
   * Get configuration directory path
   */
  getConfigDir(): string {
    return CONFIG_DIR;
  }
}

// Export singleton instance
export const externalConfigLoader = new ExternalConfigLoader();

// Export utility functions
export function getExternalConfiguration(language?: string): AppConfiguration {
  return externalConfigLoader.getConfiguration(language);
}

export function hasExternalConfiguration(): boolean {
  return externalConfigLoader.hasExternalConfig();
}

export function getConfigurationDirectory(): string {
  return externalConfigLoader.getConfigDir();
}