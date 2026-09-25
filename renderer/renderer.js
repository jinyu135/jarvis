const api = window.jarvis;

const el = Object.fromEntries([
  'activityToggle', 'agentStatus', 'approvalCount', 'approvalList', 'authButton', 'authDot',
  'authLabel', 'cancelSettings', 'closeActivity', 'closeSettings', 'composerForm', 'emptyState',
  'hotkeyInput', 'messageInput', 'messageList', 'messageScroller', 'micButton', 'notice',
  'questionCount', 'questionList',
  'saveSettings', 'sendButton', 'settingsButton', 'settingsDialog', 'settingsForm', 'settingsNotice',
  'sidePanel', 'taskCount', 'taskList', 'voiceBanner', 'voiceBannerText', 'voiceStatusDetail',
  'voiceStatusLabel', 'wakeWordEnabled', 'wakeWordInput',
].map((id) => [id, document.getElementById(id)]));

const state = {
  messages: [],
  tasks: [],
  approvals: [],
  userInputs: [],
  auth: { status: 'signed_out' },
  settings: { hotkey: 'Ctrl+Alt+J', wakeWordEnabled: false, wakeWord: '자비스' },
  status: 'ready',
  voiceStatus: 'idle',
};

const messageNodes = new Map();
let activeStreamId = null;
let sending = false;
let capture = null;
let captureStarting = null;
let capturing = false;
let voiceCommandActive = false;
let micPending = false;
let noticeTimer = null;
let speechGeneration = 0;
let lastApprovalCount = 0;
let lastQuestionSignature = null;
let previousQuestionIds = new Set();

function showNotice(message) {
  if (!message) return;
  el.notice.textContent = String(message);
  el.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.notice.hidden = true; }, 7500);
}

