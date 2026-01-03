import express, { Request, Response } from 'express';
import WebSocket from 'ws';
import { makeHeaders } from './utils.js';
import { audioRecorderManager } from '../utils/audioUtils.js';
import { executeFunctionCall } from '../functions/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('observer');

const router = express.Router();

interface ObserverMessage {
  type: string;
  event_id?: string;
  response_id?: string;
  item_id?: string;
  output_index?: number;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    type?: string;
    name?: string;
    call?: {
      call_id: string;
      arguments: string;
    };
  };
  call?: {
    call_id: string;
    function_name: string;
    arguments: string;
  };
  error?: {
    message: string;
  };
  audio?: string; // Base64 encoded audio for WebRTC
  delta?: string; // Audio delta for responses
}

// POST /observer/:callId : establish WebSocket connection to monitor the call
router.post('/:callId', express.json(), async (req: Request<{ callId: string }>, res: Response) => {
  try {
    const callId = req.params.callId;
    const url = `wss://api.openai.com/v1/realtime?call_id=${callId}`;
    const ws = new WebSocket(url, { headers: makeHeaders() });
    
    ws.on('open', () => {
      log.info('Observer WebSocket connected', { callId });
      // Trigger initial response after connection
      setTimeout(() => ws.send(JSON.stringify({ type: "response.create" })), 250);
    });
    
    ws.on('message', (data: WebSocket.Data) => {
      try {
        const message: ObserverMessage = JSON.parse(data.toString());

        // Log all messages except audio transcript deltas (too verbose)
        if (message.type !== "response.audio_transcript.delta") {
          log.debug('Observer message', { callId, type: message.type, error: message.error?.message });
        }

        // Handle audio recording for WebRTC calls
        const recorder = audioRecorderManager.getRecorder(callId);
        if (recorder.recording) {
          // Record incoming audio from user
          if (message.type === 'input_audio_buffer.append' && message.audio) {
            recorder.addIncomingAudio(message.audio);
          }
          // Record outgoing audio from bot
          else if (message.type === 'response.output_audio.delta' && message.delta) {
            recorder.addOutgoingAudio(message.delta);
          }
        }

        // Handle specific message types
        if (message.type === 'session.created') {
          log.info('Session created', { callId });
        } else if (message.type === 'response.done') {
          log.debug('Response completed', { callId });
        } else if (message.type === 'response.function_call_arguments.done') {
          log.info('Function call completed', { callId });
          try {
            const functionName = message.name;
            const args = JSON.parse(message.arguments || '{}');
            const callIdForFunction = message.call_id;
            log.info('Executing function', { callId, functionName });

            const result = executeFunctionCall(functionName!, args);

            // Send function result back to OpenAI
            const functionResultMessage = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callIdForFunction,
                output: JSON.stringify(result)
              }
            };

            ws.send(JSON.stringify(functionResultMessage));

            // Trigger response generation after function execution
            ws.send(JSON.stringify({ type: 'response.create' }));

          } catch (error) {
            log.error('Error executing function call', { callId, error: error instanceof Error ? error.message : error });

            // Send error result back to OpenAI
            const errorMessage = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: message.call_id,
                output: JSON.stringify({
                  success: false,
                  message: `Error executing function: ${error instanceof Error ? error.message : 'Unknown error'}`
                })
              }
            };

            ws.send(JSON.stringify(errorMessage));
            ws.send(JSON.stringify({ type: 'response.create' }));
          }
        } else if (message.type === 'error') {
          log.error('Error in call', { callId, error: message.error });
        }
      } catch (error) {
        log.error('Error processing observer message', { error: error instanceof Error ? error.message : error });
      }
    });

    ws.on('error', (error: Error) => {
      log.error('Observer WebSocket failed', { callId, error: error.message });
    });

    ws.on('close', () => {
      log.info('Observer WebSocket closed', { callId });

      // Stop and save recording if active
      const recorder = audioRecorderManager.getRecorder(callId);
      if (recorder.recording) {
        recorder.stop().then(paths => {
          if (paths.incomingPath || paths.outgoingPath) {
            log.info('WebRTC recordings saved', { callId, paths });
          }
        }).catch(err => {
          log.error('Failed to save WebRTC recordings', { callId, error: err.message });
        });
      }
      audioRecorderManager.removeRecorder(callId);
    });

    // Respond immediately; WebSocket continues in background
    res.status(200).json({ success: true, message: `Observer started for call ${callId}` });
    
  } catch (error: any) {
    log.error('Observer setup error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

export default router;