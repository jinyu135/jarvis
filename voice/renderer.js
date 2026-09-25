/**
 * Microphone capture for the Electron renderer.
 * `onAudio` receives a 16 kHz mono, 16-bit PCM WAV Uint8Array.
 */
export function createVoiceCapture({ onAudio, chunkMs = 5000 } = {}) {
  if (typeof onAudio !== 'function') throw new TypeError('onAudio 콜백이 필요합니다.');

  let stream = null;
  let context = null;
  let source = null;
  let processor = null;
  let frames = [];
  let frameCount = 0;
  let peakLevel = 0;
  let durationMs = Math.max(1000, Number(chunkMs) || 5000);
  let starting = null;

  function encodeWav(samples, inputRate) {
    const outputRate = 16000;
    const outputLength = Math.ceil(samples.length * outputRate / inputRate);
    const wav = new Uint8Array(44 + outputLength * 2);
    const view = new DataView(wav.buffer);
    const writeFourCC = (offset, value) => {
      for (let index = 0; index < 4; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    writeFourCC(0, 'RIFF');
    view.setUint32(4, wav.length - 8, true);
    writeFourCC(8, 'WAVE');
    writeFourCC(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, outputRate, true);
    view.setUint32(28, outputRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeFourCC(36, 'data');
    view.setUint32(40, outputLength * 2, true);
    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * inputRate / outputRate;
      const left = Math.min(Math.floor(sourcePosition), samples.length - 1);
      const right = Math.min(left + 1, samples.length - 1);
      const fraction = sourcePosition - left;
      const value = Math.max(-1, Math.min(1, samples[left] * (1 - fraction) + samples[right] * fraction));
      view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    return wav;
  }

  function emitFrames(force = false) {
    if (!context || frameCount === 0) return;
    const threshold = Math.ceil(context.sampleRate * durationMs / 1000);
    if (!force && frameCount < threshold) return;
    const sampleCount = force ? frameCount : threshold;
    const samples = new Float32Array(sampleCount);
    let copied = 0;
    const remainder = [];
    let remainderCount = 0;
    for (const frame of frames) {
      const take = Math.min(frame.length, sampleCount - copied);
      if (take > 0) {
        samples.set(frame.subarray(0, take), copied);
        copied += take;
      }
      if (take < frame.length) {
        const tail = frame.subarray(take);
        remainder.push(tail);
        remainderCount += tail.length;
      }
    }
    frames = remainder;
    frameCount = remainderCount;
    const wasAudible = peakLevel >= 0.008;
    peakLevel = 0;
    if (wasAudible && copied >= context.sampleRate * 0.3) {
      try {
        Promise.resolve(onAudio(encodeWav(samples, context.sampleRate))).catch((error) => {
          console.error('음성 전송에 실패했습니다.', error);
        });
      } catch (error) {
        console.error('음성 전송에 실패했습니다.', error);
      }
    }
  }

  async function start(options = {}) {
    if (options.chunkMs) durationMs = Math.max(1000, Number(options.chunkMs) || durationMs);
    if (context && stream) return;
    if (starting) return starting;
    starting = (async () => {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      try {
        context = new AudioContext();
        source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          const frame = new Float32Array(input);
          let power = 0;
          for (const value of frame) power += value * value;
          peakLevel = Math.max(peakLevel, Math.sqrt(power / frame.length));
          frames.push(frame);
          frameCount += frame.length;
          emitFrames();
          event.outputBuffer.getChannelData(0).fill(0);
        };
        source.connect(processor);
        processor.connect(context.destination);
        await context.resume();
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        if (context) await context.close();
        context = null;
        throw error;
      }
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  async function stop() {
    if (starting) await starting;
    if (!context) return;
    const activeContext = context;
    if (processor) processor.disconnect();
    if (source) source.disconnect();
    emitFrames(true);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    source = null;
    processor = null;
    context = null;
    frames = [];
    frameCount = 0;
    peakLevel = 0;
    await activeContext.close();
  }

  return {
    start,
    stop,
    setChunkMs(value) {
      const nextDuration = Math.max(1000, Number(value) || durationMs);
      if (nextDuration !== durationMs) {
        durationMs = nextDuration;
        frames = [];
        frameCount = 0;
        peakLevel = 0;
      }
    },
  };
}