function showSettingsNotice(message) {
  el.settingsNotice.textContent = String(message);
  el.settingsNotice.hidden = false;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function nearBottom() {
  return el.messageScroller.scrollHeight - el.messageScroller.scrollTop - el.messageScroller.clientHeight < 95;
}

function scrollToBottom() {
  el.messageScroller.scrollTop = el.messageScroller.scrollHeight;
}

function normalizeMessage(message, fallbackId) {
  const role = message.role === 'user' || message.role === 'system' ? message.role : 'assistant';
  return {
    id: String(message.id ?? message.messageId ?? fallbackId),
    role,
    content: String(message.content ?? message.text ?? ''),
    createdAt: message.createdAt ?? message.time ?? message.timestamp ?? null,
    streaming: Boolean(message.streaming),
  };
}

function createMessageNode(message) {
  const item = document.createElement('article');
  item.className = `message is-${message.role}`;
  item.dataset.messageId = message.id;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = message.role === 'user' ? '나' : message.role === 'system' ? '!' : '✦';

  const content = document.createElement('div');
  content.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const name = document.createElement('strong');
  name.textContent = message.role === 'user' ? '나' : message.role === 'system' ? '알림' : 'Jarvis';
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime(message.createdAt);
  meta.append(name, time);
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = message.content;
  content.append(meta, body);
  item.append(avatar, content);
  return item;
}

function upsertMessage(raw, options = {}) {
  const shouldScroll = nearBottom();
  const message = normalizeMessage(raw, `local-${Date.now()}`);
  const index = state.messages.findIndex((entry) => entry.id === message.id);
  if (index === -1) state.messages.push(message);
  else state.messages[index] = { ...state.messages[index], ...message };

  let node = messageNodes.get(message.id);
  if (!node) {
    node = createMessageNode(message);
    el.messageList.append(node);
    messageNodes.set(message.id, node);
  } else {
    node.querySelector('.message-body').textContent = message.content;
    node.querySelector('.message-time').textContent = formatTime(message.createdAt);
  }
  node.classList.toggle('is-streaming', message.streaming);
  el.emptyState.hidden = true;
  if (shouldScroll || options.forceScroll) scrollToBottom();
}

function renderMessages() {
  messageNodes.clear();
  el.messageList.replaceChildren();
  const messages = state.messages.map((message, index) => normalizeMessage(message, `snapshot-${index}`));
  state.messages = [];
  for (const message of messages) upsertMessage(message);
  el.emptyState.hidden = messages.length > 0;
  scrollToBottom();
}

function renderStatus() {
  const raw = typeof state.status === 'object' ? (state.status?.state ?? state.status?.status) : state.status;
  const status = String(raw ?? 'ready').toLowerCase();
  const busy = ['working', 'running', 'busy', 'thinking', 'streaming'].includes(status);
  const error = ['error', 'failed'].includes(status);
  el.agentStatus.classList.toggle('is-busy', busy);
  el.agentStatus.classList.toggle('is-ready', !busy && !error);
  el.agentStatus.lastChild.textContent = busy ? '작업 중' : error ? '확인 필요' : '준비됨';
}

function isSignedIn() {
  const auth = state.auth;
  if (typeof auth === 'boolean') return auth;
  if (typeof auth === 'string') return ['signed_in', 'authenticated', 'connected'].includes(auth);
  return Boolean(auth?.authenticated || auth?.signedIn || auth?.connected || ['signed_in', 'authenticated', 'connected'].includes(auth?.status));
}

function renderAuth() {
  const signedIn = isSignedIn();
  const name = typeof state.auth === 'object' ? (state.auth?.accountName ?? state.auth?.email) : null;
  el.authDot.classList.toggle('is-connected', signedIn);
  el.authLabel.textContent = signedIn ? (name || 'ChatGPT 연결됨') : 'ChatGPT 로그인';
  el.authButton.title = signedIn ? 'ChatGPT 로그아웃' : 'ChatGPT 로그인';
  el.authButton.setAttribute('aria-label', el.authButton.title);
}

function statusLabel(status) {
  switch (String(status ?? '').toLowerCase()) {
    case 'complete':
    case 'completed':
    case 'done': return '완료';
    case 'failed':
    case 'error': return '실패';
    case 'waiting':
    case 'awaiting_approval': return '대기';
    default: return '진행 중';
  }
}

function renderTasks() {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  el.taskCount.textContent = String(tasks.filter((task) => !['completed', 'complete', 'done', 'failed', 'error'].includes(String(task.status).toLowerCase())).length);
  el.taskList.replaceChildren();
  if (tasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-empty';
    empty.textContent = '진행 중인 작업이 없습니다.';
    el.taskList.append(empty);
    return;
  }
  for (const task of tasks.slice(-8).reverse()) {
    const card = document.createElement('div');
    card.className = 'task-card';
    const top = document.createElement('div');
    top.className = 'task-card-top';
    const title = document.createElement('strong');
    title.textContent = String(task.title ?? task.name ?? '작업 진행 중');
    const tag = document.createElement('span');
    tag.className = 'task-status';
    const label = statusLabel(task.status);
    tag.textContent = label;
    tag.classList.toggle('is-complete', label === '완료');
    tag.classList.toggle('is-failed', label === '실패');
    top.append(title, tag);
    card.append(top);
    if (task.detail || task.message) {
      const detail = document.createElement('p');
      detail.textContent = String(task.detail ?? task.message);
      card.append(detail);
    }
    const progressValue = Number(task.progress);
    if (Number.isFinite(progressValue)) {
      const progress = document.createElement('div');
      progress.className = 'task-progress';
      progress.setAttribute('role', 'progressbar');
      const value = Math.max(0, Math.min(100, progressValue));
      progress.setAttribute('aria-valuenow', String(value));
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      const fill = document.createElement('span');
      fill.style.width = `${value}%`;
      progress.append(fill);
      card.append(progress);
    }
    el.taskList.append(card);
  }
}

function renderApprovals() {
  const approvals = Array.isArray(state.approvals) ? state.approvals.filter((item) => !item.resolved && !item.decision) : [];
  const newlyPending = approvals.length > lastApprovalCount;
  lastApprovalCount = approvals.length;
  el.approvalCount.textContent = String(approvals.length);
  el.approvalList.replaceChildren();
  if (approvals.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-empty';
    empty.textContent = '확인을 기다리는 작업이 없습니다.';
    el.approvalList.append(empty);
    return;
  }
  for (const approval of approvals) {
    const card = document.createElement('div');
    card.className = 'approval-card';
    const tag = document.createElement('span');
    tag.className = 'approval-tag';
    tag.textContent = '실행 전 확인';
    const title = document.createElement('strong');
    title.textContent = String(approval.title ?? approval.action ?? '작업을 실행할까요?');
    card.append(tag, title);
    if (approval.description || approval.detail) {
      const detail = document.createElement('p');
      detail.textContent = String(approval.description ?? approval.detail);
      card.append(detail);
    }
    if (approval.target) {
      const target = document.createElement('p');
      target.className = 'approval-target';
      target.textContent = String(approval.target);
      card.append(target);
    }
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.textContent = '취소';
    reject.addEventListener('click', () => respondToApproval(approval.id, false, card));
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = '허용';
    approve.addEventListener('click', () => respondToApproval(approval.id, true, card));
    actions.append(reject, approve);
    card.append(actions);
    el.approvalList.append(card);
  }
  if (window.innerWidth <= 900 && newlyPending) {
    el.sidePanel.classList.add('is-open');
    el.activityToggle.setAttribute('aria-expanded', 'true');
  }
}

function renderUserInputs() {
  const requests = Array.isArray(state.userInputs) ? state.userInputs.filter((request) => !request.resolved) : [];
  const signature = requests.map((request) => String(request.id)).join('\u0000');
  if (signature === lastQuestionSignature) return;
  const newlyPending = requests.some((request) => !previousQuestionIds.has(String(request.id)));
  previousQuestionIds = new Set(requests.map((request) => String(request.id)));
  lastQuestionSignature = signature;
  el.questionCount.textContent = String(requests.length);
  el.questionList.replaceChildren();
  if (requests.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-empty';
    empty.textContent = '답변을 기다리는 질문이 없습니다.';
    el.questionList.append(empty);
    return;
  }
  for (const request of requests) {
    const form = document.createElement('form');
    form.className = 'question-card';
    const title = document.createElement('strong');
    title.textContent = request.title ?? 'Jarvis의 질문';
    form.append(title);
    const questions = Array.isArray(request.questions) ? request.questions : [];
    questions.forEach((question, index) => {
      const field = document.createElement('fieldset');
      field.className = 'question-field';
      field.dataset.questionId = String(question.id ?? question.questionId ?? index);
      const legend = document.createElement('legend');
      legend.textContent = question.question ?? question.title ?? question.header ?? `질문 ${index + 1}`;
      field.append(legend);
      const options = Array.isArray(question.options) ? question.options : [];
      if (options.length) {
        const groupName = `question-${request.id}-${index}`;
        options.forEach((option) => {
          const value = typeof option === 'string' ? option : String(option.label ?? option.value ?? '');
          const label = document.createElement('label');
          label.className = 'question-option';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = groupName;
          const isOtherOption = Boolean(question.isOther && /^(other|기타)$/i.test(value));
          input.value = isOtherOption ? '__free_text__' : value;
          const copy = document.createElement('span');
          copy.textContent = isOtherOption ? '직접 입력' : value;
          if (typeof option === 'object' && option?.description) {
            const detail = document.createElement('small');
            detail.textContent = String(option.description);
            copy.append(detail);
          }
          label.append(input, copy);
          field.append(label);
        });
        if (question.isOther) {
          if (!field.querySelector('input[value="__free_text__"]')) {
            const label = document.createElement('label');
            label.className = 'question-option';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = groupName;
            input.value = '__free_text__';
            const copy = document.createElement('span');
            copy.textContent = '직접 입력';
            label.append(input, copy);
            field.append(label);
          }
          const freeText = document.createElement('textarea');
          freeText.className = 'question-answer';
          freeText.dataset.freeText = 'true';
          freeText.placeholder = '답변을 입력해 주세요';
          freeText.disabled = true;
          field.addEventListener('change', () => {
            const selected = field.querySelector('input[type=radio]:checked');
            freeText.disabled = selected?.value !== '__free_text__';
            if (!freeText.disabled) freeText.focus();
          });
          field.append(freeText);
        }
      } else {
        const answer = document.createElement('textarea');
        answer.className = 'question-answer';
        answer.placeholder = '답변을 입력해 주세요';
        answer.setAttribute('aria-label', legend.textContent);
        field.append(answer);
      }
      form.append(field);
    });
    const error = document.createElement('p');
    error.className = 'question-error';
    error.hidden = true;
    form.append(error);
    const actions = document.createElement('div');
    actions.className = 'question-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.textContent = '건너뛰기';
    skip.addEventListener('click', () => { void respondToUserInput(request, form, true); });
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = '답변 보내기';
    actions.append(skip, submit);
    form.append(actions);
    form.addEventListener('submit', (event) => { event.preventDefault(); void respondToUserInput(request, form, false); });
    el.questionList.append(form);
  }
  if (window.innerWidth <= 900 && newlyPending) {
    el.sidePanel.classList.add('is-open');
    el.activityToggle.setAttribute('aria-expanded', 'true');
  }
}

async function respondToUserInput(request, form, cancelled) {
  if (!api?.respondToUserInput) return showNotice('답변 기능에 연결할 수 없습니다.');
  const answers = {};
  const error = form.querySelector('.question-error');
  error.hidden = true;
  if (!cancelled) {
    for (const field of form.querySelectorAll('.question-field')) {
      const selected = field.querySelector('input[type=radio]:checked');
      let answer = selected?.value;
      if (answer === '__free_text__' || !field.querySelector('input[type=radio]')) {
        answer = field.querySelector('.question-answer')?.value.trim();
      }
      if (!answer) {
        error.textContent = '각 질문에 답변을 입력하거나 선택해 주세요.';
        error.hidden = false;
        return;
      }
      answers[field.dataset.questionId] = { answers: [answer] };
    }
  }
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api.respondToUserInput({ id: request.id, answers, cancelled });
    if (result === false) throw new Error('이미 처리된 질문입니다. 상태를 새로 확인해 주세요.');
    state.userInputs = state.userInputs.filter((item) => String(item.id) !== String(request.id));
    renderUserInputs();
  } catch (failure) {
    buttons.forEach((button) => { button.disabled = false; });
    error.textContent = failure?.message || '답변을 보내지 못했습니다.';
    error.hidden = false;
  }
}

