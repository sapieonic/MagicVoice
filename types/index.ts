export interface SessionConfig {
  type: string;
  model: string;
  instructions: string;
  voice: string;
  turn_detection: {
    type: string;
  };
  temperature?: number;
  tools?: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required: string[];
    };
  }>;
  tool_choice?: string;
  audio: {
    input: {
      noise_reduction?: {
        type: string;
      };
      format?: {
        type: string;
      };
    };
    output?: {
      voice?: string;
      format?: {
        type: string;
      };
    };
  };
}

export interface CallMetadata {
  language: string;
  phoneNumber: string;
  customSystemPrompt?: string;
  customVoice?: string;
}

export interface TwilioMediaMessage {
  event: 'start' | 'media' | 'mark' | 'stop';
  sequenceNumber?: string;
  start?: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    tracks: string[];
    customParameters: Record<string, string>;
  };
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
  mark?: {
    name: string;
  };
  stop?: {
    accountSid: string;
    callSid: string;
  };
}

export interface OpenAIRealtimeMessage {
  type: string;
  session?: any;
  delta?: string;
  item_id?: string;
  event_id?: string;
  response_id?: string;
  output_index?: number;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    role?: string;
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
}

export interface TwilioCallRequest {
  phoneNumber: string;
  language?: string;
}

export interface TwilioWebhookRequest {
  CallSid: string;
  CallStatus: string;
  CallDuration?: string;
  From?: string;
  To?: string;
}