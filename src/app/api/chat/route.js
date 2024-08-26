import {NextResponse} from 'next/server';
import {Pinecone} from '@pinecone-database/pinecone'
import { GoogleGenerativeAI } from "@google/generative-ai";


const systemPrompt = `
You are a rate my professor agent to help students find classes, that takes in user questions and answers them.
For every user question, the top 3 professors that match the user question are returned.
Use them to answer the question if needed.
`

export async function POST(req) {
    try {
        const data = await req.json();

        const pc = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY,
        });
        const index = pc.index('rag').namespace('ns1');

        // Initialize Google Generative AI client
        const genAI = new GoogleGenerativeAI(process.env.GEM_API_KEY);

        const text = data[data.length - 1].content;

        // Use Gemini to generate an embedding-like representation
        const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });
        const embeddingResult = await embeddingModel.embedContent(text);
        
        // Log the embedding result for debugging
        // console.log("Embedding result:", embeddingResult);

        // Extract the embedding values
        let embedding;
        if (Array.isArray(embeddingResult.embedding)) {
            embedding = embeddingResult.embedding;
        } else if (embeddingResult.embedding && Array.isArray(embeddingResult.embedding.values)) {
            embedding = embeddingResult.embedding.values;
        } else {
            throw new Error("Unexpected embedding format");
        }

        // Ensure the embedding is an array of numbers
        if (embedding.some(value => typeof value !== 'number')) {
            throw new Error("Invalid embedding format: not all values are numbers");
        }

        const results = await index.query({
            topK: 5,
            includeMetadata: true,
            vector: embedding,
        });

        let resultString = '';
        results.matches.forEach((match) => {
            resultString += `
            Returned Results:
            Professor: ${match.id}
            Review: ${match.metadata.stars}
            Subject: ${match.metadata.subject}
            Stars: ${match.metadata.stars}
            \n\n`;
        });

        // Use Gemini for chat completion
        const chatModel = genAI.getGenerativeModel({ model: "gemini-pro" });
        const chat = chatModel.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                ...data.slice(0, -1).map(msg => ({
                    role: msg.role === "assistant" ? "model" : "user",
                    parts: [{ text: msg.content }]
                }))
            ],
        });

        const result = await chat.sendMessageStream(data[data.length - 1].content);

        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                try {
                    for await (const chunk of result.stream) {
                        const chunkText = chunk.text();
                        controller.enqueue(encoder.encode(chunkText));
                    }
                } catch (error) {
                    controller.error(error);
                } finally {
                    controller.close();
                }
            },
        });

        return new NextResponse(stream);
    } catch (error) {
        console.error("Error in POST function:", error);
        return new NextResponse(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}