async function respondToApproval(id, approved, card) {
  if (!api?.respondToApproval) return showNotice('승인 기능에 연결할 수 없습니다.');
  const buttons = [...card.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api.respondToApproval({ id, approved });
    if (result === false) throw new Error('이미 처리된 요청입니다. 상태를 새로 확인해 주세요.');
    state.approvals = state.approvals.filter((item) => String(item.id) !== String(id));
    renderApprovals();
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    showNotice(error?.message || '선택을 처리하지 못했습니다.');
  }
}

function voiceMode(value) {
  if (typeof value === 'object' && value) return String(value.phase ?? value.status ?? value.state ?? value.mode ?? 'idle');
  return String(value ?? 'idle');
}

function renderVoice() {
  const phase = voiceMode(state.voiceStatus).toLowerCase();
  const commandListening = ['listening', 'recording', 'command', 'capturing', 'listening-command'].includes(phase);
  voiceCommandActive = commandListening;
  el.micButton.classList.toggle('is-active', commandListening);
  el.micButton.setAttribute('aria-label', commandListening ? '음성 입력 중지' : '음성 입력 시작');
  el.micButton.title = commandListening ? '음성 입력 중지' : '음성 입력';
  el.voiceBanner.hidden = !commandListening;
  el.voiceBannerText.textContent = phase === 'transcribing' ? '음성을 처리하고 있어요…' : '듣고 있어요…';
  const labels = {
    idle: ['대기 중', '마이크 버튼으로 음성 입력을 시작할 수 있습니다.'],
    ready: ['준비됨', '마이크 버튼이나 단축키로 음성 입력을 시작할 수 있습니다.'],
    listening: ['듣는 중', '말씀해 주세요.'],
    recording: ['듣는 중', '말씀해 주세요.'],
    command: ['듣는 중', '말씀해 주세요.'],
    capturing: ['듣는 중', '말씀해 주세요.'],
    'listening-command': ['듣는 중', '말씀해 주세요.'],
    'listening-wake': ['호출어 대기 중', '호출어를 들으면 음성 입력을 시작합니다.'],
    transcribing: ['처리 중', '음성을 텍스트로 바꾸고 있습니다.'],
    processing: ['처리 중', '음성을 텍스트로 바꾸고 있습니다.'],
    speaking: ['말하는 중', 'Jarvis가 응답하고 있습니다.'],
    wake: ['호출어 대기 중', '호출어를 들으면 음성 입력을 시작합니다.'],
    wake_word: ['호출어 대기 중', '호출어를 들으면 음성 입력을 시작합니다.'],
    installing: ['음성 기능 준비 중', '음성 인식 엔진을 준비하고 있습니다.'],
    'setup-required': ['설정 필요', '음성 인식 엔진 설치 상태를 확인해 주세요.'],
    disabled: ['음성 꺼짐', '설정에서 음성 기능을 켤 수 있습니다.'],
  };
  const [label, defaultDetail] = labels[phase] ?? labels.idle;
  el.voiceStatusLabel.textContent = label;
  el.voiceStatusDetail.textContent = state.voiceStatus?.message ?? defaultDetail;
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (Array.isArray(snapshot.messages)) {
    state.messages = snapshot.messages;
    renderMessages();
  }
  if (Array.isArray(snapshot.tasks)) state.tasks = snapshot.tasks;
  if (Array.isArray(snapshot.approvals)) state.approvals = snapshot.approvals;
  if (Array.isArray(snapshot.userInputs)) state.userInputs = snapshot.userInputs;
  if (snapshot.auth !== undefined) state.auth = snapshot.auth;
  if (snapshot.settings && typeof snapshot.settings === 'object') state.settings = { ...state.settings, ...snapshot.settings };
  if (snapshot.status !== undefined) state.status = snapshot.status;
  if (snapshot.voiceStatus !== undefined) state.voiceStatus = snapshot.voiceStatus;
  renderStatus();
  renderAuth();
  renderTasks();
  renderApprovals();
  renderUserInputs();
  renderVoice();
}

