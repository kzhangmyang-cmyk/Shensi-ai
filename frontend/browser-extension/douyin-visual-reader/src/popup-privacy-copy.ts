export interface PopupPrivacyCopy {
  artifactMode: string;
  scope: string;
  lifecycle: string;
}

const LIFECYCLE = "关闭弹窗后读取仍会继续；只有点击“停止”或接管页面才会停止。";

export function popupPrivacyCopy(artifactUploadEnabled: boolean): PopupPrivacyCopy {
  return artifactUploadEnabled ? {
    artifactMode: "遮挡 WebP（可上传）",
    scope: "正文缺失或截断时，原始视口截图仅在扩展内存中短暂存在；扩展在本地裁剪评论卡、遮挡头像与无关区域并运行 OCR，只上传遮挡后的 WebP。不会私信、点赞、评论或关注。",
    lifecycle: LIFECYCLE
  } : {
    artifactMode: "纯文字（不截图）",
    scope: "纯文字模式：只读取当前可见 DOM/ARIA 文字、公开时间与计数，不截图、不运行 OCR、不上传图片。不会私信、点赞、评论或关注。",
    lifecycle: LIFECYCLE
  };
}
