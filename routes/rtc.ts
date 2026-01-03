import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { makeHeaders, makeSession, getAppConfiguration } from './utils.js';
import { audioRecorderManager } from '../utils/audioUtils.js';
import { createLogger } from '../logger.js';

const log = createLogger('rtc');
const router = express.Router();

// POST /rtc : create a new WebRTC call
router.post('/', express.text({ type: '*/*' }), async (req: Request, res: Response): Promise<void> => {
  try {
    const url = "https://api.openai.com/v1/realtime/calls";
    const headers = makeHeaders();
    
    // Get language, persona, and recording preference from headers
    const language = req.headers['x-language'] as string || getAppConfiguration().bot.defaultLanguage;
    const personaType = req.headers['x-persona'] as string;
    const enableRecording = req.headers['x-enable-recording'] === 'true';
    const config = getAppConfiguration(personaType);
    log.info('Creating WebRTC session', { language, persona: personaType || 'default', recording: enableRecording, botName: config.persona.name });

    const sessionConfig = makeSession(language, personaType);
    log.debug('Session config', { sessionConfig });

    const formData = new FormData();
    formData.set("sdp", req.body);
    formData.set("session", JSON.stringify(sessionConfig));

    log.debug('Sending request to OpenAI Realtime API');
    const opts = { method: "POST", headers, body: formData };
    const resp = await fetch(url, opts);
    
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "<no body>");
      log.error('Start call failed', { status: resp.status, error: errText });
      res.status(500).send("Internal error");
      return;
    }

    const contentType = resp.headers.get("Content-Type");
    const location = resp.headers.get("Location");
    const callId = location?.split("/").pop();
    log.info('WebRTC call created', { callId });

    // Start recording if enabled
    if (enableRecording && callId) {
      const recorder = audioRecorderManager.getRecorder(callId);
      recorder.start();
      log.info('Recording started for WebRTC call', { callId });
    }

    // Kick off observer in the background (fire-and-forget)
    const protocol = req.protocol;
    const host = req.get('host');
    const selfUrl = `${protocol}://${host}`;

    fetch(`${selfUrl}/observer/${callId}`, { method: "POST" }).catch(err => {
      log.warn('Observer connection error', { error: err.message });
    });

    // Send the response back to client
    if (contentType) {
      res.set('Content-Type', contentType);
    }
    const responseText = await resp.text();
    res.send(responseText);

  } catch (error: any) {
    log.error('RTC call error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

export default router;