function upsertTask(task) {
  if (!task || typeof task !== 'object') return;
  const id = String(task.id ?? task.taskId ?? 'current');
  const index = state.tasks.findIndex((entry) => String(entry.id ?? entry.taskId ?? 'current') === id);
  if (index === -1) state.tasks.push({ ...task, id });
  else state.tasks[index] = { ...state.tasks[index], ...task, id };
  renderTasks();
}

function streamDelta(event) {
  const id = String(event.messageId ?? event.id ?? activeStreamId ?? `stream-${Date.now()}`);
  activeStreamId = id;
  const previous = state.messages.find((message) => message.id === id);
  const content = event.content !== undefined ? String(event.content) : `${previous?.content ?? ''}${String(event.delta ?? event.text ?? '')}`;
  upsertMessage({ id, role: 'assistant', content, createdAt: previous?.createdAt ?? Date.now(), streaming: true });
  state.status = 'streaming';
  renderStatus();
}

function streamDone(event) {
  const lastAssistant = [...state.messages].reverse().find((message) => message.role === 'assistant');
  const id = String(event.messageId ?? event.id ?? activeStreamId ?? lastAssistant?.id ?? `stream-${Date.now()}`);
  const previous = state.messages.find((message) => message.id === id);
  const content = event.content ?? event.text ?? previous?.content ?? '';
  upsertMessage({ id, role: 'assistant', content, createdAt: previous?.createdAt ?? Date.now(), streaming: false });
  activeStreamId = null;
  state.status = 'ready';
  renderStatus();
}

