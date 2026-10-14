import RFB from "@novnc/novnc";
import type { DouyinLiveRfb } from "./douyin-live-login";

export function createDouyinRfb(
  target: HTMLElement,
  socketUrl: string,
): DouyinLiveRfb {
  return new RFB(target, socketUrl, { shared: true });
}

