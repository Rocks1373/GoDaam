import { api } from './client';

/**
 * Server-side OCR (Tesseract). Works in Expo Go when the backend is reachable and the user is logged in.
 */
export async function extractTextRemote(imageUri: string): Promise<string[]> {
  const form = new FormData();
  form.append('image', {
    uri: imageUri,
    name: 'scan.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);

  const { data } = await api.post<{ lines?: string[] }>('/mobile/ocr/image', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  });

  const lines = data?.lines;
  return Array.isArray(lines) ? lines : [];
}
