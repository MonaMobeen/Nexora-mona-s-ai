export function float32ToPcm16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]!));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i]! / 32768;
  }
  return float32;
}

function downsampleTo16k(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === 16000 || sourceRate <= 0) return samples;
  const ratio = sourceRate / 16000;
  const newLength = Math.max(1, Math.round(samples.length / ratio));
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += samples[j]!;
      count++;
    }
    result[i] = count > 0 ? sum / count : samples[Math.min(start, samples.length - 1)]!;
  }
  return result;
}

export class VoiceAudioEngine {
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private muted = false;
  private onAudioFrameCallback: ((base64Pcm: string, rms: number) => void) | null = null;
  private onPlaybackEmptyCallback: (() => void) | null = null;

  async start(
    onAudioFrame: (base64Pcm: string, rms: number) => void,
    onPlaybackEmpty?: () => void,
  ): Promise<void> {
    await this.stop();
    this.onAudioFrameCallback = onAudioFrame;
    this.onPlaybackEmptyCallback = onPlaybackEmpty ?? null;

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    try {
      this.inputCtx = new AudioContext({ sampleRate: 16000 });
    } catch {
      this.inputCtx = new AudioContext();
    }
    try {
      this.outputCtx = new AudioContext({ sampleRate: 24000 });
    } catch {
      this.outputCtx = new AudioContext();
    }

    await Promise.all([
      this.inputCtx.state === 'suspended' ? this.inputCtx.resume() : Promise.resolve(),
      this.outputCtx.state === 'suspended' ? this.outputCtx.resume() : Promise.resolve(),
    ]);

    this.inputAnalyser = this.inputCtx.createAnalyser();
    this.inputAnalyser.fftSize = 128;

    this.outputAnalyser = this.outputCtx.createAnalyser();
    this.outputAnalyser.fftSize = 128;
    this.outputAnalyser.connect(this.outputCtx.destination);

    this.sourceNode = this.inputCtx.createMediaStreamSource(this.micStream);
    this.processor = this.inputCtx.createScriptProcessor(2048, 1, 1);

    this.sourceNode.connect(this.inputAnalyser);
    this.inputAnalyser.connect(this.processor);
    this.processor.connect(this.inputCtx.destination);

    const actualInputRate = this.inputCtx.sampleRate;
    this.processor.onaudioprocess = (event) => {
      if (this.muted || !this.onAudioFrameCallback) return;
      const rawSamples = event.inputBuffer.getChannelData(0);
      const samples = downsampleTo16k(rawSamples, actualInputRate);
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        sumSq += samples[i]! * samples[i]!;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      const encoded = float32ToPcm16Base64(samples);
      this.onAudioFrameCallback(encoded, rms);
    };

    this.nextStartTime = this.outputCtx.currentTime;
  }

  setMuted(mute: boolean): void {
    this.muted = mute;
  }

  isMuted(): boolean {
    return this.muted;
  }

  playPcmChunk(base64Pcm24k: string): void {
    if (!this.outputCtx || !this.outputAnalyser) return;
    if (this.outputCtx.state === 'suspended') {
      void this.outputCtx.resume();
    }

    const float32 = pcm16Base64ToFloat32(base64Pcm24k);
    const audioBuffer = this.outputCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(new Float32Array(float32), 0);

    const source = this.outputCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputAnalyser);

    const now = this.outputCtx.currentTime;
    const startAt = Math.max(now + 0.015, this.nextStartTime);
    this.nextStartTime = startAt + audioBuffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0 && this.onPlaybackEmptyCallback) {
        this.onPlaybackEmptyCallback();
      }
    };

    source.start(startAt);
  }

  interruptPlayback(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore stopped sources
      }
    }
    this.activeSources.clear();
    if (this.outputCtx) {
      this.nextStartTime = this.outputCtx.currentTime;
    }
  }

  isPlayingOutput(): boolean {
    return this.activeSources.size > 0;
  }

  getVisualizationData(targetArray: Uint8Array<ArrayBuffer>, mode: 'input' | 'output'): number {
    const analyser = mode === 'output' ? this.outputAnalyser : this.inputAnalyser;
    if (!analyser) {
      targetArray.fill(0);
      return 0;
    }
    analyser.getByteFrequencyData(targetArray);
    let total = 0;
    for (let i = 0; i < targetArray.length; i++) {
      total += targetArray[i]!;
    }
    return total / (targetArray.length * 255);
  }

  async stop(): Promise<void> {
    this.interruptPlayback();
    this.onAudioFrameCallback = null;
    this.onPlaybackEmptyCallback = null;

    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }
    if (this.inputCtx) {
      await this.inputCtx.close().catch(() => {});
      this.inputCtx = null;
    }
    if (this.outputCtx) {
      await this.outputCtx.close().catch(() => {});
      this.outputCtx = null;
    }
    this.inputAnalyser = null;
    this.outputAnalyser = null;
  }
}
