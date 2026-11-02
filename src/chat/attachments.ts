/**
 * Attachment size/type validation for chat uploads.
 *
 * Limits (per contract):
 *   Images:       max 10 MB  (.jpg, .jpeg, .png, .gif, .webp, .heic, .heif)
 *   Documents:    max 50 MB  (.pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx, .csv, .txt, .zip)
 *   Voice notes:  max 50 MB  (.m4a, .aac, .webm, .ogg, .mp3, .wav)
 */

export type AttachmentCategory = 'image' | 'document' | 'voice';

const IMAGE_MIMES: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'image/gif': true,
  'image/webp': true,
};

const DOC_MIMES: Record<string, true> = {
  'application/pdf': true,
  'application/msword': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
  'application/vnd.ms-excel': true,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': true,
  'application/vnd.ms-powerpoint': true,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': true,
  'text/csv': true,
  'text/plain': true,
  'application/zip': true,
};

const VOICE_MIMES: Record<string, true> = {
  'audio/m4a': true,
  'audio/mp4': true,
  'audio/webm': true,
  'audio/ogg': true,
  'audio/mpeg': true,
  'audio/wav': true,
  'audio/x-wav': true,
};

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;   // 10 MB
const DOC_MAX_BYTES   = 50 * 1024 * 1024;   // 50 MB
const VOICE_MAX_BYTES = 50 * 1024 * 1024;   // 50 MB

export interface AttachmentInfo {
  uri: string;
  name: string;
  size: number;   // bytes
  mimeType: string;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  category?: AttachmentCategory;
}

export function validateAttachment(info: AttachmentInfo): ValidationResult {
  const { mimeType, size, name } = info;

  if (IMAGE_MIMES[mimeType]) {
    if (size > IMAGE_MAX_BYTES) {
      return { ok: false, error: `Image "${name}" exceeds 10 MB (${fmtMB(size)}).` };
    }
    return { ok: true, category: 'image' };
  }

  if (VOICE_MIMES[mimeType]) {
    if (size > VOICE_MAX_BYTES) {
      return { ok: false, error: `Voice note "${name}" exceeds 50 MB (${fmtMB(size)}).` };
    }
    return { ok: true, category: 'voice' };
  }

  if (DOC_MIMES[mimeType]) {
    if (size > DOC_MAX_BYTES) {
      return { ok: false, error: `File "${name}" exceeds 50 MB (${fmtMB(size)}).` };
    }
    return { ok: true, category: 'document' };
  }

  return {
    ok: false,
    error: `File type "${mimeType}" is not allowed. Supported: images, PDF, Office docs, CSV, TXT, ZIP, and voice notes.`,
  };
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
