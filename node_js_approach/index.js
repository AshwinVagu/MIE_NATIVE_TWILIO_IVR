(async () => {
    if (typeof global.Headers === 'undefined') {
      const fetch = await import('node-fetch');
      global.Headers = fetch.Headers;
    }
  
    const WebSocket = require("ws");
    const express = require("express");
    const WaveFile = require("wavefile").WaveFile;
    const axios = require("axios");
    const fs = require("fs");
    const textToSpeech = require('@google-cloud/text-to-speech');
    require("dotenv").config();
  
    const app = express();
    const server = require("http").createServer(app);
    const wss = new WebSocket.Server({ server });
  
    const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
    const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  
    if (!MISTRAL_API_KEY || !DEEPGRAM_API_KEY) {
        console.error("Missing API keys. Set MISTRAL_API_KEY and DEEPGRAM_API_KEY in environment variables.");
        process.exit(1);
    }
  
    let deepgram;
    let conversationHistory = {};
    let chunks = {};
    let timeoutHandlers = {};  // Stores timers to detect inactivity
    let partialTranscript = {}; // Stores ongoing speech data
    const ttsClient = new textToSpeech.TextToSpeechClient();
  
    function linearToMuLaw(sample) {
        const MU_LAW_MAX = 0x1FFF;
        const BIAS = 0x84;
        const CLIP = 32635;
  
        sample = Math.max(-CLIP, Math.min(CLIP, sample));
        let sign = (sample < 0) ? 0x80 : 0;
        if (sign) sample = -sample;
  
        sample += BIAS;
        let exponent = 7;
        for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
            exponent--;
        }
  
        const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
        return ~(sign | (exponent << 4) | mantissa) & 0xFF;
    }
  
    function pcmToMuLaw(pcmBuffer) {
        const output = Buffer.alloc(pcmBuffer.length / 2);
        for (let i = 0; i < output.length; i++) {
            const sample = pcmBuffer.readInt16LE(i * 2);
            output[i] = linearToMuLaw(sample);
        }
        return output;
    }
  
    async function streamAIResponseToTwilio(ws, aiResponse, streamSid) {
        try {
            const [response] = await ttsClient.synthesizeSpeech({
                input: { text: aiResponse },
                voice: { languageCode: 'en-US', ssmlGender: 'FEMALE' },
                audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 }
            });
  
            const pcmBuffer = Buffer.from(response.audioContent, 'binary');
            const muLawBuffer = pcmToMuLaw(pcmBuffer);
            const payload = muLawBuffer.toString('base64');
  
            console.log("Streaming AI response to Twilio...");
  
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
                ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts_response" } }));
            } else {
                console.warn("WebSocket is not open while trying to send AI response");
            }
        } catch (err) {
            console.error("Error streaming AI response:", err);
        }
    }
  
    wss.on("connection", function connection(ws) {
        console.log("New Twilio connection initiated");
  
        ws.on("message", async function incoming(message) {
            if (!deepgram || deepgram.readyState !== WebSocket.OPEN) {
                return console.error("Deepgram WebSocket is not open.");
            }
  
            const msg = JSON.parse(message);
  
            switch (msg.event) {
                case "connected":
                    console.log(`Call connected`);
                    deepgram.onerror = console.error;
  
                    let callSid = msg.callSid;
                    conversationHistory[callSid] = [];
                    partialTranscript[callSid] = "";
  
                    deepgram.onmessage = async (deepgramMsg) => {
                        const res = JSON.parse(deepgramMsg.data);
  
                        if (res.type === "Results" && res.channel?.alternatives?.length > 0) {
                            const transcript = res.channel.alternatives[0].transcript.trim();
                            if (transcript) {
                                console.log("User said:", transcript);
  
                                partialTranscript[callSid] += ` ${transcript}`.trim();
  
                                if (timeoutHandlers[callSid]) clearTimeout(timeoutHandlers[callSid]);
  
                                timeoutHandlers[callSid] = setTimeout(async () => {
                                    let finalSentence = partialTranscript[callSid].trim();
                                    if (finalSentence) {
                                        conversationHistory[callSid].push({ role: "user", content: finalSentence });
  
                                        const aiResponse = await queryLLM(conversationHistory[callSid]);
                                        conversationHistory[callSid].push({ role: "assistant", content: aiResponse });
  
                                        console.log("AI Response:", aiResponse);
  
                                        const streamSid = Object.keys(chunks)[0];
                                        await streamAIResponseToTwilio(ws, aiResponse, streamSid);
  
                                        partialTranscript[callSid] = "";
                                    }
                                }, 2000);
                            }
                        }
                    };
                    break;
  
                case "start":
                    console.log(`Starting media stream for ${msg.streamSid}`);
                    break;
  
                case "media":
                    let twilioData = msg.media.payload;
                    let wav = new WaveFile();
                    wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64"));
                    wav.fromMuLaw();
  
                    let audioBuffer = Buffer.from(wav.data.samples);
                    if (!chunks[msg.streamSid]) {
                        chunks[msg.streamSid] = [];
                    }
                    chunks[msg.streamSid].push(audioBuffer);
  
                    if (chunks[msg.streamSid].length >= 5) {
                        let combinedBuffer = Buffer.concat(chunks[msg.streamSid]);
                        deepgram.send(combinedBuffer, { binary: true });
                        chunks[msg.streamSid] = [];
                    }
                    break;
  
                case "stop":
                    console.log(`Call ended`);
                    deepgram.send(JSON.stringify({ type: "CloseStream" }));
                    delete conversationHistory[msg.callSid];
                    delete chunks[msg.streamSid];
                    delete timeoutHandlers[msg.callSid];
                    delete partialTranscript[msg.callSid];
                    break;
            }
        });
    });
  
    app.post("/", async (req, res) => {
        deepgram = await new Promise((resolve, reject) => {
            const dgSocket = new WebSocket(
                `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&interim_results=true`,
                { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
            );
    
            dgSocket.onopen = () => {
                dgSocket.send(JSON.stringify({
                    type: "Configure",
                    encoding: "linear16",
                    sample_rate: 8000,
                    channels: 1,
                    interim_results: true
                }));
                console.log("Deepgram WebSocket is now OPEN.");
                resolve(dgSocket);
            };
    
            dgSocket.onerror = (err) => {
                console.error("Failed to connect to Deepgram:", err);
                reject(err);
            };
        });
    
        res.set("Content-Type", "text/xml");
        res.send(
            `<Response>
                <Connect>
                    <Stream url='wss://${req.headers.host}' />
                </Connect>
            </Response>`
        );
    });
  
    async function queryLLM(conversation) {
        try {
            const systemPrompt = `
            You are an intelligent IVR assistant for a hospital. Your goal is to assist callers by providing accurate information about hospital services, including operational hours, address, and general inquiries.
  
            **Guidelines:**
            1. If asked about hospital hours, mention it's open **Monday to Friday from 8:00 AM to 6:00 PM** and closed on **Saturday & Sunday**.
            2. If asked for the hospital's address, provide the full address in a structured format.
            3. If asked about both, include both in your response.
            4. Keep responses **clear, concise, and professional**.
            5. If the caller asks something you don't know, politely suggest they contact the front desk.
  
            **Example Responses:**
            - **For Hours:** "The hospital is open **Monday to Friday from 8 AM to 6 PM** and closed on **weekends**."
            - **For Address:** "MediCare Hospital, 1234 Wellness Ave, Springfield, IL, 62704."
            - **For Both:** "The hospital operates **Monday to Friday, 8 AM - 6 PM**, and is closed on weekends. Visit us at **MediCare Hospital, 1234 Wellness Ave, Springfield, IL, 62704**."
            `;
  
            let formattedHistory = [{ role: "system", content: systemPrompt }, ...conversation];
  
            let response = await axios.post(
                "https://api.mistral.ai/v1/chat/completions",
                {
                    model: "mistral-small",
                    messages: formattedHistory
                },
                {
                    headers: {
                        Authorization: `Bearer ${MISTRAL_API_KEY}`,
                        "Content-Type": "application/json"
                    }
                }
            );
  
            return response.data.choices[0].message.content;
        } catch (error) {
            console.error("Error querying LLM:", error.response ? error.response.data : error.message);
            return "I'm sorry, I couldn't process your request.";
        }
    }
  
    console.log("Listening at Port 8080");
    server.listen(8080);
  })();
  