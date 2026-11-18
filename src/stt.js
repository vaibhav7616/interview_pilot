// Live speech-to-text through Deepgram's streaming API.
// Audio arrives as 16 kHz, 16-bit, 2-channel interleaved PCM:
//   channel 0 = computer audio (the interviewer / other people on the call)
//   channel 1 = microphone (you)
const { EventEmitter } = require('events');
const WebSocket = require('ws');

class DeepgramSTT extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.keepAlive = null;
    this.stopped = true;
    this.retries = 0;
    this.config = null;
  }

  start({ apiKey, language }) {
    if (!apiKey) throw new Error('Deepgram API key is missing. Add it in Settings.');
    this.config = { apiKey, language: language || 'en' };
    this.stopped = false;
    this.retries = 0;
    this._connect();
  }

  _connect() {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: this.config.language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '2',
      multichannel: 'true',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.config.apiKey}` },
    });
    this.ws = ws;
    this.emit('status', { state: 'connecting' });

    ws.on('open', () => {
      this.retries = 0;
      this.emit('status', { state: 'connected' });
      clearInterval(this.keepAlive);
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 8000);
    });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let msg = `Deepgram refused the connection (HTTP ${res.statusCode}).`;
        if (res.statusCode === 401) msg = 'Deepgram API key is invalid.';
        else if (body) msg += ' ' + body.slice(0, 300);
        this.stopped = true;
        this.emit('error', new Error(msg));
      });
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'Results') {
        const channel = Array.isArray(msg.channel_index) ? msg.channel_index[0] : 0;
        const text = msg.channel?.alternatives?.[0]?.transcript || '';
        if (!text && !msg.speech_final) return;
        this.emit('transcript', {
          channel,
          text,
          isFinal: !!msg.is_final,
          speechFinal: !!msg.speech_final,
        });
      } else if (msg.type === 'UtteranceEnd') {
        const channel = Array.isArray(msg.channel) ? msg.channel[0] : 0;
        this.emit('utteranceEnd', { channel });
      } else if (msg.type === 'SpeechStarted') {
        const channel = Array.isArray(msg.channel) ? msg.channel[0] : 0;
        this.emit('speechStarted', { channel });
      }
    });

    ws.on('error', (err) => {
      if (!this.stopped) this.emit('status', { state: 'error', message: err.message });
    });

    ws.on('close', () => {
      clearInterval(this.keepAlive);
      if (this.stopped) {
        this.emit('status', { state: 'stopped' });
        return;
      }
      if (this.retries < 5) {
        this.retries += 1;
        this.emit('status', { state: 'reconnecting', attempt: this.retries });
        setTimeout(() => !this.stopped && this._connect(), 500 * this.retries);
      } else {
        this.stopped = true;
        this.emit('error', new Error('Lost connection to Deepgram after several retries.'));
      }
    });
  }

  sendAudio(buf) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.keepAlive);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        setTimeout(() => ws.close(), 1500);
      } else {
        ws.terminate();
      }
    } catch {
      /* ignore */
    }
  }
}

module.exports = { DeepgramSTT };
