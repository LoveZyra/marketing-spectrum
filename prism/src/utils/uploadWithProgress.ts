import { IS_PLATFORM } from '../constants/config';

import { apiKeyHeaders, isValidRefreshedToken } from './api';

/**
 * POST a FormData body and report transfer progress.
 *
 * fetch() cannot do this: its request body is not observable, so every upload
 * built on authenticatedFetch can only render an indeterminate spinner. That is
 * tolerable for a 2MB PDF and not for a 500MB attachment, where the user has no
 * way to tell a slow upload from a hung one.
 *
 * XHR is the only browser API that exposes upload progress events, so this
 * reimplements authenticatedFetch's header and token handling on top of it.
 * Anything authenticatedFetch learns about auth has to be mirrored here — that
 * duplication is the price of the progress events, so it lives in exactly one
 * place rather than at each call site.
 */

/**
 * Transfer completion is not request completion: once the last byte is sent the
 * server still has to move the file into place and answer. Holding back the
 * final percent keeps the bar from sitting at a finished-looking 100% during a
 * gap that, for a large file on a slow disk, is clearly visible.
 */
const MAX_TRANSFER_PROGRESS = 99;

export type UploadProgressHandler = (percent: number) => void;

const parseJsonBody = (xhr: XMLHttpRequest): Record<string, unknown> => {
  if (!xhr.responseText) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(xhr.responseText);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    // A non-JSON body means a proxy or the platform answered instead of the
    // app. There is nothing useful to surface from it, so fall through to the
    // status-code message rather than showing the user raw HTML.
    return {};
  }
};

const readErrorMessage = (payload: Record<string, unknown>, status: number): string => {
  const error = payload.error;
  if (typeof error === 'string' && error) return error;
  const message = payload.message;
  if (typeof message === 'string' && message) return message;
  return `Upload failed (${status})`;
};

export const uploadFormDataWithProgress = <T = Record<string, unknown>>(
  url: string,
  formData: FormData,
  onProgress?: UploadProgressHandler,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open('POST', url);

    // Mirrors authenticatedFetch: the API-key gate and the JWT are both required
    // on these routes. Content-Type is deliberately not set — the browser has to
    // generate the multipart boundary itself.
    Object.entries(apiKeyHeaders()).forEach(([header, value]) => {
      xhr.setRequestHeader(header, value);
    });

    const token = localStorage.getItem('auth-token');
    if (!IS_PLATFORM && token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        // Without a Content-Length the browser cannot compute a ratio, so the
        // caller keeps whatever indeterminate state it started with.
        if (!event.lengthComputable) return;
        onProgress(Math.min(MAX_TRANSFER_PROGRESS, Math.round((event.loaded / event.total) * 100)));
      };
    }

    xhr.onload = () => {
      // Same sliding-session refresh authenticatedFetch performs. Validated
      // before storing so a malformed header cannot overwrite a good token.
      const refreshedToken = xhr.getResponseHeader('X-Refreshed-Token');
      if (isValidRefreshedToken(refreshedToken)) {
        localStorage.setItem('auth-token', refreshedToken);
      }

      const payload = parseJsonBody(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as T);
        return;
      }

      reject(new Error(readErrorMessage(payload, xhr.status)));
    };

    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload canceled.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out.'));

    xhr.send(formData);
  });
