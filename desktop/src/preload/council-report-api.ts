import { COUNCIL_REPORT_CHANNEL, validateCouncilReportRequest, type CouncilReportBridge, type CouncilReportResult } from '../shared/council-report.ts';

export function exposeCouncilReportApi(ports: {
  contextBridge: { exposeInMainWorld(key: string, value: unknown): void };
  ipcRenderer: { invoke(channel: string, value: unknown): Promise<unknown> };
}): CouncilReportBridge {
  const bridge: CouncilReportBridge = Object.freeze({
    exportPdf: (request: Parameters<CouncilReportBridge['exportPdf']>[0]) =>
      ports.ipcRenderer.invoke(COUNCIL_REPORT_CHANNEL, validateCouncilReportRequest(request)) as Promise<CouncilReportResult>,
  });
  ports.contextBridge.exposeInMainWorld('shensiCouncilReport', bridge);
  return bridge;
}
