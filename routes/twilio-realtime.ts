import express, { Request, Response } from 'express';
import WebSocket from 'ws';
import { twilioClient, twilioPhoneNumber } from './twilio-utils.js';
import { makeSession, getAppConfiguration } from './utils.js';
import dotenv from 'dotenv';
import {
  CallMetadata,
  TwilioMediaMessage,
  OpenAIRealtimeMessage,
  TwilioCallRequest,
  TwilioWebhookRequest
} from '../types/index.js';
import { createLogger } from '../logger.js';

dotenv.config();

const log = createLogger('twilio-realtime');

const router = express.Router();
const activeConnections = new Map<string, WebSocket>();

interface ExtendedCallMetadata extends CallMetadata {
  personaType?: string;
}
// Export callMetadata for use by /api/call endpoint
export const callMetadata = new Map<string, ExtendedCallMetadata>();

// Get configuration
const appConfig = getAppConfiguration();
const TEMPERATURE = appConfig.bot.temperature;
const SHOW_TIMING_MATH = false;

// Log event types for debugging
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated'
];

// Enhanced request interface for calls
interface EnhancedTwilioCallRequest extends TwilioCallRequest {
  personaType?: string;
}

// Initiate an outbound call
router.post('/call', express.json(), async (req: Request<{}, {}, EnhancedTwilioCallRequest>, res: Response): Promise<void> => {
  try {
    const { phoneNumber, language = appConfig.bot.defaultLanguage, personaType } = req.body;
    const config = getAppConfiguration(personaType);
    log.info('Creating Twilio call', { language, persona: personaType || 'default', botName: config.persona.name, role: config.persona.role });
    
    if (!twilioClient) {
      res.status(500).json({ error: 'Twilio not configured' });
      return;
    }
    
    if (!phoneNumber) {
      res.status(400).json({ error: 'Phone number is required' });
      return;
    }

    // Get the base URL for webhooks
    const forwardedHost = req.get('x-forwarded-host');
    const forwardedProto = req.get('x-forwarded-proto') || 'https';
    const host = forwardedHost || req.get('host');
    const baseUrl = `${forwardedProto}://${host}`;
    
    log.debug('Using webhook base URL', { baseUrl });
    
    // Create the call with media streams
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: twilioPhoneNumber!,
      url: `${baseUrl}/twilio-realtime/answer`,
      statusCallback: `${baseUrl}/twilio-realtime/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: false
    });

    // Store call metadata including persona
    callMetadata.set(call.sid, { language, phoneNumber, personaType });
    
    log.info('Call initiated', { phoneNumber, callSid: call.sid, status: call.status });
    res.json({ 
      success: true, 
      callSid: call.sid,
      status: call.status 
    });

  } catch (error: any) {
    log.error('Error initiating call', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// TwiML endpoint - handles call when answered
router.get('/answer', (_req: Request, res: Response) => {
  log.debug('Twilio webhook verification request received');
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Webhook configured successfully.</Say>
    </Response>`);
});

