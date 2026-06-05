const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wazier', {
  // Setup
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  pullModel: () => ipcRenderer.invoke('setup:pull-model'),
  openOllama: () => ipcRenderer.invoke('setup:open-ollama'),
  launchOllama: () => ipcRenderer.invoke('setup:launch-ollama'),
  onPullProgress: (cb) => ipcRenderer.on('setup:pull-progress', (_, pct) => cb(pct)),

  // Chat
  sendMessage: (messages) => ipcRenderer.invoke('chat:send', messages),
  onToken: (cb) => ipcRenderer.on('chat:token', (_, token) => cb(token)),
  offToken: () => ipcRenderer.removeAllListeners('chat:token'),

  // Docs
  openDocDialog: () => ipcRenderer.invoke('docs:open-dialog'),
  addDoc: (filePath) => ipcRenderer.invoke('docs:add', filePath),
  listDocs: () => ipcRenderer.invoke('docs:list'),
  deleteDoc: (id) => ipcRenderer.invoke('docs:delete', id),
  onDocProgress: (cb) => ipcRenderer.on('docs:progress', (_, msg) => cb(msg)),
  offDocProgress: () => ipcRenderer.removeAllListeners('docs:progress'),

  // Storage
  newSession: () => ipcRenderer.invoke('storage:new-session'),
  appendMessage: (sessionId, role, content) => ipcRenderer.invoke('storage:append', { sessionId, role, content }),
  listSessions: () => ipcRenderer.invoke('storage:list'),
  getMessages: (sessionId) => ipcRenderer.invoke('storage:get-messages', sessionId),
  markImportant: (sessionId) => ipcRenderer.invoke('storage:mark-important', sessionId),
  clearUnimportant: () => ipcRenderer.invoke('storage:clear-unimportant'),
  purgeOld: () => ipcRenderer.invoke('storage:purge-old'),

  // Updates
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  openUpdate: () => ipcRenderer.invoke('update:open'),
})
