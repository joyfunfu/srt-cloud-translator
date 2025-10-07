import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import ZhipuAI from "zhipuai";
import { parseAiTranslationOutput, forceMergeChunk } from '../../utils/srtParser.js';

const TRANSLATION_PROMPT = `You are an expert subtitle translator. Your task is to translate the provided SRT subtitle blocks into high-quality, natural-sounding simplified Chinese. CRITICAL FORMATTING INSTRUCTIONS: 1. Each translated block MUST correspond to an original block ID. You will receive input text prefixed with block IDs like "<id:X> original text". 2. Your output MUST consist ONLY of the translated text, prefixed with the *exact same* block IDs. For each original "<id:X> text", you must output "<id:X> translated Chinese text". 3. The sequence and total count of block IDs in your output MUST BE IDENTICAL to the input. 4. Do NOT include any explanations or comments. --- START OF TEXT TO TRANSLATE ---`;
const RETRY_PROMPT_TEMPLATE = (originalText, errorMessage) => `You are an expert subtitle translator. Your previous attempt failed validation. You MUST correct your mistake. # The Error You Made: ${errorMessage}. # The Original Text to Translate (AGAIN): --- ${originalText} --- # Critical Instructions (Re-read Carefully): 1. Re-translate the original text provided above. 2. The total count of block IDs in your output MUST BE IDENTICAL to the original text's block ID count. 3. Your output must ONLY be the translated lines, each prefixed with its correct <id:X> tag. 4. Do NOT include explanations, apologies, or any other text. Now, provide the correct translation:`;

export default async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.INTERNAL_SECRET}`) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    res.status(202).json({ message: 'Chunk processing started' });

    const job = await kv.get(`job:${jobId}`);
    if (!job || (job.status !== 'pending' && job.status !== 'processing')) {
        console.log(`Job ${jobId} not in a processable state.`);
        return;
    }
    if (job.status === 'pending') {
        job.status = 'processing';
        await kv.set(`job:${jobId}`, job);
    }
    const chunkIndexToProcess = job.translatedChunks.length;
    if (chunkIndexToProcess >= job.chunks.length) {
        console.log(`Job ${jobId} has no more chunks to process.`);
        return;
    }
    try {
        const chunk = job.chunks[chunkIndexToProcess];
        const zhipuai = new ZhipuAI({ apiKey: process.env.ZHIPU_API_KEY });
        const translatedBlocks = await translateSingleChunkWithRetry(chunk, zhipuai);
        job.translatedChunks.push(translatedBlocks);
        job.chunksCompleted = job.translatedChunks.length;
        await kv.set(`job:${jobId}`, job);

        if (job.translatedChunks.length < job.chunks.length) {
            const protocol = process.env.VERCEL_ENV === 'development' ? 'http' : 'https';
            const host = process.env.VERCEL_URL || 'localhost:3000';
            fetch(`${protocol}://${host}/api/2-process-chunk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.INTERNAL_SECRET}` },
                body: JSON.stringify({ jobId }),
            });
        } else {
            let finalSrtContent = '';
            for (let i = 0; i < job.chunks.length; i++) {
                finalSrtContent += forceMergeChunk(job.chunks[i].originalBlocks, job.translatedChunks[i]);
            }
            const translatedFilename = `translated-${jobId}.srt`;
            const translatedBlob = await put(translatedFilename, finalSrtContent, { access: 'public', addRandomSuffix: false });
            job.status = 'completed';
            job.downloadUrl = translatedBlob.url;
            delete job.chunks;
            delete job.translatedChunks;
            await kv.set(`job:${jobId}`, job);
        }
    } catch (error) {
        console.error(`[Job ${jobId}] Failed to process chunk ${chunkIndexToProcess}:`, error);
        const currentJob = await kv.get(`job:${jobId}`); // Fetch latest job state
        currentJob.status = 'failed';
        currentJob.error = error.message;
        await kv.set(`job:${jobId}`, currentJob);
    }
}

async function translateSingleChunkWithRetry(chunk, zhipuai) {
    let lastFaultyParsedTranslation = [];
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            let promptContent;
            if (attempt === 1) {
                promptContent = TRANSLATION_PROMPT + chunk.textForAI;
            } else {
                const errorMessage = `ID数量不匹配。原文应有 ${chunk.originalBlocks.length} 个ID，但你返回了 ${lastFaultyParsedTranslation.length} 个。`;
                promptContent = RETRY_PROMPT_TEMPLATE(chunk.textForAI, errorMessage);
            }
            const response = await zhipuai.chat.completions.create({
                model: "glm-4.5-flash",
                messages: [{ role: "user", content: promptContent }],
            });
            const aiResponse = response.choices[0].message.content;
            const translatedBlocks = parseAiTranslationOutput(aiResponse);
            if (chunk.originalBlocks.length === translatedBlocks.length) {
                return translatedBlocks;
            } else {
                lastFaultyParsedTranslation = translatedBlocks;
            }
        } catch (error) {
            console.error(`Chunk translation attempt ${attempt} failed:`, error);
            if (attempt === MAX_RETRIES) throw error;
        }
    }
    return lastFaultyParsedTranslation;
}