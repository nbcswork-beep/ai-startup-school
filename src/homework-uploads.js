// Homework attachments on the client: selection checks that mirror the server, and the direct
// upload to private storage. The server re-checks everything; these checks only save a round trip.

export const HOMEWORK_FILE_EXTENSIONS = ['pdf', 'docx', 'doc', 'pptx', 'xlsx', 'txt', 'png', 'jpg', 'jpeg', 'zip'];
export const HOMEWORK_FILE_ACCEPT = HOMEWORK_FILE_EXTENSIONS.map(extension => `.${extension}`).join(',');

export function fileExtensionOf(name) {
  return (/\.([^.]+)$/.exec(String(name).trim())?.[1] ?? '').toLowerCase();
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 КБ';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`;
}

/**
 * Splits a selection into files that can start uploading and readable reasons for the rest.
 * `current` is what is already attached or uploading: { count, totalBytes }.
 */
export function checkSelection(files, policy, current) {
  const accepted = [], rejected = [];
  let count = current.count, total = current.totalBytes;
  for (const file of files) {
    const extension = fileExtensionOf(file.name);
    const name = `«${file.name}»`;
    if (!HOMEWORK_FILE_EXTENSIONS.includes(extension) || !policy.extensions.includes(extension)) rejected.push(`${name}: такий формат не підтримується`);
    else if (file.size === 0) rejected.push(`${name}: файл порожній`);
    else if (file.size > policy.maxFileBytes) rejected.push(`${name}: більше ${formatFileSize(policy.maxFileBytes)}`);
    else if (count >= policy.maxFiles) rejected.push(`${name}: можна прикріпити не більше ${policy.maxFiles} файлів`);
    else if (total + file.size > policy.maxTotalBytes) rejected.push(`${name}: разом файли перевищать ${formatFileSize(policy.maxTotalBytes)}`);
    else { accepted.push({ file, extension }); count += 1; total += file.size; }
  }
  return { accepted, rejected };
}

/** Sends the bytes to the one-object URL the server issued. Resolves only on a 2xx response. */
export function sendFile(target, file, { onProgress, onStart } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onStart?.(xhr);
    xhr.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers ?? {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress?.(1); resolve(); return; }
      reject(uploadError(xhr.status));
    };
    xhr.onerror = () => reject(Object.assign(new Error('Немає з’єднання. Перевір інтернет і спробуй ще раз.'), { retryable: true, network: true }));
    xhr.ontimeout = () => reject(Object.assign(new Error('Завантаження триває надто довго. Спробуй ще раз.'), { retryable: true }));
    xhr.onabort = () => reject(Object.assign(new Error('Завантаження скасовано.'), { aborted: true }));
    xhr.send(file);
  });
}

function uploadError(status) {
  if (status === 403) return Object.assign(new Error('Посилання для завантаження застаріло. Натисни «Повторити».'), { status, retryable: true, expired: true });
  if (status === 413) return Object.assign(new Error('Файл завеликий для завантаження.'), { status, retryable: false });
  if (status === 415) return Object.assign(new Error('Такий тип файлу не приймається.'), { status, retryable: false });
  return Object.assign(new Error('Сховище файлів не відповіло. Спробуй ще раз.'), { status, retryable: true });
}

/** Server rejections that a retry of the same bytes cannot fix. */
export function isFinalUploadError(error) {
  return ['FILE_CONTENT_MISMATCH', 'FILE_TYPE_NOT_ALLOWED', 'FILE_TOO_LARGE', 'FILE_EMPTY', 'ATTACHMENT_LIMIT', 'ATTACHMENT_TOTAL_LIMIT', 'HOMEWORK_NOT_FOUND', 'FILE_STORAGE_UNAVAILABLE'].includes(error?.code)
    || error?.retryable === false;
}
