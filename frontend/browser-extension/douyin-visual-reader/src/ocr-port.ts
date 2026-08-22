export interface OcrPixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualOcrCrop {
  mediaType: "image/webp";
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface VisualOcrWord {
  text: string;
  confidence: number;
  bounds: OcrPixelRect;
}

export interface VisualOcrResult {
  text: string;
  confidence: number;
  words: VisualOcrWord[];
}

export type VisualOcrLanguages = readonly ["chi_sim", "eng"];

export interface VisualOcrPort {
  recognize(crop: VisualOcrCrop, languages: VisualOcrLanguages): Promise<VisualOcrResult>;
  endSession?(): Promise<void>;
}