async function ensureCapture() {
  if (capture) return capture;
  const { createVoiceCapture } = await import('../voice/renderer.js');
  capture = createVoiceCapture({
    onAudio(payload) {
      if (!api?.sendVoiceAudio) return;
      Promise.resolve(api.sendVoiceAudio(payload)).catch((error) => showNotice(error?.message || '음성 전송에 실패했습니다.'));
    },
  });
  return capture;
}

async function startCapture(options = {}) {
  if (capturing) {
    if (options.chunkMs) capture?.setChunkMs?.(options.chunkMs);
    return;
  }
  if (captureStarting) return captureStarting;
  captureStarting = (async () => {
    try {
      const device = await ensureCapture();
      await device.start({ chunkMs: options.chunkMs });
      capturing = true;
      renderVoice();
    } catch (error) {
      showNotice(error?.message || '마이크를 사용할 수 없습니다.');
      try { await api?.stopVoiceInput?.(); } catch { /* The notice above is actionable. */ }
    } finally {
      captureStarting = null;
    }
  })();
  return captureStarting;
}

async function stopCapture() {
  if (captureStarting) await captureStarting;
  if (!capture || !capturing) return;
  try { await capture.stop(); }
  catch (error) { showNotice(error?.message || '마이크를 중지하지 못했습니다.'); }
  finally { capturing = false; renderVoice(); }
}

