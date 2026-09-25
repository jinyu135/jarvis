'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+J';
const MAX_WAV_BYTES = 16 * 1024 * 1024;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 18_000;

function defaultVoiceDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Jarvis', 'voice');
}

function resolveAsset(configured, fileName) {
  const candidates = [
    configured,
    path.join(defaultVoiceDir(), fileName),
    process.resourcesPath && path.join(process.resourcesPath, 'voice', fileName),
    path.join(__dirname, 'bin', fileName),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function normaliseSpeech(text) {
  return String(text || '').replace(/[\[\]().,!?。！？，:;"'‘’“”]/g, ' ').replace(/\s+/g, ' ').trim();
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new TypeError('음성 데이터 형식이 올바르지 않습니다.');
}

class VoiceService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.globalShortcut = options.globalShortcut || null;
    this.autoInstall = options.autoInstall !== false;
    this.settings = {
      hotkey: options.hotkey || DEFAULT_HOTKEY,
      wakeWord: options.wakeWord || '자비스',
      wakeEnabled: options.wakeEnabled !== false,
      enabled: options.enabled !== false,
      whisperExecutable: options.whisperExecutable || process.env.JARVIS_WHISPER_CLI || null,
      modelPath: options.modelPath || process.env.JARVIS_WHISPER_MODEL || null,
    };
    this.started = false;
    this.mode = null;
    this.desiredMode = null;
    this.generation = 0;
    this.pendingAudio = null;
    this.processing = false;
    this.commandTimer = null;
    this.installPromise = null;
    this.status = { phase: 'idle', mode: null };
  }

  getStatus() {
    return { ...this.status };
  }

  rendererReady() {
    this.emit('status', this.getStatus());
    if (this.mode) {
      this.emit('capture-start', { mode: this.mode, chunkMs: this.mode === 'wake' ? 4500 : 6500 });
    }
  }

  getAssetPaths() {
    return {
      whisperExecutable: resolveAsset(this.settings.whisperExecutable, 'whisper-cli.exe'),
      modelPath: resolveAsset(this.settings.modelPath, 'ggml-base.bin'),
    };
  }

  _assetsReady() {
    const { whisperExecutable, modelPath } = this.getAssetPaths();
    if (!whisperExecutable || !fs.existsSync(whisperExecutable)) {
      this._setStatus('setup-required', null, 'whisper-cli.exe가 필요합니다. 음성 엔진 설치를 완료해 주세요.');
      return false;
    }
    if (!modelPath || !fs.existsSync(modelPath)) {
      this._setStatus('setup-required', null, '한국어 음성 인식 모델 ggml-base.bin이 필요합니다.');
      return false;
    }
    return true;
  }

  _setStatus(phase, mode = this.mode, message = null) {
    this.status = { phase, mode, ...(message ? { message } : {}) };
    this.emit('status', this.getStatus());
  }

  start() {
    if (this.started) return this.getStatus();
    this.started = true;
    if (this.globalShortcut) {
      const registered = this.globalShortcut.register(this.settings.hotkey, () => this.startCapture('command'));
      if (!registered) {
        this.emit('shortcut-error', new Error(`전역 단축키 ${this.settings.hotkey}를 등록할 수 없습니다.`));
      }
    }
    if (this.settings.enabled && this.settings.wakeEnabled) this.startCapture('wake');
    else this._setStatus('ready', null);
    return this.getStatus();
  }

  stop() {
    if (!this.started) return;
    this.stopCapture();
    if (this.globalShortcut) this.globalShortcut.unregister(this.settings.hotkey);
    this.started = false;
    this._setStatus('idle', null);
  }

  startCapture(mode = 'command') {
    if (!this.settings.enabled) {
      this._setStatus('disabled', null);
      return false;
    }
    if (!['wake', 'command'].includes(mode)) throw new TypeError('음성 입력 모드가 올바르지 않습니다.');
    this.desiredMode = mode;
    if (!this._assetsReady()) {
      if (this.autoInstall && !this.installPromise) {
        void this.installAssets().then(() => {
          if (this.started && this.settings.enabled && this.desiredMode) this.startCapture(this.desiredMode);
        }).catch((error) => {
          this._setStatus('setup-required', null, error.message);
        });
      }
      return false;
    }
    if (this.commandTimer) clearTimeout(this.commandTimer);
    this.commandTimer = null;
    this.mode = mode;
    this.generation += 1;
    this.pendingAudio = null;
    this.desiredMode = null;
    this.emit('capture-start', { mode, chunkMs: mode === 'wake' ? 4500 : 6500 });
    this._setStatus(mode === 'wake' ? 'listening-wake' : 'listening-command', mode);
    if (mode === 'command') this._armCommandTimeout(this.generation);
    return true;
  }

  stopCapture() {
    if (this.commandTimer) clearTimeout(this.commandTimer);
    this.commandTimer = null;
    this.generation += 1;
    this.pendingAudio = null;
    if (this.mode) this.emit('capture-stop');
    this.mode = null;
    if (this.started) this._setStatus('ready', null);
  }

  _armCommandTimeout(generation) {
    if (this.commandTimer) clearTimeout(this.commandTimer);
    this.commandTimer = setTimeout(() => {
      if (generation !== this.generation || this.mode !== 'command') return;
      this.emit('timeout');
      if (this.settings.wakeEnabled) this.startCapture('wake');
      else this.stopCapture();
    }, COMMAND_TIMEOUT_MS);
  }

  updateSettings(changes = {}) {
    const next = { ...this.settings };
    for (const key of ['hotkey', 'wakeWord', 'wakeEnabled', 'enabled', 'whisperExecutable', 'modelPath']) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) next[key] = changes[key];
    }
    if (typeof next.hotkey !== 'string' || !next.hotkey.trim()) throw new TypeError('단축키가 올바르지 않습니다.');
    if (typeof next.wakeWord !== 'string' || !next.wakeWord.trim()) throw new TypeError('호출어가 올바르지 않습니다.');
    if (this.started && this.globalShortcut && next.hotkey !== this.settings.hotkey) {
      if (!this.globalShortcut.register(next.hotkey, () => this.startCapture('command'))) {
        throw new Error(`전역 단축키 ${next.hotkey}를 등록할 수 없습니다.`);
      }
      this.globalShortcut.unregister(this.settings.hotkey);
    }
    this.settings = next;
    if (!next.enabled) this.stopCapture();
    else if (this.started && next.wakeEnabled && !this.mode) this.startCapture('wake');
    else if (this.started && !next.wakeEnabled && this.mode === 'wake') this.stopCapture();
    return { ...this.settings };
  }

  speak(text) {
    const utterance = String(text || '').trim();
    if (!utterance) return;
    this.emit('speak', utterance);
  }

  installAssets() {
    if (this.installPromise) return this.installPromise;
    if (process.platform !== 'win32') return Promise.reject(new Error('음성 엔진 자동 설치는 Windows에서 지원됩니다.'));
    this._setStatus('installing', null, '한국어 음성 인식 엔진을 설치하는 중입니다.');
    this.installPromise = (async () => {
      const script = await fsp.readFile(path.join(__dirname, 'setup.ps1'), 'utf8');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
          windowsHide: true,
          shell: false,
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-3000); });
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`음성 엔진 설치에 실패했습니다 (${code}). ${stderr.trim()}`));
        });
      });
      if (!this._assetsReady()) throw new Error('설치 후에도 음성 엔진 파일을 찾을 수 없습니다.');
      this._setStatus('ready', null);
      return this.getAssetPaths();
    })().finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  acceptAudio(payload) {
    if (!this.started || !this.mode) return false;
    const audio = toBuffer(payload);
    if (audio.length < 44 || audio.length > MAX_WAV_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
      throw new TypeError('유효한 WAV 음성 데이터가 아닙니다.');
    }
    if (this.mode === 'command' && this.commandTimer) {
      clearTimeout(this.commandTimer);
      this.commandTimer = null;
    }
    this.pendingAudio = { audio, generation: this.generation, mode: this.mode };
    if (!this.processing) void this._drainAudio();
    return true;
  }

  async _drainAudio() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pendingAudio) {
        const job = this.pendingAudio;
        this.pendingAudio = null;
        try {
          const text = normaliseSpeech(await this._transcribe(job.audio));
          if (job.generation === this.generation && job.mode === this.mode) {
            this._handleTranscript(text);
            if (!text && this.mode === 'command') this._armCommandTimeout(this.generation);
          }
        } catch (error) {
          if (job.generation === this.generation) {
            this._setStatus('error', this.mode, error.message);
            this.emit('recognition-error', error);
            if (this.mode === 'command') this._armCommandTimeout(this.generation);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  _handleTranscript(text) {
    if (!text) return;
    if (this.mode === 'wake') {
      const wakeWord = normaliseSpeech(this.settings.wakeWord);
      const compactText = text.replace(/\s/g, '').toLocaleLowerCase();
      const compactWake = wakeWord.replace(/\s/g, '').toLocaleLowerCase();
      const index = compactText.indexOf(compactWake);
      const englishIndex = compactText.indexOf('jarvis');
      if (index < 0 && englishIndex < 0) return;
      this.emit('wake', text);
      // A command spoken in the same segment is accepted immediately.
      const match = new RegExp(`${wakeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|jarvis`, 'iu');
      const command = normaliseSpeech(text.replace(match, ''));
      if (command) {
        this.emit('transcript', command);
      } else {
        this.startCapture('command');
      }
      return;
    }
    if (this.mode === 'command') {
      this.emit('transcript', text);
      if (this.settings.wakeEnabled) this.startCapture('wake');
      else this.stopCapture();
    }
  }

  async _transcribe(audio) {
    const { whisperExecutable, modelPath } = this.getAssetPaths();
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jarvis-voice-'));
    const audioPath = path.join(tempDir, 'speech.wav');
    const outputPath = path.join(tempDir, 'transcript');
    try {
      await fsp.writeFile(audioPath, audio);
      await new Promise((resolve, reject) => {
        const args = ['-m', modelPath, '-f', audioPath, '-l', 'ko', '-nt', '-np', '-otxt', '-of', outputPath];
        const child = spawn(whisperExecutable, args, { windowsHide: true, shell: false, cwd: path.dirname(whisperExecutable) });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('음성 인식 시간이 초과되었습니다.'));
        }, TRANSCRIPTION_TIMEOUT_MS);
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`음성 인식 엔진이 종료되었습니다 (${code}). ${stderr.trim()}`));
        });
      });
      const transcriptFile = `${outputPath}.txt`;
      return fs.existsSync(transcriptFile) ? await fsp.readFile(transcriptFile, 'utf8') : '';
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }
}

function createVoiceService(options) {
  return new VoiceService(options);
}

module.exports = { VoiceService, createVoiceService, DEFAULT_HOTKEY };
