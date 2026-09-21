import { contextBridge, ipcRenderer } from 'electron';
import { exposeDesktopApi } from './desktop-api.ts';
import { exposeCfoVoiceApi } from './cfo-voice-api.ts';
import { exposeCfoRealtimeApi } from './cfo-realtime-api.ts';
import { exposeCouncilReportApi } from './council-report-api.ts';
import { ENTERPRISE_CAPTURE_CHANNEL, ENTERPRISE_OPEN_CHANNEL, ENTERPRISE_LOCAL_CAPTURE_CHANNEL, ENTERPRISE_QUERY_CHANNEL, ENTERPRISE_SEARCH_CHANNEL, type EnterpriseQuery } from '../shared/enterprise-browser.ts';
import {ENTERPRISE_NEXT_CHANNEL} from '../shared/enterprise-browser.ts';
contextBridge.exposeInMainWorld('shensiEnterpriseBrowser', Object.freeze({ readPreview: () => ipcRenderer.invoke(ENTERPRISE_CAPTURE_CHANNEL),
  openLocal: (keyword?:string) => ipcRenderer.invoke(ENTERPRISE_OPEN_CHANNEL, keyword), captureLocal: () => ipcRenderer.invoke(ENTERPRISE_LOCAL_CAPTURE_CHANNEL),
  queryLocal: (query:EnterpriseQuery) => ipcRenderer.invoke(ENTERPRISE_QUERY_CHANNEL, query),
  searchLocal: (keyword:string) => ipcRenderer.invoke(ENTERPRISE_SEARCH_CHANNEL, keyword),nextLocal:(batchId:string)=>ipcRenderer.invoke(ENTERPRISE_NEXT_CHANNEL,batchId) }));
exposeDesktopApi({ contextBridge, ipcRenderer });
exposeCfoVoiceApi({ contextBridge, ipcRenderer });
exposeCfoRealtimeApi({ contextBridge, ipcRenderer });
exposeCouncilReportApi({ contextBridge, ipcRenderer });
