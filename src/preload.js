const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  getState: () => ipcRenderer.invoke('jarvis:get-state'),
  sendMessage: (text) => ipcRenderer.invoke('jarvis:send-message', text),
  signIn: () => ipcRenderer.invoke('jarvis:sign-in'),
  signOut: () => ipcRenderer.invoke('jarvis:sign-out'),
  respondToApproval: (choice) => ipcRenderer.invoke('jarvis:respond-approval', choice),
  respondToUserInput: (response) => ipcRenderer.invoke('jarvis:respond-user-input', response),
  updateSettings: (next) => ipcRenderer.invoke('jarvis:update-settings', next),
  startVoiceInput: () => ipcRenderer.invoke('jarvis:start-voice'),
  stopVoiceInput: () => ipcRenderer.invoke('jarvis:stop-voice'),
  sendVoiceAudio: (payload) => ipcRenderer.send('voice:audio', payload),
  voiceRendererReady: () => ipcRenderer.send('voice:renderer-ready'),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('jarvis:event', listener);
    return () => ipcRenderer.removeListener('jarvis:event', listener);
  }
});
