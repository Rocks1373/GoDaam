import { loadPuter, formatPuterError } from './puterService';

const DEFAULT_TEXT_MODEL = 'gpt-4o-mini';
const DEFAULT_VISION_MODEL = 'gpt-4o-mini';

function extractText(response) {
  if (typeof response === 'string') return response;
  const content = response?.message?.content ?? response?.content ?? response?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || part?.content || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (response == null) return '';
  return JSON.stringify(response, null, 2);
}

export async function chatWithPuter(messages, options = {}) {
  const puter = await loadPuter();
  const model = options.model || DEFAULT_TEXT_MODEL;

  const formatted = Array.isArray(messages)
    ? messages
    : [{ role: 'user', content: String(messages) }];

  try {
    const response = await puter.ai.chat(formatted, { model, ...options });
    return extractText(response);
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function ocrImage(file) {
  const puter = await loadPuter();
  try {
    const result = await puter.ai.img2txt(file);
    return extractText(result);
  } catch (firstError) {
    if (/mistral|not configured/i.test(String(firstError?.message || ''))) {
      try {
        const result = await puter.ai.img2txt({ source: file, provider: 'aws-textract' });
        return extractText(result);
      } catch {
        // fall through
      }
    }
    throw new Error(formatPuterError(firstError));
  }
}

export async function analyzeImage(file, prompt) {
  const puter = await loadPuter();
  const text =
    prompt ||
    'Analyze this warehouse/logistics document. Extract all visible text, identify document type, item numbers, quantities, dates, and delivery/order references.';

  try {
    const response = await puter.ai.chat(text, file, { model: DEFAULT_VISION_MODEL });
    return extractText(response);
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

const OCR_EXTRACTION_PROMPT = `You are a warehouse document parser. You received OCR text from an invoice, delivery note, purchase order, or similar logistics document.

Extract ONLY the fields below from the text. Return valid JSON and nothing else. Use null for any field you cannot find. If there are multiple line items, put them in the "lineItems" array.

{
  "documentType": "invoice | delivery_note | purchase_order | packing_list | pod | unknown",
  "poNumber": null,
  "soNumber": null,
  "deliveryNumber": null,
  "invoiceNumber": null,
  "vendorName": null,
  "customerName": null,
  "date": null,
  "lineItems": [
    {
      "partNumber": null,
      "description": null,
      "quantity": null,
      "uom": null
    }
  ]
}`;

export async function extractStructuredFields(rawOcrText) {
  const puter = await loadPuter();
  try {
    const response = await puter.ai.chat(
      [
        { role: 'system', content: OCR_EXTRACTION_PROMPT },
        { role: 'user', content: rawOcrText },
      ],
      { model: DEFAULT_TEXT_MODEL }
    );

    const text = extractText(response);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { raw: text, parseError: 'Could not extract JSON from AI response' };
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function ocrAndExtract(file) {
  const rawText = await ocrImage(file);
  if (!rawText || rawText.length < 5) {
    return { rawText: rawText || '', structured: null, error: 'No text detected in image' };
  }
  try {
    const structured = await extractStructuredFields(rawText);
    return { rawText, structured, error: null };
  } catch (e) {
    return { rawText, structured: null, error: e.message };
  }
}

export async function listAvailableModels() {
  const puter = await loadPuter();
  try {
    return await puter.ai.listModels();
  } catch {
    return [];
  }
}