async function speak(text) {
  if (!text || !window.speechSynthesis) return;
  const generation = ++speechGeneration;
  const resumeCapture = capturing;
  if (resumeCapture) await stopCapture();
  if (generation !== speechGeneration) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text));
  utterance.lang = 'ko-KR';
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith('ko')) ?? null;
  utterance.rate = 1;
  const resume = () => {
    if (generation !== speechGeneration || !resumeCapture) return;
    const mode = voiceMode(state.voiceStatus).toLowerCase();
    if (mode !== 'idle' && mode !== 'off') void startCapture();
  };
  utterance.onend = resume;
  utterance.onerror = resume;
  window.speechSynthesis.speak(utterance);
}

function handleEvent(event) {
  if (!event || typeof event !== 'object') return;
  switch (event.type) {
    case 'state':
      applySnapshot(event.state ?? event.snapshot ?? event.data ?? event);
      break;
    case 'message':
      upsertMessage(event.message ?? event.data ?? event);
      break;
    case 'assistant_delta':
      streamDelta(event);
      break;
    case 'assistant_done':
      streamDone(event);
      break;
    case 'task_progress':
      if (event.task) upsertTask(event.task);
      else {
        const item = event.item ?? {};
        const kind = event.itemType ?? item.type ?? '작업';
        const titles = {
          commandExecution: '명령 실행',
          fileChange: '파일 변경',
          mcpToolCall: '도구 사용',
          webSearch: '웹 검색',
        };
        upsertTask({
          id: item.id ?? item.itemId ?? kind,
          title: titles[kind] ?? String(kind),
          detail: item.command ?? item.title ?? item.name ?? item.description ?? item.summary,
          status: event.phase === 'completed' ? 'completed' : 'running',
        });
      }
      break;
    case 'approval_requested':
      state.approvals.push(event.approval ?? event);
      renderApprovals();
      break;
    case 'approval_resolved':
      state.approvals = state.approvals.filter((approval) => String(approval.id) !== String(event.id ?? event.approvalId));
      renderApprovals();
      break;
    case 'user_input_requested':
      state.userInputs.push(event.request ?? event.userInput ?? event);
      renderUserInputs();
      break;
    case 'user_input_resolved':
      state.userInputs = state.userInputs.filter((request) => String(request.id) !== String(event.id ?? event.requestId));
      renderUserInputs();
      break;
    case 'auth_state':
      state.auth = event.auth ?? event.state ?? event;
      renderAuth();
      break;
    case 'voice_status':
    case 'voice-status':
      state.voiceStatus = event.voiceStatus ?? event.status ?? event.mode ?? event;
      renderVoice();
      break;
    case 'voice-capture-start':
      void startCapture(event);
      break;
    case 'voice-capture-stop':
      void stopCapture();
      break;
    case 'voice-speak':
      void speak(event.text ?? event.content);
      break;
    case 'voice-transcript':
      if (event.text) {
        el.voiceBannerText.textContent = `들었어요: ${event.text}`;
      }
      break;
    case 'error':
      showNotice(event.message ?? event.error ?? '작업 중 오류가 발생했습니다.');
      state.status = 'error';
      renderStatus();
      break;
    default:
      break;
  }
}

function resizeInput() {
  el.messageInput.style.height = 'auto';
  el.messageInput.style.height = `${Math.min(el.messageInput.scrollHeight, 170)}px`;
}

async function sendMessage() {
  const text = el.messageInput.value.trim();
  if (!text || sending) return;
  if (!api?.sendMessage) return showNotice('Jarvis에 연결할 수 없습니다.');
  if (!isSignedIn()) return showNotice('먼저 ChatGPT 계정으로 로그인해 주세요.');
  if (['working', 'running', 'busy', 'thinking', 'streaming'].includes(String(state.status).toLowerCase())) {
    return showNotice('현재 작업이 끝나면 다음 요청을 보내 주세요.');
  }
  sending = true;
  el.sendButton.disabled = true;
  el.messageInput.value = '';
  resizeInput();
  upsertMessage({ id: `local-${Date.now()}`, role: 'user', content: text, createdAt: Date.now() }, { forceScroll: true });
  state.status = 'working';
  renderStatus();
  try {
    await api.sendMessage(text);
  } catch (error) {
    showNotice(error?.message || '메시지를 보내지 못했습니다.');
    state.status = 'error';
    renderStatus();
  } finally {
    sending = false;
    el.sendButton.disabled = false;
    el.messageInput.focus();
  }
}

