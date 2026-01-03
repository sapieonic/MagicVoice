import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import twilioRealtimeRouter, { mediaStreamWebSocketHandler, callMetadata } from './routes/twilio-realtime.js';
import { twilioClient, twilioPhoneNumber } from './routes/twilio-utils.js';
import rtcRouter from './routes/rtc.js';
import observerRouter from './routes/observer.js';
import recordingsRouter from './routes/recordings.js';
import { getConfiguration, getAvailablePersonas } from './config/app.config.js';
import { externalConfigLoader, hasExternalConfiguration, getConfigurationDirectory } from './config/external-config-loader.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
expressWs(app);

// Enable CORS for all routes
app.use(cors());

// Get app configuration
const appConfig = getConfiguration();
const PORT = process.env.PORT || 3000;

// Twilio Realtime API routes
app.use('/twilio-realtime', twilioRealtimeRouter);

// WebRTC routes for browser-based voice interaction
app.use('/rtc', rtcRouter);
app.use('/observer', observerRouter);

// Recordings management routes
app.use('/api/recordings', recordingsRouter);

// Register WebSocket endpoint for Twilio Media Stream
(app as any).ws('/twilio-realtime/media-stream', mediaStreamWebSocketHandler);

// Configuration API endpoints
app.get('/api/config', (_req, res) => {
  res.json({
    app: appConfig.app,
    bot: {
      supportedLanguages: appConfig.bot.supportedLanguages,
      defaultLanguage: appConfig.bot.defaultLanguage
    },
    persona: {
      type: appConfig.persona.type,
      name: appConfig.persona.name,
      role: appConfig.persona.role,
      company: appConfig.persona.company
    },
    availablePersonas: getAvailablePersonas()
  });
});

app.get('/api/personas', (_req, res) => {
  const personas = getAvailablePersonas().map(type => {
    const config = getConfiguration(type);
    return {
      type,
      name: config.persona.name,
      role: config.persona.role,
      company: config.persona.company,
      tone: config.persona.tone
    };
  });
  res.json(personas);
});

app.get('/api/config-info', (_req, res) => {
  res.json({
    usingExternalConfig: hasExternalConfiguration(),
    configDirectory: getConfigurationDirectory(),
    availablePersonas: getAvailablePersonas()
  });
});

app.post('/api/reload-config', (_req, res) => {
  try {
    externalConfigLoader.clearCache();
    res.json({ success: true, message: 'Configuration cache cleared successfully' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Simple API endpoint for initiating calls with custom prompts
app.post('/api/call', express.json(), async (req, res) => {
  try {
    const { phoneNumber, systemPrompt, voice, record = false } = req.body;

    // Validation
    if (!phoneNumber) {
      res.type('json').status(400).json({ success: false, error: 'phoneNumber is required' });
      return;
    }
    if (!systemPrompt) {
      res.type('json').status(400).json({ success: false, error: 'systemPrompt is required' });
      return;
    }
    if (!twilioClient) {
      res.type('json').status(500).json({ success: false, error: 'Twilio not configured' });
      return;
    }

    // Build webhook URL
    const forwardedHost = req.get('x-forwarded-host');
    const forwardedProto = req.get('x-forwarded-proto') || 'https';
    const host = forwardedHost || req.get('host');
    const baseUrl = `${forwardedProto}://${host}`;

    logger.info('API Call: Initiating call with custom prompt', { phoneNumber, record, baseUrl });

    // Create call
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: twilioPhoneNumber!,
      url: `${baseUrl}/twilio-realtime/answer`,
      statusCallback: `${baseUrl}/twilio-realtime/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: record
    });

    // Store metadata with custom prompt
    callMetadata.set(call.sid, {
      language: 'english',
      phoneNumber,
      customSystemPrompt: systemPrompt,
      customVoice: voice
    });

    logger.info('Call initiated via API', { callSid: call.sid, status: call.status });

    res.type('json').json({
      success: true,
      callSid: call.sid,
      status: call.status
    });
  } catch (error: any) {
    logger.error('Error initiating call via API', { error: error.message });
    res.type('json').status(500).json({ success: false, error: error.message });
  }
});

// End an active call
app.post('/api/call/:callSid/end', async (req, res) => {
  try {
    const { callSid } = req.params;

    if (!callSid) {
      res.type('json').status(400).json({ success: false, error: 'callSid is required' });
      return;
    }
    if (!twilioClient) {
      res.type('json').status(500).json({ success: false, error: 'Twilio not configured' });
      return;
    }

    logger.info('API: Ending call', { callSid });

    // Update call status to completed to end it
    const call = await twilioClient.calls(callSid).update({ status: 'completed' });

    // Clean up metadata
    callMetadata.delete(callSid);

    logger.info('Call ended via API', { callSid, status: call.status });

    res.type('json').json({
      success: true,
      callSid: call.sid,
      status: call.status
    });
  } catch (error: any) {
    logger.error('Error ending call via API', { callSid: req.params.callSid, error: error.message });
    res.type('json').status(500).json({ success: false, error: error.message });
  }
});

// Determine the correct public directory path
const publicDir = process.env.NODE_ENV === 'production' || __dirname.includes('dist')
  ? path.join(__dirname, 'public')  // In production, public is copied to dist/public
  : path.join(__dirname, 'public'); // In development, public is in the same directory

// Serve static files from the public directory
app.use(express.static(publicDir));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index-twilio.html'));
});

app.get('/twilio', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index-twilio.html'));
});

app.listen(PORT, () => {
  logger.info('Server started', {
    appName: appConfig.app.name,
    port: PORT,
    persona: appConfig.persona.name,
    role: appConfig.persona.role,
    defaultLanguage: appConfig.bot.defaultLanguage,
    availablePersonas: getAvailablePersonas(),
  });
});