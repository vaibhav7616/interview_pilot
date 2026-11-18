const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  appInfo: () => ipcRenderer.invoke('app:info'),

  sttStart: () => ipcRenderer.invoke('stt:start'),
  sttAudio: (arrayBuffer) => ipcRenderer.send('stt:audio', arrayBuffer),
  sttStop: () => ipcRenderer.invoke('stt:stop'),
  onTranscript: on('stt:transcript'),
  onUtteranceEnd: on('stt:utteranceEnd'),
  onSpeechStarted: on('stt:speechStarted'),
  onSttStatus: on('stt:status'),

  aiStream: (req) => ipcRenderer.invoke('ai:stream', req),
  aiCancel: (id) => ipcRenderer.invoke('ai:cancel', id),
  onAiDelta: on('ai:delta'),
  onAiDone: on('ai:done'),
  onAiError: on('ai:error'),

  importProfileDoc: () => ipcRenderer.invoke('profile:import'),

  saveSession: (s) => ipcRenderer.invoke('sessions:save', s),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id) => ipcRenderer.invoke('sessions:get', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  exportSession: (data) => ipcRenderer.invoke('sessions:export', data),

  onHotkey: on('hotkey'),
  onClickThrough: on('click-through'),
  setWindowMode: (mode) => ipcRenderer.send('win:mode', mode),
  fitWindow: (size) => ipcRenderer.send('win:fit', size),
  setClickThrough: (on) => ipcRenderer.send('win:click-through', on),
  minimize: () => ipcRenderer.send('win:minimize'),
  quit: () => ipcRenderer.send('win:quit'),
});