async function toggleVoice() {
  if (micPending) return;
  micPending = true;
  el.micButton.disabled = true;
  try {
    if (voiceCommandActive) {
      await stopCapture();
      await api?.stopVoiceInput?.();
      state.voiceStatus = 'idle';
    } else {
      if (!api?.startVoiceInput) throw new Error('음성 기능에 연결할 수 없습니다.');
      await api.startVoiceInput();
      state.voiceStatus = { phase: 'listening-command', mode: 'command' };
    }
    renderVoice();
  } catch (error) {
    showNotice(error?.message || '음성 입력을 시작하지 못했습니다.');
  } finally {
    micPending = false;
    el.micButton.disabled = false;
  }
}

function openSettings() {
  el.settingsNotice.hidden = true;
  el.hotkeyInput.value = state.settings.hotkey ?? 'Ctrl+Alt+J';
  el.wakeWordEnabled.checked = Boolean(state.settings.wakeWordEnabled);
  el.wakeWordInput.value = state.settings.wakeWord ?? '자비스';
  el.wakeWordInput.disabled = !el.wakeWordEnabled.checked;
  el.settingsDialog.showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  if (!api?.updateSettings) return showSettingsNotice('설정 기능에 연결할 수 없습니다.');
  const settings = {
    hotkey: el.hotkeyInput.value.trim(),
    wakeWordEnabled: el.wakeWordEnabled.checked,
    wakeWord: el.wakeWordInput.value.trim(),
  };
  if (!settings.hotkey) return showSettingsNotice('음성 단축키를 입력해 주세요.');
  if (settings.wakeWordEnabled && !settings.wakeWord) return showSettingsNotice('호출어를 입력해 주세요.');
  el.settingsNotice.hidden = true;
  el.saveSettings.disabled = true;
  try {
    const result = await api.updateSettings(settings);
    state.settings = { ...state.settings, ...settings, ...(result?.settings ?? {}) };
    el.settingsDialog.close();
  } catch (error) {
    showSettingsNotice(error?.message || '설정을 저장하지 못했습니다.');
  } finally {
    el.saveSettings.disabled = false;
  }
}

async function toggleAuth() {
  el.authButton.disabled = true;
  try {
    if (isSignedIn()) {
      if (!api?.signOut) throw new Error('로그아웃 기능에 연결할 수 없습니다.');
      await api.signOut();
      state.auth = { status: 'signed_out' };
    } else {
      if (!api?.signIn) throw new Error('로그인 기능에 연결할 수 없습니다.');
      await api.signIn();
    }
    renderAuth();
  } catch (error) {
    showNotice(error?.message || 'ChatGPT 계정을 연결하지 못했습니다.');
  } finally {
    el.authButton.disabled = false;
  }
}

el.composerForm.addEventListener('submit', (event) => { event.preventDefault(); void sendMessage(); });
el.messageInput.addEventListener('input', resizeInput);
el.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendMessage();
  }
});
el.micButton.addEventListener('click', () => { void toggleVoice(); });
el.authButton.addEventListener('click', () => { void toggleAuth(); });
el.settingsButton.addEventListener('click', openSettings);
el.closeSettings.addEventListener('click', () => el.settingsDialog.close());
el.cancelSettings.addEventListener('click', () => el.settingsDialog.close());
el.settingsForm.addEventListener('submit', (event) => { void saveSettings(event); });
el.wakeWordEnabled.addEventListener('change', () => { el.wakeWordInput.disabled = !el.wakeWordEnabled.checked; });
el.activityToggle.addEventListener('click', () => {
  const open = !el.sidePanel.classList.contains('is-open');
  el.sidePanel.classList.toggle('is-open', open);
  el.activityToggle.setAttribute('aria-expanded', String(open));
});
el.closeActivity.addEventListener('click', () => {
  el.sidePanel.classList.remove('is-open');
  el.activityToggle.setAttribute('aria-expanded', 'false');
});

renderStatus();
renderAuth();
renderVoice();

if (!api) {
  showNotice('Jarvis 데스크톱 연결을 찾을 수 없습니다.');
} else {
  api.onEvent?.(handleEvent);
  api.voiceRendererReady?.();
  Promise.resolve(api.getState?.()).then(applySnapshot).catch((error) => showNotice(error?.message || 'Jarvis 상태를 불러오지 못했습니다.'));
}
