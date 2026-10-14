/** Resize locally before upload; re-encoding also removes camera metadata. */
export async function preparePhoto(file) {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40000000) throw new Error('Фото завелике. Оберіть зображення меншого розміру.');
    let edge = 1280;
    for (let round = 0; round < 5; round++, edge = Math.round(edge * 0.8)) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      for (const quality of [0.86, 0.72, 0.56]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= 130000) return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
      }
    }
    throw new Error('Не вдалося стиснути фото. Обріжте його до потрібної частини.');
  } finally { bitmap.close(); }
}
