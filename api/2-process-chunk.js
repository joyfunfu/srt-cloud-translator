import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import ZhipuAI from "zhipuai";
import { parseAiTranslationOutput, forceMergeChunk } from './utils/srtParser.js';

const TRANSLATION_PROMPT = `You are an expert subtitle translator...`; // full prompt text
const RETRY_PROMPT_TEMPLATE = (originalText, errorMessage) => `You are an expert subtitle translator...`; // full prompt text

export default async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.INTERNAL_SECRET}`) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    res.status(202).json({ message: 'Chunk processing started' });

    const job = await kv.get(`job:${jobId}`);
    if (!job || (job.status !== 'pending' && job.status !== 'processing')) return;
    
    if (job.status === 'pending') {
        job.status = 'processing';
        await kv.set(`job:${jobId}`, job);
    }

    const chunkIndexToProcess = job.translatedChunks.length;
    if (chunkIndexToProcess >= job.chunks.length) return;

    try {
        const chunk = job.chunks[chunkIndexToProcess];
        const zhipuai = new ZhipuAI({ apiKey: process.env.ZHIPU_API_KEY });
        const translatedBlocks = await translateSingleChunkWithRetry(chunk, zhipuai);
        job.translatedChunks.push(translatedBlocks);
        job.chunksCompleted = job.translatedChunks.length;
        
        if (job.translatedChunks.length < job.chunks.length) {
            await kv.set(`job:${jobId}`, job);
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
            job.status = 'completed';
            job.translatedContent = finalSrtContent;
            delete job.chunks;
            delete job.translatedChunks;
            delete job.originalContent;
            await kv.set(`job:${jobId}`, job);
        }
    } catch (error) {
        console.error(`[Job ${jobId}] Error processing chunk ${chunkIndexToProcess}:`, error);
        const currentJob = await kv.get(`job:${jobId}`);
        currentJob.status = 'failed';
        currentJob.error = error.message.slice(0, 100); // Limit error message length
        await kv.set(`job:${jobId}`, currentJob);
    }
}

async function translateSingleChunkWithRetry(chunk, zhipuai) {
    // ... implementation from previous response
}