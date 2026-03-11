import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import arg from 'arg';
import OpenAI from 'openai';

async function main() {
  const args = arg({
    '--prompt': String,
    '--model': String,
    '--n': Number,
    '--aspect-ratio': String,
    '--safety-filter-level': String,
    '--output-dir': String,
    '-p': '--prompt',
    '-m': '--model',
    '-n': '--n',
  });

  const prompt = args['--prompt'];

  if (!prompt) {
    throw new Error('Missing required --prompt option.');
  }

  const model = args['--model'] ?? 'google/imagen-4.0-fast-generate-001';
  const imageCount = args['--n'] ?? 1;
  const aspectRatio = args['--aspect-ratio'] ?? '16:9';
  const safetyFilterLevel = args['--safety-filter-level'] ?? 'OFF';
  const outputDir = path.join(process.cwd(), args['--output-dir'] ?? 'output');

  const openai = new OpenAI({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    baseURL: 'https://ai-gateway.vercel.sh/v1',
  });

  const result = await openai.images.generate({
    model,
    prompt,
    n: imageCount,
    providerOptions: {
      googleVertex: {
        aspectRatio,
        safetyFilterLevel,
      },
    },
  } as any);

  await mkdir(outputDir, { recursive: true });
  const createdAtPrefix = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');

  for (const [index, image] of (result.data ?? []).entries()) {
    if (image.b64_json) {
      const outputPath = path.join(
        outputDir,
        `${createdAtPrefix}-imagen-option-${index + 1}.png`,
      );
      const imageBuffer = Buffer.from(image.b64_json, 'base64');

      await writeFile(outputPath, imageBuffer);
      console.log(`Saved generated image to ${outputPath}`);
    }
  }
}

main().catch(console.error);
