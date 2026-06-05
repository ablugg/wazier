const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wazier', {
  // Setup
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  pullModel: () => ipcRenderer.invoke('setup:pull-model'),
  openOllama: () => ipcRenderer.invoke('setup:open-ollama'),
  onPullProgress: (cb) => ipcRenderer.on('setup:pull-progress', (_, pct) => cb(pct)),

  // Chat
  sendMessage: (messages) => ipcRenderer.invoke('chat:send', messages),
  onToken: (cb) => ipcRenderer.on('chat:token', (_, token) => cb(token)),
  offToken: () => ipcRenderer.removeAllListeners('chat:token'),

  // Storage
  newSession: () => ipcRenderer.invoke('storage:new-session'),
  appendMessage: (sessionId, role, content) => ipcRenderer.invoke('storage:append', { sessionId, role, content }),
  listSessions: () => ipcRenderer.invoke('storage:list'),
  getMessages: (sessionId) => ipcRenderer.invoke('storage:get-messages', sessionId),
  markImportant: (sessionId) => ipcRenderer.invoke('storage:mark-important', sessionId),
  clearUnimportant: () => ipcRenderer.invoke('storage:clear-unimportant'),
  purgeOld: () => ipcRenderer.invoke('storage:purge-old'),
})