// POST handler for actual call handling
router.post('/answer', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const callSid = req.body.CallSid;
  log.info('Call answered', { callSid });

  // Generate TwiML to connect to Media Streams
  const forwardedHost = req.get('x-forwarded-host');
  const forwardedProto = req.get('x-forwarded-proto') || 'https';
  const host = forwardedHost || req.get('host');
  const wsProto = (forwardedProto === 'https' || req.protocol === 'https') ? 'wss' : 'ws';
  const streamUrl = `${wsProto}://${host}/twilio-realtime/media-stream`;
  
  log.debug('WebSocket URL configured', { streamUrl });
  
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="callSid" value="${callSid}"/>
        </Stream>
      </Connect>
    </Response>`);
});

// WebSocket handler for Twilio Media Streams
export const mediaStreamWebSocketHandler = (ws: WebSocket, _req: Request) => {
  log.info('Twilio Media Stream WebSocket connected');
  
  // Connection-specific state
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let callLanguage = appConfig.bot.defaultLanguage;
  let callPersonaType: string | undefined = undefined;
  let customSystemPrompt: string | undefined = undefined;
  let customVoice: string | undefined = undefined;
  let latestMediaTimestamp = 0;
  let lastAssistantItem: string | null = null;
  let markQueue: string[] = [];
  let responseStartTimestampTwilio: number | null = null;
  
  // Connect to OpenAI Realtime API
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview&temperature=${TEMPERATURE}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    }
  });

  // Initialize session with OpenAI
  const initializeSession = () => {
    // Use custom prompt if provided, otherwise use default session
    const instructions = customSystemPrompt || makeSession(callLanguage, callPersonaType).instructions;
    const voice = customVoice || getAppConfiguration(callPersonaType).bot.voice;

    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: "gpt-4o-realtime-preview",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: { type: "server_vad" }
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: voice
          },
        },
        instructions: instructions,
      },
    };

    if (customSystemPrompt) {
      log.info('Sending session update with custom system prompt', { voice });
    } else {
      const currentConfig = getAppConfiguration(callPersonaType);
      log.info('Sending session update', { language: callLanguage, persona: currentConfig.persona.name });
    }
    openAiWs.send(JSON.stringify(sessionUpdate));

    // Trigger initial response after session setup
    setTimeout(() => {
      log.debug('Triggering initial bot response');
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    }, 500);
  };

  // Handle speech interruption
  const handleSpeechStartedEvent = () => {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (SHOW_TIMING_MATH) log.debug('Calculating elapsed time for truncation', { elapsedTime });

      if (lastAssistantItem) {
        const truncateEvent = {
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime
        };
        if (SHOW_TIMING_MATH) log.debug('Sending truncation event', { truncateEvent });
        openAiWs.send(JSON.stringify(truncateEvent));
      }

      // Clear Twilio's audio buffer
      ws.send(JSON.stringify({
        event: 'clear',
        streamSid: streamSid
      }));

      // Reset state
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  };

  // Send mark messages to track playback
  const sendMark = () => {
    if (streamSid) {
      const markEvent = {
        event: 'mark',
        streamSid: streamSid,
        mark: { name: 'responsePart' }
      };
      ws.send(JSON.stringify(markEvent));
      markQueue.push('responsePart');
    }
  };

  // OpenAI WebSocket event handlers
  openAiWs.on('open', () => {
    log.info('Connected to OpenAI Realtime API');
    setTimeout(initializeSession, 100);
  });

  openAiWs.on('message', (data: WebSocket.Data) => {
    try {
      const response: OpenAIRealtimeMessage = JSON.parse(data.toString());

      if (LOG_EVENT_TYPES.includes(response.type)) {
        log.debug('OpenAI event', { type: response.type });
      }

      // Handle audio output from OpenAI
      if (response.type === 'response.output_audio.delta' && response.delta) {
        const audioDelta = {
          event: 'media',
          streamSid: streamSid,
          media: { payload: response.delta }
        };
        ws.send(JSON.stringify(audioDelta));

        // Track timing for interruption handling
        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
          if (SHOW_TIMING_MATH) log.debug('Setting start timestamp', { responseStartTimestampTwilio });
        }

        if (response.item_id) {
          lastAssistantItem = response.item_id;
        }
        
        sendMark();
        // log.trace('Audio sent to Twilio');
      }

      // Handle speech interruption
      if (response.type === 'input_audio_buffer.speech_started') {
        log.debug('User started speaking (interruption)');
        handleSpeechStartedEvent();
      }

      // Log conversation events
      if (response.type === 'conversation.item.created' && response.item?.role === 'assistant') {
        log.debug('Assistant speaking');
      }

      if (response.type === 'response.done') {
        log.debug('Response complete');
      }

      if (response.type === 'error') {
        log.error('OpenAI error', { error: response.error });
      }

    } catch (error) {
      log.error('Error processing OpenAI message', { error: error instanceof Error ? error.message : error });
    }
  });

  openAiWs.on('error', (error: Error) => {
    log.error('OpenAI WebSocket error', { error: error.message });
  });

  openAiWs.on('close', () => {
    log.info('OpenAI WebSocket closed');
  });

  // Handle incoming messages from Twilio
  ws.on('message', (message: WebSocket.Data) => {
    try {
      const data: TwilioMediaMessage = JSON.parse(message.toString());

      switch (data.event) {
        case 'start':
          if (data.start) {
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;

            // Retrieve language, persona, and custom prompt from metadata
            const metadata = callMetadata.get(callSid);
            if (metadata) {
              callLanguage = metadata.language;
              callPersonaType = metadata.personaType;
              customSystemPrompt = metadata.customSystemPrompt;
              customVoice = metadata.customVoice;

              if (customSystemPrompt) {
                log.info('Media stream started with custom prompt', { callSid, streamSid });
              } else {
                const config = getAppConfiguration(callPersonaType);
                log.info('Media stream started', { callSid, streamSid, language: callLanguage, persona: config.persona.name });
              }
            } else {
              log.info('Media stream started with defaults', { callSid, streamSid, language: callLanguage });
            }

            // Reset timestamps for new stream
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
          }
          break;

        case 'media':
          // Track latest timestamp for interruption handling
          if (data.media) {
            latestMediaTimestamp = parseInt(data.media.timestamp);
            
            // Forward audio to OpenAI
            if (openAiWs.readyState === WebSocket.OPEN && data.media.payload) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
          }
          break;

        case 'mark':
          // Remove mark from queue when Twilio confirms playback
          if (markQueue.length > 0) {
            markQueue.shift();
          }
          break;

        case 'stop':
          log.info('Media stream stopped', { callSid });
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.close();
          }
          break;

        default:
          log.trace('Received Twilio event', { event: data.event });
          break;
      }
    } catch (error) {
      log.error('Error processing Twilio message', { error: error instanceof Error ? error.message : error });
    }
  });

  // Handle connection close
  ws.on('close', () => {
    log.info('Twilio WebSocket disconnected');
    if (openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
    if (callSid) {
      activeConnections.delete(callSid);
      // Clean up call metadata to prevent memory leaks
      callMetadata.delete(callSid);
    }
  });

  ws.on('error', (error: Error) => {
    log.error('Twilio WebSocket error', { error: error.message });
  });
};

// Status callback endpoint
router.get('/status', (_req: Request, res: Response) => {
  log.debug('Status webhook verification request received');
  res.status(200).send('Status webhook configured');
});

router.post('/status', express.urlencoded({ extended: false }), (req: Request<{}, {}, TwilioWebhookRequest>, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  const status = { callSid: CallSid, status: CallStatus, duration: CallDuration };
  log.info('Call status update', status);
  
  if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer') {
    activeConnections.delete(CallSid);
  }
  
  res.status(200).json(status).end();
});

export default router;