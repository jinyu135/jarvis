# Javis 음성 모듈

Windows Electron 앱에서 한국어 음성 명령을 받습니다. 마이크 입력은 Electron renderer에서 16 kHz PCM WAV로 만들고, 메인 프로세스가 로컬 whisper.cpp CLI로 인식합니다. AI 응답 읽기는 renderer의 Windows `speechSynthesis` 음성을 사용합니다. OpenAI Audio API나 Python은 사용하지 않습니다.

## 메인 프로세스 연결

```js
const { createVoiceService } = require('./voice');
const voice = createVoiceService({ globalShortcut });
voice.on('capture-start', ({ mode, chunkMs }) => sendToRenderer('voice-capture-start', { mode, chunkMs }));
voice.on('capture-stop', () => sendToRenderer('voice-capture-stop'));
voice.on('status', (status) => sendToRenderer('voice-status', status));
voice.on('speak', (text) => sendToRenderer('voice-speak', text));
voice.on('transcript', (text) => handleUserCommand(text));
ipcMain.on('voice:audio', (_event, wav) => voice.acceptAudio(wav));
app.whenReady().then(() => voice.start());
app.on('will-quit', () => voice.stop());
```

Renderer에서 `createVoiceCapture({ onAudio })`를 `../voice/renderer.js`에서 import합니다. `onAudio`가 받은 `Uint8Array`는 IPC `voice:audio`로 전송합니다. `voice-capture-start` 이벤트에서 `capture.start({ chunkMs })`, `voice-capture-stop`에서 `capture.stop()`을 호출합니다. `voice-speak`는 `speechSynthesis`에서 `ko-KR` 음성을 선택해 읽습니다. 읽는 동안 마이크를 잠시 멈추면 Javis가 자기 음성을 다시 인식하는 것을 막을 수 있습니다.

서비스 API: `start()`, `stop()`, `rendererReady()`, `startCapture('command'|'wake')`, `stopCapture()`, `acceptAudio(wav)`, `speak(text)`, `updateSettings(changes)`, `getStatus()`, `installAssets()`. 기본 전역 단축키는 `Ctrl+Shift+J`, 호출어는 `자비스`입니다. `start()`는 호출어 대기를 시작하고, 단축키는 곧바로 명령 대기를 시작합니다. `startCapture('command')`를 마이크 버튼에 연결할 수 있습니다. Renderer가 준비된 후 `rendererReady()`를 호출하면 현재 음성 상태와 캡처 시작 이벤트가 다시 전달됩니다.

## 음성 엔진 설치

첫 실행에 필요한 파일이 없다면 `start()`가 `voice/setup.ps1`을 실행하여 `%LOCALAPPDATA%\Jarvis\voice`에 CPU용 whisper.cpp b5130과 다국어 `ggml-base.bin` 모델을 내려받습니다. b5130의 Windows x64 및 ARM64 압축 파일은 공식 릴리스의 SHA256 값으로, 모델은 공식 모델 목록의 SHA1 값으로 확인합니다. 모델은 약 142 MiB입니다. 자동 설치에 실패하면 `setup-required` 상태와 오류 메시지가 전달됩니다. 인터넷이 없는 배포 환경에서는 `whisper-cli.exe`, 같은 폴더의 DLL, `ggml-base.bin`을 설치 패키지의 `resources/voice/`에 넣거나 `JAVIS_WHISPER_CLI`와 `JAVIS_WHISPER_MODEL` 환경 변수를 지정할 수 있습니다. 패키징할 때 `voice/setup.ps1`과 `voice/renderer.js`도 포함해야 합니다.

출처: [whisper.cpp b5130 바이너리와 SHA256](https://github.com/ggml-org/whisper.cpp/releases/expanded_assets/b5130), [CLI 옵션](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/README.md), [모델 목록과 SHA1](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md).
