import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('audio-utils');

/**
 * Audio recording and WAV file utilities for saving call audio
 */

// μ-law decoding table
const ULAW_DECODE_TABLE = new Int16Array([
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0
]);

/**
 * Converts μ-law encoded audio to 16-bit PCM
 */
export function ulawToPcm(ulawData: Uint8Array): Int16Array {
  const pcmData = new Int16Array(ulawData.length);
  for (let i = 0; i < ulawData.length; i++) {
    pcmData[i] = ULAW_DECODE_TABLE[ulawData[i]];
  }
  return pcmData;
}

/**
 * Writes a string into a DataView at the given offset
 */
export function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Converts 16-bit PCM samples to a WAV file buffer
 */
export function pcmToWav(pcmData: Int16Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcmData.length * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmData.length * 2, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // audio format (1 = PCM)
  view.setUint16(22, 1, true); // channels (1 = mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, pcmData.length * 2, true);

  // Write PCM data
  let offset = 44;
  for (let i = 0; i < pcmData.length; i++) {
    view.setInt16(offset, pcmData[i], true);
    offset += 2;
  }

  return buffer;
}

/**
 * Audio stream recorder for capturing incoming and outgoing audio
 */
export class AudioRecorder {
  private incomingBuffer: Uint8Array[] = [];
  private outgoingBuffer: Uint8Array[] = [];
  private combinedBuffer: { data: Uint8Array; type: 'incoming' | 'outgoing'; timestamp: number }[] = [];
  private callId: string;
  private recordingsDir: string;
  private isRecording: boolean = false;

  constructor(callId: string) {
    this.callId = callId;
    this.recordingsDir = path.join(process.cwd(), 'recordings');

    // Create recordings directory if it doesn't exist
    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
    }
  }

  /**
   * Start recording audio
   */
  start(): void {
    this.isRecording = true;
    this.incomingBuffer = [];
    this.outgoingBuffer = [];
    this.combinedBuffer = [];
    log.info('Started recording', { callId: this.callId });
  }

  /**
   * Add incoming audio data (from user)
   */
  addIncomingAudio(base64Audio: string): void {
    if (!this.isRecording) return;

    const audioBuffer = Buffer.from(base64Audio, 'base64');
    const audioData = new Uint8Array(audioBuffer);
    this.incomingBuffer.push(audioData);
    this.combinedBuffer.push({
      data: audioData,
      type: 'incoming',
      timestamp: Date.now()
    });
  }

  /**
   * Add outgoing audio data (from bot)
   */
  addOutgoingAudio(base64Audio: string): void {
    if (!this.isRecording) return;

    const audioBuffer = Buffer.from(base64Audio, 'base64');
    const audioData = new Uint8Array(audioBuffer);
    this.outgoingBuffer.push(audioData);
    this.combinedBuffer.push({
      data: audioData,
      type: 'outgoing',
      timestamp: Date.now()
    });
  }

  /**
   * Stop recording and save audio files
   */
  async stop(): Promise<{ incomingPath?: string; outgoingPath?: string; combinedPath?: string }> {
    if (!this.isRecording) return {};

    this.isRecording = false;
    log.info('Stopped recording', { callId: this.callId });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const paths: { incomingPath?: string; outgoingPath?: string; combinedPath?: string } = {};

    // Save incoming audio
    if (this.incomingBuffer.length > 0) {
      const incomingPath = path.join(
        this.recordingsDir,
        `${this.callId}_${timestamp}_incoming.wav`
      );
      await this.saveAudioFile(this.incomingBuffer, incomingPath);
      paths.incomingPath = incomingPath;
    }

    // Save outgoing audio
    if (this.outgoingBuffer.length > 0) {
      const outgoingPath = path.join(
        this.recordingsDir,
        `${this.callId}_${timestamp}_outgoing.wav`
      );
      await this.saveAudioFile(this.outgoingBuffer, outgoingPath);
      paths.outgoingPath = outgoingPath;
    }

    // Save combined audio (conversation)
    if (this.combinedBuffer.length > 0) {
      const combinedPath = path.join(
        this.recordingsDir,
        `${this.callId}_${timestamp}_conversation.wav`
      );
      await this.saveCombinedAudioFile(this.combinedBuffer, combinedPath);
      paths.combinedPath = combinedPath;
    }

    return paths;
  }

  /**
   * Save combined audio buffer to WAV file (chronologically ordered conversation)
   */
  private async saveCombinedAudioFile(
    combinedBuffer: { data: Uint8Array; type: 'incoming' | 'outgoing'; timestamp: number }[],
    filePath: string
  ): Promise<void> {
    // Sort by timestamp to ensure chronological order
    const sortedBuffer = combinedBuffer.sort((a, b) => a.timestamp - b.timestamp);

    // Combine all audio buffers in chronological order
    const totalLength = sortedBuffer.reduce((sum, item) => sum + item.data.length, 0);
    const combinedAudio = new Uint8Array(totalLength);
    let offset = 0;

    for (const item of sortedBuffer) {
      combinedAudio.set(item.data, offset);
      offset += item.data.length;
    }

    // Convert μ-law to PCM
    const pcmData = ulawToPcm(combinedAudio);

    // Convert to WAV
    const wavBuffer = pcmToWav(pcmData, 8000); // Twilio uses 8kHz sample rate

    // Save to file
    await fs.promises.writeFile(filePath, Buffer.from(wavBuffer));
  }

  /**
   * Save audio buffer to WAV file
   */
  private async saveAudioFile(audioBuffers: Uint8Array[], filePath: string): Promise<void> {
    // Combine all audio buffers
    const totalLength = audioBuffers.reduce((sum, buf) => sum + buf.length, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;

    for (const buffer of audioBuffers) {
      combinedBuffer.set(buffer, offset);
      offset += buffer.length;
    }

    // Convert μ-law to PCM
    const pcmData = ulawToPcm(combinedBuffer);

    // Convert to WAV
    const wavBuffer = pcmToWav(pcmData, 8000); // Twilio uses 8kHz sample rate

    // Save to file
    await fs.promises.writeFile(filePath, Buffer.from(wavBuffer));
  }

  /**
   * Get current recording status
   */
  get recording(): boolean {
    return this.isRecording;
  }
}

/**
 * Manages audio recorders for multiple calls
 */
export class AudioRecorderManager {
  private recorders: Map<string, AudioRecorder> = new Map();

  /**
   * Get or create a recorder for a call
   */
  getRecorder(callId: string): AudioRecorder {
    if (!this.recorders.has(callId)) {
      this.recorders.set(callId, new AudioRecorder(callId));
    }
    return this.recorders.get(callId)!;
  }

  /**
   * Remove a recorder for a call
   */
  removeRecorder(callId: string): void {
    const recorder = this.recorders.get(callId);
    if (recorder && recorder.recording) {
      recorder.stop();
    }
    this.recorders.delete(callId);
  }

  /**
   * Stop all active recordings
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.recorders.values())
      .filter(r => r.recording)
      .map(r => r.stop());
    await Promise.all(stopPromises);
  }
}

// Export a singleton instance
export const audioRecorderManager = new AudioRecorderManager();